/**
 * Inbox (ingest triage) design palette + per-source metadata (design handoff).
 *
 * Type colors reuse the Journal's `var(--jv-type-*)` tokens (see
 * `$lib/journal/theme`) so the type pill/chips match the timeline everywhere.
 * Source colors are literal brand hexes — they have no semantic `--color-*`
 * token and read the same in light/dark, mirroring the Import dashboard's
 * per-source accents. Alpha-composited tints go through {@link alpha}.
 * Exception: GitHub's brand hex is near-black, so it goes through the
 * `--src-github` token (app.css), which lightens under `:root.dark`.
 */

import { alpha } from '$lib/journal/theme';

export { alpha };
export { typeMeta, typeOrder, TYPE_META } from '$lib/journal/theme';

export interface SourceMeta {
  /** Display label for badges, chips, and group headers. */
  label: string;
  /** Brand color — a literal hex, or a `var(--src-*)` token when the brand
   * hex is too dark to read on the dark paper (see app.css). */
  color: string;
  /** `Icon` glyph name (see `$lib/components/Icon.svelte`). */
  glyph: string;
}

/** Known ingest sources, in canonical display order. Unknown source strings
 * fall back to a neutral gray + generic glyph via {@link sourceMeta}. */
export const SOURCE_META: Record<string, SourceMeta> = {
  github: { label: 'GitHub', color: 'var(--src-github)', glyph: 'code' },
  shortcut: { label: 'Shortcut', color: '#6552d0', glyph: 'bookmarks' },
  gmail: { label: 'Gmail', color: '#c5331f', glyph: 'mail' },
  calendar: { label: 'Calendar', color: '#1a73e8', glyph: 'event' },
  linkedin: { label: 'LinkedIn', color: '#0a66c2', glyph: 'work' },
  slack: { label: 'Slack', color: '#611f69', glyph: 'forum' },
  rss: { label: 'RSS', color: '#e8732c', glyph: 'rss_feed' },
  manual: { label: 'Manual', color: '#6b7280', glyph: 'edit_note' }
};

const SOURCE_ORDER = Object.keys(SOURCE_META);

/** Meta for a (possibly unknown) source string — unknown sources keep the raw
 * value as the label with a neutral gray + generic note glyph. */
export function sourceMeta(source: string): SourceMeta {
  return SOURCE_META[source] ?? { label: source || 'Unknown', color: '#6b7280', glyph: 'edit_note' };
}

/** Canonical order index for a source (for sorting Source groups/chips).
 * Unknown sources sort to the end, then alphabetically by the caller. */
export function sourceOrder(source: string): number {
  const i = SOURCE_ORDER.indexOf(source);
  return i === -1 ? SOURCE_ORDER.length : i;
}

/** Promote/kept/success green, reused for additions + Status "kept" swatch. */
export const KEPT_COLOR = '#1f9e6f';
/** Frivolous/flagged amber (the deeper text shade from the handoff). */
export const FLAGGED_COLOR = '#c07a00';
