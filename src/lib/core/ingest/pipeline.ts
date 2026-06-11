/**
 * The staging pipeline (ingest-reduce plan §1): RawItems → candidate inbox.
 *
 * The hard boundary lives here. This function:
 *   - NEVER writes into `entries/` — candidates only.
 *   - NEVER calls an LLM — Stage 1 is fully deterministic.
 *   - Dedupes against (in order) the provenance index (already promoted), the
 *     rejected list (human said no), and the inbox itself (deterministic
 *     candidate filenames make re-staging idempotent).
 *
 * Every candidate is created `private: true` — ingested material defaults to
 * the most protective posture and only a deliberate human edit makes it
 * public (brutal-accuracy + private-by-default principles).
 */

import type { RecordStore } from '../record';
import { provenanceKey } from '../record';
import { makeEntry, nowIso, type NewEntryInput } from '../entry';
import type { TriageResult } from '../triage';
import type { IngestReport, RawItem } from './types';

/** Flatten a triage signal onto entry frontmatter as the five `triage_*` keys
 * (triage spec §2). `triage_model` is omitted unless an LLM decided. These ride
 * the candidate only and are stripped on promote (record.ts). */
function triageExtra(result: TriageResult): Record<string, unknown> {
  return {
    triage_signal: result.signal,
    triage_reason: result.reason,
    triage_source: result.source,
    ...(result.model ? { triage_model: result.model } : {}),
    triage_at: result.at
  };
}

/** Map a RawItem onto the entry-creation input. Pure — unit-tested. The
 * provenance keys (`source`, `source_id`) ride the frontmatter pass-through;
 * no schema change is needed (plan §1). When a triage `result` is supplied it is
 * folded in as the `triage_*` keys (triage spec §6) — back-compatible: absent =
 * today's behavior. */
export function rawItemToEntryInput(
  item: RawItem,
  ingestedAt: string = nowIso(),
  result?: TriageResult
): NewEntryInput {
  const extra: Record<string, unknown> = {
    source: item.source,
    source_id: item.sourceId,
    ingested_at: ingestedAt,
    reviewed: false,
    ...(item.url ? { source_url: item.url, links: [item.url] } : {}),
    ...(item.suggestedProject ? { project: item.suggestedProject } : {}),
    ...(item.extraFrontmatter ?? {}),
    ...(result ? triageExtra(result) : {})
  };
  return {
    type: item.suggestedType ?? 'journal',
    title: item.title,
    date: item.date || undefined, // empty → makeEntry defaults to today
    private: true, // always; review can open it up, never the reverse
    tags: item.suggestedTags ?? [],
    body: item.body ?? '',
    extra
  };
}

/** The dedupe verdict for a batch: the fresh items plus the skip breakdown. */
interface Selection {
  fresh: RawItem[];
  skippedPromoted: number;
  skippedRejected: number;
}

/** Categorize a batch against the record (already promoted) and the rejected
 * list. Bulk-loads promoted ids per source present in the batch (one query
 * each). Items with an empty source id are left in `fresh` — staging reports
 * them as errors (preserving today's per-item error path). */
async function categorize(store: RecordStore, items: RawItem[]): Promise<Selection> {
  const rejected = await store.rejectedKeys();
  const promotedBySource = new Map<string, Set<string>>();
  for (const source of new Set(items.map((i) => String(i.source)))) {
    promotedBySource.set(source, await store.promotedSourceIds(source));
  }
  const fresh: RawItem[] = [];
  let skippedPromoted = 0;
  let skippedRejected = 0;
  for (const item of items) {
    const source = String(item.source);
    if (item.sourceId && promotedBySource.get(source)?.has(item.sourceId)) {
      skippedPromoted++;
      continue;
    }
    if (item.sourceId && rejected.has(provenanceKey(source, item.sourceId))) {
      skippedRejected++;
      continue;
    }
    fresh.push(item);
  }
  return { fresh, skippedPromoted, skippedRejected };
}

/**
 * The items in `items` not already promoted into the record or previously
 * rejected — i.e. what a stage run would actually write (triage spec §6). The
 * import layer calls this **before** triage so the LLM never classifies an item
 * that would be skipped (saves tokens, never sends already-handled content to a
 * cloud provider).
 */
export async function selectNewItems(store: RecordStore, items: RawItem[]): Promise<RawItem[]> {
  return (await categorize(store, items)).fresh;
}

/**
 * Stage a batch of fetched items into the candidate inbox, deduping against
 * the record, the rejected list, and the inbox. Per-item failures are
 * reported, never thrown — one bad payload must not abort a 200-item import.
 *
 * `opts.signals` (triage spec §6) carries triage results keyed by
 * `provenanceKey`; a matching signal is folded onto the candidate's
 * frontmatter. Absent ⇒ today's behavior, untriaged.
 */
export async function stageItems(
  store: RecordStore,
  items: RawItem[],
  opts: { signals?: Map<string, TriageResult> } = {}
): Promise<IngestReport> {
  const { fresh, skippedPromoted, skippedRejected } = await categorize(store, items);
  const report: IngestReport = {
    fetched: items.length,
    staged: 0,
    skippedPromoted,
    skippedRejected,
    errors: []
  };

  for (const item of fresh) {
    try {
      if (!item.sourceId) {
        report.errors.push(`(${item.source}) item without a source id: "${item.title}"`);
        continue;
      }
      if (!item.title) {
        report.errors.push(`(${item.source}:${item.sourceId}) item without a title`);
        continue;
      }
      const signal = opts.signals?.get(provenanceKey(String(item.source), item.sourceId));
      // Staging the same (source, source_id) twice overwrites the same
      // candidate file (deterministic filename), so an inbox re-run is
      // idempotent — counted as staged, not duplicated.
      await store.stageCandidate(makeEntry(rawItemToEntryInput(item, nowIso(), signal)));
      report.staged++;
    } catch (e) {
      report.errors.push(`(${item.source}:${item.sourceId}) ${String(e)}`);
    }
  }
  return report;
}
