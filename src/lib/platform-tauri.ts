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
import {
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  writeTextFile
} from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
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
 * Http seam via the webview's fetch. GitHub, Asana, and Google APIs all send
 * CORS headers, so plain fetch works from the Tauri webview. If a future
 * provider doesn't, upgrade this to @tauri-apps/plugin-http (same interface,
 * no CORS constraint) — the seam means nothing else changes.
 */
const tauriHttp: Http = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
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
 * INTERIM Secrets implementation — plaintext JSON in the app-data dir
 * (NEVER inside the record repo). Good enough to wire the UI; replace with a
 * keyring-backed plugin (e.g. tauri-plugin-keyring) BEFORE storing real
 * long-lived tokens. The Secrets seam makes that swap a one-file change.
 */
class FileSecrets implements Secrets {
  private cache: Record<string, string> | null = null;

  private async path(): Promise<string> {
    return join(await appDataDir(), 'whoami-secrets.json');
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readTextFile(await this.path());
      this.cache = JSON.parse(raw) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    await writeTextFile(await this.path(), JSON.stringify(this.cache ?? {}, null, 2));
  }

  async get(key: string): Promise<string | null> {
    const m = await this.load();
    return m[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const m = await this.load();
    m[key] = value;
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    const m = await this.load();
    delete m[key];
    await this.persist();
  }
}

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
  return { fs, db, git, hash: sha256, joinPath, http: tauriHttp, secrets: new FileSecrets() };
}
