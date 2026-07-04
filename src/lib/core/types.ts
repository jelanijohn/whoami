/**
 * Who Am I — core domain types and platform interfaces.
 *
 * This module is deliberately framework-agnostic. It knows nothing about
 * Tauri, the browser, or Node. All I/O is reached through the {@link Platform}
 * interfaces, which the Tauri frontend and the test/CLI harness implement
 * differently. That is what keeps the core testable on its own.
 *
 * The one rule from the spec governs everything here:
 *   Plain text in the Git repo is canonical. SQLite is a throwaway index.
 *   Every write goes to the text first, then to the index — never the reverse.
 */

/** The canonical timeline entry types (spec §3). Unknown values are tolerated
 * on read so the schema can grow without breaking older clients. */
export type EntryType =
  | 'journal'
  | 'role'
  | 'project'
  | 'win'
  | 'skill'
  | 'education'
  | 'milestone'
  | 'mention';

export const ENTRY_TYPES: readonly EntryType[] = [
  'journal',
  'role',
  'project',
  'win',
  'skill',
  'education',
  'milestone',
  'mention'
];

/**
 * Parsed frontmatter for a timeline entry.
 *
 * The required fields (id, type, date, title, private) are typed explicitly.
 * Everything else — known-optional fields like `tags`/`org`/`links` as well as
 * fields this version has never heard of — rides along in the index signature
 * and MUST be preserved on round-trip (spec §3).
 */
export interface EntryFrontmatter {
  /** ULID. Stable, time-sortable, unique. The canonical identity. */
  id: string;
  /** journal | role | project | win | skill | education | milestone | mention */
  type: EntryType | string;
  /** ISO 8601 date the event happened: YYYY-MM-DD. */
  date: string;
  /** If true, NEVER appears in any generated artifact. */
  private: boolean;
  title: string;
  /** When the entry was first written (set once). */
  created?: string;
  /** Last edit; the app maintains this, Git is the backstop. */
  updated?: string;
  tags?: string[];
  /** For `type: project` entries only: the stable kebab-case identifier other
   * entries reference via their `project` key (ingest-reduce plan §2.1). Set
   * once at creation, defaulting to a slug of the title. */
  slug?: string;
  /** Affiliation: the `slug` of the project entry this belongs to (plan §2.2).
   * Optional — an entry with no `project` is simply outside every per-project
   * reduction. Rides the pass-through, so it costs no DB migration. */
  project?: string;
  /** Unknown / type-specific keys, preserved verbatim across read+write. */
  [key: string]: unknown;
}

/** A timeline entry: structured frontmatter + free-form Markdown body. */
export interface Entry {
  frontmatter: EntryFrontmatter;
  body: string;
  /** Path relative to the record root, e.g. `entries/2024-03-14-x-7g8h9j.md`.
   * Present when the entry was loaded from / written to disk. */
  path?: string;
}

/** Structured identity for the singleton profile (spec §4). */
export interface ProfileFrontmatter {
  name?: string;
  headline?: string;
  identities?: Record<string, string>;
  location?: string;
  [key: string]: unknown;
}

export interface Profile {
  frontmatter: ProfileFrontmatter;
  body: string;
}

// ---------------------------------------------------------------------------
// Platform interfaces — the only seam through which the core does I/O.
// ---------------------------------------------------------------------------

/** Minimal filesystem surface the core needs. Paths are absolute unless the
 * method name says otherwise. Implementations: node `fs`, Tauri `plugin-fs`. */
export interface FileSystem {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Create a directory (and parents). No-op if it already exists. */
  mkdir(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** List immediate file names (not full paths) in a directory. Returns []
   * if the directory does not exist. */
  readDir(path: string): Promise<string[]>;
}

/** A row-returning result, narrowed by the caller. */
export type Row = Record<string, unknown>;

/** Minimal async SQL surface. Implementations: better-sqlite3 (wrapped),
 * Tauri `plugin-sql`. Both speak SQLite. */
export interface Database {
  /** Run a statement (or several, for schema setup) with optional params. */
  execute(sql: string, params?: unknown[]): Promise<void>;
  /** Run a query and return rows. */
  select<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Result of running a git subprocess. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Shells out to the system `git`. Implementations: node `child_process`,
 * Tauri `plugin-shell`. The core never embeds a git library (spec §9). */
export interface GitRunner {
  /** Run `git <args>` in `cwd`. Never throws on non-zero exit — inspect
   * `code`. */
  run(args: string[], cwd: string): Promise<GitResult>;
}

// ---------------------------------------------------------------------------
// Ingestion seams (ingest-reduce plan §1, §3) — optional Platform capabilities.
// ---------------------------------------------------------------------------

/** A plain HTTP request. v1 adapters speak JSON-over-HTTPS only, so the body
 * surface is text. */
export interface HttpRequest {
  url: string;
  /** Defaults to GET. */
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The response, fully buffered. Adapters parse `text` as JSON themselves so
 * the seam stays dumb and mockable. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
}

/** Minimal HTTP surface for ingestion adapters. Like waid's `provider/`
 * module, everything above this seam is pure and network-agnostic: adapters
 * receive a ready token and an {@link Http}, never a keyring or a socket.
 * Implementations: node/webview `fetch`. */
export interface Http {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Secret storage for provider tokens. Secrets MUST NEVER be written into the
 * record repo or any entry frontmatter — only through this seam (mirrors
 * waid's keyring discipline). Implementations: OS keyring / app-data store. */
export interface Secrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A single-turn LLM completion (ingest-reduce plan §3). The core builds the
 * whole prompt; the platform implementation only transports it. */
export interface LlmCompletionRequest {
  system: string;
  user: string;
  /** Soft cap on output tokens; implementations clamp to provider limits. */
  maxTokens?: number;
}

/** The LLM seam — optional on {@link Platform}. Every reduce affordance MUST
 * degrade with a clear "no provider configured" message when it is absent, so
 * the app stays fully usable with no LLM at all (deterministic rollup still
 * works). Implementations live in `llm/` (Ollama, Anthropic) over the `Http`
 * and `Secrets` seams. */
export interface Llm {
  complete(req: LlmCompletionRequest): Promise<string>;
}

/** Interactive OAuth connect flows that need a native shell (a loopback
 * listener for the redirect + the system browser for consent). Absent on Node
 * ⇒ Connect is disabled with a clear message. Token REFRESH never uses this
 * seam — it runs in the core over {@link Http} + {@link Secrets}
 * (`ingest/gmail-oauth.ts`), so it stays unit-testable. */
export interface OAuthConnect {
  /** Run the Gmail desktop-loopback+PKCE consent flow; stores the grant via
   * the platform keyring and resolves to the connected account's email. */
  connectGmail(): Promise<string>;
}

/** A binary document parsed to plain text (résumé import spec §3). */
export interface ExtractedDoc {
  text: string;
  kind: 'pdf' | 'docx';
  /** PDF only, advisory. */
  pageCount?: number;
}

/** Read a .pdf/.docx file and return its plain text. Binary parsing is
 * platform-specific and is deliberately kept out of the core (the core résumé
 * module receives `text` and never imports pdf.js/mammoth). Implementations:
 *   Tauri webview — pdf.js (Mozilla) for PDF, mammoth for DOCX;
 *   Node test/CLI — pdf-parse for PDF, mammoth for DOCX.
 * Absent on a platform ⇒ résumé import is disabled with a clear message. */
export interface DocExtract {
  extractText(path: string): Promise<ExtractedDoc>;
}

/**
 * The full platform bundle handed to the core. The Tauri app builds one from
 * its plugins; tests build one from node primitives.
 */
export interface Platform {
  fs: FileSystem;
  db: Database;
  git: GitRunner;
  /** sha256 (hex) of a UTF-8 string. Node: crypto. Browser: SubtleCrypto. */
  hash(content: string): Promise<string>;
  /** Join path segments with the platform separator. The core stays
   * separator-agnostic by routing all joins through here. */
  joinPath(...segments: string[]): string;
  /** Optional — present when ingestion (Stage 1) is wired. Core features that
   * need them must degrade with a clear message when absent. */
  http?: Http;
  secrets?: Secrets;
  /** Optional — present when an LLM provider is configured (plan §3). Absent is
   * normal: the deterministic rollup and the whole app work without it. */
  llm?: Llm;
  /** Optional — present when binary document parsing is wired (résumé import
   * spec §3). Absent ⇒ résumé import is disabled with a clear message. */
  docs?: DocExtract;
  /** Optional — interactive OAuth consent flows (Gmail). Present only on the
   * desktop shell; absent ⇒ Connect is disabled with a clear message. */
  oauth?: OAuthConnect;
  /** Optional — open an external SQLite file (an absolute path) **read-only**,
   * for importing another app's local database (Warp history import). The caller
   * is responsible for `close()`. Absent ⇒ that import is disabled with a clear
   * message. Distinct from {@link db}, which is the app's own writable index. */
  openDatabase?(path: string): Promise<Database>;
}
