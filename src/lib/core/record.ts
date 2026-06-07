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
  getEntryById,
  countsByType,
  allTags,
  getMeta,
  type ListFilters,
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
import { emptyProfile, parseProfile, PROFILE_PATH, serializeProfile } from './profile';
import { PROFILE_BODY_PLACEHOLDER, RECORD_GITIGNORE, RECORD_README } from './templates';
import { generateResumeMarkdown } from './generators/resume';
import { generateSiteHtml } from './generators/site';

// Re-export the index types the UI consumes through the facade.
export type { ListFilters, RebuildReport };

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
