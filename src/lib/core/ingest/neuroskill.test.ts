import { describe, expect, it } from 'vitest';
import {
  segmentSessions,
  mapNeuroskillSession,
  importNeuroskillSessions,
  type DateParts,
  type NeuroskillEpochRow,
  type NeuroskillLabelRow
} from './neuroskill';
import { rawItemToEntryInput } from './pipeline';
import { prefilterItem } from '../triage/prefilter';
import { DEFAULT_RUBRIC } from '../triage/types';

/** A fixed, timezone-independent date helper (owner-local pinned to UTC) so the
 * asserted `date`/`iso`/`hhmm` are deterministic regardless of the host TZ
 * (spec §4.6 / §10). */
const utcParts: DateParts = (ts) => {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const iso = `${date}T${hhmm}:${pad(d.getUTCSeconds())}`;
  return { date, iso, hhmm };
};

function epoch(ts: number, metrics: Record<string, unknown>): NeuroskillEpochRow {
  return { ts, metrics: JSON.stringify(metrics) };
}

// 2026-05-24 18:50:00Z (spec §2.1 reference epoch).
const START_A = 1779648600;
const START_B = 1779649160; // gap of 200 s after session A's last epoch (>120 s)

// Constant non-focus metrics, plus ignored keys (`channels`, a flow correlate)
// to prove the allowlist (R9) is honored.
const BASE_A = {
  engagement: 50,
  mood: 60,
  relaxation: 40,
  meditation: 30,
  cognitive_load: 20,
  drowsiness: 10,
  faa: 0.5,
  channels: [1, 2, 3, 4],
  permutation_entropy: 99
};

/** Session A — 73 epochs at 5 s steps (6.0 min). First 12 epochs are high
 * focus (90), the rest low (10). The last epoch carries malformed `metrics`. */
const epochsA: NeuroskillEpochRow[] = [];
for (let i = 0; i < 73; i++) {
  const ts = START_A + i * 5;
  if (i === 72) {
    epochsA.push({ ts, metrics: '{' }); // malformed → skipped (§4.2)
    continue;
  }
  epochsA.push(epoch(ts, { focus: i < 12 ? 90 : 10, ...BASE_A }));
}

/** Session B — 13 epochs at 5 s steps (1.0 min calibration blip). */
const epochsB: NeuroskillEpochRow[] = [];
for (let i = 0; i < 13; i++) epochsB.push(epoch(START_B + i * 5, { focus: 50, engagement: 50 }));

const labels: NeuroskillLabelRow[] = [
  { id: 1, text: 'Eyes Open', context: '', eeg_start: START_A + 10, eeg_end: START_A + 20 },
  { id: 2, text: 'Way before', context: '', eeg_start: START_A - 5000, eeg_end: START_A - 4990 },
  // Point label (end == 0) inside session A — overlaps by `lo` only (§4.5).
  { id: 3, text: 'Eyes Closed', context: 'baseline', eeg_start: START_A + 30, eeg_end: 0 }
];

const allEpochs = [...epochsA, ...epochsB];

describe('segmentSessions', () => {
  it('splits on a >120 s gap and keeps contiguous 5 s epochs together', () => {
    const sessions = segmentSessions(allEpochs);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ startTs: START_A, endTs: START_A + 360 });
    expect(sessions[0].epochs).toHaveLength(73);
    expect(sessions[1]).toMatchObject({ startTs: START_B, endTs: START_B + 60 });
    expect(sessions[1].epochs).toHaveLength(13);
  });

  it('returns [] for empty input', () => {
    expect(segmentSessions([])).toEqual([]);
  });
});

describe('mapNeuroskillSession (session A)', () => {
  const items = importNeuroskillSessions(allEpochs, labels, utcParts);
  const itemA = items[0];

  it('produces one candidate per session', () => {
    expect(items).toHaveLength(2);
  });

  it('sets the source identity, taxonomy, date and title', () => {
    expect(itemA.source).toBe('neuroskill');
    expect(itemA.sourceId).toBe(String(START_A));
    expect(itemA.suggestedType).toBe('journal');
    expect(itemA.suggestedTags).toEqual(['neuroskill', 'session']);
    expect(itemA.suggestedProject).toBeUndefined();
    expect(itemA.date).toBe('2026-05-24');
    expect(itemA.title).toBe('Focus session — 6 min');
    expect(itemA.meta).toEqual({ duration_min: '6', epochs: '73' });
  });

  it('rolls up exact means over the allowlist only (ignoring the malformed epoch)', () => {
    const fm = itemA.extraFrontmatter!;
    expect(fm.neuroskill_duration_min).toBe(6);
    expect(fm.neuroskill_epochs).toBe(73);
    expect(fm.neuroskill_started_at).toBe('2026-05-24T18:50:00');
    expect(fm.neuroskill_ended_at).toBe('2026-05-24T18:56:00');
    // 12×90 + 60×10 = 1680, over 72 finite-focus epochs → 23.3.
    expect(fm.neuroskill_mean_focus).toBe(23.3);
    expect(fm.neuroskill_mean_engagement).toBe(50);
    expect(fm.neuroskill_mean_mood).toBe(60);
    expect(fm.neuroskill_mean_relaxation).toBe(40);
    expect(fm.neuroskill_mean_meditation).toBe(30);
    expect(fm.neuroskill_mean_cognitive_load).toBe(20);
    expect(fm.neuroskill_mean_drowsiness).toBe(10);
    expect(fm.neuroskill_mean_faa).toBe(0.5);
    // Allowlist only — never `channels` / flow correlates.
    expect(fm.neuroskill_mean_channels).toBeUndefined();
    expect(fm.neuroskill_mean_permutation_entropy).toBeUndefined();
  });

  it('reports the peak-focus window', () => {
    const fm = itemA.extraFrontmatter!;
    expect(fm.neuroskill_peak_focus).toBe(90);
    expect(fm.neuroskill_peak_focus_start).toBe('2026-05-24T18:50:00');
    expect(fm.neuroskill_peak_focus_end).toBe('2026-05-24T18:50:55');
  });

  it('attaches only the overlapping labels, in id order, context appended', () => {
    const fm = itemA.extraFrontmatter!;
    expect(fm.neuroskill_labels).toEqual(['Eyes Open', 'Eyes Closed — baseline']);
  });

  it('builds a raw, un-polished body', () => {
    expect(itemA.body).toBe(
      [
        '6 min tracked (73 epochs).',
        'Focus 23.3 · Engagement 50 · Mood 60 · Relaxation 40 · Cognitive load 20 (means).',
        'Peak focus 18:50–18:50 (mean focus 90).',
        'Labels in window: "Eyes Open", "Eyes Closed — baseline".'
      ].join('\n')
    );
  });

  it('feeds rawItemToEntryInput as a private, dated journal candidate', () => {
    const input = rawItemToEntryInput(itemA);
    expect(input.private).toBe(true);
    expect(input.type).toBe('journal');
    expect(input.date).toBe('2026-05-24'); // a real date — never defaulted to today
    expect(input.extra?.source).toBe('neuroskill');
    expect(input.extra?.source_id).toBe(String(START_A));
  });
});

describe('triage prefilter', () => {
  const items = importNeuroskillSessions(allEpochs, labels, utcParts);

  it('keeps a session ≥ the threshold and buries a calibration blip', () => {
    expect(prefilterItem(items[0], DEFAULT_RUBRIC).verdict).toBe('keep'); // 6 min
    expect(prefilterItem(items[1], DEFAULT_RUBRIC).verdict).toBe('frivolous'); // 1 min
  });

  it('keeps an item with no usable duration meta (never wrongly buried)', () => {
    const noMeta = { ...items[0], meta: {} };
    expect(prefilterItem(noMeta, DEFAULT_RUBRIC).verdict).toBe('keep');
  });
});

describe('importNeuroskillSessions robustness', () => {
  it('returns [] for empty input', () => {
    expect(importNeuroskillSessions([], [])).toEqual([]);
  });

  it('still maps an all-malformed-metrics session (means omitted), never throwing', () => {
    const malformed: NeuroskillEpochRow[] = [
      { ts: START_A, metrics: '{' },
      { ts: START_A + 5, metrics: 'not json' },
      { ts: START_A + 10, metrics: '[1,2,3]' }
    ];
    const items = importNeuroskillSessions(malformed, [], utcParts);
    expect(items).toHaveLength(1);
    const fm = items[0].extraFrontmatter!;
    expect(fm.neuroskill_mean_focus).toBeUndefined();
    expect(fm.neuroskill_peak_focus).toBeUndefined();
    expect(fm.neuroskill_labels).toBeUndefined();
    expect(items[0].body).toBe('0.2 min tracked (3 epochs).');
  });
});
