/**
 * Website import — identity-link harvest (website-import spec §4). PURE.
 *
 * The footer / head of a personal site lists the owner's canonical identities
 * (LinkedIn, GitHub, social profiles). Collecting them answers the brief's
 * "which identity is definitively you online" — and it is a deterministic,
 * LLM-free extraction: match the page's outbound links + JSON-LD `sameAs`
 * against a known-platform table, first occurrence wins.
 *
 * v1 builds and tests this but wires it to NO UI (spec §4 / D5): identities are
 * `Profile.identities`, not timeline candidates, and the propose→tick→merge
 * surface is a separate profile-merge spec. It MUST never auto-write the
 * profile.
 */

import type { FetchedPage } from './types';

/** Known platforms, keyed by the host(s) that identify them. Order is the tie
 * stable order; within a platform, first matching URL across the pages wins. */
const PLATFORMS: { platform: string; hosts: string[] }[] = [
  { platform: 'linkedin', hosts: ['linkedin.com'] },
  { platform: 'github', hosts: ['github.com'] },
  { platform: 'twitter', hosts: ['twitter.com', 'x.com'] },
  { platform: 'vimeo', hosts: ['vimeo.com'] },
  { platform: 'youtube', hosts: ['youtube.com', 'youtu.be'] },
  { platform: 'instagram', hosts: ['instagram.com'] },
  { platform: 'facebook', hosts: ['facebook.com', 'fb.com'] },
  { platform: 'tumblr', hosts: ['tumblr.com'] },
  { platform: 'mastodon', hosts: ['mastodon.social'] },
  { platform: 'bluesky', hosts: ['bsky.app'] },
  { platform: 'threads', hosts: ['threads.net'] }
];

/** The platform a URL belongs to, or null. Matches the host exactly or as a
 * subdomain (so `jelani.tumblr.com` maps to tumblr). */
function platformFor(raw: string): string | null {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  for (const { platform, hosts } of PLATFORMS) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return platform;
  }
  return null;
}

/** Recursively collect every `sameAs` string value anywhere in parsed JSON-LD
 * (objects, arrays, and `@graph` nesting are all walked). */
function collectSameAs(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectSameAs(n, out);
    return;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const same = o.sameAs;
    if (typeof same === 'string') out.push(same);
    else if (Array.isArray(same)) for (const s of same) if (typeof s === 'string') out.push(s);
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') collectSameAs(v, out);
    }
  }
}

/**
 * Harvest `{ platform: url }` from the fetched pages — JSON-LD `sameAs` first
 * (more authoritative), then document outbound links, in page order.
 * Deterministic and deduped; first occurrence per platform wins.
 */
export function harvestIdentities(pages: FetchedPage[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const page of pages) {
    const sameAs: string[] = [];
    for (const block of page.structured.jsonLd) collectSameAs(block, sameAs);
    for (const url of [...sameAs, ...page.outboundLinks]) {
      const platform = platformFor(url);
      if (platform && !(platform in out)) out[platform] = url;
    }
  }
  return out;
}
