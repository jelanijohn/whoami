/**
 * Import feeds — saved, re-runnable import configurations (import-feed-spec).
 *
 * This module holds ONLY the pure, framework-agnostic logic for feeds so it can
 * be unit-tested off-device (no Svelte runes, no Tauri): the {@link Feed} shape,
 * forward-compatible defaulting, the rolling-window `since` derivation, the
 * form→feed shaping, and the refresh-report aggregation. All orchestration (the
 * keyring lookup, fetch+stage, toasts) stays in the import-action layer
 * (`AppState`, `state.svelte.ts`) — feeds never touch the record repo, the
 * index, or an LLM beyond the existing triage pass.
 */

import type { IngestReport, IngestSource } from './ingest/types';

/** The ingest sources that can be saved as a feed. LinkedIn and Résumé are
 * inherently interactive file-dialog imports and do not participate (spec §11);
 * this is the {@link IngestSource} subset feeds use. */
export type FeedKind =
  | 'github'
  | 'asana'
  | 'shortcut'
  | 'gmail'
  | 'claude-code'
  | 'warp'
  | 'neuroskill'
  | 'website';

/** The local picker sources. They are ALWAYS prefilter-only + private (spec
 * §5.2; neuroskill spec R4/R5): the sensitivity rule is not overridable per
 * feed. */
const PICKER_KINDS: ReadonlySet<FeedKind> = new Set(['claude-code', 'warp', 'neuroskill']);

/** True for the local picker kinds (claude-code/warp/neuroskill) whose
 * LLM-triage and privacy flags are forced (spec §5.2; neuroskill R4/R5). */
export function isPickerKind(kind: FeedKind): boolean {
  return PICKER_KINDS.has(kind);
}

/** A saved, re-runnable import configuration. Machine-local (localStorage),
 * never the record repo — tokens stay in the keyring (spec §0.4–0.5). */
export interface Feed {
  /** Stable local id (e.g. crypto.randomUUID()). */
  id: string;
  /** Human label shown in the list. */
  label: string;
  kind: FeedKind;
  /** Disabled feeds are skipped by Refresh-all; still runnable individually. */
  enabled: boolean;
  /** Per-feed param snapshot. Shape per kind (spec §3): mirrors the matching
   * `ImportSettings[kind]` for live-API kinds; `{ roots }` / `{ dirs }` for the
   * picker kinds. */
  params: Record<string, unknown>;
  /** Per-feed project pre-assignment (slug, '' ⇒ none). Stored verbatim. */
  project: string;
  /** Stage candidates private (default true). Forced true for picker kinds. */
  private: boolean;
  /** Per-feed LLM-triage flag. Forced false for picker kinds; ignored when no
   * provider is ready. */
  useLlm: boolean;
  /** 'fixed' uses `params.since/until` verbatim; 'rolling' derives `since` from
   * `lastRunAt` (spec §3.4). Meaningful only for github/asana/shortcut. */
  window: 'fixed' | 'rolling';
  /** ISO timestamp of the last successful run; drives rolling windows. */
  lastRunAt?: string;
  /** Opt-in: run this feed on folder open (Phase 3). MUST default false. */
  runOnOpen: boolean;
}

/** One feed's outcome inside a Refresh-all run (spec §4.4.1). */
export interface FeedRunResult {
  id: string;
  label: string;
  kind: IngestSource;
  /** null ⇒ the run errored (see `error`). */
  report: IngestReport | null;
  error?: string;
}

/** The aggregate of a Refresh-all run (spec §4.4.1). */
export interface RefreshReport {
  startedAt: string;
  results: FeedRunResult[];
  totalFetched: number;
  totalStaged: number;
}

/**
 * Normalize a (possibly older / partial) persisted feed, filling every missing
 * field so older shapes load forward-compatibly (spec §4.1.1). Picker kinds get
 * their `private`/`useLlm` forced regardless of what was stored (spec §5.2), so
 * a stale or hand-edited payload can never weaken the chat-history posture.
 */
export function withFeedDefaults(partial: Partial<Feed>): Feed {
  const kind = (partial.kind ?? 'github') as FeedKind;
  const picker = isPickerKind(kind);
  return {
    id: partial.id ?? '',
    label: partial.label ?? '',
    kind,
    enabled: partial.enabled ?? true,
    params: partial.params ?? {},
    project: partial.project ?? '',
    private: picker ? true : (partial.private ?? true),
    useLlm: picker ? false : (partial.useLlm ?? false),
    window: partial.window ?? 'fixed',
    lastRunAt: partial.lastRunAt,
    runOnOpen: partial.runOnOpen ?? false
  };
}

/** Raw inputs captured from the import form when saving a feed (spec §4.2.4).
 * The state layer snapshots its runes into this; the shaping itself is pure. */
export interface FeedFormInput {
  id: string;
  label: string;
  kind: FeedKind;
  project: string;
  /** live-API param snapshot (github/asana/gmail) — mirrors `ImportSettings`. */
  liveParams?: Record<string, unknown>;
  /** claude-code: the sanitized-cwd root dir names. */
  roots?: string[];
  /** warp: the working_directory strings. */
  dirs?: string[];
  /** neuroskill: the NeuroSkill data directory (holds activity/labels.sqlite). */
  dataDir?: string;
  /** The github form's `importPrivate`; ignored for other kinds. */
  importPrivate?: boolean;
  /** `importSettings.triage.useLlm` at save time; ignored for picker kinds. */
  useLlm?: boolean;
}

/**
 * Shape a feed from a form snapshot (spec §4.2.4), routing the params into the
 * right per-kind shape and forcing the picker-kind flags via
 * {@link withFeedDefaults}. New feeds always start `window: 'fixed'`.
 */
export function buildFeed(input: FeedFormInput): Feed {
  const base: Partial<Feed> = {
    id: input.id,
    label: input.label,
    kind: input.kind,
    project: input.project,
    window: 'fixed'
  };
  if (input.kind === 'claude-code') {
    return withFeedDefaults({ ...base, params: { roots: input.roots ?? [] } });
  }
  if (input.kind === 'warp') {
    return withFeedDefaults({ ...base, params: { dirs: input.dirs ?? [] } });
  }
  if (input.kind === 'neuroskill') {
    return withFeedDefaults({ ...base, params: { dataDir: input.dataDir ?? '' } });
  }
  return withFeedDefaults({
    ...base,
    params: input.liveParams ?? {},
    private: input.kind === 'github' ? (input.importPrivate ?? true) : true,
    useLlm: input.useLlm ?? false
  });
}

/**
 * The effective live-API params for a run, applying the rolling-window `since`
 * derivation (spec §3.4):
 *  - github/asana/shortcut + `window: 'rolling'` + `lastRunAt` ⇒ `since` becomes
 *    `lastRunAt`'s date (YYYY-MM-DD), overriding `params.since`; `until` is left
 *    alone (same-day overlap is harmless — dedupe drops known items).
 *  - gmail ⇒ `window` is ignored; the freeform query owns the window.
 *  - claude-code/warp ⇒ params untouched (they always re-scan + dedupe).
 *
 * Returns a fresh clone — the stored feed params are never mutated.
 */
export function effectiveLiveParams(feed: Feed): Record<string, unknown> {
  const params = { ...(feed.params ?? {}) };
  if (
    (feed.kind === 'github' || feed.kind === 'asana' || feed.kind === 'shortcut') &&
    feed.window === 'rolling' &&
    feed.lastRunAt
  ) {
    params.since = feed.lastRunAt.slice(0, 10);
  }
  return params;
}

/** Sum the staged/fetched totals across the non-null reports (spec §4.4.1); a
 * feed whose run threw (`report: null`) contributes nothing to the totals. */
export function aggregateRefreshReport(startedAt: string, results: FeedRunResult[]): RefreshReport {
  let totalFetched = 0;
  let totalStaged = 0;
  for (const r of results) {
    if (r.report) {
      totalFetched += r.report.fetched;
      totalStaged += r.report.staged;
    }
  }
  return { startedAt, results, totalFetched, totalStaged };
}
