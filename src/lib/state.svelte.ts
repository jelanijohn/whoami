/**
 * Shared UI state (Svelte 5 runes).
 *
 * Owns the open {@link RecordStore}, the selected record folder, and the
 * derived view-model (entries, profile, git status). Every mutating action goes
 * through the store, which writes text first and then the index — the UI never
 * touches files or the database directly.
 */

import {
  RecordStore,
  gitInit,
  gitStatus,
  gitSync,
  type Entry,
  type GitStatus,
  type NewEntryInput,
  type Platform,
  type Profile,
  type ProjectSummary,
  type RebuildReport,
  type SyncResult
} from './core';
import { createTauriPlatform } from './platform-tauri';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

const LS_KEY = 'whoami:recordRoot';

class AppState {
  /** Absolute path to the open record folder, or null before one is chosen. */
  recordRoot = $state<string | null>(null);
  store = $state<RecordStore | null>(null);
  entries = $state<Entry[]>([]);
  profile = $state<Profile | null>(null);
  git = $state<GitStatus | null>(null);
  /** Project entries with their affiliated-entry counts (plan §2.3). Powers the
   * project filter and the inbox picker. */
  projects = $state<ProjectSummary[]>([]);
  /** Staged ingestion candidates awaiting review (plan §1). */
  candidates = $state<Entry[]>([]);

  busy = $state(false);
  message = $state('');
  error = $state('');

  // Timeline filters.
  search = $state('');
  filterType = $state('');
  filterProject = $state('');
  includePrivate = $state(false);

  /** Non-reactive handle to the platform (its plugin objects aren't state). */
  private platform: Platform | null = null;

  /** Restore the last-opened folder on launch, if any. */
  async init(): Promise<void> {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (saved) await this.openFolder(saved);
  }

  /** Prompt for a record folder and open it. */
  async chooseFolder(): Promise<void> {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: 'Select your Who Am I record folder'
    });
    if (typeof picked === 'string') await this.openFolder(picked);
  }

  /** Open (and, if empty, scaffold) a record folder, then build the index. */
  async openFolder(path: string): Promise<void> {
    this.busy = true;
    this.error = '';
    this.message = '';
    try {
      const platform = await createTauriPlatform(path);
      const store = new RecordStore(platform, path);
      await store.init(); // scaffold missing files + ensure schema
      await store.reindex(); // incremental build on open (spec §5)
      this.platform = platform;
      this.store = store;
      this.recordRoot = path;
      localStorage.setItem(LS_KEY, path);
      await this.refresh();
      this.message = `Opened ${path}`;
    } catch (e) {
      this.error = `Could not open folder: ${String(e)}`;
    } finally {
      this.busy = false;
    }
  }

  /** Re-read the timeline, profile, projects, and git status from disk/index. */
  async refresh(): Promise<void> {
    if (!this.store) return;
    this.entries = await this.store.listEntries({
      includePrivate: this.includePrivate,
      search: this.search.trim() || undefined,
      type: this.filterType || undefined,
      project: this.filterProject || undefined
    });
    this.projects = await this.store.listProjects(this.includePrivate);
    this.profile = await this.store.readProfile();
    await this.refreshGit();
  }

  async refreshGit(): Promise<void> {
    if (!this.platform || !this.recordRoot) return;
    try {
      this.git = await gitStatus(this.platform.git, this.recordRoot);
    } catch {
      this.git = null;
    }
  }

  // --- Entry CRUD -----------------------------------------------------------

  async createEntry(input: NewEntryInput): Promise<Entry | null> {
    if (!this.store) return null;
    return this.guard(async () => {
      const e = await this.store!.createEntry(input);
      await this.refresh();
      this.message = `Saved “${e.frontmatter.title}”`;
      return e;
    });
  }

  async updateEntry(entry: Entry): Promise<Entry | null> {
    if (!this.store) return null;
    return this.guard(async () => {
      const e = await this.store!.updateEntry(entry);
      await this.refresh();
      this.message = `Updated “${e.frontmatter.title}”`;
      return e;
    });
  }

  async deleteEntry(entry: Entry): Promise<void> {
    if (!this.store) return;
    await this.guard(async () => {
      await this.store!.deleteEntry(entry);
      await this.refresh();
      this.message = `Removed “${entry.frontmatter.title}” (still in Git history)`;
    });
  }

  // --- Candidate inbox (ingest review, plan §1–2) ---------------------------

  /** Load the staged candidates awaiting review. */
  async loadCandidates(): Promise<void> {
    if (!this.store) return;
    await this.guard(async () => {
      this.candidates = await this.store!.listCandidates();
      // The picker needs the current project list even before a timeline refresh.
      this.projects = await this.store!.listProjects(true);
    });
  }

  /** Promote a candidate into the record, assigning the picked project (plan
   * §2.4). An empty `project` clears any suggested affiliation. */
  async promoteCandidate(candidatePath: string, project = ''): Promise<Entry | null> {
    if (!this.store) return null;
    return this.guard(async () => {
      const e = await this.store!.promoteCandidate(candidatePath, { project });
      this.candidates = await this.store!.listCandidates();
      await this.refresh();
      this.message = `Promoted “${e.frontmatter.title}”`;
      return e;
    });
  }

  /** Reject a candidate: remembered so it is never re-proposed (plan §1). */
  async rejectCandidate(candidatePath: string, title = ''): Promise<void> {
    if (!this.store) return;
    await this.guard(async () => {
      await this.store!.rejectCandidate(candidatePath);
      this.candidates = await this.store!.listCandidates();
      this.message = title ? `Rejected “${title}”` : 'Rejected candidate';
    });
  }

  // --- Profile --------------------------------------------------------------

  async saveProfile(profile: Profile): Promise<void> {
    if (!this.store) return;
    await this.guard(async () => {
      await this.store!.saveProfile(profile);
      this.profile = await this.store!.readProfile();
      this.message = 'Profile saved';
    });
  }

  // --- Outputs --------------------------------------------------------------

  resumeMarkdown(): Promise<string> {
    return this.store ? this.store.resumeMarkdown() : Promise.resolve('');
  }
  siteHtml(): Promise<string> {
    return this.store ? this.store.siteHtml() : Promise.resolve('');
  }
  async exportResume(): Promise<void> {
    await this.guard(async () => {
      const rel = await this.store!.exportResume();
      this.message = `Wrote ${rel}`;
    });
  }
  async exportSite(): Promise<void> {
    await this.guard(async () => {
      const rel = await this.store!.exportSite();
      this.message = `Wrote ${rel}`;
    });
  }

  // --- Index maintenance ----------------------------------------------------

  async reindex(full = false): Promise<RebuildReport | null> {
    if (!this.store) return null;
    return this.guard(async () => {
      const report = full ? await this.store!.fullRebuild() : await this.store!.reindex();
      await this.refresh();
      this.message = `${full ? 'Full rebuild' : 'Reindex'}: ${report.indexed} indexed, ${report.skipped} unchanged, ${report.deleted} removed${report.errors.length ? `, ${report.errors.length} skipped` : ''}`;
      return report;
    });
  }

  // --- Git sync -------------------------------------------------------------

  async sync(message?: string): Promise<SyncResult | null> {
    if (!this.platform || !this.recordRoot) return null;
    return this.guard(async () => {
      const result = await gitSync(this.platform!.git, this.recordRoot!, { message });
      await this.refreshGit();
      this.message = result.message;
      if (!result.ok) this.error = result.message;
      return result;
    });
  }

  async gitInit(): Promise<void> {
    if (!this.platform || !this.recordRoot) return;
    await this.guard(async () => {
      await gitInit(this.platform!.git, this.recordRoot!);
      await this.refreshGit();
      this.message = 'Initialized a git repository';
    });
  }

  /** Run an async action with busy/error bookkeeping. */
  private async guard<T>(fn: () => Promise<T>): Promise<T | null> {
    this.busy = true;
    this.error = '';
    try {
      return await fn();
    } catch (e) {
      this.error = String(e);
      return null;
    } finally {
      this.busy = false;
    }
  }
}

export const app = new AppState();
