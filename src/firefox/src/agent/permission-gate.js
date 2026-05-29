/**
 * Deterministic capability × origin permission gate for the WebBrain agent.
 *
 * KEEP THIS FILE PURE JS — no chrome.* / browser.* / DOM imports — so
 * test/run.js can load it under Node (same convention as markdown-link.js).
 *
 * Design (modeled on the capability/permission system in Claude for Chrome):
 * the gate does NOT inspect button text or the user's prompt wording, and it
 * uses NO language model. Every consequential tool call is mapped to a fixed
 * CAPABILITY type, and the decision is purely:
 *
 *     (capability, host)  ->  allow | deny | prompt
 *
 * The user grants a (capability, host) pairing ONCE (this turn) or ALWAYS
 * (persisted). This is language-agnostic (a "Gönder" button is a CLICK on
 * bank.com.tr, gated identically to "Send"), needs no synonym lists, and is
 * un-injectable: a page cannot talk the gate out of a decision because the
 * gate never reads page content — the human is the trust anchor.
 *
 * Read-only capabilities (read_page, get_accessibility_tree, screenshot, …)
 * are intentionally NOT gated; only state-changing / high-reach actions are.
 */

export const Capability = {
  NAVIGATE: 'navigate',          // navigate / new_tab to a host
  CLICK: 'click',                // click / click_ax
  TYPE: 'type',                  // type_text / type_ax / set_field
  EXECUTE_JS: 'execute_js',      // execute_js
  NETWORK: 'network_write',      // fetch_url / research_url with a write method
  DOWNLOAD: 'download',          // download_* tools
};

// Human-readable verb for the permission prompt: "WebBrain wants to <label> <host>".
export const CAPABILITY_LABEL = {
  [Capability.NAVIGATE]: 'navigate to',
  [Capability.CLICK]: 'click on',
  [Capability.TYPE]: 'type into',
  [Capability.EXECUTE_JS]: 'run JavaScript on',
  [Capability.NETWORK]: 'send a write request to',
  [Capability.DOWNLOAD]: 'download files from',
};

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Tool name -> capability. Tools absent from this map (and fetch_url with a
// non-write method) are read-only and never gated.
const TOOL_CAPABILITY = {
  navigate: Capability.NAVIGATE,
  new_tab: Capability.NAVIGATE,
  click: Capability.CLICK,
  click_ax: Capability.CLICK,
  type_text: Capability.TYPE,
  type_ax: Capability.TYPE,
  set_field: Capability.TYPE,
  execute_js: Capability.EXECUTE_JS,
  download_files: Capability.DOWNLOAD,
  download_resource_from_page: Capability.DOWNLOAD,
  download_social_media: Capability.DOWNLOAD,
};

/**
 * Map a tool call to its gated capability, or null if the tool is read-only /
 * not gated. fetch_url and research_url are only gated when they carry a write
 * method (GET/HEAD reads are not consequential).
 */
export function capabilityFor(name, args) {
  if (name === 'fetch_url' || name === 'research_url') {
    const method = String((args && args.method) || 'GET').toUpperCase();
    return MUTATION_METHODS.has(method) ? Capability.NETWORK : null;
  }
  return TOOL_CAPABILITY[name] || null;
}

/** Normalize a URL or bare host to a comparable registrable-ish host. */
export function normalizeHost(input) {
  if (typeof input !== 'string' || !input) return '';
  try {
    if (/^https?:\/\//i.test(input)) {
      return new URL(input).hostname.toLowerCase().replace(/^www\./, '');
    }
  } catch { /* fall through to bare-host parsing */ }
  let h = input.toLowerCase().replace(/^www\./, '').split('/')[0];
  // strip a :port (but leave IPv6 bracket forms alone)
  if (!h.startsWith('[')) {
    const c = h.indexOf(':');
    if (c > -1 && c === h.lastIndexOf(':')) h = h.slice(0, c);
  }
  return h;
}

/**
 * Which host does this capability act on? Navigate/network target the
 * destination URL; click/type/execute/download target the current page.
 */
export function hostForCapability(capability, args, currentUrlOrHost) {
  if (capability === Capability.NAVIGATE || capability === Capability.NETWORK) {
    return normalizeHost((args && args.url)) || normalizeHost(currentUrlOrHost);
  }
  return normalizeHost(currentUrlOrHost);
}

/**
 * Stores and evaluates (capability, host) grants. Pure logic — storage is
 * injected via async load/save hooks so this stays Node-testable. `skipAll`
 * is an optional escape hatch (e.g. an explicit autopilot setting).
 *
 * Grant shape: { capability, host, action: 'allow'|'deny', duration: 'once'|'always', ts }
 *   - 'always' grants are persisted (via save) and survive turns/sessions.
 *   - 'once' grants/denies live only until the next beginTurn().
 */
export class PermissionManager {
  constructor(opts = {}) {
    this._load = typeof opts.load === 'function' ? opts.load : null;
    this._save = typeof opts.save === 'function' ? opts.save : null;
    this._skipAll = typeof opts.skipAll === 'function' ? opts.skipAll : (() => false);
    this.permissions = [];
    this._hydrated = false;
  }

  async hydrate() {
    if (this._hydrated) return;
    this._hydrated = true;
    if (!this._load) return;
    try {
      const stored = await this._load();
      if (Array.isArray(stored)) {
        for (const g of stored) {
          if (g && g.capability && g.host) {
            this.permissions.push({ ...g, duration: 'always' });
          }
        }
      }
    } catch { /* storage unavailable → start empty */ }
  }

  /** Drop transient (once) grants/denies at the start of a new user turn. */
  beginTurn() {
    this.permissions = this.permissions.filter(p => p.duration === 'always');
  }

  /** { allowed, needsPrompt, grant? } for a (host, capability). */
  check(host, capability) {
    if (this._skipAll()) return { allowed: true, needsPrompt: false };
    const h = normalizeHost(host);
    const g = this.permissions.find(p => p.capability === capability && p.host === h);
    if (g) return { allowed: g.action === 'allow', needsPrompt: false, grant: g };
    return { allowed: false, needsPrompt: true };
  }

  /** Record a decision. 'always' grants are persisted. */
  async record(host, capability, action, duration) {
    const h = normalizeHost(host);
    this.permissions = this.permissions.filter(p => !(p.capability === capability && p.host === h));
    this.permissions.push({ capability, host: h, action, duration, ts: Date.now() });
    if (duration === 'always' && this._save) {
      try { await this._save(this.permissions.filter(p => p.duration === 'always')); } catch { /* best-effort */ }
    }
  }

  /** All persisted (always) grants — for a settings/management UI. */
  listAlwaysGrants() {
    return this.permissions.filter(p => p.duration === 'always');
  }
}
