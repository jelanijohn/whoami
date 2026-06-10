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
import type { IngestReport, RawItem } from './types';

/** Map a RawItem onto the entry-creation input. Pure — unit-tested. The
 * provenance keys (`source`, `source_id`) ride the frontmatter pass-through;
 * no schema change is needed (plan §1). */
export function rawItemToEntryInput(item: RawItem, ingestedAt: string = nowIso()): NewEntryInput {
  const extra: Record<string, unknown> = {
    source: item.source,
    source_id: item.sourceId,
    ingested_at: ingestedAt,
    reviewed: false,
    ...(item.url ? { source_url: item.url, links: [item.url] } : {}),
    ...(item.suggestedProject ? { project: item.suggestedProject } : {}),
    ...(item.extraFrontmatter ?? {})
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

/**
 * Stage a batch of fetched items into the candidate inbox, deduping against
 * the record, the rejected list, and the inbox. Per-item failures are
 * reported, never thrown — one bad payload must not abort a 200-item import.
 */
export async function stageItems(store: RecordStore, items: RawItem[]): Promise<IngestReport> {
  const report: IngestReport = {
    fetched: items.length,
    staged: 0,
    skippedPromoted: 0,
    skippedRejected: 0,
    errors: []
  };

  const rejected = await store.rejectedKeys();
  // Bulk-load promoted ids per source present in this batch (one query each).
  const promotedBySource = new Map<string, Set<string>>();
  for (const source of new Set(items.map((i) => String(i.source)))) {
    promotedBySource.set(source, await store.promotedSourceIds(source));
  }

  for (const item of items) {
    try {
      if (!item.sourceId) {
        report.errors.push(`(${item.source}) item without a source id: "${item.title}"`);
        continue;
      }
      if (!item.title) {
        report.errors.push(`(${item.source}:${item.sourceId}) item without a title`);
        continue;
      }
      const source = String(item.source);
      if (promotedBySource.get(source)?.has(item.sourceId)) {
        report.skippedPromoted++;
        continue;
      }
      if (rejected.has(provenanceKey(source, item.sourceId))) {
        report.skippedRejected++;
        continue;
      }
      // Staging the same (source, source_id) twice overwrites the same
      // candidate file (deterministic filename), so an inbox re-run is
      // idempotent — counted as staged, not duplicated.
      await store.stageCandidate(makeEntry(rawItemToEntryInput(item)));
      report.staged++;
    } catch (e) {
      report.errors.push(`(${item.source}:${item.sourceId}) ${String(e)}`);
    }
  }
  return report;
}
