/**
 * Website import — shared types & constants (website-import spec §3.5).
 *
 * A personal website is a *generated output* in the Who Am I model; importing
 * from one runs the pipeline backwards, pulling polished prose into a record
 * whose premise is brutal accuracy (spec §0). Acquisition (Stage 1) is therefore
 * deterministic and LLM-free — two runs over the same site resolve the same page
 * set and the same `sourceId`s. The single LLM pass (Stage 2, `pipeline.ts`)
 * only *structures* already-fetched, already-cleaned text.
 */

/** The literal `source` every website-derived item carries (spec §6). */
export const WEBSITE_SOURCE = 'website';

/** Hard cap on pages fetched in one run — Who Am I is *not* a crawler (spec §0.2). */
export const WEBSITE_MAX_PAGES = 25;

/** A fetched page whose cleaned `mainText` is shorter than this is treated as a
 * JS shell / empty page and reported rather than extracted (spec §1 non-goal). */
export const WEBSITE_MIN_TEXT = 200;

/** Structured signals lifted from a page's head/markup (spec §3.3). Data only —
 * never instructions, and links here are never auto-followed (spec §0.4). */
export interface PageStructured {
  /** Parsed `application/ld+json` blocks (each already JSON-parsed). */
  jsonLd: unknown[];
  /** `og:*` meta properties (key without the `og:` prefix). */
  openGraph: Record<string, string>;
  /** `name=…` meta tags (e.g. `description`). */
  meta: Record<string, string>;
  /** `<title>` / `og:title`. */
  title?: string;
}

/** The pure result of {@link extractPage}: cleaned text + structured signals. */
export interface ExtractedPage {
  title?: string;
  /** Boilerplate-stripped, whitespace-normalized body text (paragraph breaks
   * preserved as `\n\n` so the chunker can split cleanly). */
  mainText: string;
  structured: PageStructured;
  /** Absolute hrefs found in the document — recorded as DATA, never fetched
   * (spec §0.2, §3.3). */
  outboundLinks: string[];
}

/** A page after acquisition: its extracted content plus provenance URLs. */
export interface FetchedPage extends ExtractedPage {
  /** The URL we requested. */
  url: string;
  /** The URL after redirects (best-effort, per the `Http` seam — see
   * `getText`). */
  finalUrl: string;
}
