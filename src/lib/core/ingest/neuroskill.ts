/**
 * NeuroSkill adapter — **import-only** (neuroskill-ingest spec): turns one past
 * EEG session into one review candidate. Like the Warp / Claude Code adapters it
 * is a local, zero-auth, "what state was I in while working" source — brain-state
 * that never auto-promotes and never reaches a cloud LLM (spec R4/R5).
 *
 * A pure mapper in the Warp mould: it takes already-read SQLite rows (plain
 * objects the platform read layer pulled from NeuroSkill's `activity.sqlite` /
 * `labels.sqlite`) and returns `RawItem`s. It never opens the database, reads
 * disk, calls the network, calls an LLM, or reads the clock except through the
 * injected {@link DateParts} helper (spec R2). One session = one candidate; the
 * human's promote is the only commit gate (spec R3).
 *
 * SCHEMA COUPLING (spec R9): every NeuroSkill column/table name and JSON metric
 * key lives in THIS module (and its fixtures) and nowhere else — a NeuroSkill
 * version bump touches exactly one file.
 *
 * SECURITY STANCE (data, never instructions, spec R10): label `text`/`context`
 * are external content stored verbatim as *data*. They never reach an LLM in v1
 * (spec R4); any future pass MUST fence them with a do-not-follow guard
 * (ingest/types.ts security stance).
 */

import { asNum, type RawItem } from './types';

/** One `eeg_timeseries` row. `ts` is Unix epoch SECONDS; `metrics` is a JSON
 * object of scalar metrics (spec §2.1). */
export interface NeuroskillEpochRow {
  ts: number;
  metrics: string;
}

/** One `labels` row (the `*_embedding` BLOB columns are deliberately omitted —
 * spec §2.2). All time columns are Unix epoch seconds; `0` means "absent". */
export interface NeuroskillLabelRow {
  id?: number;
  text: string;
  context?: string;
  eeg_start?: number;
  eeg_end?: number;
  wall_start?: number;
  wall_end?: number;
  label_start?: number;
  label_end?: number;
}

/** A contiguous run of epochs (a recording session). Intermediate shape,
 * exported for tests (spec §3). */
export interface NeuroskillSession {
  startTs: number;
  endTs: number;
  epochs: NeuroskillEpochRow[];
}

export const NEUROSKILL_SOURCE = 'neuroskill' as const;
/** Gap (seconds) between consecutive epochs that starts a new session. */
export const NEUROSKILL_GAP_SECONDS = 120;
/** ~60 s peak-focus window (12 × ~5 s epochs). */
export const NEUROSKILL_PEAK_WINDOW_EPOCHS = 12;
/** The v1 rollup allowlist (spec R9). The only metric keys ever read; `channels`
 * and every other key are ignored. */
export const NEUROSKILL_METRIC_KEYS = [
  'focus',
  'engagement',
  'mood',
  'relaxation',
  'meditation',
  'cognitive_load',
  'drowsiness',
  'faa'
] as const;

/** Inject the date helper so the mapper stays deterministic + tz-testable
 * (spec R2, §4.6). All values are owner-local wall-clock. */
export type DateParts = (tsSeconds: number) => {
  date: string; // YYYY-MM-DD (owner-local)
  iso: string; // YYYY-MM-DDTHH:MM:SS (owner-local, no offset)
  hhmm: string; // HH:MM (owner-local)
};

/** Default owner-local date helper (host timezone), shared with the wiring
 * layer (spec §7). Deterministic given a `ts` + a pinned TZ — tests set
 * `process.env.TZ` before importing this module. */
export const defaultDateParts: DateParts = (tsSeconds) => {
  const d = new Date(tsSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const iso = `${date}T${hhmm}:${pad(d.getSeconds())}`;
  return { date, iso, hhmm };
};

/** Round to one decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Parse one epoch's `metrics` JSON into a flat object, never throwing — a
 * corrupt/unparseable `metrics` yields `{}` (an epoch with no scalars), which
 * never aborts the session (spec §4.2, mirrors Warp's `parseWarpQueryInput`).
 */
function parseMetrics(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Split epoch rows into sessions on a `> NEUROSKILL_GAP_SECONDS` gap (spec §4.1).
 * Rows are sorted ascending by `ts` first; contiguous ~5 s epochs stay one
 * session. Empty input → `[]`.
 */
export function segmentSessions(rows: NeuroskillEpochRow[]): NeuroskillSession[] {
  const ordered = [...rows].sort((a, b) => a.ts - b.ts);
  const sessions: NeuroskillSession[] = [];
  let current: NeuroskillEpochRow[] = [];
  for (const row of ordered) {
    const prev = current[current.length - 1];
    if (prev && row.ts - prev.ts > NEUROSKILL_GAP_SECONDS) {
      sessions.push({ startTs: current[0].ts, endTs: prev.ts, epochs: current });
      current = [];
    }
    current.push(row);
  }
  if (current.length) {
    sessions.push({ startTs: current[0].ts, endTs: current[current.length - 1].ts, epochs: current });
  }
  return sessions;
}

/** Mean of `focus` over a window, omitting epochs with no finite `focus`, or
 * undefined when none of them carry one. */
function windowMeanFocus(focusVals: (number | undefined)[], lo: number, hi: number): number | undefined {
  let sum = 0;
  let n = 0;
  for (let j = lo; j < hi; j++) {
    const v = focusVals[j];
    if (v !== undefined) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : undefined;
}

/** The peak-focus block (spec §4.4): the `NEUROSKILL_PEAK_WINDOW_EPOCHS`-epoch
 * window with the highest mean focus (ties → earliest); the whole session when
 * it has ≤ W epochs. Omitted when no epoch has a finite `focus`. */
function peakFocusBlock(
  epochs: NeuroskillEpochRow[],
  focusVals: (number | undefined)[]
): { value: number; startTs: number; endTs: number } | undefined {
  const n = epochs.length;
  const w = Math.min(NEUROSKILL_PEAK_WINDOW_EPOCHS, n);
  if (w === 0) return undefined;
  let bestStart = -1;
  let bestMean = -Infinity;
  for (let i = 0; i + w <= n; i++) {
    const m = windowMeanFocus(focusVals, i, i + w);
    if (m !== undefined && m > bestMean) {
      bestMean = m;
      bestStart = i;
    }
  }
  if (bestStart < 0) return undefined;
  return {
    value: round1(bestMean),
    startTs: epochs[bestStart].ts,
    endTs: epochs[bestStart + w - 1].ts
  };
}

/** Positive (present, non-zero) numbers only — `0` means "absent" (spec §2.2). */
function positives(...vals: (number | undefined)[]): number[] {
  return vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

/** A label's effective `[lo, hi]` window, or null when it has no usable
 * timestamp at all (spec §4.5). */
function labelWindow(label: NeuroskillLabelRow): { lo: number; hi: number } | null {
  const starts = positives(label.eeg_start, label.wall_start, label.label_start);
  if (starts.length === 0) return null;
  const lo = Math.min(...starts);
  const ends = positives(label.eeg_end, label.wall_end, label.label_end);
  const hi = ends.length ? Math.max(Math.max(...ends), lo) : lo;
  return { lo, hi };
}

/** One label's display text: `text`, with `— context` appended when context is
 * non-empty. Verbatim — calibration labels are NOT filtered (spec R9/R10). */
function labelDisplay(label: NeuroskillLabelRow): string {
  const text = (label.text ?? '').trim();
  const ctx = (label.context ?? '').trim();
  return ctx ? `${text} — ${ctx}` : text;
}

/** Overlapping labels for a session, in row/id order (spec §4.5). A label
 * overlaps when its `[lo, hi]` intersects `[startTs, endTs]`. */
function overlappingLabels(session: NeuroskillSession, labels: NeuroskillLabelRow[]): string[] {
  const out: string[] = [];
  for (const label of labels) {
    const win = labelWindow(label);
    if (!win) continue;
    if (win.lo <= session.endTs && win.hi >= session.startTs) out.push(labelDisplay(label));
  }
  return out;
}

/** Human display order for the metrics that appear in the body means line. */
const BODY_METRICS: readonly [string, string][] = [
  ['Focus', 'focus'],
  ['Engagement', 'engagement'],
  ['Mood', 'mood'],
  ['Relaxation', 'relaxation'],
  ['Cognitive load', 'cognitive_load']
];

/**
 * Map one session → its `RawItem` (spec §4.7). Returns `null` only for a
 * zero-epoch session (a guard — `segmentSessions` never yields one).
 */
export function mapNeuroskillSession(
  session: NeuroskillSession,
  labels: NeuroskillLabelRow[],
  dateParts: DateParts
): RawItem | null {
  const { epochs, startTs, endTs } = session;
  if (epochs.length === 0) return null;

  const epochCount = epochs.length;
  const durationMin = round1((endTs - startTs) / 60);
  const parsed = epochs.map((e) => parseMetrics(e.metrics));

  // Means over the allowlist only (spec §4.3): omit a key with no finite values.
  const means: Record<string, number> = {};
  for (const key of NEUROSKILL_METRIC_KEYS) {
    let sum = 0;
    let n = 0;
    for (const m of parsed) {
      const v = asNum(m[key]);
      if (v !== undefined) {
        sum += v;
        n++;
      }
    }
    if (n > 0) means[key] = round1(sum / n);
  }

  const focusVals = parsed.map((m) => asNum(m.focus));
  const peak = peakFocusBlock(epochs, focusVals);
  const labelTexts = overlappingLabels(session, labels);

  const start = dateParts(startTs);
  const end = dateParts(endTs);

  // Body — raw, un-polished; only lines whose data is present (spec §4.7).
  const lines: string[] = [`${durationMin} min tracked (${epochCount} epochs).`];
  const meanSegs = BODY_METRICS.filter(([, key]) => key in means).map(([label, key]) => `${label} ${means[key]}`);
  if (meanSegs.length) lines.push(`${meanSegs.join(' · ')} (means).`);
  if (peak) {
    lines.push(`Peak focus ${dateParts(peak.startTs).hhmm}–${dateParts(peak.endTs).hhmm} (mean focus ${peak.value}).`);
  }
  if (labelTexts.length) {
    lines.push(`Labels in window: ${labelTexts.map((t) => `"${t}"`).join(', ')}.`);
  }

  // Frontmatter — omit any whose source datum is absent (spec §4.7).
  const extra: Record<string, unknown> = {
    neuroskill_started_at: start.iso,
    neuroskill_ended_at: end.iso,
    neuroskill_duration_min: durationMin,
    neuroskill_epochs: epochCount
  };
  for (const key of NEUROSKILL_METRIC_KEYS) {
    if (key in means) extra[`neuroskill_mean_${key}`] = means[key];
  }
  if (peak) {
    extra.neuroskill_peak_focus = peak.value;
    extra.neuroskill_peak_focus_start = dateParts(peak.startTs).iso;
    extra.neuroskill_peak_focus_end = dateParts(peak.endTs).iso;
  }
  if (labelTexts.length) extra.neuroskill_labels = labelTexts;

  return {
    source: NEUROSKILL_SOURCE,
    sourceId: String(startTs),
    title: `Focus session — ${durationMin} min`,
    date: start.date,
    body: lines.join('\n'),
    suggestedType: 'journal',
    suggestedTags: ['neuroskill', 'session'],
    suggestedProject: undefined,
    extraFrontmatter: extra,
    meta: { duration_min: String(durationMin), epochs: String(epochCount) }
  };
}

/**
 * Map all epoch rows → many `RawItem`s, one per session (spec §4.8). Segments,
 * then maps each session in a try/catch — one bad session never aborts the
 * batch (mirrors `importWarpConversations`). Returns `RawItem[]`.
 */
export function importNeuroskillSessions(
  epochRows: NeuroskillEpochRow[],
  labelRows: NeuroskillLabelRow[],
  dateParts: DateParts = defaultDateParts
): RawItem[] {
  const items: RawItem[] = [];
  for (const session of segmentSessions(epochRows)) {
    try {
      const item = mapNeuroskillSession(session, labelRows, dateParts);
      if (item) items.push(item);
    } catch {
      // One bad session never aborts the import.
    }
  }
  return items;
}
