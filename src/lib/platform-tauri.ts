/**
 * Tauri-backed {@link Platform} implementation.
 *
 * Wires the framework-agnostic core to the desktop runtime:
 *   - FileSystem → @tauri-apps/plugin-fs (the canonical text files)
 *   - Database   → @tauri-apps/plugin-sql (the derived SQLite index)
 *   - GitRunner  → @tauri-apps/plugin-shell (system `git`, no embedded lib)
 *   - hash       → WebCrypto SubtleCrypto (sha256)
 *
 * This file is only imported by the SvelteKit UI, never by the core or tests,
 * so the Tauri plugins never reach the test bundle.
 */

import Database from '@tauri-apps/plugin-sql';
import { Command } from '@tauri-apps/plugin-shell';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  writeTextFile
} from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type {
  Database as CoreDatabase,
  FileSystem,
  GitRunner,
  Http,
  HttpRequest,
  HttpResponse,
  Platform,
  Row,
  Secrets
} from './core';

const fs: FileSystem = {
  readTextFile: (path) => readTextFile(path),
  writeTextFile: (path, contents) => writeTextFile(path, contents),
  exists: (path) => exists(path),
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async removeFile(path) {
    // `remove` throws if the path is absent; callers guard with exists(), but
    // stay defensive so a missing file is never fatal.
    try {
      await remove(path);
    } catch {
      /* already gone */
    }
  },
  async readDir(path) {
    try {
      const entries = await readDir(path);
      return entries.filter((e) => e.isFile || e.isDirectory).map((e) => e.name);
    } catch {
      return [];
    }
  }
};

const git: GitRunner = {
  async run(args, cwd) {
    // `name: 'git'` matches the shell scope alias in capabilities/default.json.
    const output = await Command.create('git', args, { cwd }).execute();
    return {
      code: output.code ?? (output.signal != null ? 1 : 0),
      stdout: output.stdout,
      stderr: output.stderr
    };
  }
};

/**
 * Http seam via @tauri-apps/plugin-http: requests are issued from the Rust side,
 * so they are not subject to the webview's CORS policy. This matters because the
 * Anthropic Messages API sends no CORS headers for browser origins — a plain
 * webview fetch to it fails the preflight with "TypeError: Load failed". The
 * plugin's `fetch` keeps the Web API signature, so the seam is otherwise
 * unchanged; the reachable hosts are scoped in src-tauri/capabilities/default.json.
 */
const tauriHttp: Http = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await tauriFetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, ok: res.ok, headers, text: await res.text() };
  }
};

/**
 * Secrets seam backed by the OS keyring (macOS Keychain / Windows Credential
 * Manager / Linux Secret Service) via the `secret_*` commands in the Rust shell
 * (src-tauri/src/lib.rs). Replaces the interim plaintext file store: provider
 * tokens never touch disk in the clear, and never the record repo. `secret_get`
 * returns null for an absent key, matching the seam contract.
 */
const keyringSecrets: Secrets = {
  get: (key) => invoke<string | null>('secret_get', { key }),
  set: (key, value) => invoke<void>('secret_set', { key, value }),
  delete: (key) => invoke<void>('secret_delete', { key })
};

/** Split a multi-statement SQL script into individual statements. Our schema
 * SQL contains no semicolons inside string literals, so a naive split is safe.
 * plugin-sql executes one statement per call, unlike better-sqlite3's `exec`. */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

class TauriDatabase implements CoreDatabase {
  private constructor(private readonly db: Database) {}

  static async open(name: string): Promise<TauriDatabase> {
    // Relative name → plugin-sql resolves it under the OS app-config dir, so
    // the index lives outside the repo and is per-machine (spec §5).
    return new TauriDatabase(await Database.load(`sqlite:${name}`));
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (params.length === 0) {
      for (const stmt of splitStatements(sql)) {
        await this.db.execute(stmt);
      }
      return;
    }
    await this.db.execute(sql, params);
  }

  async select<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.select<T[]>(sql, params);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** sha256 (hex) of a UTF-8 string via WebCrypto. */
async function sha256(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Synchronous, OS-aware path join (the core's joinPath must be sync). Picks
 * the separator from the root segment so Windows and POSIX paths both work. */
function joinPath(...segments: string[]): string {
  const first = segments[0] ?? '';
  const sep = /\\/.test(first) || /^[A-Za-z]:/.test(first) ? '\\' : '/';
  return segments
    .filter((s) => s.length > 0)
    .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep);
}

/** Stable short hash of the record path, used to name its per-record index db
 * so different record folders / machines never share one index file. */
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * Build a Tauri Platform for a given record folder. The index db name is
 * derived from the record path so each folder gets its own throwaway index.
 */
export async function createTauriPlatform(recordRoot: string): Promise<Platform> {
  const dbName = `whoami-index-${shortHash(recordRoot)}.db`;
  const db = await TauriDatabase.open(dbName);
  return { fs, db, git, hash: sha256, joinPath, http: tauriHttp, secrets: keyringSecrets };
}
