# whoami — NeuroSkill ingest adapter spec

**Status:** normative implementation contract for Claude Code. Locked decisions below are
final; do not relitigate them in code. Grounded in live reads (2026-06-19) of the whoami
source and the real NeuroSkill install at `C:\Users\jelan\AppData\Local\NeuroSkill`.

**One line:** NeuroSkill is a new **ingest source**. Its past EEG sessions become dated
**candidate journal entries** in the inbox — derived deterministically from
`activity.sqlite` via the existing read-only external-SQLite seam, reviewed and promoted
like any other import. Brain-state never auto-promotes and never reaches a cloud LLM.

---

## 0. Locked decisions

1. **Taxonomy:** a session imports as `type: journal` with `tags: ['neuroskill', 'session']`.
   **No new entry type, no taxonomy change.** (Matches the Warp / Claude Code adapters,
   which also use `suggestedType: 'journal'`.)
2. **Triage threshold:** sessions shorter than **5 minutes** are marked `frivolous` (catches
   calibration blips); ≥ 5 min are `keep`. Owner-editable via a new `neuroskillMinMinutes`
   rubric field (default `5`).
3. **Transport:** read-only SQLite through the existing `Platform.openDatabase` seam.
   All-SQLite (no WebSocket API). Reads `eeg_timeseries` from `activity.sqlite` and `labels`
   from `labels.sqlite`.
4. **Scope:** `eeg_timeseries` + `labels` **only**. Never read any other NeuroSkill table.
5. **Privacy:** forced `private: true` and **prefilter-only** (never sent to an LLM triage
   pass), exactly like the `claude-code` / `warp` picker kinds. Savable as a re-runnable feed.

---

## 1. Hard rules (prohibitions)

- **R1 — Read scope.** The adapter and its wiring read **only** `eeg_timeseries` (from
  `activity.sqlite`) and `labels` (from `labels.sqlite`). It MUST NOT read, query, or join
  `active_windows`, `input_activity`, `input_buckets`, `secondary_windows`, `terminal_*`,
  `browser_activities`, `clipboard_events`, `user_screenshot_events`, `file_*`,
  `meeting_events`, `conversations*`, `focus_sessions`, or any other table. *Rationale,
  verified live: those tables' population state changes as the owner toggles NeuroSkill
  tracking on/off (`active_windows` already holds 73 rows and `input_activity` 19,391 on
  this install, contradicting the older "all empty" note). Hard-scoping the read is what
  guarantees whoami's import is unaffected by those toggles.*
- **R2 — Pure mapper.** `src/lib/core/ingest/neuroskill.ts` is a pure, fixture-tested
  module: rows in → `RawItem[]` out. It MUST NOT open a database, touch disk, call the
  network, call an LLM, or read the clock except through the injected date helper (§4.6).
  All SQLite I/O happens in the wiring layer (§7), above the seam.
- **R3 — One session = one candidate.** Never split a session across candidates or merge
  sessions.
- **R4 — Stage 1 is deterministic.** No LLM anywhere in this feature. Forced prefilter-only.
- **R5 — Private by default, always.** Every candidate stages `private: true`. The feed kind
  is forced-private (§6); a stale or hand-edited feed payload can never weaken this.
- **R6 — Never default the date to today.** Every session has a real `ts`; the entry date is
  derived from it (§4.6). There is no `needs_date` path here.
- **R7 — Do not modify stable boundaries.** `rawItemToEntryInput`, `stageItems`,
  `selectNewItems` (pipeline.ts) and the `RawItem` shape (ingest/types.ts) are used **as-is**.
  The only edits to existing files are the additive ones enumerated in §8.
- **R8 — License / file boundary.** Access NeuroSkill **only** as a read-only SQLite file.
  Do not link, vendor, copy, or adapt any NeuroSkill (GPL-3.0) source. Reading another app's
  data file read-only is arm's-length — the same posture the Warp adapter already takes.
- **R9 — Schema coupling is isolated.** Every NeuroSkill column/table name and JSON metric
  key lives in `neuroskill.ts` (and its fixtures) and nowhere else, so a NeuroSkill version
  bump touches exactly one module.
- **R10 — Label text is DATA, never instructions.** Label `text`/`context` are external
  content stored verbatim. They are not interpreted. (They never reach an LLM in v1 — R4 —
  but if a future pass ever consumes them, they MUST be fenced with the same do-not-follow
  guard the other adapters use; ingest/types.ts security stance.)

---

## 2. Verified data model (NeuroSkill)

All facts below were confirmed by direct inspection of the live DBs on 2026-06-19.

### 2.1 `eeg_timeseries` (in `activity.sqlite`)
```sql
CREATE TABLE eeg_timeseries ( ts INTEGER PRIMARY KEY, metrics TEXT NOT NULL DEFAULT '{}' );
```
- `ts` is **Unix epoch seconds** (e.g. `1779648605` = 2026-05-24 18:50:05Z). Confirmed:
  the install spans 2026-05-24 … 2026-06-17.
- One row per **~5-second epoch** (994 of 1012 gaps are exactly 5 s; a few are 6 s).
- `metrics` is a JSON object. Verified scalar keys present on every row include:
  `focus`, `engagement`, `mood`, `relaxation`, `meditation`, `cognitive_load`,
  `drowsiness`, `faa` (plus ~35 more, and a `channels` array of 4 — **ignored**, R9).
- Live data segments into **7 sessions** with a 120 s gap rule (durations 29.4, 12.5, 1.1,
  14.7, 10.3, 7.3, 8.8 min). The 1.1-min one is a calibration blip — the case the 5-min
  threshold catches.
- **WAL note (no action needed):** the seam opens the file `immutable=1`, which reads the
  main DB and ignores the live `-wal`. Verified: all 1012 epochs are in the main file
  (the large WAL is the high-frequency input/window tables, never EEG). Accepted edge: a
  session being *actively recorded* at import time may have trailing epochs still in the WAL
  and thus appear truncated; whoami imports completed history and dedupes on re-import, so
  this self-heals. Optional hardening in §4.7 (recency cooldown).

### 2.2 `labels` (in `labels.sqlite`)
```sql
CREATE TABLE labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, context TEXT DEFAULT '',
  eeg_start INTEGER NOT NULL DEFAULT 0, eeg_end INTEGER NOT NULL DEFAULT 0,
  wall_start INTEGER NOT NULL DEFAULT 0, wall_end INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  text_embedding BLOB, context_embedding BLOB, embedding_model TEXT,
  label_start INTEGER NOT NULL DEFAULT 0, label_end INTEGER NOT NULL DEFAULT 0 );
```
- All time columns are **Unix epoch seconds**, same clock as `eeg_timeseries.ts` (verified:
  label `eeg_start`s fall inside session 1's `ts` range).
- Live rows: 6, all calibration ("Eyes Open" / "Eyes Closed"), all inside session 1.
  `eeg_start..eeg_end` is a ~10 s window; `wall_*` and `label_*` are points
  (`start == end`). `0` means "absent".
- **Today there is no narrative label.** Every session imports as state-without-narrative;
  session 1 additionally carries the calibration label texts. This is acceptable for a raw
  record (see §4.5 — we do **not** hardcode a calibration filter, R9/R10).
- **Ignore** the `*_embedding` BLOB columns.

---

## 3. New module: `src/lib/core/ingest/neuroskill.ts`

Public surface (all pure):

```ts
export interface NeuroskillEpochRow { ts: number; metrics: string; }      // one eeg_timeseries row
export interface NeuroskillLabelRow {                                     // one labels row (BLOBs omitted)
  id?: number; text: string; context?: string;
  eeg_start?: number; eeg_end?: number;
  wall_start?: number; wall_end?: number;
  label_start?: number; label_end?: number;
}

export interface NeuroskillSession {        // intermediate (exported for tests)
  startTs: number; endTs: number;
  epochs: NeuroskillEpochRow[];
}

export const NEUROSKILL_SOURCE = 'neuroskill' as const;
export const NEUROSKILL_GAP_SECONDS = 120;        // session boundary
export const NEUROSKILL_PEAK_WINDOW_EPOCHS = 12;  // ~60 s peak-focus window
export const NEUROSKILL_METRIC_KEYS = [           // the v1 rollup allowlist (R9)
  'focus','engagement','mood','relaxation','meditation','cognitive_load','drowsiness','faa'
] as const;

/** Inject the date helper so the mapper stays deterministic + tz-testable (R2, §4.6). */
export type DateParts = (tsSeconds: number) => {
  date: string;      // YYYY-MM-DD (owner-local)
  iso: string;       // YYYY-MM-DDTHH:MM:SS (owner-local, no offset)
  hhmm: string;      // HH:MM (owner-local)
};

export function segmentSessions(rows: NeuroskillEpochRow[]): NeuroskillSession[];
export function mapNeuroskillSession(
  session: NeuroskillSession, labels: NeuroskillLabelRow[], dateParts: DateParts
): RawItem | null;
export function importNeuroskillSessions(
  epochRows: NeuroskillEpochRow[], labelRows: NeuroskillLabelRow[], dateParts?: DateParts
): RawItem[];
```

---

## 4. The algorithm

### 4.1 Session segmentation — `segmentSessions`
Sort `rows` ascending by `ts`. Walk: when `ts[i] - ts[i-1] > NEUROSKILL_GAP_SECONDS`, start a
new session. Each session is `{ startTs: first ts, endTs: last ts, epochs: [...] }`. Empty
input → `[]`.

### 4.2 Per-epoch metric parse
For each epoch, `JSON.parse(metrics)` inside a try/catch. **A corrupt/unparseable `metrics`
yields an epoch with no scalars — never throws and never aborts the session** (mirrors
Warp's `parseWarpQueryInput` robustness).

### 4.3 Means — over `NEUROSKILL_METRIC_KEYS` only
For each allowlisted key, mean over the epochs where the value is a finite number (use the
`asNum` helper from ingest/types.ts). Round to 1 decimal. **Omit a key entirely** if no epoch
carried a finite value for it. Do not read any key outside the allowlist; do not read
`channels`.

### 4.4 Peak-focus block
Let `W = NEUROSKILL_PEAK_WINDOW_EPOCHS`. If the session has ≤ W epochs, the peak block is the
whole session. Otherwise slide a window of `W` consecutive epochs and pick the window with the
highest mean `focus` (ties → earliest window). Report `{ value: meanFocus(1dp),
startTs: window first ts, endTs: window last ts }`. If no epoch has a finite `focus`, omit the
peak block.

### 4.5 Overlapping labels
A label overlaps a session when its window `[lo, hi]` intersects `[startTs, endTs]`, where:
- `lo = min of the present, non-zero values among (eeg_start, wall_start, label_start)`;
- `hi = max of the present, non-zero values among (eeg_end, wall_end, label_end)`, clamped to
  `hi >= lo`; if no end value is present/non-zero, `hi = lo` (treat as a point).
- A label with no usable timestamp at all is skipped.

Collect each overlapping label's `text` (and `— context` appended when `context` is non-empty)
into `neuroskill_labels: string[]`, in label `id`/row order. **Pass through verbatim**; do
**not** filter calibration labels (R9/R10). (Consequence on today's data: session 1 carries
the "Eyes Open"/"Eyes Closed" texts; review handles it.)

### 4.6 Date / time derivation (the one timezone-sensitive point)
The mapper takes an injected `dateParts(ts)` (default in §7) returning owner-local
`date` (YYYY-MM-DD), `iso` (YYYY-MM-DDTHH:MM:SS), and `hhmm` (HH:MM). **All displayed
clock values are owner-local wall-clock** (a 2:30pm session reads as 14:30, not UTC).
*Tests MUST pin the timezone* (e.g. set `process.env.TZ` before importing) so fixtures are
deterministic. `RawItem.date` = `dateParts(startTs).date`. There is no `needs_date` path.

### 4.7 `mapNeuroskillSession` → `RawItem`
```
duration_min = round((endTs - startTs) / 60, 1)
source        = 'neuroskill'
sourceId      = String(startTs)        // stable dedupe identity (source, source_id)
date          = dateParts(startTs).date
suggestedType = 'journal'
suggestedTags = ['neuroskill', 'session']
suggestedProject = undefined            // no project inference (focus_sessions.project is empty/unused)
```
**Title:** `Focus session — {duration_min} min` (e.g. `Focus session — 14.7 min`). If there is
exactly one overlapping non-calibration-looking label you may append `: "{label text, ≤60 chars}"`
— but this is optional; the plain duration title is the required default.

**Body** (raw, un-polished; only include lines whose data is present):
```
{duration_min} min tracked ({epochCount} epochs).
Focus {f} · Engagement {e} · Mood {m} · Relaxation {r} · Cognitive load {c} (means).
Peak focus {hhmm(peak.startTs)}–{hhmm(peak.endTs)} (mean focus {peak.value}).
Labels in window: "{label1}", "{label2}".
```

**`extraFrontmatter`** (omit any whose source datum is absent):
```
neuroskill_started_at:  dateParts(startTs).iso
neuroskill_ended_at:    dateParts(endTs).iso
neuroskill_duration_min: number
neuroskill_epochs:       number
neuroskill_mean_focus / _engagement / _mood / _relaxation / _meditation /
  _cognitive_load / _drowsiness / _faa:  number   // only the keys that had data
neuroskill_peak_focus:        number               // peak.value
neuroskill_peak_focus_start:  string               // dateParts(peak.startTs).iso
neuroskill_peak_focus_end:    string
neuroskill_labels:            string[]             // only when non-empty
```

**`meta`** (string-valued, for the prefilter — §5):
```
{ duration_min: String(duration_min), epochs: String(epochCount) }
```

Return `null` only if the session has **zero** epochs (it never will from `segmentSessions`,
but guard anyway).

**Optional hardening (recency cooldown):** `importNeuroskillSessions` MAY accept a `nowTs`
and skip a session whose `endTs` is within ~120 s of `nowTs` (an in-progress recording). Not
required — dedupe-on-re-import already self-heals (§2.1 WAL note). If implemented, default
off / cooldown 0 so fixture tests are unaffected.

### 4.8 `importNeuroskillSessions`
`segmentSessions(epochRows)` → for each session, `mapNeuroskillSession(...)` in a try/catch;
push non-null results; **one bad session never aborts the batch** (mirrors
`importWarpConversations`). Returns `RawItem[]`.

---

## 5. Triage prefilter

### 5.1 Rubric field (`src/lib/core/triage/types.ts`)
Add to `TriageRubric`:
```ts
/** NeuroSkill: minimum session length (minutes) to count as `keep`; shorter →
 *  `frivolous` (calibration blips). Owner-editable; persists in importSettings. */
neuroskillMinMinutes: number;
```
Add to `DEFAULT_RUBRIC`: `neuroskillMinMinutes: 5`.

### 5.2 `prefilterNeuroskill` (`src/lib/core/triage/prefilter.ts`)
```ts
function prefilterNeuroskill(item: RawItem, rubric: TriageRubric): PrefilterOutcome {
  const min = Number.isFinite(rubric.neuroskillMinMinutes) ? rubric.neuroskillMinMinutes : 5;
  const mins = Number(item.meta?.duration_min);
  if (Number.isFinite(mins) && mins < min) return frivolous('short session (calibration/blip)');
  return keep('tracked focus session');
}
```
Wire a `case 'neuroskill': return prefilterNeuroskill(item, rubric);` into `prefilterItem`.

### 5.3 Forced prefilter-only
NeuroSkill candidates MUST NOT be sent to the optional LLM triage pass (R4/R5). This is
enforced by the picker-kind treatment in §6 (`useLlm` forced `false`); do not special-case it
in the LLM pass itself.

---

## 6. Feeds (`src/lib/core/feeds.ts`)

- Add `'neuroskill'` to the `FeedKind` union.
- Add `'neuroskill'` to `PICKER_KINDS` → `withFeedDefaults` then forces `private: true` and
  `useLlm: false` for it automatically (R5/R4). Confirm `withFeedDefaults` needs no other change.
- `buildFeed`: add a branch
  ```ts
  if (input.kind === 'neuroskill') {
    return withFeedDefaults({ ...base, params: { dataDir: input.dataDir ?? '' } });
  }
  ```
  and add an optional `dataDir?: string` to `FeedFormInput`.
- `params` shape for a neuroskill feed: `{ dataDir: string }` — the NeuroSkill **data
  directory** (the folder containing `activity.sqlite` + `labels.sqlite`). **Never hardcode
  it** (§7). On this environment the value is the WSL2 path
  `/mnt/c/Users/jelan/AppData/Local/NeuroSkill`.
- `effectiveLiveParams`: neuroskill is neither github nor asana, so params pass through
  untouched — correct. It always re-scans and dedupes (like the picker kinds); no rolling
  window. New sessions get new `startTs` → new `sourceId` → fresh; promoted/rejected sessions
  are skipped by `selectNewItems` / `stageItems`.

---

## 7. Wiring (state layer — `src/lib/state.svelte.ts`)

All SQLite I/O lives here, above the `openDatabase` seam (R2). **Read the existing Warp import
path in `state.svelte.ts` first and mirror its structure** (token-less variant). The neuroskill
run is:

1. Resolve `dataDir` from the feed `params.dataDir` (or the import-form field). Guard: if
   `platform.openDatabase` is absent, disable the import with a clear "external database access
   not available on this platform" message.
2. `activityPath = platform.joinPath(dataDir, 'activity.sqlite')`,
   `labelsPath = platform.joinPath(dataDir, 'labels.sqlite')`.
3. Open each read-only and run exactly one query each, then `close()` each (the seam opens
   `?mode=ro&immutable=1`, so the live NeuroSkill daemon's locks are never touched):
   ```sql
   -- activity.sqlite
   SELECT ts, metrics FROM eeg_timeseries ORDER BY ts;
   -- labels.sqlite
   SELECT id, text, context, eeg_start, eeg_end, wall_start, wall_end, label_start, label_end
   FROM labels;
   ```
   These two SELECTs are the **only** statements run against NeuroSkill (R1). If `labels.sqlite`
   is missing/unopenable, proceed with `labelRows = []` (labels are enrichment, not required).
4. `const items = importNeuroskillSessions(epochRows, labelRows);` (the wiring supplies the
   default `dateParts` — see below).
5. `const fresh = await selectNewItems(store, items);`
6. Prefilter each fresh item (always-on; **no LLM pass**, R4) → build the `signals` map keyed
   by `provenanceKey('neuroskill', sourceId)`.
7. `await stageItems(store, items, { signals, private: true, project: feed.project || undefined });`
   — `private: true` is explicit even though the pipeline default already is true.

**Default `dateParts`** (wiring-supplied, owner-local): build from a `Date`:
```ts
const d = new Date(tsSeconds * 1000);
const pad = (n: number) => String(n).padStart(2, '0');
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const iso  = `${date}T${hhmm}:${pad(d.getSeconds())}`;
```
(Uses the host local timezone — the owner's clock. The mapper is pure; this impurity is
confined to the wiring + the injected helper.)

---

## 8. Exhaustive list of file changes

**New files**
- `src/lib/core/ingest/neuroskill.ts` (§3–§4)
- `src/lib/core/ingest/neuroskill.test.ts` (§10)

**Edited (additive only)**
- `src/lib/core/ingest/types.ts` — add `'neuroskill'` to the `IngestSource` union.
- `src/lib/core/ingest/index.ts` — re-export `NEUROSKILL_SOURCE`, `segmentSessions`,
  `mapNeuroskillSession`, `importNeuroskillSessions`, and the new types.
- `src/lib/core/triage/types.ts` — add `neuroskillMinMinutes` to `TriageRubric` + `DEFAULT_RUBRIC`.
- `src/lib/core/triage/prefilter.ts` — add `prefilterNeuroskill` + the `case 'neuroskill'`.
- `src/lib/core/feeds.ts` — `FeedKind`, `PICKER_KINDS`, `buildFeed`, `FeedFormInput.dataDir`.
- `src/lib/state.svelte.ts` — the import run (§7) + a `dataDir` import-form field/UI, mirroring
  the Warp import affordance.
- Import-form / feed UI component(s) (wherever the Warp/Claude-Code picker UI lives) — a
  NeuroSkill option with a data-directory input.

**Explicitly NOT changed**
- `src/lib/core/types.ts` (`Platform.openDatabase` already exists and suffices).
- `src/lib/platform-tauri.ts` (`openExternalReadOnly` already does `?mode=ro&immutable=1`).
- `src/lib/core/ingest/pipeline.ts` (`rawItemToEntryInput`, `stageItems`, `selectNewItems`
  used as-is — R7).

---

## 9. Phases & acceptance criteria

**Phase 1 — pure mapper + types (off-device, no Tauri).**
- [ ] `segmentSessions` splits on a >120 s gap; contiguous 5 s epochs stay one session.
- [ ] `mapNeuroskillSession` produces a `RawItem` with `source:'neuroskill'`,
      `sourceId === String(startTs)`, `suggestedType:'journal'`,
      `suggestedTags:['neuroskill','session']`, correct `date`, means over the allowlist only,
      a peak-focus block, and overlapping label texts.
- [ ] Corrupt `metrics` in one epoch is skipped, not thrown; means ignore it.
- [ ] `importNeuroskillSessions([], [])` → `[]`; one bad session never aborts the batch.
- [ ] `'neuroskill'` is in `IngestSource` and exported from `index.ts`.

**Phase 2 — triage.**
- [ ] `neuroskillMinMinutes` defaults to 5; a 1.1-min session → `frivolous`, a 14.7-min →
      `keep`; an item with no/garbled `meta.duration_min` → `keep` (never wrongly buried).
- [ ] `prefilterItem` routes `'neuroskill'` to `prefilterNeuroskill`.

**Phase 3 — wiring.**
- [ ] With `openDatabase` absent, the import is disabled with a clear message (no throw).
- [ ] A run opens both DBs read-only, runs exactly the two SELECTs in §7, closes both, stages
      candidates `private:true`, and folds the prefilter signal onto each.
- [ ] Re-running stages nothing new (idempotent); promoting then re-running skips the promoted
      session; rejecting then re-running skips the rejected one.
- [ ] No statement is ever issued against any table other than `eeg_timeseries` / `labels` (R1).

**Phase 4 — feed + UI.**
- [ ] A neuroskill feed is forced `private:true`, `useLlm:false`, stores `{ dataDir }`, and
      participates in Refresh-all; `dataDir` is configurable, never hardcoded.

---

## 10. Fixtures & test cases (`neuroskill.test.ts`)

Build fixtures from the **real shapes** above (seconds-epoch `ts`, JSON `metrics`). Pin the
timezone at the top of the test (e.g. `process.env.TZ = 'UTC'`) so `date`/`hhmm` are
deterministic, and pass a fixed `dateParts` or rely on the pinned TZ.

Minimum fixture set:
- **Two sessions** separated by a >120 s gap: session A ~6 min (≥ threshold), session B ~1 min
  (calibration blip). Each with several 5 s epochs of JSON `metrics` carrying the allowlist keys
  with known values (so the asserted means are exact).
- One epoch in session A with **malformed `metrics`** (`'{'`) → skipped by §4.2.
- **Labels:** one whose window overlaps session A (asserted attached), one entirely outside both
  (asserted absent), one with `end == 0` (point label, overlap by `lo` only).

Assertions:
1. `segmentSessions` → 2 sessions with the expected `startTs`/`endTs`/epoch counts.
2. Session A `RawItem`: exact means (1 dp), peak block window + value, `duration_min`, title,
   `sourceId === String(A.startTs)`, tags, `date`.
3. Session A `neuroskill_labels` contains only the overlapping label's text (with context
   appended when present); the non-overlapping label is absent.
4. Session B prefilters to `frivolous` at the default 5-min threshold; session A → `keep`.
5. `rawItemToEntryInput(itemA)` (used unchanged) yields `private:true`, `type:'journal'`,
   `source/source_id` provenance, the real `date` (no default-to-today).
6. Empty input → `[]`; an all-malformed-`metrics` session still returns an item (means just
   omitted) and never throws.

---

## 11. Non-goals & accepted limitations

- **Not an accomplishment source.** EEG is *state while doing*, not *what was done*. Most
  sessions are context, not headline entries — that is why the threshold + triage exist. Don't
  over-import.
- **No `focus_sessions` / project attribution.** That table is empty and file-tracking-dependent
  (R1); the adapter sets no `suggestedProject`.
- **No backfill of meaning.** Pre-labeling history (and today's calibration-only labels) imports
  as state-without-narrative — fine for the raw record.
- **Win evidence (no code).** A promoted neuroskill session can *corroborate* a win through the
  existing citation-gated win flow ("shipped X during a sustained high-focus block"); it never
  *makes* a win. No special handling here.
- **iroh / dormant LLM.** Read-only file access is arm's-length and unaffected. If "fully local"
  needs proving, confirm separately in the NeuroSkill repo — out of scope here.
- **WAL recency edge** (§2.1) — accepted; dedupe-on-re-import self-heals; optional cooldown
  (§4.7) if desired.

---

## 12. Open items for Jelani (none block Phase 1)

1. **`dataDir` UX:** a free-text path field, or a directory picker? (Either works; picker is
   nicer but the path is stable, so text is fine for v1.)
2. **Title-from-label:** keep the plain `Focus session — N min` title always, or opt into the
   optional `: "label"` suffix (§4.7)? Default in this spec is plain.
3. **Secondary metrics tier:** v1 rolls up 8 headline metrics. Want the "flow correlates"
   (`permutation_entropy`, `pac_theta_gamma`, `higuchi_fd`) carried in `extraFrontmatter` as a
   second tier later? (Trivial one-line extension to the allowlist when wanted.)
