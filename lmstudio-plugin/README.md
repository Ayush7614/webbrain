# WebBrain Web Tools — LM Studio plugin

Two web-fetching tools that make any LM Studio model chat-aware of
the live web:

- **`fetch_url`** — raw HTTP fetch, content-type aware. JSON gets
  pretty-printed, HTML gets stripped to readable text plus the page
  `<title>`, plain text comes back verbatim, binary is summarised
  rather than inlined as a data URL.
- **`research_url`** — same fetcher, but biased toward "give me the
  readable article body, not the navigation chrome". Extracts the
  `<main>` / `<article>` region and culls header/nav/footer/aside
  before stripping tags. Best for news pages, blog posts, GitHub
  READMEs, Wikipedia, docs sites.

Pure Node implementation — no browser, no Puppeteer, no Playwright.
The actual fetching code is the same logic that ships in the
[WebBrain](https://webbrain.one) Chrome / Firefox extension's
`network-tools.js` module, ported to TypeScript with the chrome.*
APIs replaced by Node `fetch`.

## What this plugin can't do

Listed up front so it doesn't bite you mid-session:

- **No JavaScript rendering.** Single-page apps that hydrate from
  JSON (Twitter, Notion, modern dashboards) will return near-empty
  text. The plugin flags this case with `spaSuspected: true` in the
  result so the model can give up gracefully instead of looping.
- **No clicks, no typing, no screenshots.** Those need a real
  browser. The WebBrain Chrome/Firefox extension does that; this
  plugin only does the read-only subset.
- **No cookies, no login.** Each fetch is anonymous from your IP
  with no shared session — you can't research pages behind a
  login through this tool.

If you need any of those, install the WebBrain extension instead
(or in addition) — it talks to the same model server but provides
the full agent loop with browser interaction. See <https://webbrain.one>.

## Install

### Prerequisite

LM Studio 0.3.x or newer (when the plugin SDK shipped) and Node 20+.

### Build

```bash
cd lmstudio-plugin
npm install
npm run build
```

This compiles `src/*.ts` → `dist/*.js` via `tsc`.

### Hook it into LM Studio

LM Studio looks for plugins in `~/.lmstudio/plugins/<author>/<name>/`
(macOS / Linux) or `%USERPROFILE%\.lmstudio\plugins\<author>\<name>\`
(Windows). The fastest way to install during development:

```bash
# from the repo root
lms plugin push ./lmstudio-plugin
```

Or symlink the folder into your plugins dir for hot-reload:

```bash
ln -s "$(pwd)/lmstudio-plugin" ~/.lmstudio/plugins/@webbrain/lmstudio-web-tools
```

Then restart LM Studio (or reload the plugins panel) and enable
"WebBrain Web Tools" for the chat session you want to use it in.

### Verify

In any chat where the plugin is enabled, ask the model something
that obviously needs a fresh fetch:

> What's on the front page of news.ycombinator.com right now?

Models that support tool-use will call `research_url` and come back
with the live headlines.

## Caveats and SDK drift

The plugin SDK API surface (`@lmstudio/sdk`'s `tool()`, the
`client.plugins.setToolsProvider(...)` registration, the manifest
shape) is current as of this plugin's `version`. If LM Studio
ships a breaking SDK change, you may need to adjust **only**
`src/index.ts` — the actual tool logic in `src/tools/*.ts` and
`src/util/*.ts` doesn't depend on the SDK.

The fastest way to see current shape: run
`lms create -t tools-provider` in a scratch directory once and
diff the scaffolded `index.ts` against ours. The pattern is small:
import `tool` and `LMStudioClient`, build tool objects with a
`name` / `description` / `parameters` / `implementation`, and
register them via `client.plugins.setToolsProvider(...)`.

## Safety notes

The plugin runs in the user's local Node process, so anything
reachable from that process is reachable from the LLM. The defenses
below are layered — each closes a class of bypass the previous one
missed — but DNS rebinding is a known residual gap (see the bottom
of this section).

- **URL guard, structural (sync).** By default, requests to RFC1918
  (`10.*`, `172.16-31.*`, `192.168.*`), loopback (`127.*`, `::1`),
  link-local (`169.254.*`, `fe80::/10`), unique-local IPv6
  (`fc00::/7`), cloud-metadata IPs, and `*.local` / `*.internal` /
  `*.lan` / `*.home` / `*.corp` / `*.intranet` domains are blocked.
  Non-`http(s)` protocols (`file://`, `ftp://`, `gopher://`,
  `javascript:`) are blocked too.
- **DNS resolution check.** Before each hop, the hostname is
  resolved via `dns.lookup({all: true})` and every returned A/AAAA
  address is checked against the same private ranges. This closes
  the bypass where `attacker.example A 127.0.0.1` would otherwise
  pass the syntactic check.
- **Per-redirect re-validation.** Redirects are followed manually
  (5 hops max). Each `Location` header runs through both the
  structural and DNS-resolution checks before we follow it. A
  public URL cannot 302 to `http://169.254.169.254/...` and have
  the plugin happily fetch it.
- **Cross-origin header stripping.** When a redirect crosses
  origins, `Authorization`, `Cookie`, `Proxy-Authorization`, and
  `Proxy-Authenticate` request headers are dropped. Same-origin
  redirects keep the full header set. This stops credentials
  passed via the per-call `headers` arg from leaking through an
  open-redirect chain.
- **Streaming response cap.** Bodies are read with a hard byte
  ceiling (4 MB for `fetch_url`, 6 MB for `research_url`). Past
  the cap, the underlying stream is cancelled and the result is
  marked `truncated: true`. A malicious or misconfigured server
  that sends a 1 GB response can no longer OOM the plugin.
- **No `credentials: 'include'`.** Unlike the Chrome extension
  (which forwards the user's browser cookies), this plugin makes
  anonymous requests. The model cannot reach pages behind your
  existing browser logins.
- **Timeouts.** Default 30 s, hard cap 120 s. Long-tail sites that
  hang forever won't lock up the model's tool-call loop.

Set `allowPrivate: true` on a per-call basis to opt out of the URL
guard + DNS check for that one call — useful when you actually want
the plugin to talk to localhost services.

### Known residual gap: DNS rebinding

An attacker controlling a domain with TTL=0 can return a public IP
when our guard runs `dns.lookup` and a private IP a moment later
when `fetch` connects. Closing this fully requires pinning the
resolved IP via a custom `undici` Agent's `connect.lookup` hook so
the connection uses the exact address we validated. That's tracked
as a follow-up — the current layered defense raises the bar enough
to stop drive-by SSRF from open redirects and naive hostname tricks
but is not a hardened sandbox. If you're running this on a cloud
VM with sensitive instance-metadata endpoints, run it under a
network policy that blocks 169.254.169.254 outbound rather than
relying solely on this plugin's checks.

## File layout

```
lmstudio-plugin/
├── README.md
├── package.json          ← npm dependencies + build scripts
├── tsconfig.json         ← strict-mode TS config, ES2022 / ESM
├── manifest.json         ← LM Studio plugin metadata
└── src/
    ├── index.ts          ← plugin registration glue
    ├── tools/
    │   ├── fetchUrl.ts   ← fetch_url implementation
    │   └── researchUrl.ts← research_url implementation
    └── util/
        ├── htmlToText.ts ← regex HTML stripper
        ├── safeFetch.ts  ← redirect-revalidating wrapper + streaming cap
        └── urlGuard.ts   ← private-IP / file:// blocker (sync structural check)
```

`tools/` and `util/` are pure functions with no SDK dependency —
you can also `import` them from any other Node project that wants
the same web-fetching primitives.

## License

MIT, same as the rest of WebBrain. See `../LICENSE`.
