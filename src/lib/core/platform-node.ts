/**
 * Node-backed {@link Platform} implementation.
 *
 * Used by the test suite and by any future CLI wrapper around the same core.
 * It is deliberately NOT imported by the Tauri frontend (which provides its own
 * plugin-backed platform), so node built-ins and better-sqlite3 never reach the
 * browser bundle.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Database, FileSystem, GitRunner, Platform, Row } from './types';

const nodeFs: FileSystem = {
  async readTextFile(path) {
    return readFile(path, 'utf8');
  },
  async writeTextFile(path, contents) {
    await writeFile(path, contents, 'utf8');
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async removeFile(path) {
    await rm(path, { force: true });
  },
  async readDir(path) {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  }
};

const nodeGit: GitRunner = {
  run(args, cwd) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    });
  }
};

/** better-sqlite3 wrapped to satisfy the async {@link Database} interface. */
class NodeDatabase implements Database {
  private db: BetterSqlite3.Database;
  constructor(path: string) {
    this.db = new BetterSqlite3(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }
  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (params.length === 0) {
      // Schema / multi-statement scripts with no bound values.
      this.db.exec(sql);
      return;
    }
    this.db.prepare(sql).run(...(params as never[]));
  }
  async select<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }
  async close(): Promise<void> {
    this.db.close();
  }
}

async function sha256(content: string): Promise<string> {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Build a node Platform. `dbPath` is where the SQLite index lives (use
 * `:memory:` for ephemeral tests). */
export function createNodePlatform(dbPath: string): Platform {
  return {
    fs: nodeFs,
    db: new NodeDatabase(dbPath),
    git: nodeGit,
    hash: sha256,
    joinPath: (...segments: string[]) => join(...segments)
  };
}
