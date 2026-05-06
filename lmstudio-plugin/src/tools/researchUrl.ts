/**
 * research_url tool — like fetch_url, but biased toward "give me the
 * readable article body, not the navigation chrome".
 *
 * The Chrome extension version of this tool spawns a hidden tab and
 * lets the page's JavaScript run, then walks the DOM picking out
 * <main> / <article> and culling header/nav/footer/aside. We can't
 * do that inside an LM Studio plugin (Node host, no browser), so we
 * fall back to a fetch-based heuristic:
 *
 *   1. Fetch the URL plain (no JS execution — SPAs that rely on
 *      client-side rendering won't return useful content here).
 *   2. Pluck the chunk between the first <main> / <article> /
 *      role="main" element's open tag and its close, if present.
 *   3. Otherwise fall back to <body>.
 *   4. Drop noisy children (<header>, <nav>, <footer>, <aside>,
 *      common nav/sidebar class names) before stripping tags.
 *   5. Run the result through htmlToText to flatten to prose.
 *
 * Limitations vs the Chrome version (documented up front):
 *   - SPAs that render content via JavaScript appear empty here.
 *   - The "skip if it looks like a paywall/cookie banner" logic
 *     in the Chrome version isn't ported — we just return whatever
 *     the page sent.
 *   - Outbound link extraction is best-effort regex, not real DOM.
 *
 * For most static news pages, blog posts, GitHub READMEs, Wikipedia,
 * docs sites, this is plenty. For a Twitter timeline or a Notion
 * page that hydrates from JSON, you'll see a near-empty result.
 */

import { htmlToText } from "../util/htmlToText.js";
import { safeFetch, readBodyCapped } from "../util/safeFetch.js";

const RESEARCH_TEXT_LIMIT = 16_000;
const DEFAULT_TIMEOUT_MS = 30_000;
// Hard byte ceiling for the streamed body. Slightly larger than
// fetchUrl's 4 MB because research_url is biased toward whole HTML
// articles (which can run long), but small enough to bound worst-case
// memory if a server replies with a giant SPA bundle.
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024; // 6 MB

export interface ResearchUrlArgs {
  url: string;
  /** ms; default 30 000, cap 120 000. */
  timeout?: number;
  /** Allow RFC1918 / loopback targets. Off by default. */
  allowPrivate?: boolean;
}

export interface ResearchUrlLink {
  text: string;
  href: string;
}

export interface ResearchUrlResult {
  success: boolean;
  url?: string;
  title?: string;
  text?: string;
  truncated?: boolean;
  originalLength?: number;
  /** Up to 30 outbound links extracted by regex from the source HTML. */
  links?: ResearchUrlLink[];
  error?: string;
  /** True if the fetched HTML looked SPA-shaped (almost no body content). */
  spaSuspected?: boolean;
}

/**
 * Find the "main content" region in raw HTML using a few common
 * containers in priority order. Returns the inner HTML of whichever
 * container matched, or the original string if none did.
 */
function extractMainRegion(html: string): string {
  const containers = [
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    /<body\b[^>]*>([\s\S]*?)<\/body>/i,
  ];
  for (const re of containers) {
    const m = html.match(re);
    if (m && m[1] && m[1].trim().length > 100) return m[1];
  }
  return html;
}

/**
 * Cull header/nav/footer/aside blocks from a chunk of HTML before
 * we tag-strip it. The patterns are deliberately permissive —
 * better to drop a few too many ad/nav blocks than to leak them
 * into the readable text.
 */
function dropChrome(html: string): string {
  const patterns = [
    /<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi,
    /<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi,
    /<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi,
    /<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi,
    /<[^>]+role=["'](?:navigation|banner|contentinfo|complementary)["'][\s\S]*?<\/[^>]+>/gi,
  ];
  let out = html;
  for (const re of patterns) out = out.replace(re, " ");
  return out;
}

/**
 * Extract outbound links via regex. Real DOM would be better, but
 * we've already accepted the "regex parsing is good enough for
 * non-SPA pages" tradeoff in the rest of this file.
 */
function extractLinks(html: string, base: string): ResearchUrlLink[] {
  const out: ResearchUrlLink[] = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 30) {
    const rawHref = m[1];
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;
    let absolute: string;
    try {
      absolute = new URL(rawHref, base).toString();
    } catch {
      continue;
    }
    // Inner text via regex tag-strip
    const text = (m[2] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!text) continue;
    out.push({ text, href: absolute });
  }
  return out;
}

export async function researchUrl(args: ResearchUrlArgs): Promise<ResearchUrlResult> {
  if (!args?.url) return { success: false, error: "url is required" };

  const timeoutMs = Math.min(
    Math.max(args.timeout ?? DEFAULT_TIMEOUT_MS, 1000),
    120_000,
  );
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // safeFetch handles URL guard + DNS check + per-redirect re-validation
    // and cross-origin header stripping. See safeFetch.ts for design.
    const res = await safeFetch(args.url, {
      method: "GET",
      signal: controller.signal,
      allowPrivate: !!args.allowPrivate,
      headers: {
        // Some sites gate on User-Agent. Pretend to be a recent
        // desktop Firefox — same MO as curl/wget defaults.
        "User-Agent":
          "Mozilla/5.0 (LMStudio WebBrain Tools) Gecko/20100101 Firefox/142.0",
      },
    });
    if (!res.ok) {
      return {
        success: false,
        error: `HTTP ${res.status} ${res.statusText} for ${res.url}`,
      };
    }
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (
      !contentType.includes("html") &&
      !contentType.includes("xhtml") &&
      !contentType.startsWith("text/")
    ) {
      return {
        success: false,
        error:
          `research_url expected HTML/text content; got ${contentType || "(unknown)"}. Use fetch_url for JSON / binary.`,
      };
    }

    const { text: html, truncated: bodyTruncated } = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    const finalUrl = res.url;

    // Title comes from the full document, not the cropped region —
    // <title> lives in <head>.
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch?.[1] ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

    const mainHtml = dropChrome(extractMainRegion(html));
    const { text } = htmlToText(mainHtml);

    // Heuristic: pages whose body strips to <300 chars after we've
    // pulled <main> / <article> are almost certainly SPA shells.
    const spaSuspected = text.length < 300 && html.length > 5000;

    const links = extractLinks(html, finalUrl);

    return {
      success: true,
      url: finalUrl,
      title,
      text: text.slice(0, RESEARCH_TEXT_LIMIT),
      truncated: text.length > RESEARCH_TEXT_LIMIT || bodyTruncated,
      originalLength: text.length,
      links,
      ...(spaSuspected ? { spaSuspected: true } : {}),
    };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return { success: false, error: `research_url timed out after ${timeoutMs} ms` };
    }
    return { success: false, error: `research_url failed: ${err.message}` };
  } finally {
    clearTimeout(t);
  }
}
