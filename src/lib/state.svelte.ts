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
  type SyncResult
} from './core';
import { createTauriPlatform } from './platform-tauri';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

const LS_KEY = 'whoami:recordRoot';
const LS_LLM = 'whoami:llm';
const LS_IMPORT = 'whoami:import';

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

  // Timeline filters.
  search = $state('');
  filterType = $state('');
  filterProject = $state('');
  includePrivate = $state(false);

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
  async llmTriageInbox(): Promise<void> {
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
        { llm: this.llm!, model, rubric: this.triageRubric() }
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
