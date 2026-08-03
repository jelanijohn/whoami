# Ticket Grouping & Merge-at-Promote — Implementation Spec

**Status:** Locked. Decisions D1–D5 confirmed by owner (2026-07-02).
**Stage:** Stage 1 (fully deterministic — no LLM anywhere in this feature).
**Problem:** Repeated small commits/PRs against one Shortcut ticket (e.g. 15 × "sc-57886 promo banner disclaimer") flood the inbox and, if promoted individually, pad the record with near-identical entries. The natural unit of work is the ticket; the ingest unit is the commit. This feature re-chunks at the review gate.

Two coupled deliverables:

1. **Ticket grouping** — a new inbox `GroupBy` mode that clusters candidates by Shortcut ticket (primary) or normalized title (fallback).
2. **Merge-at-promote** — a promote-gate action that collapses N selected same-source candidates into ONE record entry carrying multi-row provenance, so re-imports still skip every constituent.

---

## 0. Locked decisions

| # | Decision |
|---|----------|
| D1 | Grouping key: `shortcut` ticket id primary; normalized-title fallback for ticketless candidates. Fallback groups are visibly marked as heuristic suggestions; they never auto-include anything in a merge — merge is always an explicit human selection. |
| D2 | Merged entry keeps the scalar `source_id` (= primary constituent) for back-compat with every existing reader, and adds `source_ids: string[]` as the full set. Both project into the provenance table. |
| D3 | "Reject group" appends **every** constituent's `(source, source_id)` to `rejected.tsv` so no member is ever re-proposed. |
| D4 | Merge is a **promote-gate action only**: candidates in → one record entry out → candidate files deleted. Already-promoted entries are NEVER merged or mutated by this feature. |
| D5 | Verbatim commit `messageBody` text is included per constituent, **deduplicated**: byte-identical (after trim) message bodies collapse to a single block listing the short SHAs that carried it. Empty bodies are omitted entirely. |

---

## 1. New module: `src/lib/core/merge.ts` (pure)

All merge logic is pure functions (the adapter/mapper idiom — data in, data out, fixture-tested). The store method (§3) is a thin impure shell around them.

### 1.1 `ticketOf(c: Entry): string`

The grouping accessor (lives in `src/lib/inbox/grouping.ts` alongside `sourceOf`/`projectOf`, but specified here for locality):

1. If `frontmatter.shortcut_ids` is a non-empty string array → its first element.
2. Else if `frontmatter.shortcut` is an object with a string `id` → that id.
3. Else `''`.

Returns the bare numeric id (no `sc-` prefix) — matching `extractShortcutRefs` output.

### 1.2 `normalizedTitleKey(title: string, refPattern?: string): string`

The D1 fallback key. Pure:

1. Lowercase.
2. Strip every Shortcut ref using the same word-bounded compilation as `extractShortcutRefs` (default `DEFAULT_SHORTCUT_REF`; an invalid override yields no stripping, never throws — mirror the existing `try/catch` guard).
3. Replace every run of non-alphanumeric characters with a single space; trim.
4. Return `''` if what remains is empty (a title that was *only* a ticket ref falls back to nothing — such candidates group by their ticket anyway).

Example: `"Sc 57886 add discliamer to promo banner"` → `"add discliamer to promo banner"` (note: no spell-correction — brutal accuracy extends to typos).

### 1.3 `buildMergedEntry(candidates: Entry[], overrides: MergeOverrides): Entry`

The heart of the feature. Pure — given parsed candidate entries and the human's gate overrides, returns the fully-formed merged entry (fresh ULID via `makeEntry`; the merged entry is a new artifact, no constituent's stage-time ULID survives).

```ts
export interface MergeOverrides {
  /** Final title. Required — the UI seeds it from mergedTitleDefault (§1.4). */
  title: string;
  /** YYYY-MM-DD. Optional; when absent the merged date is the max valid
   * constituent date. At least one of (override, ≥1 valid constituent date)
   * must exist or the build THROWS — the promote date gate holds (never
   * defaults to today). */
  date?: string;
  /** Same semantics as PromoteOverrides.project / .parent / .tags. */
  project?: string;
  parent?: string;
  tags?: string[];
}
```

**Validation (throw on violation, before any construction):**

- `candidates.length >= 2`.
- Every candidate has the same `frontmatter.source` (this release: must be `'github'`; the check is `source === candidates[0].source && source === 'github'` so relaxing later is one line).
- Every candidate has a non-empty `source_id`.
- Date gate as documented above; `overrides.date`, when present, must match `/^\d{4}-\d{2}-\d{2}$/` (same regex as `promoteCandidate`).

**Ordering:** constituents are processed in ascending date order (undated last, then by `source_id` for a stable tie-break). "Primary" = the first in this order.

**Frontmatter of the merged entry:**

| Key | Value |
|---|---|
| `id` / `created` / `updated` | fresh, via `makeEntry` |
| `type` | `'journal'` |
| `title` | `overrides.title` (trimmed; throw if empty) |
| `date` | `overrides.date` else max valid constituent date |
| `private` | `true` if ANY constituent is private (most-protective fold) |
| `reviewed` | `true` |
| `tags` | union of all constituent tags ∪ `overrides.tags`, deduped, first-seen order |
| `source` | `'github'` |
| `source_id` | primary's `source_id` (D2 scalar) |
| `source_ids` | every constituent's `source_id`, in constituent order, **including** the primary (D2 array = the full set) |
| `source_url` | primary's `source_url` if present |
| `links` | union of every constituent's `source_url`, deduped, constituent order |
| `project` | `overrides.project` semantics identical to `PromoteOverrides` (empty string clears; `undefined` → the modal candidates' shared suggestion if all agree, else unset) |
| `parent` | `overrides.parent` if non-empty |
| `shortcut_ids` | union of every constituent's `shortcut_ids`, deduped, first-seen order (omit if empty) |
| `shortcut` | the first constituent's `shortcut` object, verbatim, if any constituent carries one (omit otherwise) |
| `change_size` | element-wise SUM of every constituent's `change_size` (`additions`, `deletions`, `changed_files`); omit if no constituent carries one |
| `merged_count` | `candidates.length` (an honest fact: this entry summarizes N ingested items) |
| triage keys | **never carried** — strip all `TRIAGE_KEYS`, same as `promoteCandidate` |
| `needs_date` | never carried (the gate above guarantees a valid date) |

No other constituent frontmatter keys are carried. In particular, per-constituent `merged_at` / `commit_sha` are NOT hoisted — the per-item facts live in the body ledger.

**Body of the merged entry, in order:**

1. **Header line:** `Merged from {N} GitHub {commits|PRs/issues|items} in {repo}.` — repo taken from the ledger source when all constituents agree; `across {k} repos` phrasing when they don't. Item kind: `commits` when every constituent's body matches `/^GitHub commit in /m`, `PRs/issues` when none do, `items` mixed.
2. **Ledger** — one line per constituent, ascending date order:
   `- {date or '—'} · {shortSourceId} · {constituent title} · +{a} −{d}`
   where `shortSourceId` is the first 7 chars for a 40-hex-char SHA, else the full id (issue/PR databaseIds are short already); the `+a −d` segment is omitted when the constituent has no `change_size`. These are our own computed facts (the commit-mapper idiom).
3. **Deduplicated messages (D5)** — for each distinct non-empty trimmed `--- Message ---` / `--- Description ---` block text found across constituents (extract everything after the first such delimiter up to any `--- Shortcut ---` block), in first-seen constituent order:
   `--- Message ({sha1}, {sha2}, …) ---` followed by the verbatim text. Short ids in the parens. Byte-identical texts collapse to one block; distinct texts each get their own.
4. **One `--- Shortcut ---` block** — if any constituent carries one, take the first constituent's block verbatim (they are all built by `shortcutEnrichment` from the same story, so any is representative). Strip constituent blocks via `stripShortcutBlock` before message extraction in step 3 so no Shortcut text leaks into a "message". Exactly zero or one Shortcut block in the output, always last — preserving the `stripShortcutBlock` invariant for future re-enrichment.

### 1.4 `mergedTitleDefault(candidates: Entry[]): string`

The UI seed for `overrides.title`. Pure. Precedence:

1. If any constituent's body contains a `--- Shortcut ---` block, parse the story name from its header line — the line format is OURS (`shortcutEnrichment`): `sc-{id}( ({qualifiers}))?: {name}`. Regex: `/^sc-\d+(?:\s*\([^)]*\))?:\s*(.+)$/m` applied to the text following the block delimiter. Return `sc-{id}: {name}` on match.
2. Else the most frequent `normalizedTitleKey` among constituents, rendered from the first constituent carrying it (its original casing/wording, ticket ref and all).
3. Else the primary's title.

Never returns `''` given valid constituents (validation guarantees titles exist).

---

## 2. Provenance projection: `src/lib/core/index-db.ts`

In `upsertEntry`, immediately after the existing scalar provenance insert, add the array projection:

```ts
const srcIds = Array.isArray(fm.source_ids)
  ? (fm.source_ids as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '')
  : [];
if (src) {
  for (const sid of srcIds) {
    await db.execute(
      `INSERT OR IGNORE INTO provenance (entry_id, source, source_id) VALUES (?, ?, ?)`,
      [fm.id, src, sid]
    );
  }
}
```

Notes:

- **No schema change.** The `provenance` table already keys `(entry_id, source, source_id)` with `UNIQUE (source, source_id)` — it was built for this. `SCHEMA_VERSION` stays `2`.
- `OR IGNORE` keeps the existing conflict stance (first indexed entry keeps a contested claim) and makes the scalar/array overlap (the primary appears in both) a silent no-op.
- Because `sourceIds()` and `findBySource()` already read this table, `categorize()` in `pipeline.ts` and `selectNewItems()` skip every constituent SHA on the next import **with zero changes to pipeline.ts**. Do not touch `pipeline.ts`, `stageItems`, or `rawItemToEntryInput`.
- Rebuild path: `rebuild`/`reindexFile` flow through `upsertEntry`, so a full index rebuild reconstructs the multi-row provenance from the text files — the derived-cache invariant holds.

---

## 3. Store method: `RecordStore.promoteMerged`

`src/lib/core/record.ts`, alongside `promoteCandidate`:

```ts
async promoteMerged(candidatePaths: string[], overrides: MergeOverrides): Promise<Entry>
```

Behavior (the standard write order — text first, then index):

1. Read every candidate via `readEntryFile` (byte-exact from disk). Any unreadable path throws — nothing has been written yet.
2. `const merged = buildMergedEntry(candidates, overrides)` — all validation throws happen here, before any filesystem effect.
3. Write the merged entry to its canonical `entries/` path (`expectedPath`), via `writeEntryFile`.
4. Delete every constituent candidate file.
5. `reindexFile` the ONE new path.
6. Return the merged entry.

Failure stance: steps 1–2 are effect-free. If a candidate-file delete in step 4 fails after step 3 succeeded, the leftover candidate is harmless — its `(source, source_id)` is now in provenance, so the pipeline's `skippedPromoted` path retires it on the next dedupe pass, and a manual reject also works. Do not attempt rollback of the written entry.

**Group reject (D3)** requires no new store code: the existing `rejectCandidate` per path (already looped by the state layer's bulk `rejectCandidates`) appends each constituent's provenance row. Verify with the named test in §7 only.

---

## 4. State layer: `src/lib/state.svelte.ts`

One new action mirroring the existing promote wrapper conventions (busy flag, error surface, `loadCandidates` refresh):

```ts
async promoteMerged(paths: string[], overrides: MergeOverrides): Promise<number>
```

Returns the number of **candidates consumed** (i.e. `paths.length`) so the inbox session counter keeps counting inbox items retired, not record entries created. Refresh `candidates` after; refresh `projects` if `overrides.project` named a slug (the count changed).

---

## 5. Inbox UI

### 5.1 Ticket grouping (`src/lib/inbox/grouping.ts` + `src/routes/inbox/+page.svelte`)

- Add `'ticket'` to `GroupBy`; add an `<option value="ticket">Ticket</option>` to the Group-by select.
- Bucketing inside `computeGroups` for `groupBy === 'ticket'`:
  - Key `sc:{id}` when `ticketOf(c)` is non-empty. Label: `sc-{id}` plus the story name when any member's `shortcut` block yields one via the §1.4 regex (label building may reuse `mergedTitleDefault` on the group).
  - Else key `t:{normalizedTitleKey}` **only when ≥ 2 candidates share that key** (computed in a pre-pass). Label: the rendered title + a `· suggested` suffix (the D1 heuristic marker).
  - Everything else lands in key `__solo`, label `Ungrouped`, sorted last.
  - Group sort: by size desc (the existing project-group idiom), `__solo` pinned last.
- Group swatch: `{ variant: 'square', color: <shortcut source color from sourceMeta('shortcut')> }` for `sc:` groups; the neutral/unaffiliated color for `t:` and `__solo`.
- **Group-header select control:** in ticket mode (and harmlessly in every mode), add a checkbox to the group header that selects/deselects all of that group's candidate paths into the existing `selected` set. This is the bridge between grouping and the merge action — no separate per-group merge state.

### 5.2 Merge action (bulk bar)

In the existing sticky bulk-action bar, add a **"Merge into one entry"** button:

- Enabled iff `selectedCount >= 2` AND every selected candidate has `sourceOf(c) === 'github'`. Disabled otherwise, with a title-tooltip explaining why (mixed sources / non-GitHub / fewer than 2).
- Clicking opens the **merge preview dialog** (a modal, same visual idiom as the existing "New project?" dialog):
  - **Title** input, seeded from `mergedTitleDefault(selection)`.
  - **Date** input, seeded from the max valid constituent date; required (red/blocked state) when no constituent has a valid date.
  - **Project** select, seeded per the bulk bar's current `bulkProject` semantics (KEEP → shared suggestion if all constituents agree, else none).
  - **Parent** — run the existing `suggestShortcutParent` against the first `shortcut`-carrying constituent; show the same clearable "Matched Shortcut story sc-… " strip as `CandidateRow` when it resolves.
  - **Read-only ledger preview** — the §1.3 ledger lines, so the human sees exactly what the merged body will assert.
  - Confirm button: **"Merge & promote as 1"**.
- On confirm: if the chosen project slug is not an existing project, route through the SAME project-resolution dialog flow (`beginPromote`'s create / file-under / promote-anyway walk) before calling `app.promoteMerged` — do not fork a second resolution UX. The cleanest wiring: resolve the slug first via the existing dialog machinery, then call `promoteMerged` with the resolved slug.
- After success: clear selection, `promotedCount += paths.length`, standard refresh.

### 5.3 Reject group

No new button beyond §5.1's group checkbox: select group → existing "Reject N". Confirm text unchanged. (D3 is satisfied by the existing per-candidate provenance append.)

---

## 6. Prohibitions

1. **No LLM calls anywhere in this feature.** Grouping, title derivation, ledger, message dedupe — all deterministic.
2. **Never merge or mutate promoted entries (D4).** `promoteMerged` accepts inbox candidate paths only; passing an `entries/` path must fail (validate paths start with `INBOX_DIR`).
3. **No automatic merging.** The system groups and previews; only an explicit human confirm writes anything. Title-fallback (`t:`) groups are suggestions — they carry the visible heuristic marker and never expand a selection on their own.
4. **Do not modify** `stageItems`, `rawItemToEntryInput`, `categorize`, `selectNewItems`, or any adapter mapper. The pipeline is untouched by design; provenance projection (§2) is the only core-boundary change.
5. **Scalar `source_id` remains present and primary (D2).** No reader migration; `candidateToRawItem`, `rejected.tsv` rows, and `findBySource` behavior are unchanged.
6. **Never default a date to today.** The merge date gate mirrors `promoteCandidate` exactly.
7. **No diff/code content.** The ledger and message blocks carry only what the candidates already carry (headlines, counts, verbatim commit messages) — nothing new is fetched.
8. **`stripShortcutBlock` invariant holds:** the merged body ends with at most one `--- Shortcut ---` block, appended last.

---

## 7. Acceptance criteria & named tests

### Phase 1 — pure core (`merge.test.ts`, `grouping.test.ts` additions)

- `ticketOf`: reads `shortcut_ids[0]`; falls back to `shortcut.id`; `''` otherwise.
- `normalizedTitleKey`: `"Sc 57886 promo banner disclaimer"` and `"sc-57886 promo banner disclaimer"` produce the same key; a ref-only title yields `''`; invalid pattern override never throws.
- `buildMergedEntry` fixtures (build them from the real inbox shapes — `mapGithubCommitNode` output staged through `rawItemToEntryInput`):
  - **`merges_15_same_ticket_commits`** — 15 commit candidates, same `sc-57886`, several byte-identical message bodies: output has 15 ledger lines ascending by date, ONE deduped message block listing all carrier SHAs (D5), one Shortcut block, summed `change_size`, `source_ids.length === 15`, scalar `source_id` = earliest commit's SHA, `merged_count: 15`.
  - **`distinct_messages_each_get_a_block`** — 3 candidates, 2 distinct non-empty messages → exactly 2 message blocks in first-seen order.
  - **`date_gate_throws_when_all_undated_and_no_override`**; **`override_date_wins`**; **`invalid_override_date_throws`**.
  - **`mixed_source_throws`**; **`single_candidate_throws`**; **`non_github_throws`**.
  - **`privacy_folds_most_protective`** — one private constituent ⇒ merged `private: true`.
  - **`triage_keys_never_carried`**.
- `mergedTitleDefault`: Shortcut block name wins (`sc-57886: <story name>`); frequency fallback; primary-title fallback.

### Phase 2 — provenance & store (`record`/`index-db` tests)

- **`source_ids_project_into_provenance`** — index an entry with `source_ids: [a,b,c]`, scalar `source_id: a` ⇒ `sourceIds('github')` contains all three; `findBySource('github', c)` resolves to the entry.
- **`reimport_skips_all_constituents`** — after `promoteMerged` over commits `[a,b,c]`, `selectNewItems` on a batch containing raw items `a`, `b`, `c`, `d` returns only `d` (`skippedPromoted === 3` via `stageItems` report).
- **`promoteMerged_write_order`** — merged file exists in `entries/` with expected frontmatter; all constituent files removed from `.inbox/`; index has exactly one new row.
- **`promoteMerged_rejects_non_inbox_paths`** (prohibition 2).
- **`reject_group_appends_every_provenance`** — bulk-reject 3 candidates ⇒ `rejectedKeys()` contains all 3 keys; a re-import reports `skippedRejected === 3` (D3).
- **`full_rebuild_reconstructs_array_provenance`** — nuke & rebuild ⇒ same `sourceIds` set.

### Phase 3 — UI

- Ticket group-by clusters the D1 fixture inbox: `sc:57886` group holds both `sc-57886 …` and `Sc 57886 …` titled candidates (ticket extraction from `shortcut_ids` frontmatter — note candidates staged before enrichment cluster via title fallback until enriched); `Promo banner mst` singletons land in Ungrouped unless ≥2 share the normalized key.
- Group-header checkbox selects the group's rows into `selected`.
- Merge button disabled for mixed-source and single selections, with tooltip.
- Merge dialog: ledger preview matches `buildMergedEntry` output; empty title blocks confirm; project-resolution dialog fires for a novel slug before the merge lands.
- Session counter increments by candidates consumed.

---

## 8. Out of scope (explicitly)

- Merging already-promoted entries (D4) — a future, separate feature if ever.
- Any Stage-2 LLM roll-up of ticket clusters — still deferred; note that `shortcut_ids` union + `merged_count` on merged entries are compatible inputs for it.
- Cross-source merges (e.g. folding a `source: 'shortcut'` story candidate into a commit merge). A story candidate sharing the ticket appears in the `sc:` group for visibility but is excluded from the merge selection validity check — the parent-assist path (`suggestShortcutParent`) is its intended relationship.
- Un-merge. Git history of the record repo is the escape hatch, as everywhere else.
