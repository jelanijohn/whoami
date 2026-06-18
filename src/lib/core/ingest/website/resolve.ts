/**
 * Website import — URL resolution (website-import spec §3.2). PURE, no I/O.
 *
 * This is the reproducibility guarantee (spec §0.1): given the same entered
 * URLs + the same sitemap text, it resolves the exact same, deterministically
 * ordered page set every time. It is also the "not a crawler" boundary
 * (spec §0.2) — it unions only the URLs the user entered with the `<loc>`s of a
 * sitemap they explicitly pointed at, bounded to the allowlisted origins and
 * capped. It never discovers links from page bodies.
 */

import { WEBSITE_MAX_PAGES } from './types';

export interface ResolveInput {
  /** User-entered page URLs. Each one's origin is allowlisted. */
  urls: string[];
  /** Already-fetched sitemap text, if a sitemap was given (acquire.ts fetches
   * it; this module stays pure). */
  sitemapXml?: string;
  /** The sitemap's own URL, if one was entered — its origin joins the allowlist
   * so a sitemap-only run still resolves its `<loc>`s (spec §3.2). */
  sitemapUrl?: string;
  /** Hard page cap (default {@link WEBSITE_MAX_PAGES}). */
  maxPages?: number;
}

/** File extensions that are never page content (spec §3.2). Deliberately does
 * NOT include `.xml`: a sitemapindex's first-level `<loc>`s are nested-sitemap
 * `.xml` URLs and must survive parsing (spec D4) even though v1 won't fetch them. */
const NON_CONTENT_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif',
  'css', 'js', 'mjs',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg',
  'woff', 'woff2', 'ttf', 'otf', 'eot'
]);

/** Parse a URL, returning it only if it is http(s); else null (spec §3.2 rejects
 * non-http(s) — mailto:, javascript:, tel:, ftp:, …). */
function parseHttp(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u;
}

/** True when the URL's path points at an obvious non-content asset. */
function isNonContent(u: URL): boolean {
  const last = u.pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return false;
  return NON_CONTENT_EXT.has(last.slice(dot + 1).toLowerCase());
}

/**
 * A canonical form for dedupe (spec §3.2): drop the fragment, lower-case the
 * host, and strip a trailing slash from the path (so `/about` and `/about/`
 * collapse). The query is kept — distinct queries can be distinct pages.
 */
function canonical(u: URL): string {
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
}

/** Extract the text of every `<loc>` element from a sitemap (handles both a
 * flat `urlset` and the first level of a `sitemapindex` — both use `<loc>`; v1
 * does NOT recursively fetch nested sitemaps, spec §3.2 / D4). */
function sitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    // Sitemap locs are XML-escaped; decode the handful that occur in URLs.
    const decoded = m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .trim();
    if (decoded) out.push(decoded);
  }
  return out;
}

/**
 * Resolve the bounded, deduped, origin-allowlisted page set for a run, in
 * deterministic order: entered URLs first (input order), then sitemap `<loc>`s
 * (sitemap order), truncated to `maxPages`.
 */
export function resolvePages(input: ResolveInput): string[] {
  const maxPages = input.maxPages ?? WEBSITE_MAX_PAGES;
  const allowlist = new Set<string>();

  // Entered URLs define the allowlist and lead the order.
  const entered: URL[] = [];
  for (const raw of input.urls) {
    const u = parseHttp(raw);
    if (!u) continue;
    allowlist.add(u.origin);
    entered.push(u);
  }
  // A sitemap's own origin is trusted too, so a sitemap-only run still resolves.
  if (input.sitemapUrl) {
    const s = parseHttp(input.sitemapUrl);
    if (s) allowlist.add(s.origin);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  const push = (u: URL): void => {
    if (isNonContent(u)) return;
    const key = canonical(u);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  for (const u of entered) push(u);
  if (input.sitemapXml) {
    for (const loc of sitemapLocs(input.sitemapXml)) {
      const u = parseHttp(loc);
      if (!u || !allowlist.has(u.origin)) continue; // foreign-origin loc dropped
      push(u);
    }
  }

  return out.slice(0, maxPages);
}
