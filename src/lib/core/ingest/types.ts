/**
 * Ingestion — shared types (ingest-reduce plan §1).
 *
 * Adapters fetch from a provider through the {@link Http} seam and map raw API
 * payloads into {@link RawItem}s with **pure, fixture-tested mapper functions**
 * — the same architecture as waid's `provider/` module: this layer never
 * touches disk, secrets, or the index. The pipeline turns RawItems into
 * candidate entries in the review inbox; only the human's promote makes one
 * canonical.
 *
 * SECURITY STANCE (data, never instructions): titles, snippets, and bodies
 * here are external text and may contain injected instructions. They are
 * stored verbatim as *data*. Any later LLM pass over them (the reduce stage)
 * MUST wrap them in fenced data blocks with an explicit do-not-follow guard.
 */

export type IngestSource =
  | 'github'
  | 'asana'
  | 'shortcut'
  | 'gmail'
  | 'linkedin'
  | 'resume'
  | 'claude-code'
  | 'warp'
  | 'neuroskill'
  | 'website';

/** A normalized item from any provider — the common shape every `map*`
 * function produces (waid's `IntegrationItem`, adapted for a historical
 * record: it carries an event date and entry-type suggestion). */
export interface RawItem {
  source: IngestSource | string;
  /** Provider-stable id; (source, sourceId) is the dedupe identity. */
  sourceId: string;
  title: string;
  /** Event date, YYYY-MM-DD — when the thing happened. */
  date: string;
  /** Canonical web URL for the item, when one exists. */
  url?: string;
  /** Factual body text (verbatim provider data; never synthesized). */
  body?: string;
  /** Suggested entry type ('journal' | 'role' | 'project' | …). Default journal. */
  suggestedType?: string;
  suggestedTags?: string[];
  /** Suggested project slug when the adapter context implies one (e.g. the
   * GitHub repo). A suggestion for the review UI — never auto-applied. */
  suggestedProject?: string;
  /** Extra type-specific frontmatter to carry onto the entry (org, role, end…). */
  extraFrontmatter?: Record<string, unknown>;
  /** Provider extras, kept small and string-valued (waid's `meta`). */
  meta?: Record<string, string>;
  /** Same-source ids that supersede this item: stage it only if NONE of them is
   * already promoted, rejected, or staged. Transient — never persisted to
   * frontmatter. GitHub commit mode fills it with the commit's associated PRs'
   * databaseIds (commit sourceIds are 40-hex, PR ids decimal — no collision). */
  supersededBy?: string[];
}

/** What a staging run did — surfaced in the UI after each adapter run. */
export interface IngestReport {
  fetched: number;
  staged: number;
  /** Skipped: already promoted into the record (provenance index). */
  skippedPromoted: number;
  /** Skipped: previously rejected by the human. */
  skippedRejected: number;
  /** Skipped: superseded by an already-handled item (e.g. a commit whose
   * associated PR is already staged/promoted/rejected). */
  skippedSuperseded: number;
  /** Per-item problems; a bad item never aborts the run. */
  errors: string[];
}

/** Keyring entry names for provider tokens (the {@link Secrets} seam, plan §1).
 * Like the Anthropic key, these NEVER touch the record repo or entry
 * frontmatter — only the OS keyring. Gmail is not here: it uses an OAuth grant
 * instead of a pasted token (see `gmail-oauth.ts`). */
export const GITHUB_TOKEN_NAME = 'github.token';
export const ASANA_TOKEN_NAME = 'asana.token';
/** A Shortcut token grants COMPLETE account access — OS keyring only, exactly
 * like the others. One token serves both the Shortcut enrichment of GitHub
 * items (enriched candidates keep `source: 'github'`) AND the Shortcut story
 * import source (`source: 'shortcut'` candidates). */
export const SHORTCUT_TOKEN_NAME = 'shortcut.token';

/** Pull a string out of an unknown JSON shape, or undefined. */
export function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Pull a finite number out of an unknown JSON shape, or undefined. */
export function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Safe nested lookup: `get(obj, 'a', 'b')` ≈ obj?.a?.b. */
export function get(v: unknown, ...path: (string | number)[]): unknown {
  let cur = v;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** First 10 chars of an ISO timestamp → YYYY-MM-DD, or undefined. */
export function isoDate(v: unknown): string | undefined {
  const s = asStr(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}
