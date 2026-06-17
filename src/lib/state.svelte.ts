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
  makeLlm,
  ANTHROPIC_KEY_NAME,
  fetchGithub,
  fetchAsana,
  listAsanaProjects,
  fetchGmail,
  validateGithub,
  validateAsana,
  validateGmail,
  importLinkedinArchive,
  importClaudeCodeSessions,
  claudeCodeRootAllowed,
  claudeCodeProjectName,
  CLAUDE_CODE_DEFAULT_PROJECTS,
  importWarpConversations,
  warpProjectName,
  type WarpQueryRow,
  type WarpConversationMeta,
  parseResume,
  stageItems,
  selectNewItems,
  triageItems,
  llmTriageItems,
  DEFAULT_RUBRIC,
  type TriageRubric,
  GITHUB_TOKEN_NAME,
  ASANA_TOKEN_NAME,
  GMAIL_TOKEN_NAME,
  type AsanaFetchOpts,
  type AsanaProject,
  type Database,
  type Entry,
  type GitStatus,
  type GmailFetchOpts,
  type GithubFetchOpts,
  type Http,
  type IngestReport,
  type Llm,
  type LlmConfig,
  type NewEntryInput,
  type Platform,
  type Profile,
  type ProjectRollup,
  type ProjectSummary,
  type RawItem,
  type RebuildReport,
  type ReduceProposal,
  type SortDir,
  type SortKey,
  type SyncResult
} from './core';
import { createTauriPlatform } from './platform-tauri';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { homeDir, join, localDataDir } from '@tauri-apps/api/path';

const LS_KEY = 'whoami:recordRoot';
const LS_LLM = 'whoami:llm';
const LS_IMPORT = 'whoami:import';
/** Persisted Journal layout preferences (view/grouping/sort/private) so the
 * user's preferred layout sticks between sessions (design handoff). */
const LS_VIEW = 'whoami:journalView';

/** The four switchable Journal views (design handoff). */
export type JournalView = 'grouped' | 'timeline' | 'calendar' | 'table';
/** How the Grouped view buckets entries. */
export type JournalGroupBy = 'project' | 'type' | 'month';

/** Live (API) ingest sources. LinkedIn is import-only (archive), handled apart. */
export type LiveSource = 'github' | 'asana' | 'gmail';

/** Keyring entry name per live source — the token never leaves the keyring. */
const TOKEN_NAMES: Record<LiveSource, string> = {
  github: GITHUB_TOKEN_NAME,
  asana: ASANA_TOKEN_NAME,
  gmail: GMAIL_TOKEN_NAME
};

/** Non-secret import parameters, persisted on this machine (outside the record,
 * like {@link LlmConfig}). Tokens are NOT here — they live in the keyring. */
export interface ImportSettings {
  github: {
    user: string;
    repo: string;
    since: string;
    until: string;
    limit: number;
    baseUrl: string;
    /** Fetch PR/issue discussion in addition to the description (spec §1). */
    fetchDiscussion: boolean;
    commentScope: 'self' | 'all';
    /** Blank ⇒ omit ⇒ adapter default (2000). Stored as a string for the input. */
    discussionCharCap: string;
    /** Stage candidates as `private: true` (default). Unchecking stages them
     * public from the start — the user's deliberate opt-out of the protective
     * default for this source. */
    importPrivate: boolean;
  };
  asana: {
    workspace: string;
    /** Project gid to scope the fetch to ('' ⇒ the whole workspace). Chosen via
     * the picker fed by {@link AppState.loadAsanaProjects}. */
    project: string;
    since: string;
    until: string;
    /** Include completed tasks (default true — historical reconstruction). */
    includeCompleted: boolean;
    limit: number;
  };
  gmail: { query: string; limit: number };
  /** Triage settings (spec §6): the per-import LLM flag (off by default) plus
   * optional rubric overrides. Persisted here (localStorage), never the record. */
  triage: { useLlm: boolean; rubric?: Partial<TriageRubric> };
}

export const DEFAULT_IMPORT_SETTINGS: ImportSettings = {
  github: {
    user: '',
    repo: '',
    since: '',
    until: '',
    limit: 50,
    baseUrl: '',
    fetchDiscussion: false,
    commentScope: 'self',
    discussionCharCap: '',
    importPrivate: true
  },
  asana: { workspace: '', project: '', since: '', until: '', includeCompleted: true, limit: 100 },
  gmail: { query: '', limit: 25 },
  triage: { useLlm: false }
};

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
  /** Non-secret per-source import params, persisted outside the record. */
  importSettings = $state<ImportSettings>(structuredClone(DEFAULT_IMPORT_SETTINGS));
  /** Import-time project pre-selection (slug, '' ⇒ none). Seeds the `project`
   * frontmatter of every candidate staged by the next import so the inbox picker
   * defaults to it. Transient on purpose — project slugs are record-specific, so
   * it is NOT persisted like {@link importSettings} and resets each session. */
  importProject = $state('');
  /** Which live sources currently have a token in the keyring (TODO §2.1). */
  tokenPresent = $state<Record<string, boolean>>({});
  /** Asana projects fetched for the import picker (empty until "Load projects").
   * Transient — project gids are account-specific, so it is not persisted. */
  asanaProjects = $state<AsanaProject[]>([]);
  /** Claude Code projects discovered under `~/.claude/projects/` (empty until
   * "Find projects"). Each carries the raw sanitized-cwd root dir, a friendly
   * name, and its count of top-level session files. Transient — the roots are
   * machine-specific, so this is not persisted. */
  claudeCodeProjects = $state<{ root: string; name: string; sessions: number }[]>([]);
  /** Root dir names the user has selected to import (subset of
   * {@link claudeCodeProjects}). Transient, like the discovered list. */
  claudeCodeSelected = $state<string[]>([]);
  /** Warp projects discovered in `warp.sqlite` (empty until "Find projects").
   * Each is a `working_directory` the Agent ran in, with a friendly name and its
   * count of conversations. Transient — machine-specific, so not persisted. */
  warpProjects = $state<{ dir: string; name: string; conversations: number }[]>([]);
  /** Working dirs the user has selected to import (subset of {@link warpProjects}). */
  warpSelected = $state<string[]>([]);
  /** Result of the most recent import run, surfaced after each fetch. */
  lastImportReport = $state<IngestReport | null>(null);
  /** Persisted LLM provider choice (plan §3), or null when none is configured. */
  llmConfig = $state<LlmConfig | null>(null);
  /** True when an {@link Llm} is actually built and ready to call. */
  llmReady = $state(false);
  /** True when the platform can parse PDF/DOCX (the {@link DocExtract} seam is
   * present). Drives whether résumé import is offered (résumé spec §6). */
  docsAvailable = $state(false);

  busy = $state(false);
  message = $state('');
  error = $state('');

  // Journal filters + sort (design handoff). These drive the index query in
  // {@link refresh} — the views never re-filter in memory.
  search = $state('');
  /** Multi-select entry types; empty ⇒ all types. Replaces the old single
   * `filterType`. */
  selTypes = $state<string[]>([]);
  filterProject = $state('');
  filterTag = $state('');
  /** Inclusive date bounds (YYYY-MM-DD) or '' for open-ended. */
  dateFrom = $state('');
  dateTo = $state('');
  includePrivate = $state(false);
  sortKey = $state<SortKey>('date');
  sortDir = $state<SortDir>('desc');

  // Journal layout (persisted, see {@link savePrefs}).
  view = $state<JournalView>('grouped');
  groupBy = $state<JournalGroupBy>('project');

  /** Tags with usage counts (most-used first) for the tag filter. */
  tags = $state<{ tag: string; count: number }[]>([]);
  /** Entry count per type (honoring the privacy toggle) for the type chips. */
  typeCounts = $state<Record<string, number>>({});
  /** Total entries matching only the privacy toggle — the unfiltered baseline
   * the header subtitle compares the filtered count against. */
  total = $state(0);

  /** Non-reactive handle to the platform (its plugin objects aren't state). */
  private platform: Platform | null = null;
  /** Non-reactive built LLM client (its closures aren't state). */
  private llm: Llm | null = null;

  /** Restore the last-opened folder and LLM config on launch, if any. */
  async init(): Promise<void> {
    if (typeof localStorage !== 'undefined') {
      const rawLlm = localStorage.getItem(LS_LLM);
      if (rawLlm) {
        try {
          this.llmConfig = JSON.parse(rawLlm) as LlmConfig;
        } catch {
          /* ignore a corrupt setting */
        }
      }
      const rawImport = localStorage.getItem(LS_IMPORT);
      if (rawImport) {
        try {
          const p = JSON.parse(rawImport) as Partial<ImportSettings>;
          this.importSettings = {
            github: { ...DEFAULT_IMPORT_SETTINGS.github, ...p.github },
            asana: { ...DEFAULT_IMPORT_SETTINGS.asana, ...p.asana },
            gmail: { ...DEFAULT_IMPORT_SETTINGS.gmail, ...p.gmail },
            triage: { ...DEFAULT_IMPORT_SETTINGS.triage, ...p.triage }
          };
        } catch {
          /* ignore a corrupt setting */
        }
      }
      const rawView = localStorage.getItem(LS_VIEW);
      if (rawView) {
        try {
          const v = JSON.parse(rawView) as Partial<{
            view: JournalView;
            groupBy: JournalGroupBy;
            sortKey: SortKey;
            sortDir: SortDir;
            includePrivate: boolean;
          }>;
          if (v.view) this.view = v.view;
          if (v.groupBy) this.groupBy = v.groupBy;
          if (v.sortKey) this.sortKey = v.sortKey;
          if (v.sortDir) this.sortDir = v.sortDir;
          if (typeof v.includePrivate === 'boolean') this.includePrivate = v.includePrivate;
        } catch {
          /* ignore a corrupt setting */
        }
      }
      const saved = localStorage.getItem(LS_KEY);
      if (saved) await this.openFolder(saved);
    }
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
      this.docsAvailable = !!platform.docs;
      localStorage.setItem(LS_KEY, path);
      await this.buildLlm();
      await this.refreshTokenPresence();
      await this.refresh();
      this.message = `Opened ${path}`;
    } catch (e) {
      this.error = `Could not open folder: ${String(e)}`;
    } finally {
      this.busy = false;
    }
  }

  /** Re-read the timeline, profile, projects, and git status from disk/index.
   * All Journal filters/sort are pushed into the index query here — the views
   * read the returned page and never re-filter in memory (design handoff). */
  async refresh(): Promise<void> {
    if (!this.store) return;
    this.entries = await this.store.listEntries({
      includePrivate: this.includePrivate,
      search: this.search.trim() || undefined,
      types: this.selTypes.length ? this.selTypes : undefined,
      project: this.filterProject || undefined,
      tag: this.filterTag || undefined,
      dateFrom: this.dateFrom || undefined,
      dateTo: this.dateTo || undefined,
      sort: { key: this.sortKey, dir: this.sortDir }
    });
    this.projects = await this.store.listProjects(this.includePrivate);
    this.tags = await this.store.tagCounts(this.includePrivate);
    this.typeCounts = await this.store.countsByType(this.includePrivate);
    this.total = Object.values(this.typeCounts).reduce((a, b) => a + b, 0);
    this.profile = await this.store.readProfile();
    await this.refreshGit();
  }

  /** Toggle a type in/out of the multi-select set (empty ⇒ all types). */
  toggleType(type: string): void {
    this.selTypes = this.selTypes.includes(type)
      ? this.selTypes.filter((t) => t !== type)
      : [...this.selTypes, type];
  }

  /** True when any filter narrows the timeline (drives the Clear button +
   * the header subtitle). Private being hidden counts as an active filter. */
  get activeFilters(): boolean {
    return !!(
      this.search ||
      this.selTypes.length ||
      this.filterProject ||
      this.filterTag ||
      this.dateFrom ||
      this.dateTo ||
      !this.includePrivate
    );
  }

  /** Reset every filter and re-enable private (design handoff). The caller is
   * responsible for the follow-up {@link refresh}. */
  clearFilters(): void {
    this.search = '';
    this.selTypes = [];
    this.filterProject = '';
    this.filterTag = '';
    this.dateFrom = '';
    this.dateTo = '';
    this.includePrivate = true;
  }

  /** Persist the layout preferences (view/grouping/sort/private). */
  savePrefs(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      LS_VIEW,
      JSON.stringify({
        view: this.view,
        groupBy: this.groupBy,
        sortKey: this.sortKey,
        sortDir: this.sortDir,
        includePrivate: this.includePrivate
      })
    );
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

  /** Assign an existing entry to a project (or clear it with an empty slug),
   * for filing old entries from the timeline. Goes through the normal write
   * path: text first (with `project` set/removed), then a single-file reindex. */
  async setEntryProject(entry: Entry, slug: string): Promise<Entry | null> {
    if (!this.store) return null;
    const project = slug.trim();
    if ((typeof entry.frontmatter.project === 'string' ? entry.frontmatter.project : '') === project) {
      return entry; // no-op: already affiliated as requested
    }
    const frontmatter = { ...entry.frontmatter };
    if (project) frontmatter.project = project;
    else delete frontmatter.project;
    return this.guard(async () => {
      const e = await this.store!.updateEntry({ ...entry, frontmatter });
      await this.refresh();
      this.message = project
        ? `Filed “${e.frontmatter.title}” under ${project}`
        : `Cleared project on “${e.frontmatter.title}”`;
      return e;
    });
  }

  /** Flip the `private` flag on several entries in one pass. Skips entries
   * already in the requested state, then writes each through the normal
   * text-first path and reindexes — a single `refresh()` at the end keeps the
   * timeline consistent (mirrors {@link promoteCandidates}). */
  async bulkSetPrivate(entries: Entry[], isPrivate: boolean): Promise<number> {
    if (!this.store) return 0;
    const targets = entries.filter((e) => (e.frontmatter.private ?? false) !== isPrivate);
    if (targets.length === 0) return 0;
    return (
      (await this.guard(async () => {
        let ok = 0;
        for (const e of targets) {
          const frontmatter = { ...e.frontmatter, private: isPrivate };
          await this.store!.updateEntry({ ...e, frontmatter });
          ok++;
        }
        await this.refresh();
        this.message = `Marked ${ok} ${ok === 1 ? 'entry' : 'entries'} ${isPrivate ? 'private' : 'public'}`;
        return ok;
      })) ?? 0
    );
  }

  /** Assign (or clear, with an empty slug) the `project` affiliation on several
   * entries at once — the bulk counterpart of {@link setEntryProject}. */
  async bulkSetProject(entries: Entry[], slug: string): Promise<number> {
    if (!this.store) return 0;
    const project = slug.trim();
    const targets = entries.filter(
      (e) => (typeof e.frontmatter.project === 'string' ? e.frontmatter.project : '') !== project
    );
    if (targets.length === 0) return 0;
    return (
      (await this.guard(async () => {
        let ok = 0;
        for (const e of targets) {
          const frontmatter = { ...e.frontmatter };
          if (project) frontmatter.project = project;
          else delete frontmatter.project;
          await this.store!.updateEntry({ ...e, frontmatter });
          ok++;
        }
        await this.refresh();
        this.message = project
          ? `Filed ${ok} ${ok === 1 ? 'entry' : 'entries'} under ${project}`
          : `Cleared project on ${ok} ${ok === 1 ? 'entry' : 'entries'}`;
        return ok;
      })) ?? 0
    );
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

  /** Authoritative check for an existing `type: project` entry with this slug,
   * across all privacy levels — the inbox prompt must not offer to re-create a
   * project that already exists but happens to be private. */
  async projectExists(slug: string): Promise<boolean> {
    const s = slug.trim();
    if (!this.store || !s) return false;
    const projects = await this.store.listProjects(true);
    return projects.some((p) => p.slug === s);
  }

  /**
   * Create a new `type: project` entry titled `name` for a candidate whose
   * affiliation slug (`oldSlug`) has no project yet (inbox promote gate). After
   * minting the project, every other staged candidate that referenced `oldSlug`
   * is relabelled to the new project's slug, so the rest of the inbox follows
   * the (possibly edited) name in one pass. Reloads candidates + projects so the
   * picker shows the new project immediately. Returns the new project's slug, or
   * null if creation failed.
   */
  async createProjectFromCandidate(name: string, oldSlug: string): Promise<string | null> {
    if (!this.store) return null;
    return this.guard(async () => {
      const project = await this.store!.createEntry({ type: 'project', title: name.trim() });
      const newSlug = typeof project.frontmatter.slug === 'string' ? project.frontmatter.slug : '';
      const moved = newSlug ? await this.store!.relabelCandidateProject(oldSlug, newSlug) : 0;
      this.candidates = await this.store!.listCandidates();
      await this.refresh();
      this.message =
        `Created project “${project.frontmatter.title}”` +
        (moved ? ` · moved ${moved} other inbox item${moved === 1 ? '' : 's'} to it` : '');
      return newSlug;
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

  /** Promote several candidates in one pass, reloading + refreshing once at the
   * end rather than per item. A single item failing doesn't abort the rest;
   * the toast reports how many succeeded. Returns the count promoted. */
  async promoteCandidates(items: { path: string; project?: string }[]): Promise<number> {
    if (!this.store || items.length === 0) return 0;
    return (
      (await this.guard(async () => {
        let ok = 0;
        let failed = 0;
        for (const { path, project = '' } of items) {
          try {
            await this.store!.promoteCandidate(path, { project });
            ok++;
          } catch {
            failed++;
          }
        }
        this.candidates = await this.store!.listCandidates();
        await this.refresh();
        this.message = `Promoted ${ok} candidate${ok === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`;
        return ok;
      })) ?? 0
    );
  }

  /** Re-run the prefilter over the already-staged inbox so a rubric change
   * (e.g. broadened triage patterns) reaches existing candidates, not just
   * future imports. Prefilter-only — local, no LLM. */
  async retriageInbox(): Promise<void> {
    if (!this.store) return;
    await this.guard(async () => {
      const res = await this.store!.retriageCandidates(this.triageRubric());
      this.candidates = await this.store!.listCandidates();
      this.message = `Re-triaged ${res.total}: ${res.frivolous} frivolous, ${res.keep} keep${
        res.updated ? ` (${res.updated} changed)` : ' (no changes)'
      }`;
    });
  }

  /** Run the kept inbox candidates through the LLM triage pass to catch
   * frivolous cases the deterministic prefilter misses. Annotation only — items
   * stay in the inbox; some `keep` flip to `frivolous` (triage spec §0). No-op
   * with a clear message when no provider is configured. */
  async llmTriageInbox(extraInstructions?: string): Promise<void> {
    if (!this.store) return;
    if (!this.llmReady || !this.llm) {
      this.message = 'Configure an AI provider first (Data → AI provider)';
      return;
    }
    await this.guard(async () => {
      // Only the `keep` set needs the model — already-frivolous items are caught.
      const targets = await this.store!.candidateRawItems({ signal: 'keep' });
      if (targets.length === 0) {
        this.message = 'No kept candidates to send to the model';
        return;
      }
      const model = this.llmConfig ? `${this.llmConfig.provider}:${this.llmConfig.model}` : undefined;
      const results = await llmTriageItems(
        targets.map((t) => t.item),
        { llm: this.llm!, model, rubric: this.triageRubric(), extraInstructions }
      );
      // Only persist the model's frivolous findings — re-affirming `keep` would
      // rewrite every kept candidate to no effect. Items stay in the inbox.
      const flagged = new Map([...results].filter(([, r]) => r.signal === 'frivolous'));
      const res = await this.store!.applyTriageResults(flagged);
      this.candidates = await this.store!.listCandidates();
      this.message = `LLM triage: flagged ${res.frivolous} of ${targets.length} kept item${
        targets.length === 1 ? '' : 's'
      } as frivolous`;
    });
  }

  /** Reject several candidates in one pass (see {@link promoteCandidates}).
   * Returns the count rejected. */
  async rejectCandidates(paths: string[]): Promise<number> {
    if (!this.store || paths.length === 0) return 0;
    return (
      (await this.guard(async () => {
        let ok = 0;
        let failed = 0;
        for (const path of paths) {
          try {
            await this.store!.rejectCandidate(path);
            ok++;
          } catch {
            failed++;
          }
        }
        this.candidates = await this.store!.listCandidates();
        this.message = `Rejected ${ok} candidate${ok === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`;
        return ok;
      })) ?? 0
    );
  }

  // --- Ingest import (TODO §2 — populate the inbox) -------------------------

  /** Persist the non-secret import params (outside the record repo). Quiet —
   * it runs on every import, so the import result owns the toast. */
  saveImportSettings(settings: ImportSettings): void {
    this.importSettings = settings;
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_IMPORT, JSON.stringify(settings));
  }

  /** Store (or, when blank, clear) a provider token in the OS keyring via the
   * Secrets seam — never the record repo (plan §1). */
  async setSourceToken(source: LiveSource, token: string): Promise<void> {
    await this.guard(async () => {
      if (!this.platform?.secrets) throw new Error('No secret storage available on this platform');
      const t = token.trim();
      if (t) await this.platform.secrets.set(TOKEN_NAMES[source], t);
      else await this.platform.secrets.delete(TOKEN_NAMES[source]);
      await this.refreshTokenPresence();
      this.message = t ? `Saved ${source} token` : `Cleared ${source} token`;
    });
  }

  /** Refresh which live sources have a token saved (drives the UI status). */
  async refreshTokenPresence(): Promise<void> {
    const secrets = this.platform?.secrets;
    if (!secrets) {
      this.tokenPresent = {};
      return;
    }
    const out: Record<string, boolean> = {};
    for (const source of Object.keys(TOKEN_NAMES) as LiveSource[]) {
      const v = await secrets.get(TOKEN_NAMES[source]);
      out[source] = !!v && v.trim().length > 0;
    }
    this.tokenPresent = out;
  }

  /** Cheap credential check against the provider (mirrors {@link testLlm}). */
  async testSourceToken(source: LiveSource): Promise<void> {
    await this.guard(async () => {
      const http = this.platform?.http;
      const secrets = this.platform?.secrets;
      if (!http || !secrets) throw new Error('This platform has no network/secret support');
      const token = await secrets.get(TOKEN_NAMES[source]);
      if (!token) throw new Error(`No ${source} token saved`);
      if (source === 'github') await validateGithub(http, token, this.importSettings.github.baseUrl || undefined);
      else if (source === 'asana') await validateAsana(http, token);
      else await validateGmail(http, token);
      this.message = `${source} token looks valid`;
    });
  }

  /** Fetch the workspace's projects to populate the Asana import picker. Needs a
   * saved token; resolves the workspace from settings, or the account's first. */
  async loadAsanaProjects(): Promise<void> {
    await this.guard(async () => {
      const http = this.platform?.http;
      const secrets = this.platform?.secrets;
      if (!http || !secrets) throw new Error('This platform has no network/secret support');
      const token = await secrets.get(TOKEN_NAMES.asana);
      if (!token) throw new Error('No asana token saved — add one first');
      this.asanaProjects = await listAsanaProjects(http, {
        token,
        workspace: this.importSettings.asana.workspace.trim() || undefined
      });
      this.message = `Loaded ${this.asanaProjects.length} Asana project${this.asanaProjects.length === 1 ? '' : 's'}`;
    });
  }

  /**
   * Enumerate the projects under `~/.claude/projects/` to populate the Claude
   * Code import picker. Each root dir holds one project's session logs; we count
   * its top-level `*.jsonl` files and skip roots with none (Claude Code internals
   * like `memory/`). The previously-default scope (whoami/waid) is pre-selected
   * when present, so the common case stays one extra click — but every project is
   * now offered, and the human chooses the scope (spec §7 opt-in stays explicit).
   */
  async loadClaudeCodeProjects(): Promise<void> {
    await this.guard(async () => {
      if (!this.platform) throw new Error('Open a record folder first');
      const fs = this.platform.fs;
      const projectsDir = await join(await homeDir(), '.claude', 'projects');
      const roots = await fs.readDir(projectsDir);
      const found: { root: string; name: string; sessions: number }[] = [];
      for (const root of roots) {
        const rootPath = await join(projectsDir, root);
        const sessions = (await fs.readDir(rootPath)).filter((n) => n.endsWith('.jsonl')).length;
        if (sessions > 0) found.push({ root, name: claudeCodeProjectName(root), sessions });
      }
      found.sort((a, b) => a.name.localeCompare(b.name));
      this.claudeCodeProjects = found;
      this.claudeCodeSelected = found
        .filter((f) => claudeCodeRootAllowed(f.root, CLAUDE_CODE_DEFAULT_PROJECTS))
        .map((f) => f.root);
      if (found.length === 0) throw new Error(`No Claude Code projects with sessions under ${projectsDir}`);
      this.message = `Found ${found.length} Claude Code project${found.length === 1 ? '' : 's'}`;
    });
  }

  /** The effective triage rubric: shipped defaults overlaid with any owner
   * overrides persisted in `importSettings` (never the record repo, spec §5). */
  private triageRubric(): TriageRubric {
    return { ...DEFAULT_RUBRIC, ...(this.importSettings.triage.rubric ?? {}) };
  }

  /** Run the import-action triage pass over the fresh items (triage spec §6).
   * The deterministic prefilter always runs; the LLM is engaged only when the
   * per-import flag is set AND a provider is actually ready, and even then only
   * over the prefilter-`unsure` remainder. Stays out of `stageItems`/`pipeline`
   * so the staging boundary never calls an LLM (spec §0 rule 2). */
  private triageFresh(fresh: RawItem[], useLlmTriage: boolean) {
    const useLlm = useLlmTriage && this.llmReady && this.llm !== null;
    return triageItems(fresh, {
      rubric: this.triageRubric(),
      llm: useLlm ? this.llm : null,
      model: useLlm && this.llmConfig ? `${this.llmConfig.provider}:${this.llmConfig.model}` : undefined
    });
  }

  /** Shared run path: pull the token, fetch via the adapter, triage the fresh
   * items, then stage candidates and reload the inbox. Stays behind the Stage-1
   * boundary — `stageItems` never writes into `entries/` and never calls an LLM;
   * the triage pass (which may, when the flag is set, classify the ambiguous
   * remainder before staging) lives here in the import-action layer. */
  private runStage(
    source: LiveSource,
    fetcher: (http: Http, token: string) => Promise<RawItem[]>,
    opts: { useLlmTriage: boolean; private?: boolean }
  ): Promise<IngestReport | null> {
    return this.guard(async () => {
      if (!this.store) throw new Error('Open a record folder first');
      const http = this.platform?.http;
      const secrets = this.platform?.secrets;
      if (!http || !secrets) throw new Error('This platform has no network/secret support');
      const token = await secrets.get(TOKEN_NAMES[source]);
      if (!token) throw new Error(`No ${source} token saved — add one first`);
      const items = await fetcher(http, token);
      // Triage only the items a stage run would actually keep, so the LLM never
      // sees already-promoted/rejected content (spec §6). Pass the full `items`
      // to stageItems so its report still counts those skips.
      const fresh = await selectNewItems(this.store, items);
      const signals = await this.triageFresh(fresh, opts.useLlmTriage);
      const report = await stageItems(this.store, items, {
        signals,
        private: opts.private,
        project: this.importProject
      });
      this.lastImportReport = report;
      await this.loadCandidates();
      const known = report.skippedPromoted + report.skippedRejected;
      this.message = `${source}: staged ${report.staged}, ${known} already known${report.errors.length ? `, ${report.errors.length} errors` : ''}`;
      return report;
    });
  }

  importGithub(params: Omit<GithubFetchOpts, 'token'>): Promise<IngestReport | null> {
    return this.runStage('github', (http, token) => fetchGithub(http, { ...params, token }), {
      useLlmTriage: this.importSettings.triage.useLlm,
      private: this.importSettings.github.importPrivate
    });
  }
  importAsana(params: Omit<AsanaFetchOpts, 'token'>): Promise<IngestReport | null> {
    return this.runStage('asana', (http, token) => fetchAsana(http, { ...params, token }), {
      useLlmTriage: this.importSettings.triage.useLlm
    });
  }
  importGmail(params: Omit<GmailFetchOpts, 'token'>): Promise<IngestReport | null> {
    return this.runStage('gmail', (http, token) => fetchGmail(http, { ...params, token }), {
      useLlmTriage: this.importSettings.triage.useLlm
    });
  }

  /** LinkedIn is import-only (plan §1): pick the export CSVs, parse, stage.
   * No token, no network — pure file → candidates. Returns null on cancel. */
  async importLinkedin(): Promise<IngestReport | null> {
    return this.guard(async () => {
      if (!this.store || !this.platform) throw new Error('Open a record folder first');
      const picked = await openDialog({
        multiple: true,
        title: 'Select LinkedIn export CSVs (Positions.csv, Projects.csv, Education.csv)',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length === 0) return null; // cancelled
      const files: Record<string, string> = {};
      for (const p of paths) {
        // Key by basename (cross-platform): the archive mapper matches on it.
        const base = p.split(/[\\/]/).pop() ?? p;
        files[base] = await this.platform.fs.readTextFile(p);
      }
      const items = importLinkedinArchive(files);
      if (items.length === 0) {
        throw new Error('No Positions.csv / Projects.csv / Education.csv rows found in the selected files');
      }
      // LinkedIn runs prefilter-only — archive rows are record-grade, always
      // `keep`, and are never sent to the LLM (spec §4).
      const fresh = await selectNewItems(this.store, items);
      const signals = await this.triageFresh(fresh, false);
      const report = await stageItems(this.store, items, { signals, project: this.importProject });
      this.lastImportReport = report;
      await this.loadCandidates();
      const known = report.skippedPromoted + report.skippedRejected;
      this.message = `linkedin: staged ${report.staged}, ${known} already known${report.errors.length ? `, ${report.errors.length} errors` : ''}`;
      return report;
    });
  }

  /**
   * Claude Code history import (claude-code-adapter spec §3, §9): zero-auth,
   * import-only. Given the `roots` the human selected in the picker (fed by
   * {@link loadClaudeCodeProjects}), reads only those roots' top-level `*.jsonl`
   * files and hands the text to the pure core mapper. Per-project opt-in (spec
   * §7) is preserved — the human chooses the scope rather than a fixed allowlist.
   * No token, no network — local files → candidates. Returns null when no
   * sessions are found.
   *
   * Chat history is the most sensitive source in the system (spec §7), so this
   * runs **prefilter-only** like LinkedIn/résumé — session content is never sent
   * to a cloud triage model — and every candidate stays private by default.
   */
  async importClaudeCode(roots: string[]): Promise<IngestReport | null> {
    return this.guard(async () => {
      if (!this.store || !this.platform) throw new Error('Open a record folder first');
      if (roots.length === 0) throw new Error('Select at least one Claude Code project to import');
      const fs = this.platform.fs;
      const projectsDir = await join(await homeDir(), '.claude', 'projects');
      // Read only top-level *.jsonl per selected root — sibling session-id dirs
      // and memory/ are Claude Code internals and stay ignored (spec §2).
      const files: Record<string, string> = {};
      for (const root of roots) {
        const rootPath = await join(projectsDir, root);
        for (const name of await fs.readDir(rootPath)) {
          if (!name.endsWith('.jsonl')) continue;
          const path = await join(rootPath, name);
          files[path] = await fs.readTextFile(path);
        }
      }
      const items = importClaudeCodeSessions(files);
      if (items.length === 0) {
        throw new Error('No Claude Code sessions with a genuine human turn found in scope');
      }
      const fresh = await selectNewItems(this.store, items);
      const signals = await this.triageFresh(fresh, false);
      const report = await stageItems(this.store, items, { signals, project: this.importProject });
      this.lastImportReport = report;
      await this.loadCandidates();
      const known = report.skippedPromoted + report.skippedRejected;
      this.message = `claude-code: staged ${report.staged}, ${known} already known${report.errors.length ? `, ${report.errors.length} errors` : ''}`;
      return report;
    });
  }

  /**
   * Resolve the local Warp SQLite path across platforms, or null when none of
   * the known locations exist. Windows: `%LOCALAPPDATA%\warp\Warp\data`; macOS:
   * the Warp-Stable app-support dir (sandboxed + non-sandboxed); Linux: the XDG
   * state dir then the older share dir.
   */
  private async warpDbPath(): Promise<string | null> {
    if (!this.platform) return null;
    const fs = this.platform.fs;
    const home = await homeDir();
    // Path under a Windows %LOCALAPPDATA% (native Windows) or a mounted Windows
    // drive (WSL): warp/Warp/data/warp.sqlite.
    const winRel = ['warp', 'Warp', 'data', 'warp.sqlite'];
    const candidates: string[] = [];
    try {
      candidates.push(await join(await localDataDir(), ...winRel));
    } catch {
      // localDataDir may be unavailable on some platforms — skip that candidate.
    }
    candidates.push(
      await join(home, 'Library', 'Application Support', 'dev.warp.Warp-Stable', 'warp.sqlite'),
      await join(home, 'Library', 'Group Containers', '2BBY89MBSN.dev.warp', 'Library', 'Application Support', 'dev.warp.Warp-Stable', 'warp.sqlite'),
      await join(home, '.local', 'state', 'warp-terminal', 'warp.sqlite'),
      await join(home, '.local', 'share', 'warp-terminal', 'warp.sqlite')
    );
    // WSL: the app runs on Linux but Warp lives on a mounted Windows drive at
    // /mnt/<drive>/Users/<user>/AppData/Local/warp/Warp/data/warp.sqlite. Probe
    // each drive's user dirs (Windows usernames differ from the Linux one).
    for (const drive of ['c', 'd', 'e']) {
      const users = `/mnt/${drive}/Users`;
      if (!(await fs.exists(users))) continue;
      for (const user of await fs.readDir(users)) {
        candidates.push(await join(users, user, 'AppData', 'Local', ...winRel));
      }
    }
    for (const p of candidates) {
      if (await fs.exists(p)) return p;
    }
    return null;
  }

  /** Open Warp's `warp.sqlite` read-only, or throw a clear message when the
   * platform can't open external DBs / no Warp DB is present. */
  private async openWarpDb(): Promise<Database> {
    if (!this.platform?.openDatabase) throw new Error('This platform cannot open external databases');
    const path = await this.warpDbPath();
    if (!path) throw new Error('No Warp database found — open Warp at least once, then retry');
    return this.platform.openDatabase(path);
  }

  /** Map each Warp conversation to its primary (most-frequent) working_directory,
   * the project we anchor its candidate to. One lightweight scan of `ai_queries`. */
  private async warpConversationDirs(db: Database): Promise<Map<string, string>> {
    const rows = await db.select<{ conversation_id: string; working_directory: string | null }>(
      `SELECT conversation_id, working_directory FROM ai_queries`
    );
    const perConv = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!r.conversation_id || !r.working_directory) continue;
      let counts = perConv.get(r.conversation_id);
      if (!counts) perConv.set(r.conversation_id, (counts = new Map()));
      counts.set(r.working_directory, (counts.get(r.working_directory) ?? 0) + 1);
    }
    const primary = new Map<string, string>();
    for (const [conv, counts] of perConv) {
      let best = '';
      let bestN = 0;
      for (const [wd, n] of counts) if (n > bestN) ((best = wd), (bestN = n));
      if (best) primary.set(conv, best);
    }
    return primary;
  }

  /**
   * Enumerate the projects (working directories) in Warp's local `warp.sqlite`
   * to populate the Warp import picker. Each entry is a directory the Agent ran
   * in, with its conversation count. Every project is offered — the human chooses
   * the scope (per-project opt-in, like the Claude Code flow). Read-only.
   */
  async loadWarpProjects(): Promise<void> {
    await this.guard(async () => {
      if (!this.platform) throw new Error('Open a record folder first');
      const db = await this.openWarpDb();
      try {
        const primary = await this.warpConversationDirs(db);
        const counts = new Map<string, number>();
        for (const dir of primary.values()) counts.set(dir, (counts.get(dir) ?? 0) + 1);
        const found = [...counts.entries()]
          .map(([dir, conversations]) => ({ dir, name: warpProjectName(dir), conversations }))
          .sort((a, b) => a.name.localeCompare(b.name));
        this.warpProjects = found;
        this.warpSelected = [];
        if (found.length === 0) throw new Error('No Warp Agent conversations found in warp.sqlite');
        this.message = `Found ${found.length} Warp project${found.length === 1 ? '' : 's'}`;
      } finally {
        await db.close();
      }
    });
  }

  /**
   * Warp Agent-mode history import (warp-adapter spec): zero-auth, import-only.
   * Given the working `dirs` the human selected in the picker (fed by
   * {@link loadWarpProjects}), reads the `ai_queries` rows for conversations
   * anchored to those dirs (plus the optional `agent_conversations` enrichment)
   * and hands them to the pure core mapper. One conversation = one candidate.
   *
   * Like Claude Code, chat history is the most sensitive source (spec §7), so
   * this runs **prefilter-only** — conversation content never reaches a cloud
   * triage model — and every candidate stays private by default. Read-only: the
   * Warp DB is opened with `mode=ro&immutable=1`, never written or locked.
   */
  async importWarp(dirs: string[]): Promise<IngestReport | null> {
    return this.guard(async () => {
      if (!this.store || !this.platform) throw new Error('Open a record folder first');
      if (dirs.length === 0) throw new Error('Select at least one Warp project to import');
      const db = await this.openWarpDb();
      try {
        const primary = await this.warpConversationDirs(db);
        const wanted = new Set(dirs);
        const convIds = [...primary.entries()].filter(([, dir]) => wanted.has(dir)).map(([id]) => id);
        if (convIds.length === 0) throw new Error('No Warp conversations in the selected projects');
        const ph = convIds.map(() => '?').join(',');
        const rows = (await db.select(
          `SELECT conversation_id, start_ts, input, working_directory, output_status,
                  model_id, planning_model_id, coding_model_id
             FROM ai_queries WHERE conversation_id IN (${ph})`,
          convIds
        )) as unknown as WarpQueryRow[];
        const metaRows = (await db.select(
          `SELECT conversation_id, conversation_data, last_modified_at
             FROM agent_conversations WHERE conversation_id IN (${ph})`,
          convIds
        )) as unknown as WarpConversationMeta[];
        const metas: Record<string, WarpConversationMeta> = {};
        for (const m of metaRows) metas[m.conversation_id] = m;

        const items = importWarpConversations(rows, metas);
        if (items.length === 0) throw new Error('No Warp conversations with a genuine prompt found in scope');
        const fresh = await selectNewItems(this.store, items);
        const signals = await this.triageFresh(fresh, false);
        const report = await stageItems(this.store, items, { signals, project: this.importProject });
        this.lastImportReport = report;
        await this.loadCandidates();
        const known = report.skippedPromoted + report.skippedRejected;
        this.message = `warp: staged ${report.staged}, ${known} already known${report.errors.length ? `, ${report.errors.length} errors` : ''}`;
        return report;
      } finally {
        await db.close();
      }
    });
  }

  /**
   * Résumé import (résumé spec §6): a .pdf/.docx → LLM parse → candidate inbox.
   * The LLM is MANDATORY here — arbitrary résumé prose has no deterministic
   * parse — so with no document reader or no provider the action refuses rather
   * than falling back (spec §0 rule 2). The parse runs in this import-action
   * layer, BEFORE `stageItems`; the staging boundary never calls an LLM.
   * Returns null on cancel.
   */
  async importResume(): Promise<IngestReport | null> {
    return this.guard(async () => {
      if (!this.store || !this.platform) throw new Error('Open a record folder first');
      // Guard (spec §6 step 1) — no silent or partial fallback.
      if (!this.platform.docs || !this.llmReady || !this.llm) {
        throw new Error('Résumé import needs a document reader and a configured LLM provider');
      }
      const picked = await openDialog({
        multiple: false,
        title: 'Select a résumé (PDF or DOCX)',
        filters: [{ name: 'Résumé', extensions: ['pdf', 'docx'] }]
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return null; // cancelled

      const { text } = await this.platform.docs.extractText(path);
      const model = this.llmConfig ? `${this.llmConfig.provider}:${this.llmConfig.model}` : undefined;
      const { items, errors } = await parseResume(this.llm, text, { model });
      // Dedupe before anything else (spec §6 step 4).
      const fresh = await selectNewItems(this.store, items);
      // Résumé items are record-grade like LinkedIn rows: prefilter-only, never
      // sent to the triage model (spec §6 step 5). Every item stays `keep`.
      const signals = await this.triageFresh(fresh, false);
      const report = await stageItems(this.store, items, { signals, project: this.importProject });
      // Surface the parser's drops (undated / unverifiable) next to any staging
      // errors so the owner knows what was skipped and can add it by hand (§6.7).
      report.errors.push(...errors);
      this.lastImportReport = report;
      await this.loadCandidates();
      const known = report.skippedPromoted + report.skippedRejected;
      this.message = `résumé: parsed ${items.length}, staged ${report.staged}, ${known} already known${errors.length ? `, ${errors.length} skipped` : ''}`;
      return report;
    });
  }

  // --- LLM provider (plan §3) -----------------------------------------------

  /** (Re)build the LLM client from the current config + platform seams, then
   * recompute {@link llmReady}. Anthropic also needs a stored key to be truly
   * ready, so a client alone is not enough (TODO §1.2). */
  private async buildLlm(): Promise<void> {
    this.llm = this.platform && this.llmConfig ? makeLlm(this.platform, this.llmConfig) : null;
    this.llmReady = this.llm !== null && (await this.llmKeyPresent());
  }

  /** True when the current provider has whatever secret it needs to actually
   * run: Ollama needs none; Anthropic needs a key in the Secrets seam. Without
   * this check, `llmReady` reported "Ready" with no key and the failure only
   * surfaced at complete() time (TODO §1.2). */
  private async llmKeyPresent(): Promise<boolean> {
    if (!this.llm || !this.llmConfig) return false;
    if (this.llmConfig.provider !== 'anthropic') return true;
    const key = await this.platform?.secrets?.get(ANTHROPIC_KEY_NAME);
    return !!key && key.trim().length > 0;
  }

  /** Persist the provider/model choice (outside the record repo) and rebuild. */
  async saveLlmConfig(config: LlmConfig | null): Promise<void> {
    this.llmConfig = config;
    if (config) localStorage.setItem(LS_LLM, JSON.stringify(config));
    else localStorage.removeItem(LS_LLM);
    await this.buildLlm();
    this.message = config ? `LLM set to ${config.provider} (${config.model})` : 'LLM provider cleared';
  }

  /** Store the Anthropic API key in the OS keyring via the Secrets seam — never
   * in the record repo (plan §3). */
  async setAnthropicKey(key: string): Promise<void> {
    await this.guard(async () => {
      if (!this.platform?.secrets) throw new Error('No secret storage available on this platform');
      await this.platform.secrets.set(ANTHROPIC_KEY_NAME, key.trim());
      await this.buildLlm();
      this.message = 'Saved Anthropic API key';
    });
  }

  /** Round-trip a tiny completion to confirm the provider is reachable. */
  async testLlm(): Promise<void> {
    await this.guard(async () => {
      if (!this.llm) throw new Error('No LLM provider configured');
      const out = await this.llm.complete({
        system: 'You are a terse assistant.',
        user: 'Reply with exactly the word: ok',
        maxTokens: 16
      });
      this.message = `LLM replied: ${out.trim().slice(0, 80) || '(empty)'}`;
    });
  }

  /** Deterministic rollup for a project — works with no LLM configured. */
  projectRollup(slug: string): Promise<ProjectRollup | null> {
    return this.store ? this.store.projectRollup(slug) : Promise.resolve(null);
  }

  /** Generate a retrospective proposal (plan §4.3–4.4) — nothing is written
   * until {@link acceptRetrospective}. */
  generateRetrospective(slug: string): Promise<ReduceProposal | null> {
    if (!this.store) return Promise.resolve(null);
    return this.guard(async () => {
      if (!this.llm) throw new Error('No LLM provider configured (set one in Data → AI provider)');
      const proposal = await this.store!.reduceProject(this.llm, slug);
      this.message = `Drafted a retrospective from ${proposal.entryCount} entries — review and accept`;
      return proposal;
    });
  }

  /** The accept gate: persist the proposed reduction into the project entry. */
  async acceptRetrospective(proposal: ReduceProposal): Promise<void> {
    if (!this.store) return;
    await this.guard(async () => {
      await this.store!.saveProjectReduction(proposal.projectEntryId, proposal.inner);
      await this.refresh();
      this.message = 'Saved the retrospective into the project entry';
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
