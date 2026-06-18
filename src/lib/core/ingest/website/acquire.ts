/**
 * Website import — Stage 1 acquisition (website-import spec §3.4).
 *
 * Deterministic, LLM-FREE, and reproducible (spec §0.1): fetch the sitemap (if
 * any) and each resolved page through the `Http` seam, clean each with the pure
 * `extractPage`, and return the fetched pages plus a per-page error report. It
 * is NOT a crawler (spec §0.2) — it only fetches `resolvePages`' bounded,
 * origin-allowlisted set, sequentially with a politeness delay, and never
 * follows links found in page bodies.
 *
 * A single bad page never aborts the run: a fetch failure, or a page whose
 * cleaned text is below {@link WEBSITE_MIN_TEXT} (a JS shell / non-HTML page,
 * §1 non-goal), is recorded in `errors` and skipped.
 */

import type { Http } from '../../types';
import { getText } from '../http';
import { extractPage } from './extract';
import { harvestIdentities } from './identities';
import { resolvePages } from './resolve';
import { WEBSITE_MIN_TEXT, WEBSITE_SOURCE, type FetchedPage } from './types';

export interface WebsiteFetchOpts {
  urls: string[];
  sitemapUrl?: string;
  maxPages?: number;
  /** Delay (ms) between sequential page fetches — politeness, reinforcing "not
   * a crawler" (spec §3.4). Defaults to 250ms; tests pass 0. */
  delayMs?: number;
}

export interface AcquireResult {
  pages: FetchedPage[];
  errors: string[];
  /** The deterministic identity-link harvest (spec §4). Returned for callers,
   * but v1 wires it to no UI and never writes the profile (spec §4 / D5). */
  identities: Record<string, string>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetch + clean the resolved page set for a run (spec §3.4). */
export async function acquireWebsite(http: Http, opts: WebsiteFetchOpts): Promise<AcquireResult> {
  const errors: string[] = [];
  const delayMs = opts.delayMs ?? 250;

  let sitemapXml: string | undefined;
  if (opts.sitemapUrl) {
    try {
      sitemapXml = (await getText(http, opts.sitemapUrl, WEBSITE_SOURCE)).text;
    } catch (e) {
      // A failed sitemap is reported, then the entered URLs still resolve.
      errors.push(`sitemap ${opts.sitemapUrl}: ${String(e)}`);
    }
  }

  const resolved = resolvePages({
    urls: opts.urls,
    sitemapXml,
    sitemapUrl: opts.sitemapUrl,
    maxPages: opts.maxPages
  });

  const pages: FetchedPage[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const url = resolved[i];
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    try {
      const fetched = await getText(http, url, WEBSITE_SOURCE);
      const finalUrl = fetched.finalUrl || url;
      const extracted = extractPage(fetched.text, finalUrl);
      if (extracted.mainText.length < WEBSITE_MIN_TEXT) {
        errors.push(
          `${url}: too little text (${extracted.mainText.length} chars — likely a JS shell or non-HTML page)`
        );
        continue;
      }
      pages.push({ ...extracted, url, finalUrl });
    } catch (e) {
      errors.push(`${url}: ${String(e)}`);
    }
  }

  return { pages, errors, identities: harvestIdentities(pages) };
}
