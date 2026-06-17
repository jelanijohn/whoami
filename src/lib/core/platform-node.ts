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
import { extname, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type {
  Database,
  DocExtract,
  FileSystem,
  GitRunner,
  Http,
  Platform,
  Row,
  Secrets
} from './types';

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

/** Ingestion Http seam over node's global fetch (Node 18+). */
const nodeHttp: Http = {
  async request(req) {
    const resp = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body
    });
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: resp.status, ok: resp.ok, headers, text: await resp.text() };
  }
};

/** Test/CLI Secrets: in-memory, seeded on read from `WHOAMI_SECRET_<KEY>` env
 * vars (key uppercased, non-alphanumerics → `_`). Never persisted to disk. */
class EnvSecrets implements Secrets {
  private map = new Map<string, string>();
  private envName(key: string): string {
    return `WHOAMI_SECRET_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  }
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? process.env[this.envName(key)] ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/** better-sqlite3 wrapped to satisfy the async {@link Database} interface. */
class NodeDatabase implements Database {
  private db: BetterSqlite3.Database;
  constructor(path: string, opts: { readonly?: boolean } = {}) {
    this.db = new BetterSqlite3(path, opts.readonly ? { readonly: true } : undefined);
    if (!opts.readonly) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    }
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

/**
 * DocExtract seam (résumé import spec §3): pdf-parse for PDF, mammoth for DOCX.
 * The binary parsers are imported lazily so they never burden the common
 * (non-résumé) code paths, and so the core never statically pulls them in.
 */
const nodeDocs: DocExtract = {
  async extractText(path) {
    const ext = extname(path).toLowerCase();
    if (ext === '.pdf') {
      const data = await readFile(path);
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(data) });
      try {
        const result = await parser.getText();
        return { text: result.text, kind: 'pdf', pageCount: result.total };
      } finally {
        await parser.destroy();
      }
    }
    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.extractRawText({ path });
      return { text: value, kind: 'docx' };
    }
    throw new Error(`Unsupported résumé format "${ext || path}" — expected .pdf or .docx`);
  }
};

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
    joinPath: (...segments: string[]) => join(...segments),
    http: nodeHttp,
    secrets: new EnvSecrets(),
    docs: nodeDocs,
    async openDatabase(path: string) {
      return new NodeDatabase(path, { readonly: true });
    }
  };
}
