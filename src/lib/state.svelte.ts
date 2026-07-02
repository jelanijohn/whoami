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
  importNeuroskillSessions,
  type NeuroskillEpochRow,
  type NeuroskillLabelRow,
  parseResume,
  acquireWebsite,
  parseWebsite,
  buildIdentityProposal,
  applyIdentityMerge,
  type IdentityProposal,
  stageItems,
  selectNewItems,
  triageItems,
  llmTriageItems,
  DEFAULT_RUBRIC,
  type TriageRubric,
  buildFeed,
  withFeedDefaults,
  effectiveLiveParams,
  aggregateRefreshReport,
  type Feed,
  type FeedKind,
  type FeedRunResult,
  type RefreshReport,
  GITHUB_TOKEN_NAME,
  ASANA_TOKEN_NAME,
  GMAIL_TOKEN_NAME,
  SHORTCUT_TOKEN_NAME,
  DEFAULT_SHORTCUT_REF,
  enrichRawItemsWithShortcut,
  fetchShortcutStories,
  fetchShortcutStoryItems,
  validateShortcut,
  type ShortcutWindow,
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
  type WinProposal,
  type AcceptedWin,
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
/** Saved import feeds — machine-local, never the record repo (spec §0.4). */
const LS_FEEDS = 'whoami:feeds';

export type { Feed, FeedKind, FeedRunResult, RefreshReport } from './core';
/** Persisted Journal layout preferences (view/grouping/sort/private) so the
 * user's preferred layout sticks between sessions (design handoff). */
const LS_VIEW = 'whoami:journalView';

/** A selection at/above this size still runs as one synthesis call (spec §2.4)
 * but the toast nudges the human to narrow it for sharper wins (spec §5). */
const WINS_SELECTION_HINT = 40;

/** The four switchable Journal views (design handoff). */
export type JournalView = 'grouped' | 'timeline' | 'calendar' | 'table';
/** How the Grouped view buckets entries. */
export type JournalGroupBy = 'project' | 'type' | 'month';

/** Live (API) ingest sources. LinkedIn is import-only (archive), handled apart.
 * Shortcut is both a source (the story import) and an enrichment of GitHub
 * items — one keyring token serves both (story-import spec §3). */
export type LiveSource = 'github' | 'asana' | 'shortcut' | 'gmail';

/** Everything with a keyring token. Now identical to {@link LiveSource} (the
 * alias survives for the connection-settings surface, which predates Shortcut
 * becoming a source of its own). */
export type TokenSource = LiveSource;

/** Keyring entry name per token holder — the token never leaves the keyring. */
const TOKEN_NAMES: Record<TokenSource, string> = {
  github: GITHUB_TOKEN_NAME,
  asana: ASANA_TOKEN_NAME,
  gmail: GMAIL_TOKEN_NAME,
  shortcut: SHORTCUT_TOKEN_NAME
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
    /** 'items' (default) = issues & PRs; 'commits' = repo commits (commits spec). */
    mode: 'items' | 'commits';
    /** Commit mode: branch to read ('' ⇒ default branch). */
    branch: string;
    /** Commit mode: drop merge commits (default true). */
    excludeMerges: boolean;
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
  /** Website import (website-import spec §7.1): `urls` is a textarea, one URL
   * per line. All three are stored as strings for the form inputs. `allowUndated`
   * carries entries the parser can't date into the inbox (allow-undated spec §D). */
  website: { urls: string; sitemapUrl: string; maxPages: string; allowUndated: boolean };
  /** Résumé import: the only persisted résumé setting today — carry roles/wins
   * the parser can't date into the inbox (allow-undated spec §D). */
  resume: { allowUndated: boolean };
  /** NeuroSkill import (neuroskill spec §7): the data directory holding
   * `activity.sqlite` + `labels.sqlite`. A stable local path, so it persists
   * here for convenience; never hardcoded. */
  neuroskill: { dataDir: string };
  /** Triage settings (spec §6): the per-import LLM flag (off by default) plus
   * optional rubric overrides. Persisted here (localStorage), never the record. */
  triage: { useLlm: boolean; rubric?: Partial<TriageRubric> };
  /** Shortcut: the GitHub-enrichment knobs (shortcut spec §7.1) plus the story
   * import's own `updated_at` window (story-import spec §3). The token is NOT
   * here — it lives in the keyring like the others. */
  shortcut: {
    /** Owner-editable ticket-ref pattern (regex source), default `sc-\d+` (D5). */
    refPattern: string;
    /** Run Shortcut enrichment during GitHub import when a token is present. */
    enrich: boolean;
    /** Pull the story description verbatim (bounded). Default FALSE (D2) —
     * client-ticket prose stays out unless deliberately opted into. Applies to
     * enrichment only; the story import always carries its description. */
    includeDescription: boolean;
    /** Story-import window bounds, YYYY-MM-DD ('' ⇒ open). */
    since: string;
    until: string;
  };
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
    mode: 'items',
    branch: '',
    excludeMerges: true,
    importPrivate: true
  },
  asana: { workspace: '', project: '', since: '', until: '', includeCompleted: true, limit: 100 },
  gmail: { query: '', limit: 25 },
  website: { urls: '', sitemapUrl: '', maxPages: '25', allowUndated: false },
  resume: { allowUndated: false },
  neuroskill: { dataDir: '' },
  triage: { useLlm: false },
  shortcut: { refPattern: DEFAULT_SHORTCUT_REF, enrich: true, includeDescription: false, since: '', until: '' }
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
  /** Saved, re-runnable import feeds (import-feed-spec). Persisted to
   * `localStorage` (LS_FEEDS), never the record repo. */
  feeds = $state<Feed[]>([]);
  /** Result of the most recent Refresh-all run, surfaced in the Import page. */
  lastRefreshReport = $state<RefreshReport | null>(null);
  /** A pending identity-merge proposal awaiting the user's review, or null
   *  (profile-merge spec §3.1). Held like a {@link ReduceProposal} — never
   *  auto-applied, transient (not persisted). */
  pendingIdentityProposal = $state<IdentityProposal | null>(null);
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
            website: { ...DEFAULT_IMPORT_SETTINGS.website, ...p.website },
            resume: { ...DEFAULT_IMPORT_SETTINGS.resume, ...p.resume },
            neuroskill: { ...DEFAULT_IMPORT_SETTINGS.neuroskill, ...p.neuroskill },
            triage: { ...DEFAULT_IMPORT_SETTINGS.triage, ...p.triage },
            shortcut: { ...DEFAULT_IMPORT_SETTINGS.shortcut, ...p.shortcut }
          };
        } catch {
          /* ignore a corrupt setting */
        }
      }
      const rawFeeds = localStorage.getItem(LS_FEEDS);
      if (rawFeeds) {
        try {
          const arr = JSON.parse(rawFeeds);
          if (Array.isArray(arr)) {
            // Normalize each persisted feed forward-compatibly (spec §4.1.1); an
            // id should always be present, but mint one if a hand-edited payload
            // dropped it so CRUD-by-id stays sound.
            this.feeds = arr.map((f) => {
              const feed = withFeedDefaults(f as Partial<Feed>);
              if (!feed.id) feed.id = crypto.randomUUID();
              return feed;
            });
          }
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
      // Phase 3 (spec §7.2): opportunistically run any feed the user opted into
      // on-open, without blocking the UI. Inbox-only, like every feed run; the
      // busy flag + toast already communicate progress. Defaults off per feed.
      if (this.feeds.some((f) => f.enabled && f.runOnOpen)) {
        void this.refreshAll({ onOpenOnly: true });
      }
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
   * §2.4). An empty `project` clears any suggested affiliation. `parent` is the
   * accepted parent-assist suggestion (story-import spec §7), if any. */
  async promoteCandidate(
    candidatePath: string,
    project = '',
    date?: string,
    parent?: string
  ): Promise<Entry | null> {
    if (!this.store) return null;
    return this.guard(async () => {
      const e = await this.store!.promoteCandidate(candidatePath, { project, date, parent });
      this.candidates = await this.store!.listCandidates();
      await this.refresh();
      this.message = `Promoted “${e.frontmatter.title}”`;
      return e;
    });
  }

  /** Parent-assist lookup (story-import spec §7): the promoted Shortcut story
   * entry matching a github candidate's `shortcut.id`, or null. Index-only and
   * quiet — no guard/toast; failure means no prefill, never an error. */
  async suggestShortcutParent(candidate: Entry): Promise<string | null> {
    if (!this.store) return null;
    return this.store.suggestShortcutParent(candidate);
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
  async promoteCandidates(
    items: { path: string; project?: string; date?: string; parent?: string; tags?: string[] }[]
  ): Promise<number> {
    if (!this.store || items.length === 0) return 0;
    return (
      (await this.guard(async () => {
        let ok = 0;
        let failed = 0;
        for (const { path, project = '', date, parent, tags } of items) {
          try {
            await this.store!.promoteCandidate(path, { project, date, parent, tags });
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

  /** Backfill Shortcut enrichment over the already-staged inbox (shortcut spec
   * §6): re-extracts ticket refs from each candidate (so pre-feature candidates
   * are covered), fetches each distinct story once across the whole inbox, and
   * rewrites enriched candidates in place. Annotation only — never promotes,
   * rejects, or touches `triage_*`/title/date. Idempotent on re-run. */
  async enrichInboxFromShortcut(): Promise<void> {
    if (!this.store) return;
    await this.guard(async () => {
      const http = this.platform?.http;
      const secrets = this.platform?.secrets;
      if (!http || !secrets) throw new Error('This platform has no network/secret support');
      const token = await secrets.get(SHORTCUT_TOKEN_NAME);
      if (!token) throw new Error('No shortcut token saved — add one first');
      const s = this.importSettings.shortcut;
      const res = await this.store!.enrichCandidates(
        (ids) => fetchShortcutStories(http, token, ids, { includeDescription: s.includeDescription }),
        { refPattern: s.refPattern.trim() || undefined }
      );
      this.candidates = await this.store!.listCandidates();
      this.message = `Shortcut: enriched ${res.enriched} of ${res.total} candidate${
        res.total === 1 ? '' : 's'
      } (${res.storiesFetched} stor${res.storiesFetched === 1 ? 'y' : 'ies'} fetched)`;
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
  async setSourceToken(source: TokenSource, token: string): Promise<void> {
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
    for (const source of Object.keys(TOKEN_NAMES) as TokenSource[]) {
      const v = await secrets.get(TOKEN_NAMES[source]);
      out[source] = !!v && v.trim().length > 0;
    }
    this.tokenPresent = out;
  }

  /** Cheap credential check against the provider (mirrors {@link testLlm}). */
  async testSourceToken(source: TokenSource): Promise<void> {
    await this.guard(async () => {
      const http = this.platform?.http;
      const secrets = this.platform?.secrets;
      if (!http || !secrets) throw new Error('This platform has no network/secret support');
      const token = await secrets.get(TOKEN_NAMES[source]);
      if (!token) throw new Error(`No ${source} token saved`);
      if (source === 'github') await validateGithub(http, token, this.importSettings.github.baseUrl || undefined);
      else if (source === 'asana') await validateAsana(http, token);
      else if (source === 'shortcut') await validateShortcut(http, token);
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
    opts: {
      useLlmTriage: boolean;
      private?: boolean;
      project?: string;
      /** Deterministic enrichment of the fresh items before triage/staging
       * (shortcut spec §5). Runs only on `selectNewItems` output so no
       * enrichment call is ever spent on an item that won't stage. May return a
       * non-fatal note appended to the result toast; it must catch its own
       * failures — enrichment must never abort an import. */
      enrichFresh?: (http: Http, fresh: RawItem[]) => Promise<string | void>;
    }
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
      const note = opts.enrichFresh ? ((await opts.enrichFresh(http, fresh)) ?? '') : '';
      const signals = await this.triageFresh(fresh, opts.useLlmTriage);
      const report = await stageItems(this.store, items, {
        signals,
        private: opts.private,
        project: opts.project ?? this.importProject
      });
      this.lastImportReport = report;
      await this.loadCandidates();
      const known = report.skippedPromoted + report.skippedRejected;
      this.message = `${source}: staged ${report.staged}, ${known} already known${report.errors.length ? `, ${report.errors.length} errors` : ''}${note ? ` — ${note}` : ''}`;
      return report;
    });
  }

  /** A per-run override for a single import, supplied by {@link runFeed} so a
   * feed can pin its own project/private/useLlm instead of reading the globals.
   * Absent fields fall back to today's defaults — the `/import` form calls these
   * with one arg and behaves exactly as before. */
  importGithub(
    params: Omit<GithubFetchOpts, 'token'>,
    over?: {
      useLlmTriage?: boolean;
      private?: boolean;
      project?: string;
      /** Per-feed Shortcut overrides (spec §7.2); absent ⇒ the global settings. */
      shortcutEnrich?: boolean;
      shortcutIncludeDescription?: boolean;
    }
  ): Promise<IngestReport | null> {
    const shortcut = this.importSettings.shortcut;
    // Ref extraction is always-on and token-free (spec §1); an explicit
    // per-feed pattern in `params` wins over the global setting.
    const shortcutRefPattern = params.shortcutRefPattern ?? (shortcut.refPattern.trim() || undefined);
    return this.runStage(
      'github',
      (http, token) => fetchGithub(http, { ...params, shortcutRefPattern, token }),
      {
        useLlmTriage: over?.useLlmTriage ?? this.importSettings.triage.useLlm,
        private: over?.private ?? this.importSettings.github.importPrivate,
        project: over?.project,
        enrichFresh: async (http, fresh) => {
          // Gate the *fetch* on token + flag (spec §7.1); failure degrades to
          // ref-tagged-but-un-enriched candidates, never an aborted import.
          if (!(over?.shortcutEnrich ?? shortcut.enrich)) return;
          const token = await this.platform?.secrets?.get(SHORTCUT_TOKEN_NAME);
          if (!token) return;
          try {
            await enrichRawItemsWithShortcut(http, token, fresh, {
              includeDescription: over?.shortcutIncludeDescription ?? shortcut.includeDescription
            });
          } catch (e) {
            return `Shortcut enrichment skipped: ${String(e)}`;
          }
        }
      }
    );
  }
  importAsana(
    params: Omit<AsanaFetchOpts, 'token'>,
    over?: { useLlmTriage?: boolean; private?: boolean; project?: string }
  ): Promise<IngestReport | null> {
    return this.runStage('asana', (http, token) => fetchAsana(http, { ...params, token }), {
      useLlmTriage: over?.useLlmTriage ?? this.importSettings.triage.useLlm,
      private: over?.private,
      project: over?.project
    });
  }
  /** The Shortcut story import (story-import spec §3): windowed, follower-scoped
   * acquisition through {@link fetchShortcutStoryItems}. Always stages private —
   * there is no per-source public opt-in for Shortcut (spec §0). Adapter-level
   * notes (window truncation, skipped stories) are folded into the run's report
   * so they are never silently dropped (spec §4.3). */
  async importShortcut(
    params: ShortcutWindow,
    over?: { useLlmTriage?: boolean; project?: string }
  ): Promise<IngestReport | null> {
    const errors: string[] = [];
    const report = await this.runStage(
      'shortcut',
      (http, token) => fetchShortcutStoryItems(http, token, params, { errors }),
      {
        useLlmTriage: over?.useLlmTriage ?? this.importSettings.triage.useLlm,
        private: true,
        project: over?.project
      }
    );
    if (report && errors.length) {
      report.errors.push(...errors);
      this.message += ` — ${errors.length} note${errors.length === 1 ? '' : 's'} (see report)`;
    }
    return report;
  }
  importGmail(
    params: Omit<GmailFetchOpts, 'token'>,
    over?: { useLlmTriage?: boolean; private?: boolean; project?: string }
  ): Promise<IngestReport | null> {
    return this.runStage('gmail', (http, token) => fetchGmail(http, { ...params, token }), {
      useLlmTriage: over?.useLlmTriage ?? this.importSettings.triage.useLlm,
      private: over?.private,
      project: over?.project
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
  async importClaudeCode(roots: string[], project?: string): Promise<IngestReport | null> {
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
      const report = await stageItems(this.store, items, {
        signals,
        project: project ?? this.importProject
      });
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
  async importWarp(dirs: string[], project?: string): Promise<IngestReport | null> {
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
        const report = await stageItems(this.store, items, {
          signals,
          project: project ?? this.importProject
        });
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
   * NeuroSkill EEG-session import (neuroskill spec §7): zero-auth, import-only,
   * all-SQLite. Reads `eeg_timeseries` (from `activity.sqlite`) and `labels`
   * (from `labels.sqlite`) read-only, segments past sessions, and hands the rows
   * to the pure core mapper — one session = one candidate.
   *
   * Brain-state is the most private source here (spec R5): every candidate is
   * staged `private: true` and runs **prefilter-only** — it never reaches a cloud
   * triage model. Both DBs are opened `mode=ro&immutable=1`, so the live
   * NeuroSkill daemon's locks are never touched, and ONLY the two §7 SELECTs are
   * ever run (spec R1). `labels.sqlite` is enrichment: if it is missing or
   * unopenable the import proceeds with no labels.
   */
  async importNeuroskill(dataDir: string, project?: string): Promise<IngestReport | null> {
    return this.guard(async () => {
      if (!this.store || !this.platform) throw new Error('Open a record folder first');
      if (!this.platform.openDatabase) {
        throw new Error('External database access is not available on this platform');
      }
      const dir = dataDir.trim();
      if (!dir) throw new Error('Enter the NeuroSkill data directory first');

      const activityPath = this.platform.joinPath(dir, 'activity.sqlite');
      const labelsPath = this.platform.joinPath(dir, 'labels.sqlite');

      // eeg_timeseries — the only statement run against activity.sqlite (R1).
      const activity = await this.platform.openDatabase(activityPath);
      let epochRows: NeuroskillEpochRow[];
      try {
        epochRows = (await activity.select(
          `SELECT ts, metrics FROM eeg_timeseries ORDER BY ts`
        )) as unknown as NeuroskillEpochRow[];
      } finally {
        await activity.close();
      }

      // labels — the only statement run against labels.sqlite (R1). Enrichment:
      // a missing/unopenable labels DB is non-fatal (proceed with no labels).
      let labelRows: NeuroskillLabelRow[] = [];
      try {
        const labelsDb = await this.platform.openDatabase(labelsPath);
        try {
          labelRows = (await labelsDb.select(
            `SELECT id, text, context, eeg_start, eeg_end, wall_start, wall_end, label_start, label_end
               FROM labels`
          )) as unknown as NeuroskillLabelRow[];
        } finally {
          await labelsDb.close();
        }
      } catch {
        // labels.sqlite is optional enrichment — proceed with labelRows = [].
      }

      const items = importNeuroskillSessions(epochRows, labelRows);
      if (items.length === 0) throw new Error('No NeuroSkill sessions found in eeg_timeseries');
      const fresh = await selectNewItems(this.store, items);
      const signals = await this.triageFresh(fresh, false);
      const report = await stageItems(this.store, items, {
        signals,
        private: true,
        project: project ?? this.importProject
      });
      this.lastImportReport = report;
      await this.loadCandidates();
      const known = report.skippedPromoted + report.skippedRejected;
      this.message = `neuroskill: staged ${report.staged}, ${known} already known${report.errors.length ? `, ${report.errors.length} errors` : ''}`;
      return report;
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
      const { items, errors } = await parseResume(this.llm, text, {
        model,
        allowUndated: this.importSettings.resume.allowUndated
      });
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

  /**
   * Website import (website-import spec §7.1). Two stages, mirroring résumé:
   * Stage 1 `acquireWebsite` is deterministic + LLM-free (fetch → clean →
   * extract); Stage 2 `parseWebsite` is the one LLM pass, run here BEFORE
   * `stageItems` (the staging boundary never calls an LLM). The LLM is mandatory
   * — polished prose has no deterministic parse — so with no provider or no http
   * seam the action refuses rather than falling back (spec §0.1, §12.1).
   *
   * Every candidate stages `private: true` regardless of any feed flag (spec
   * §0.3, §12.6). The identity harvest may run inside `acquireWebsite`, but v1
   * neither surfaces nor persists it (spec §4 / D5) — no profile write occurs.
   */
  async importWebsite(
    params: { urls: string[]; sitemapUrl?: string; maxPages?: number },
    over?: { useLlmTriage?: boolean; project?: string; allowUndated?: boolean }
  ): Promise<IngestReport | null> {
    return this.guard(async () => {
      if (!this.store || !this.platform) throw new Error('Open a record folder first');
      const http = this.platform.http;
      if (!http) throw new Error('This platform has no network support');
      if (!this.llmReady || !this.llm) {
        throw new Error('Website import needs a configured LLM provider (Data → AI provider)');
      }
      if (params.urls.length === 0 && !params.sitemapUrl) {
        throw new Error('Enter at least one page URL or a sitemap URL');
      }
      // Stage 1 — deterministic acquisition (no LLM, not a crawler).
      const acquired = await acquireWebsite(http, {
        urls: params.urls,
        sitemapUrl: params.sitemapUrl,
        maxPages: params.maxPages
      });
      if (acquired.pages.length === 0) {
        const failed = acquired.errors.length
          ? ` (${acquired.errors.length} page${acquired.errors.length === 1 ? '' : 's'} failed or were empty)`
          : '';
        throw new Error(`No usable pages fetched${failed}`);
      }
      // Stage 2 — the single LLM extraction pass, before staging.
      const allowUndated = over?.allowUndated ?? this.importSettings.website.allowUndated;
      const { items, errors } = await parseWebsite(this.llm, acquired.pages, { allowUndated });
      // Dedupe gate, then optional triage — neither re-sends already-handled
      // content to a provider (spec §7.1). Website prose is polished/public, so
      // it honors the LLM-triage flag like github (spec §7.3), unlike chat sources.
      const fresh = await selectNewItems(this.store, items);
      const useLlmTriage = over?.useLlmTriage ?? this.importSettings.triage.useLlm;
      const signals = await this.triageFresh(fresh, useLlmTriage);
      const report = await stageItems(this.store, items, {
        signals,
        private: true,
        project: over?.project ?? this.importProject
      });
      // Surface acquisition + parse problems (failed/short pages, dropped items)
      // next to any staging errors so the owner knows what was skipped.
      report.errors.push(...acquired.errors, ...errors);
      // Identity harvest (profile-merge spec §3.2): the deterministic harvest ran
      // inside acquisition. If it found links, hold a proposal against the current
      // profile for review — this writes NOTHING to the profile itself.
      const proposed = acquired.identities; // Record<platform,url>
      if (Object.keys(proposed).length) {
        const existing = (this.profile?.frontmatter.identities as Record<string, string>) ?? {};
        const proposal = buildIdentityProposal(existing, proposed);
        this.pendingIdentityProposal = proposal.hasActionable ? proposal : null;
      }
      this.lastImportReport = report;
      await this.loadCandidates();
      const known = report.skippedPromoted + report.skippedRejected;
      // When pages were fetched but nothing was proposed, say why: the importer
      // never invents a date (spec §8), so undated prose and client-rendered
      // pages yield nothing — that's the brutal-accuracy boundary, not a failure.
      const hint =
        items.length === 0 && !allowUndated
          ? ' — no dated items found (it never guesses dates; enable “Allow undated items”, or try Résumé import)'
          : '';
      this.message = `website: fetched ${acquired.pages.length} page${acquired.pages.length === 1 ? '' : 's'}, parsed ${items.length}, staged ${report.staged}, ${known} already known${report.errors.length ? `, ${report.errors.length} notes` : ''}${hint}`;
      return report;
    });
  }

  // --- Import feeds (import-feed-spec) ---------------------------------------

  /** Persist the feed list (outside the record repo). Quiet — the CRUD callers
   * own any toast (mirrors {@link saveImportSettings}). */
  saveFeeds(): void {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_FEEDS, JSON.stringify(this.feeds));
  }

  addFeed(feed: Feed): void {
    this.feeds = [...this.feeds, feed];
    this.saveFeeds();
  }

  updateFeed(id: string, patch: Partial<Feed>): void {
    this.feeds = this.feeds.map((f) => (f.id === id ? { ...f, ...patch } : f));
    this.saveFeeds();
  }

  removeFeed(id: string): void {
    this.feeds = this.feeds.filter((f) => f.id !== id);
    this.saveFeeds();
  }

  /** Snapshot the current import-form state for `kind` into a new {@link Feed}
   * (spec §4.2.4), add it, and return it. The pure shaping (per-kind param shape
   * + forced picker flags) lives in {@link buildFeed}. */
  saveCurrentAsFeed(kind: FeedKind, label: string): Feed {
    const live =
      kind === 'github' || kind === 'asana' || kind === 'gmail' || kind === 'website';
    // A github feed snapshots the Shortcut settings too (spec §7.2): the feed
    // carries a project, so this yields per-project pattern config for free.
    const shortcut =
      kind === 'github'
        ? {
            shortcutRefPattern: this.importSettings.shortcut.refPattern,
            shortcutEnrich: this.importSettings.shortcut.enrich,
            shortcutIncludeDescription: this.importSettings.shortcut.includeDescription
          }
        : undefined;
    const feed = buildFeed({
      id: crypto.randomUUID(),
      label,
      kind,
      project: this.importProject,
      // A shortcut feed carries only the story-import window — the enrichment
      // knobs sharing `importSettings.shortcut` belong to github feeds (§7.2).
      liveParams:
        kind === 'shortcut'
          ? { since: this.importSettings.shortcut.since, until: this.importSettings.shortcut.until }
          : live
            ? { ...($state.snapshot(this.importSettings[kind]) as Record<string, unknown>), ...shortcut }
            : undefined,
      roots: kind === 'claude-code' ? $state.snapshot(this.claudeCodeSelected) : undefined,
      dirs: kind === 'warp' ? $state.snapshot(this.warpSelected) : undefined,
      dataDir: kind === 'neuroskill' ? this.importSettings.neuroskill.dataDir : undefined,
      importPrivate: this.importSettings.github.importPrivate,
      useLlm: this.importSettings.triage.useLlm
    });
    this.addFeed(feed);
    return feed;
  }

  /**
   * Run a single feed (spec §4.3.4): dispatch by kind through the matching import
   * method with the feed's per-run overrides, applying the rolling-window `since`
   * derivation first. Reuses each method's existing guard/toast/reload — a
   * single-feed run behaves exactly like clicking that source's button today,
   * just with the feed's project/private/useLlm. On success, stamps `lastRunAt`
   * (it drives the next run only for rolling github/asana; display-only
   * otherwise). Returns the report, or null on error/empty.
   */
  async runFeed(feed: Feed): Promise<IngestReport | null> {
    let report: IngestReport | null = null;
    if (feed.kind === 'claude-code') {
      const roots = Array.isArray(feed.params.roots) ? (feed.params.roots as string[]) : [];
      report = await this.importClaudeCode(roots, feed.project);
    } else if (feed.kind === 'warp') {
      const dirs = Array.isArray(feed.params.dirs) ? (feed.params.dirs as string[]) : [];
      report = await this.importWarp(dirs, feed.project);
    } else if (feed.kind === 'neuroskill') {
      const dataDir = typeof feed.params.dataDir === 'string' ? feed.params.dataDir : '';
      report = await this.importNeuroskill(dataDir, feed.project);
    } else {
      const params = effectiveLiveParams(feed);
      const over = { useLlmTriage: feed.useLlm, private: feed.private, project: feed.project };
      if (feed.kind === 'github')
        report = await this.importGithub(this.toGithubParams(params), {
          ...over,
          // Older feeds carry no shortcut keys — undefined falls back to the
          // global settings inside importGithub.
          shortcutEnrich: params.shortcutEnrich === undefined ? undefined : !!params.shortcutEnrich,
          shortcutIncludeDescription:
            params.shortcutIncludeDescription === undefined ? undefined : !!params.shortcutIncludeDescription
        });
      else if (feed.kind === 'asana') report = await this.importAsana(this.toAsanaParams(params), over);
      else if (feed.kind === 'shortcut')
        // Shortcut always stages private (spec §0) — only useLlm/project carry over.
        report = await this.importShortcut(this.toShortcutParams(params), {
          useLlmTriage: feed.useLlm,
          project: feed.project
        });
      else if (feed.kind === 'gmail') report = await this.importGmail(this.toGmailParams(params), over);
      else if (feed.kind === 'website')
        // Website always stages private (spec §0.3); the feed's `private` flag is
        // ignored — only its useLlm/project carry over.
        report = await this.importWebsite(this.toWebsiteParams(params), {
          useLlmTriage: feed.useLlm,
          project: feed.project,
          allowUndated: !!params.allowUndated
        });
    }
    if (report) this.updateFeed(feed.id, { lastRunAt: new Date().toISOString() });
    return report;
  }

  /** Convert a stored github param snapshot to fetch opts (mirrors the form's
   * `runGithub`). The `since` here may already be the rolling-window override. */
  private toGithubParams(p: Record<string, unknown>): Omit<GithubFetchOpts, 'token'> {
    const capStr = String(p.discussionCharCap ?? '').trim();
    const cap = capStr ? Number(capStr) : undefined;
    return {
      user: String(p.user ?? '').trim(),
      repo: String(p.repo ?? '').trim() || undefined,
      since: (p.since as string) || undefined,
      until: (p.until as string) || undefined,
      limit: (p.limit as number) || undefined,
      baseUrl: String(p.baseUrl ?? '').trim() || undefined,
      fetchDiscussion: !!p.fetchDiscussion,
      commentScope: (p.commentScope as 'self' | 'all') ?? 'self',
      discussionCharCap: cap && Number.isFinite(cap) && cap > 0 ? cap : undefined,
      mode: (p.mode as 'items' | 'commits') ?? 'items',
      branch: String(p.branch ?? '').trim() || undefined,
      excludeMerges: p.excludeMerges === undefined ? true : !!p.excludeMerges,
      // The feed's snapshotted ticket-ref pattern (spec §7.2); absent on older
      // feeds ⇒ undefined ⇒ importGithub falls back to the global setting.
      shortcutRefPattern: String(p.shortcutRefPattern ?? '').trim() || undefined
    };
  }

  private toAsanaParams(p: Record<string, unknown>): Omit<AsanaFetchOpts, 'token'> {
    return {
      workspace: String(p.workspace ?? '').trim() || undefined,
      project: String(p.project ?? '').trim() || undefined,
      since: (p.since as string) || undefined,
      until: (p.until as string) || undefined,
      includeCompleted: (p.includeCompleted as boolean) ?? true,
      limit: (p.limit as number) || undefined
    };
  }

  private toShortcutParams(p: Record<string, unknown>): ShortcutWindow {
    return {
      since: (p.since as string) || undefined,
      until: (p.until as string) || undefined
    };
  }

  private toGmailParams(p: Record<string, unknown>): Omit<GmailFetchOpts, 'token'> {
    return { query: String(p.query ?? '').trim(), limit: (p.limit as number) || undefined };
  }

  /** Convert a stored website param snapshot to `importWebsite` params (mirrors
   * the form's `runWebsite`): split the `urls` textarea into lines, trim a
   * sitemap URL, and parse the page cap. */
  private toWebsiteParams(p: Record<string, unknown>): { urls: string[]; sitemapUrl?: string; maxPages?: number } {
    const urls = String(p.urls ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const maxStr = String(p.maxPages ?? '').trim();
    const maxPages = maxStr ? Number(maxStr) : undefined;
    return {
      urls,
      sitemapUrl: String(p.sitemapUrl ?? '').trim() || undefined,
      maxPages: maxPages && Number.isFinite(maxPages) && maxPages > 0 ? maxPages : undefined
    };
  }

  /**
   * Refresh every enabled feed (spec §4.4.3): run them **sequentially** (no
   * provider hammering), tolerating per-feed errors so one failure never aborts
   * the rest. Each {@link runFeed} reloads the inbox itself (acceptable for v1,
   * spec §4.4.3(b)). Aggregates a {@link RefreshReport} and sets a summary toast.
   */
  async refreshAll(opts: { onOpenOnly?: boolean } = {}): Promise<RefreshReport | null> {
    const enabled = this.feeds.filter((f) => f.enabled && (!opts.onOpenOnly || f.runOnOpen));
    if (enabled.length === 0) {
      // On-open is opportunistic — stay quiet when nothing opted in (spec §7).
      if (!opts.onOpenOnly) this.message = 'No enabled feeds to refresh — save one first';
      return null;
    }
    const startedAt = new Date().toISOString();
    const results: FeedRunResult[] = [];
    this.busy = true;
    try {
      for (const feed of enabled) {
        const base = { id: feed.id, label: feed.label, kind: feed.kind };
        try {
          const report = await this.runFeed(feed);
          if (report) results.push({ ...base, report });
          else results.push({ ...base, report: null, error: this.error || 'run failed' });
        } catch (e) {
          results.push({ ...base, report: null, error: String(e) });
        }
      }
    } finally {
      this.busy = false;
    }
    const refresh = aggregateRefreshReport(startedAt, results);
    this.lastRefreshReport = refresh;
    const known = results.reduce(
      (n, r) => n + (r.report ? r.report.skippedPromoted + r.report.skippedRejected : 0),
      0
    );
    const errs = results.filter((r) => !r.report).length;
    this.message =
      `Refreshed ${enabled.length} feed${enabled.length === 1 ? '' : 's'}: ` +
      `staged ${refresh.totalStaged}, ${known} already known` +
      (errs ? `, ${errs} failed` : '');
    return refresh;
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

  // --- Wins from Journal (wins-from-journal spec §5) ------------------------

  /** Roles + projects the picker offers as a win's nesting parent. Includes
   * private ones — the human is choosing where it *will* nest; the generator's
   * privacy strip is the real gate (spec §5). */
  async winTargets(): Promise<{ id: string; label: string; kind: 'role' | 'project' }[]> {
    if (!this.store) return [];
    // Include private roles/projects — the human is choosing where it *will*
    // nest; the generator's privacy strip is the real gate (spec §5). Fetch
    // projects with includePrivate explicitly so the picker doesn't inherit the
    // Journal's private toggle.
    const [roles, projects] = await Promise.all([
      this.store.listEntries({ types: ['role'], includePrivate: true }),
      this.store.listProjects(true)
    ]);
    const roleTargets = roles.map((e) => ({
      id: String(e.frontmatter.id),
      label: String(e.frontmatter.title),
      kind: 'role' as const
    }));
    const projectTargets = projects.map((p) => ({
      id: String(p.entry.frontmatter.id),
      label: String(p.entry.frontmatter.title),
      kind: 'project' as const
    }));
    return [...roleTargets, ...projectTargets];
  }

  /** Draft wins from a hand-picked selection (spec §5) — nothing is written
   * until {@link acceptWins}. Empty result is reported plainly, not an error. */
  draftWins(sourceIds: string[]): Promise<WinProposal | null> {
    if (!this.store) return Promise.resolve(null);
    return this.guard(async () => {
      if (!this.llm) throw new Error('No LLM provider configured (set one in Data → AI provider)');
      const proposal = await this.store!.draftWins(this.llm, sourceIds);
      proposal.model = this.llmConfig
        ? `${this.llmConfig.provider}:${this.llmConfig.model}`
        : undefined;
      if (proposal.drafts.length === 0) {
        this.message = "The model didn't draft any wins it could ground in your selection";
      } else {
        // A single synthesis call only (spec §2.4) — never split silently; nudge
        // the human to narrow a very large selection instead.
        const hint =
          proposal.sourceCount >= WINS_SELECTION_HINT
            ? ' — tip: a tighter selection (one project or stretch at a time) usually yields sharper wins'
            : '';
        this.message = `Drafted ${proposal.drafts.length} win(s) from ${proposal.sourceCount} entries — review and accept${hint}`;
      }
      return proposal;
    });
  }

  /** The accept gate: create the kept/edited wins as first-class entries. */
  acceptWins(accepted: AcceptedWin[]): Promise<Entry[] | null> {
    if (!this.store) return Promise.resolve(null);
    return this.guard(async () => {
      const model = this.llmConfig
        ? `${this.llmConfig.provider}:${this.llmConfig.model}`
        : undefined;
      const created = await this.store!.saveWins(accepted, { model });
      await this.refresh();
      this.message = `Saved ${created.length} win(s)`;
      return created;
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

  /** The accept gate (profile-merge spec §3.3): merge the ticked identity rows
   *  into the profile via the normal text-first write path, then clear the
   *  pending proposal. `selected` is platform → url. Writes nothing unless called. */
  async applyIdentityMerge(selected: Record<string, string>): Promise<void> {
    if (!this.store || !this.profile) return;
    await this.guard(async () => {
      const prev = this.profile!.frontmatter;
      const existing = (prev.identities as Record<string, string>) ?? {};
      const identities = applyIdentityMerge(existing, selected);
      await this.store!.saveProfile({
        frontmatter: { ...prev, identities }, // preserve unknown keys (profile.ts round-trip)
        body: this.profile!.body
      });
      this.profile = await this.store!.readProfile();
      this.pendingIdentityProposal = null;
      const n = Object.keys(selected).length;
      this.message = `Added ${n} identit${n === 1 ? 'y' : 'ies'} to your profile`;
    });
  }

  /** Dismiss the pending identity proposal without writing anything (spec §3.3). */
  dismissIdentityProposal(): void {
    this.pendingIdentityProposal = null;
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
