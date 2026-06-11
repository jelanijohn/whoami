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

import type { Entry, Platform, Profile } from './types';
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
import type { Llm } from './types';
// Import from the leaf module (not the index) to avoid a triage→record cycle.
import { TRIAGE_KEYS } from './triage/types';
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

/** Frontmatter the human can set/override at the promote gate (plan §2.4). */
export interface PromoteOverrides {
  /** Project slug to affiliate the entry with. An empty string clears any
   * suggested affiliation; `undefined` leaves the candidate's value untouched. */
  project?: string;
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
    const next = touchEntry({ ...candidate, frontmatter: fm });
    const newPath = expectedPath(next);
    await this.writeEntryFile({ ...next, path: newPath });
    await this.platform.fs.removeFile(this.abs(candidatePath));
    await reindexFile(this.platform, this.recordRoot, newPath);
    return { ...next, path: newPath };
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
      if (typeof src === 'string' && src && typeof sid === 'string' && sid) {
        await this.appendRejected(src, sid);
      }
    }
    await this.platform.fs.removeFile(this.abs(candidatePath));
  }

  /** Provenance keys (`source\tsource_id`) of every rejected item. */
  async rejectedKeys(): Promise<Set<string>> {
    const { fs } = this.platform;
    const abs = this.abs(REJECTED_FILE);
    if (!(await fs.exists(abs))) return new Set();
    const text = await fs.readTextFile(abs);
    return new Set(text.split('\n').map((l) => l.trim()).filter(Boolean));
  }

  private async appendRejected(source: string, sourceId: string): Promise<void> {
    const { fs } = this.platform;
    await fs.mkdir(this.abs(INBOX_DIR));
    const abs = this.abs(REJECTED_FILE);
    const existing = (await fs.exists(abs)) ? await fs.readTextFile(abs) : '';
    const key = provenanceKey(source, sourceId);
    const keys = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean));
    if (keys.has(key)) return;
    const next = existing && !existing.endsWith('\n') ? `${existing}\n${key}\n` : `${existing}${key}\n`;
    await fs.writeTextFile(abs, next);
  }

  /** The entry id already carrying a (source, source_id), or null (dedupe). */
  findBySource(source: string, sourceId: string): Promise<string | null> {
    return dbFindBySource(this.platform.db, source, sourceId);
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
