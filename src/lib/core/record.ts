/**
 * The record facade — the single entry point the UI / CLI drives.
 *
 * Enforces the spec's write order without exception (spec §6):
 *   1. Write the `.md` text file (the source of truth).
 *   2. Update `updated` in that file's frontmatter.
 *   3. Reindex *that one file* into the SQLite index.
 *
 * The index is never the only place a change exists, not even momentarily.
 * Reads go through the index (§6); writes always touch text first.
 */

import type { Entry, EntryFrontmatter, Platform, Profile } from './types';
import type { RawItem } from './ingest/types';
// Leaf module (like triage below) — shortcut.ts never imports record, no cycle.
import {
  extractShortcutRefs,
  shortcutEnrichment,
  stripShortcutBlock,
  type ShortcutStory
} from './ingest/shortcut';
import {
  ensureSchema,
  rebuild,
  reindexFile,
  removeByPath,
  listEntries as dbListEntries,
  listProjects as dbListProjects,
  getEntryById,
  findBySource as dbFindBySource,
  sourceIds as dbSourceIds,
  countsByType,
  allTags,
  tagCounts as dbTagCounts,
  getMeta,
  type ListFilters,
  type ProjectSummary,
  type RebuildReport
} from './index-db';
import {
  expectedPath,
  makeEntry,
  parseEntry,
  serializeEntry,
  touchEntry,
  type NewEntryInput
} from './entry';
import { buildMergedEntry, type MergeOverrides } from './merge';
import {
  rollupEntries,
  runReducePipeline,
  renderRetrospective,
  upsertMarkedBlock,
  extractMarkedBlock,
  stripMarkedBlock,
  type ProjectRollup,
  type RollupOptions,
  type ReduceProposal
} from './reduce';
import { draftWins as draftWinsPipeline, type WinDraft } from './wins';
import type { Llm } from './types';
// Import from the leaf modules (not the index) to avoid a triage→record cycle.
import { TRIAGE_KEYS, type TriageRubric, type TriageSignal, type TriageResult } from './triage/types';
import { prefilterItem } from './triage/prefilter';
import { emptyProfile, parseProfile, PROFILE_PATH, serializeProfile } from './profile';
import {
  PROFILE_BODY_PLACEHOLDER,
  RECORD_GITATTRIBUTES,
  RECORD_GITIGNORE,
  RECORD_README
} from './templates';
import { generateResumeMarkdown } from './generators/resume';
import { generateSiteHtml } from './generators/site';

// Re-export the index types the UI consumes through the facade.
export type { ListFilters, ProjectSummary, RebuildReport, ReduceProposal };
export type { WinDraft };

/** A wins draft proposal awaiting the human accept gate (wins spec §3.1).
 * Nothing is written until {@link RecordStore.saveWins} is called. */
export interface WinProposal {
  /** The selected source entry ULIDs. */
  sourceIds: string[];
  sourceCount: number;
  /** Evidence-verified drafts (may be empty). */
  drafts: WinDraft[];
  /** Latest date among the selected sources — seeds each win's date. */
  defaultDate: string;
  /** Provenance string, e.g. "anthropic:claude-…", or undefined. */
  model?: string;
}

/** One accepted (possibly human-edited) win at the gate (wins spec §3.1). */
export interface AcceptedWin {
  /** Final statement (the human may have edited the draft). */
  text: string;
  /** Source ULIDs (carried from the draft). */
  evidence: string[];
  /** Role/project ULID to nest under, or '' / undefined for Highlights. */
  parent?: string;
  /** YYYY-MM-DD; required & validated (never defaults to today). */
  date: string;
  /** Defaults false (public) at the call site. */
  private?: boolean;
}

/** Frontmatter the human can set/override at the promote gate (plan §2.4). */
export interface PromoteOverrides {
  /** Project slug to affiliate the entry with. An empty string clears any
   * suggested affiliation; `undefined` leaves the candidate's value untouched. */
  project?: string;
  /** Supply or correct the event date (YYYY-MM-DD). REQUIRED to promote a
   * candidate staged without one (needs_date). An empty string is treated as
   * "no date provided" and will not satisfy the gate. */
  date?: string;
  /** Parent entry ULID to nest under (story-import spec §7) — e.g. the promoted
   * Shortcut story a commit candidate belongs to. Prefilled as a suggestion by
   * {@link RecordStore.suggestShortcutParent}; the human can clear it. An empty
   * string clears; `undefined` leaves the candidate untouched. */
  parent?: string;
  /** Tags to add on promote. Unioned with the candidate's existing tags
   * (deduped, order preserved: existing first). `undefined` or `[]` leaves the
   * candidate's tags untouched — the promote gate never strips staged tags. */
  tags?: string[];
}

/** The candidate inbox (ingest-reduce plan §1): staged-but-unreviewed ingested
 * items. Lives inside the record folder for locality but is gitignored — a
 * candidate is NOT part of the record until promoted. */
export const INBOX_DIR = '.inbox';
const REJECTED_FILE = `${INBOX_DIR}/rejected.tsv`;

/** Stable dedupe key for a (source, source_id) pair. */
export function provenanceKey(source: string, sourceId: string): string {
  return `${source}\t${sourceId}`;
}

/** The provenance key of one `rejected.tsv` row: its first two tab-separated
 * columns (`source\tsource_id`), ignoring any trailing title column. */
function keyOfRejectedLine(line: string): string {
  const [source, sourceId] = line.split('\t');
  return provenanceKey(source, sourceId ?? '');
}

/** Reconstruct just enough of a {@link RawItem} from a staged candidate to
 * re-run the prefilter. The prefilter-relevant `meta` fields are written
 * verbatim into the candidate body by the adapters (`From:` for Gmail, `State:`
 * for GitHub, `Status:` for Asana), so they round-trip without a schema. */
function candidateToRawItem(entry: Entry): RawItem {
  const fm = entry.frontmatter as Record<string, unknown>;
  const body = entry.body ?? '';
  const meta: Record<string, string> = {};
  const from = body.match(/^From:\s*(.+)$/im);
  if (from) meta.from = from[1].trim();
  const state = body.match(/^State:\s*([^.\n]+)/im);
  if (state) meta.state = state[1].trim().toLowerCase();
  const status = body.match(/^Status:\s*([^.\n]+)/im);
  if (status) meta.status = status[1].trim().toLowerCase();
  return {
    source: typeof fm.source === 'string' ? fm.source : '',
    sourceId: fm.source_id == null ? '' : String(fm.source_id),
    title: typeof fm.title === 'string' ? fm.title : '',
    date: typeof fm.date === 'string' ? fm.date : '',
    // The same composed body staged at import time — the LLM triage view
    // excerpts it for context (the prefilter ignores it).
    body,
    meta
  };
}

/** Tiny non-crypto hash for collision-proofing candidate filenames. */
function hash8(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Deterministic candidate filename from provenance, so re-staging the same
 * item overwrites its own file instead of accumulating duplicates. */
function candidateFilename(entry: Entry): string {
  const fm = entry.frontmatter;
  const source = typeof fm.source === 'string' && fm.source ? fm.source : 'manual';
  const sourceId = typeof fm.source_id === 'string' && fm.source_id ? fm.source_id : fm.id;
  const safe =
    sourceId
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item';
  return `${source}-${safe}-${hash8(`${source}\t${sourceId}`)}.md`;
}

export class RecordStore {
  constructor(
    private readonly platform: Platform,
    /** Absolute path to the record folder (the data repo root). */
    readonly recordRoot: string
  ) {}

  private abs(relPath: string): string {
    return this.platform.joinPath(this.recordRoot, relPath);
  }

  /** Ensure the index schema exists. Call once after opening a folder. */
  async open(): Promise<void> {
    await ensureSchema(this.platform.db);
  }

  // -------------------------------------------------------------------------
  // Scaffolding
  // -------------------------------------------------------------------------

  /**
   * Initialize a record folder: create the directory layout and seed
   * `profile.md`, `.gitignore`, and `README.md` if absent. Never overwrites an
   * existing file. Safe to call on an already-initialized folder.
   */
  async init(): Promise<void> {
    const { fs } = this.platform;
    await fs.mkdir(this.recordRoot);
    await fs.mkdir(this.abs('entries'));
    await fs.mkdir(this.abs('assets'));
    await fs.mkdir(this.abs('templates'));

    await this.seedFile('.gitignore', RECORD_GITIGNORE);
    await this.seedFile('.gitattributes', RECORD_GITATTRIBUTES);
    await this.seedFile('README.md', RECORD_README);
    if (!(await fs.exists(this.abs(PROFILE_PATH)))) {
      const profile = emptyProfile();
      profile.body = PROFILE_BODY_PLACEHOLDER;
      await fs.writeTextFile(this.abs(PROFILE_PATH), serializeProfile(profile));
    }
    await this.open();
  }

  private async seedFile(relPath: string, contents: string): Promise<void> {
    if (!(await this.platform.fs.exists(this.abs(relPath)))) {
      await this.platform.fs.writeTextFile(this.abs(relPath), contents);
    }
  }

  // -------------------------------------------------------------------------
  // Writes (text first, then index)
  // -------------------------------------------------------------------------

  /** Create a new entry: write text, then index it. */
  async createEntry(input: NewEntryInput): Promise<Entry> {
    const entry = makeEntry(input);
    const path = entry.path ?? expectedPath(entry);
    await this.writeEntryFile({ ...entry, path });
    await reindexFile(this.platform, this.recordRoot, path);
    return { ...entry, path };
  }

  /**
   * Update an existing entry. Writes text first (bumping `updated`), reindexes,
   * and—if the date or title changed the canonical filename—renames the file on
   * disk and drops the stale index row. Identity (`id`) is never touched.
   */
  async updateEntry(entry: Entry): Promise<Entry> {
    const next = touchEntry(entry);
    const oldPath = entry.path;
    const newPath = expectedPath(next);

    await this.writeEntryFile({ ...next, path: newPath });

    if (oldPath && oldPath !== newPath) {
      // Remove the old file + its stale index row after the new file exists.
      if (await this.platform.fs.exists(this.abs(oldPath))) {
        await this.platform.fs.removeFile(this.abs(oldPath));
      }
      await removeByPath(this.platform.db, oldPath);
    }

    await reindexFile(this.platform, this.recordRoot, newPath);
    return { ...next, path: newPath };
  }

  /** Delete an entry: remove the file, then its index row. Git keeps history. */
  async deleteEntry(entry: Entry): Promise<void> {
    const path = entry.path ?? expectedPath(entry);
    if (await this.platform.fs.exists(this.abs(path))) {
      await this.platform.fs.removeFile(this.abs(path));
    }
    await removeByPath(this.platform.db, path);
  }

  private async writeEntryFile(entry: Entry): Promise<void> {
    await this.platform.fs.mkdir(this.abs('entries'));
    await this.platform.fs.writeTextFile(this.abs(entry.path!), serializeEntry(entry));
  }

  // -------------------------------------------------------------------------
  // Candidate inbox (ingest-reduce plan §1) — staged, not yet record.
  //
  // The hard rule: ingestion never writes a canonical entry directly. Items
  // land here as candidate files; only the human's promote turns one into a
  // real `entries/*.md` (text first, then index — the same write order as
  // every other path). Reject remembers the provenance so re-running an
  // adapter never re-proposes the same item.
  // -------------------------------------------------------------------------

  /** All staged candidates, oldest filename first. */
  async listCandidates(): Promise<Entry[]> {
    const names = (await this.platform.fs.readDir(this.abs(INBOX_DIR)))
      .filter((n) => n.endsWith('.md'))
      .sort();
    const out: Entry[] = [];
    for (const name of names) {
      const rel = `${INBOX_DIR}/${name}`;
      out.push(parseEntry(await this.platform.fs.readTextFile(this.abs(rel)), rel));
    }
    return out;
  }

  /**
   * Re-run the deterministic prefilter over every staged candidate and refold
   * its `triage_*` signal in place, so a rubric change (e.g. broadened patterns)
   * reaches the existing inbox — not just future imports. Prefilter-only: no
   * network, no LLM, and `keep` here means only "no deterministic frivolous
   * signal". A candidate is rewritten only when its signal/reason actually
   * changes, so re-running is cheap and idempotent.
   */
  async retriageCandidates(
    rubric: TriageRubric
  ): Promise<{ total: number; updated: number; keep: number; frivolous: number }> {
    const candidates = await this.listCandidates();
    const at = new Date().toISOString();
    let updated = 0;
    let keep = 0;
    let frivolous = 0;
    for (const c of candidates) {
      const { verdict, reason } = prefilterItem(candidateToRawItem(c), rubric);
      // Prefilter-only: `unsure` folds to keep (triage spec §4), never frivolous.
      const signal: TriageSignal = verdict === 'frivolous' ? 'frivolous' : 'keep';
      if (signal === 'frivolous') frivolous++;
      else keep++;
      const fm = c.frontmatter as Record<string, unknown>;
      if (fm.triage_signal === signal && fm.triage_reason === reason && fm.triage_source === 'prefilter') {
        continue; // unchanged — leave the file untouched
      }
      const nextFm: Record<string, unknown> = {
        ...fm,
        triage_signal: signal,
        triage_reason: reason,
        triage_source: 'prefilter',
        triage_at: at
      };
      delete nextFm.triage_model; // a prefilter verdict never carries a model
      await this.writeEntryFile({ ...c, frontmatter: nextFm as EntryFrontmatter });
      updated++;
    }
    return { total: candidates.length, updated, keep, frivolous };
  }

  /**
   * Reconstruct staged candidates as {@link RawItem}s for an external triage
   * pass (e.g. the LLM), each paired with its provenance key. Optionally limited
   * to candidates currently carrying a given signal — the LLM pass only needs
   * the `keep` set, since flagging already-frivolous items would be wasted work.
   */
  async candidateRawItems(opts: { signal?: TriageSignal } = {}): Promise<{ key: string; item: RawItem }[]> {
    const out: { key: string; item: RawItem }[] = [];
    for (const c of await this.listCandidates()) {
      if (opts.signal && c.frontmatter.triage_signal !== opts.signal) continue;
      const item = candidateToRawItem(c);
      out.push({ key: provenanceKey(item.source, item.sourceId), item });
    }
    return out;
  }

  /**
   * Fold a `provenanceKey → TriageResult` map (e.g. from {@link llmTriageItems})
   * onto matching staged candidates, writing each changed file in place. Pure
   * annotation — never promotes, rejects, moves, or deletes (triage spec §0): an
   * item only gains/changes its `triage_*` signal and stays in the inbox.
   */
  async applyTriageResults(
    results: Map<string, TriageResult>
  ): Promise<{ updated: number; keep: number; frivolous: number }> {
    let updated = 0;
    let keep = 0;
    let frivolous = 0;
    for (const c of await this.listCandidates()) {
      const fm = c.frontmatter as Record<string, unknown>;
      const key = provenanceKey(String(fm.source ?? ''), fm.source_id == null ? '' : String(fm.source_id));
      const r = results.get(key);
      if (!r) continue;
      if (r.signal === 'frivolous') frivolous++;
      else keep++;
      const unchanged =
        fm.triage_signal === r.signal &&
        fm.triage_reason === r.reason &&
        fm.triage_source === r.source &&
        fm.triage_model === r.model;
      if (unchanged) continue;
      const nextFm: Record<string, unknown> = {
        ...fm,
        triage_signal: r.signal,
        triage_reason: r.reason,
        triage_source: r.source,
        triage_at: r.at
      };
      if (r.model) nextFm.triage_model = r.model;
      else delete nextFm.triage_model;
      await this.writeEntryFile({ ...c, frontmatter: nextFm as EntryFrontmatter });
      updated++;
    }
    return { updated, keep, frivolous };
  }

  /**
   * Rewrite the `project` affiliation of every staged candidate currently
   * pointing at `fromSlug` so it points at `toSlug` instead, writing each
   * changed file in place. Used at the promote gate when a project is created
   * on the fly: the rest of the inbox follows the (re)name in one pass so the
   * owner isn't re-typing it per item. Candidates without `project: fromSlug`
   * are left untouched; a no-op when the slugs match or `fromSlug` is empty.
   * Returns the number of candidates rewritten.
   */
  async relabelCandidateProject(fromSlug: string, toSlug: string): Promise<number> {
    if (!fromSlug || fromSlug === toSlug) return 0;
    let updated = 0;
    for (const c of await this.listCandidates()) {
      if (c.frontmatter.project !== fromSlug) continue;
      const frontmatter = { ...c.frontmatter, project: toSlug };
      await this.writeEntryFile({ ...c, frontmatter });
      updated++;
    }
    return updated;
  }

  /**
   * Enrich staged candidates from Shortcut in place (shortcut-enrichment spec
   * §6, the backfill path). Re-extracts refs from each candidate's title + body
   * (NOT only frontmatter — pre-feature candidates have no `shortcut_ids` key
   * yet), dedupes story fetches across the whole inbox (two-pass: union all
   * refs, ONE `fetcher` call, then rewrite), folds story facts into frontmatter
   * and appends the `--- Shortcut ---` block to the body. Idempotent: any
   * existing block is replaced, and a candidate is rewritten only when
   * enrichment actually changes its bytes. Never promotes/rejects/moves/
   * deletes; never alters `title`/`date` or the `triage_*` keys.
   *
   * The fetcher is injected (a closure over http + token + includeDescription)
   * so the store stays free of the Http/Secrets seams — consistent with taking
   * an `Llm` for {@link draftWins} rather than constructing one.
   */
  async enrichCandidates(
    fetcher: (ids: string[]) => Promise<Map<string, ShortcutStory>>,
    opts: { refPattern?: string } = {}
  ): Promise<{ total: number; enriched: number; storiesFetched: number }> {
    const candidates = await this.listCandidates();

    // Pass 1 — union every candidate's refs (frontmatter tag ∪ re-extraction).
    const refsByPath = new Map<string, string[]>();
    for (const c of candidates) {
      const fm = c.frontmatter as Record<string, unknown>;
      const tagged = Array.isArray(fm.shortcut_ids)
        ? fm.shortcut_ids.filter((v): v is string => typeof v === 'string')
        : [];
      const extracted = extractShortcutRefs(
        `${typeof fm.title === 'string' ? fm.title : ''}\n${c.body ?? ''}`,
        opts.refPattern
      );
      const refs = [...new Set([...tagged, ...extracted])];
      if (refs.length > 0 && c.path) refsByPath.set(c.path, refs);
    }
    const allIds = [...new Set([...refsByPath.values()].flat())];
    if (allIds.length === 0) return { total: candidates.length, enriched: 0, storiesFetched: 0 };

    const stories = await fetcher(allIds);

    // Pass 2 — rewrite each ref-bearing candidate whose story resolved.
    let enriched = 0;
    for (const c of candidates) {
      const refs = c.path ? refsByPath.get(c.path) : undefined;
      if (!refs) continue;
      const story = refs.map((id) => stories.get(id)).find((s) => s !== undefined);
      if (!story) continue;
      const { frontmatter, bodyBlock } = shortcutEnrichment(story);
      const nextFm = { ...c.frontmatter, shortcut_ids: refs, ...frontmatter };
      const base = stripShortcutBlock(c.body ?? '');
      const nextBody = base ? `${base}\n\n${bodyBlock}` : bodyBlock;
      const next: Entry = { ...c, frontmatter: nextFm as EntryFrontmatter, body: nextBody };
      // Byte-identical ⇒ leave the file untouched (retriageCandidates idiom).
      if (serializeEntry(next) === serializeEntry(c)) continue;
      await this.writeEntryFile(next);
      enriched++;
    }
    return { total: candidates.length, enriched, storiesFetched: stories.size };
  }

  /** Write a candidate file into the inbox. Deterministic filename per
   * (source, source_id), so re-staging the same item is idempotent. The entry
   * is stored in full canonical entry format — promote is then just a move. */
  async stageCandidate(entry: Entry): Promise<Entry> {
    await this.platform.fs.mkdir(this.abs(INBOX_DIR));
    const rel = `${INBOX_DIR}/${candidateFilename(entry)}`;
    await this.platform.fs.writeTextFile(this.abs(rel), serializeEntry(entry));
    return { ...entry, path: rel };
  }

  /**
   * Promote a candidate into the record: apply any review overrides (the
   * project picker, plan §2.4), mark it reviewed, write it to its canonical
   * `entries/` path (preserving the ULID minted at stage time), remove the
   * inbox file, and reindex. This is the human commit gate.
   */
  async promoteCandidate(
    candidatePath: string,
    overrides: PromoteOverrides = {}
  ): Promise<Entry> {
    const candidate = await this.readEntryFile(candidatePath);
    const fm = { ...candidate.frontmatter, reviewed: true };
    // Triage signals are a review aid for the inbox, never a fact about the
    // work — strip them so nothing reaches the record (triage spec §5, §6).
    for (const k of TRIAGE_KEYS) delete (fm as Record<string, unknown>)[k];
    if (overrides.project !== undefined) {
      const project = overrides.project.trim();
      if (project) fm.project = project;
      else delete fm.project;
    }
    if (overrides.parent !== undefined) {
      const parent = overrides.parent.trim();
      if (parent) (fm as Record<string, unknown>).parent = parent;
      else delete (fm as Record<string, unknown>).parent;
    }
    if (overrides.tags?.length) {
      const existing = Array.isArray(fm.tags) ? fm.tags : [];
      const added = overrides.tags.map((t) => t.trim()).filter(Boolean);
      fm.tags = [...new Set([...existing, ...added])];
    }

    // --- Date gate (allow-undated-imports spec §C) --------------------------
    // Apply an explicit date override first…
    if (overrides.date !== undefined) {
      const d = overrides.date.trim();
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        throw new Error(`Invalid date "${d}" — use YYYY-MM-DD`);
      }
      if (d) fm.date = d;
    }
    // …then enforce: a real, valid date is required to enter the record. A valid
    // date supersedes and clears the needs-date marker; its absence blocks the
    // promote (we NEVER default to today — résumé spec §8 / brutal accuracy).
    const hasValidDate =
      typeof fm.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fm.date);
    if (hasValidDate) {
      delete (fm as Record<string, unknown>).needs_date;
    } else {
      throw new Error('This candidate has no date yet — set its date before promoting.');
    }
    // ------------------------------------------------------------------------

    const next = touchEntry({ ...candidate, frontmatter: fm });
    const newPath = expectedPath(next);
    await this.writeEntryFile({ ...next, path: newPath });
    await this.platform.fs.removeFile(this.abs(candidatePath));
    await reindexFile(this.platform, this.recordRoot, newPath);
    return { ...next, path: newPath };
  }

  /**
   * Merge-at-promote (merge spec §3): collapse N staged candidates into ONE
   * record entry carrying multi-row provenance, then retire every constituent
   * candidate file. The standard write order — text first, then index. Inbox
   * candidates only (D4): already-promoted entries are never merged or mutated.
   *
   * Failure stance: steps 1–2 are effect-free (all validation throws happen in
   * {@link buildMergedEntry} before any filesystem effect). A constituent
   * delete failing after the merged entry was written is harmless — its
   * (source, source_id) is now in provenance, so the pipeline's
   * skippedPromoted path retires it on the next dedupe pass. No rollback.
   */
  async promoteMerged(candidatePaths: string[], overrides: MergeOverrides): Promise<Entry> {
    for (const p of candidatePaths) {
      if (!p.startsWith(`${INBOX_DIR}/`)) {
        throw new Error(`Only inbox candidates can be merged — not "${p}".`);
      }
    }
    const candidates: Entry[] = [];
    for (const p of candidatePaths) candidates.push(await this.readEntryFile(p));
    const merged = buildMergedEntry(candidates, overrides);
    const newPath = merged.path ?? expectedPath(merged);
    await this.writeEntryFile({ ...merged, path: newPath });
    for (const p of candidatePaths) {
      try {
        await this.platform.fs.removeFile(this.abs(p));
      } catch {
        /* leftover candidate is harmless — provenance retires it next pass */
      }
    }
    await reindexFile(this.platform, this.recordRoot, newPath);
    return { ...merged, path: newPath };
  }

  /** Reject a candidate: remember its provenance (so it is never re-proposed)
   * and delete the file. Nothing enters the record or the index. */
  async rejectCandidate(candidatePath: string): Promise<void> {
    let entry: Entry | null = null;
    try {
      entry = await this.readEntryFile(candidatePath);
    } catch {
      /* unreadable candidate — still remove it below */
    }
    if (entry) {
      const src = entry.frontmatter.source;
      const sid = entry.frontmatter.source_id;
      const title = entry.frontmatter.title;
      if (typeof src === 'string' && src && typeof sid === 'string' && sid) {
        await this.appendRejected(src, sid, typeof title === 'string' ? title : '');
      }
    }
    await this.platform.fs.removeFile(this.abs(candidatePath));
  }

  /** Provenance keys (`source\tsource_id`) of every rejected item. Each row is
   * `source\tsource_id[\ttitle]` — the optional third column is a human-readable
   * label kept only to make the reject log learnable (triage refinement); the
   * key is always the first two columns, so 2- and 3-column rows dedupe alike. */
  async rejectedKeys(): Promise<Set<string>> {
    const { fs } = this.platform;
    const abs = this.abs(REJECTED_FILE);
    if (!(await fs.exists(abs))) return new Set();
    const text = await fs.readTextFile(abs);
    return new Set(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map(keyOfRejectedLine)
    );
  }

  private async appendRejected(source: string, sourceId: string, title: string): Promise<void> {
    const { fs } = this.platform;
    await fs.mkdir(this.abs(INBOX_DIR));
    const abs = this.abs(REJECTED_FILE);
    const existing = (await fs.exists(abs)) ? await fs.readTextFile(abs) : '';
    const key = provenanceKey(source, sourceId);
    const keys = new Set(
      existing.split('\n').map((l) => l.trim()).filter(Boolean).map(keyOfRejectedLine)
    );
    if (keys.has(key)) return;
    // Tabs/newlines would corrupt the TSV; collapse any whitespace run to a space.
    const label = title.replace(/\s+/g, ' ').trim();
    const row = label ? `${key}\t${label}` : key;
    const next = existing && !existing.endsWith('\n') ? `${existing}\n${row}\n` : `${existing}${row}\n`;
    await fs.writeTextFile(abs, next);
  }

  /** The entry id already carrying a (source, source_id), or null (dedupe). */
  findBySource(source: string, sourceId: string): Promise<string | null> {
    return dbFindBySource(this.platform.db, source, sourceId);
  }

  /**
   * Promote-time parent assist (story-import spec §7): for a GitHub candidate
   * enriched with a Shortcut story, look up the promoted story entry sharing
   * that `shortcut.id` in the provenance index. Returns its ULID to *prefill*
   * the parent field — a suggestion only; nothing auto-files. Index-only and
   * read-only; any failure degrades to no prefill, never an error.
   */
  async suggestShortcutParent(candidate: Entry): Promise<string | null> {
    if (candidate.frontmatter.source !== 'github') return null;
    const sc = candidate.frontmatter.shortcut;
    const id =
      sc && typeof sc === 'object' && !Array.isArray(sc)
        ? (sc as Record<string, unknown>).id
        : undefined;
    if (typeof id !== 'string' || !id) return null;
    try {
      return await this.findBySource('shortcut', id);
    } catch {
      return null;
    }
  }

  /** All promoted source_ids for one source (bulk dedupe). */
  promotedSourceIds(source: string): Promise<Set<string>> {
    return dbSourceIds(this.platform.db, source);
  }

  // -------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------

  async readProfile(): Promise<Profile> {
    const path = this.abs(PROFILE_PATH);
    if (!(await this.platform.fs.exists(path))) return emptyProfile();
    return parseProfile(await this.platform.fs.readTextFile(path));
  }

  async saveProfile(profile: Profile): Promise<void> {
    await this.platform.fs.writeTextFile(this.abs(PROFILE_PATH), serializeProfile(profile));
  }

  // -------------------------------------------------------------------------
  // Reads (from the index)
  // -------------------------------------------------------------------------

  listEntries(filters: ListFilters = {}): Promise<Entry[]> {
    return dbListEntries(this.platform.db, filters);
  }

  /** Every project entry with its affiliated-entry count (plan §2.3). Powers
   * the project picker and the per-project filter. */
  listProjects(includePrivate = false): Promise<ProjectSummary[]> {
    return dbListProjects(this.platform.db, includePrivate);
  }

  /**
   * Deterministic rollup over a project's affiliated entries (plan §4.2). The
   * floor of Stage 2: needs no LLM. Includes private entries by default — the
   * rollup serves the owner's project view; privacy is enforced where outputs
   * are generated, not here.
   */
  async projectRollup(
    slug: string,
    opts: { includePrivate?: boolean } & RollupOptions = {}
  ): Promise<ProjectRollup> {
    const { includePrivate = true, ...rollupOpts } = opts;
    const entries = await this.listEntries({ project: slug, includePrivate });
    return rollupEntries(entries, rollupOpts);
  }

  /**
   * Generate a per-project retrospective via the LLM map/reduce pipeline
   * (plan §4.3–4.4). Returns a PROPOSAL only — nothing is written. The human's
   * accept gate is {@link saveProjectReduction}. Every surviving fact's evidence
   * resolves to a real entry ULID (unverifiable claims are dropped upstream).
   */
  async reduceProject(
    llm: Llm,
    slug: string,
    opts: { tokenBudget?: number; maxTokens?: number; now?: string } = {}
  ): Promise<ReduceProposal> {
    const projects = await this.listProjects(true);
    const summary = projects.find((p) => p.slug === slug);
    if (!summary?.entry.path) throw new Error(`No project entry with slug "${slug}"`);

    // Byte-exact body from disk so the diff/upsert preserve the human's prose.
    const projectEntry = await this.readEntryFile(summary.entry.path);
    const entries = (await this.listEntries({ project: slug, includePrivate: true })).sort((a, b) =>
      String(a.frontmatter.date).localeCompare(String(b.frontmatter.date))
    );

    const retro = await runReducePipeline(llm, {
      entries,
      projectProse: stripMarkedBlock(projectEntry.body),
      tokenBudget: opts.tokenBudget,
      maxTokens: opts.maxTokens
    });

    const generated = opts.now ?? new Date().toISOString().slice(0, 10);
    const inner = renderRetrospective(retro, { entryCount: entries.length, generated });
    return {
      slug,
      projectEntryId: projectEntry.frontmatter.id,
      entryCount: entries.length,
      retro,
      inner,
      currentInner: extractMarkedBlock(projectEntry.body),
      currentBody: projectEntry.body,
      proposedBody: upsertMarkedBlock(projectEntry.body, inner)
    };
  }

  /**
   * The reduce accept gate (plan §4.4): upsert the rendered block into the
   * project entry's marker region and persist via the normal write path (text
   * first, `updated` bumped, single-file reindex). The body is re-read from disk
   * first so any human edits to the prose since generation are preserved
   * byte-for-byte outside the markers.
   */
  async saveProjectReduction(projectEntryId: string, inner: string): Promise<Entry> {
    const indexed = await getEntryById(this.platform.db, projectEntryId);
    if (!indexed?.path) throw new Error('project entry not found');
    const fresh = await this.readEntryFile(indexed.path);
    return this.updateEntry({ ...fresh, body: upsertMarkedBlock(fresh.body, inner) });
  }

  // -------------------------------------------------------------------------
  // Wins from Journal (wins-from-journal spec §3) — a NEW output path, not the
  // reduce region. Drafts résumé-grade accomplishments from a hand-picked set of
  // entries via the LLM. `draftWins` proposes (writes nothing); `saveWins` is the
  // human accept gate that creates first-class `type: win` entries.
  // -------------------------------------------------------------------------

  /**
   * Draft wins from a selection of source entry ULIDs (wins spec §3.2). Returns a
   * PROPOSAL only — nothing is written. Every surviving draft's evidence resolves
   * to one of the selected ULIDs (ungrounded drafts are dropped upstream). Throws
   * if not a single id resolves.
   */
  async draftWins(
    llm: Llm,
    sourceIds: string[],
    opts: { maxTokens?: number } = {}
  ): Promise<WinProposal> {
    const entries: Entry[] = [];
    for (const id of sourceIds) {
      const e = await getEntryById(this.platform.db, id);
      if (e) entries.push(e); // skip ids that don't resolve
    }
    if (entries.length === 0) throw new Error('None of the selected entries could be loaded');

    // Latest date among the resolved sources seeds each win's date (never today).
    const defaultDate = entries
      .map((e) => String(e.frontmatter.date))
      .reduce((a, b) => (b > a ? b : a));

    const drafts = await draftWinsPipeline(llm, { entries, maxTokens: opts.maxTokens });
    return {
      sourceIds: entries.map((e) => String(e.frontmatter.id)),
      sourceCount: entries.length,
      drafts,
      defaultDate
    };
  }

  /**
   * The wins accept gate (wins spec §3.3): create a `type: win` entry per accepted
   * draft via the normal text-first-then-index path. Defaults public (D4) so the
   * win surfaces in the résumé/site. Enforces a valid date — NEVER defaults to
   * today (mirrors the promote date gate). Returns the created entries.
   */
  async saveWins(accepted: AcceptedWin[], opts: { model?: string } = {}): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const win of accepted) {
      const date = win.date.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error('A win needs a valid date (YYYY-MM-DD) — never defaults to today.');
      }
      const parent = win.parent?.trim();
      const entry = await this.createEntry({
        type: 'win',
        title: win.text.trim(),
        date,
        private: win.private ?? false,
        body: '',
        extra: {
          ...(parent ? { parent } : {}),
          evidence: win.evidence,
          generator: 'wins',
          ...(opts.model ? { model: opts.model } : {})
        }
      });
      out.push(entry);
    }
    return out;
  }

  getEntry(id: string): Promise<Entry | null> {
    return getEntryById(this.platform.db, id);
  }

  /** Read & parse an entry directly from its file (bypasses the index). Used
   * for editing, where we want the byte-exact on-disk content. */
  async readEntryFile(relPath: string): Promise<Entry> {
    return parseEntry(await this.platform.fs.readTextFile(this.abs(relPath)), relPath);
  }

  countsByType(includePrivate = false): Promise<Record<string, number>> {
    return countsByType(this.platform.db, includePrivate);
  }

  allTags(includePrivate = false): Promise<string[]> {
    return allTags(this.platform.db, includePrivate);
  }

  /** Tags with usage counts, most-used first — drives the Journal tag filter. */
  tagCounts(includePrivate = false): Promise<{ tag: string; count: number }[]> {
    return dbTagCounts(this.platform.db, includePrivate);
  }

  lastRebuild(): Promise<string | null> {
    return getMeta(this.platform.db, 'last_rebuild');
  }

  // -------------------------------------------------------------------------
  // Outputs (derived; private entries never included — spec §7)
  // -------------------------------------------------------------------------

  /** Render the resume as Markdown (non-private entries only). */
  async resumeMarkdown(): Promise<string> {
    const [profile, entries] = await Promise.all([
      this.readProfile(),
      this.listEntries({ includePrivate: false })
    ]);
    return generateResumeMarkdown({ profile, entries });
  }

  /** Render the personal site as a standalone HTML string. */
  async siteHtml(): Promise<string> {
    const [profile, entries] = await Promise.all([
      this.readProfile(),
      this.listEntries({ includePrivate: false })
    ]);
    return generateSiteHtml({ profile, entries });
  }

  /** Write the resume to `dist/resume.md`; returns the record-relative path. */
  async exportResume(): Promise<string> {
    const md = await this.resumeMarkdown();
    await this.platform.fs.mkdir(this.abs('dist'));
    const rel = 'dist/resume.md';
    await this.platform.fs.writeTextFile(this.abs(rel), md);
    return rel;
  }

  /** Write the site to `dist/index.html`; returns the record-relative path. */
  async exportSite(): Promise<string> {
    const html = await this.siteHtml();
    await this.platform.fs.mkdir(this.abs('dist'));
    const rel = 'dist/index.html';
    await this.platform.fs.writeTextFile(this.abs(rel), html);
    return rel;
  }

  // -------------------------------------------------------------------------
  // Index maintenance
  // -------------------------------------------------------------------------

  /** Incremental reindex (skips unchanged files). */
  reindex(): Promise<RebuildReport> {
    return rebuild(this.platform, this.recordRoot, { full: false });
  }

  /** Full nuke-and-rebuild escape hatch (spec §5.4). */
  fullRebuild(): Promise<RebuildReport> {
    return rebuild(this.platform, this.recordRoot, { full: true });
  }
}
