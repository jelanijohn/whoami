/**
 * The SQLite index (spec §5).
 *
 * This is a DERIVED cache. It is rebuilt from the canonical text files and is
 * never synced or authoritative. If it is deleted, {@link rebuild} reconstructs
 * it from `entries/*.md` with zero data loss.
 *
 * All SQL uses anonymous `?` placeholders bound positionally — the one
 * placeholder syntax both better-sqlite3 (tests/CLI) and Tauri's plugin-sql
 * (sqlite via sqlx) bind identically, so the same strings run on both.
 */

import type { Database, Entry, Platform, Row } from './types';
import { parseEntry, entryErrors } from './entry';

export const SCHEMA_VERSION = 2;

const ENTRIES_DIR = 'entries';

/** Create the index schema if it does not yet exist (idempotent). */
export async function ensureSchema(db: Database): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS entries (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      date         TEXT NOT NULL,
      title        TEXT,
      private      INTEGER NOT NULL DEFAULT 0,
      created      TEXT,
      updated      TEXT,
      body         TEXT,
      source_path  TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      frontmatter  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_date_idx ON entries(date);
    CREATE INDEX IF NOT EXISTS entries_type_idx ON entries(type);
    CREATE INDEX IF NOT EXISTS entries_path_idx ON entries(source_path);

    CREATE TABLE IF NOT EXISTS tags (
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      tag      TEXT NOT NULL,
      PRIMARY KEY (entry_id, tag)
    );

    CREATE TABLE IF NOT EXISTS provenance (
      entry_id  TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      source    TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY (entry_id, source, source_id),
      UNIQUE (source, source_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      id UNINDEXED, title, body
    );

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  await setMeta(db, 'schema_version', String(SCHEMA_VERSION));
}

/** Drop every index table — the "nuke and rebuild" escape hatch (spec §5.4). */
export async function dropSchema(db: Database): Promise<void> {
  await db.execute(`
    DROP TABLE IF EXISTS entries_fts;
    DROP TABLE IF EXISTS provenance;
    DROP TABLE IF EXISTS tags;
    DROP TABLE IF EXISTS entries;
    DROP TABLE IF EXISTS meta;
  `);
}

async function setMeta(db: Database, key: string, value: string): Promise<void> {
  await db.execute(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

export async function getMeta(db: Database, key: string): Promise<string | null> {
  const rows = await db.select<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key]);
  return rows.length ? rows[0].value : null;
}

/** Remove an entry (and its tags / provenance / FTS row) from the index by id. */
async function deleteById(db: Database, id: string): Promise<void> {
  await db.execute(`DELETE FROM tags WHERE entry_id = ?`, [id]);
  await db.execute(`DELETE FROM provenance WHERE entry_id = ?`, [id]);
  await db.execute(`DELETE FROM entries_fts WHERE id = ?`, [id]);
  await db.execute(`DELETE FROM entries WHERE id = ?`, [id]);
}

/**
 * Insert or replace one entry's index rows. Implemented as delete-then-insert
 * keyed on the ULID so the entries/tags/provenance/FTS rows can never drift
 * out of sync.
 */
async function upsertEntry(
  db: Database,
  entry: Entry,
  sourcePath: string,
  contentHash: string
): Promise<void> {
  const fm = entry.frontmatter;
  await deleteById(db, fm.id);
  await db.execute(
    `INSERT INTO entries
       (id, type, date, title, private, created, updated, body, source_path, content_hash, frontmatter)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fm.id,
      fm.type,
      fm.date,
      fm.title,
      fm.private ? 1 : 0,
      fm.created ?? null,
      fm.updated ?? null,
      entry.body,
      sourcePath,
      contentHash,
      JSON.stringify(fm)
    ]
  );
  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  for (const tag of tags) {
    await db.execute(`INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?, ?)`, [fm.id, tag]);
  }
  // Provenance is a derived projection of the `source` / `source_id`
  // frontmatter pass-through keys (ingest-reduce plan §1) — populated exactly
  // like tags, rebuilt from text like everything else here. OR IGNORE: if a
  // hand-edited second file claims the same (source, source_id), the first
  // indexed entry keeps the claim rather than failing the whole reindex.
  const src = typeof fm.source === 'string' ? fm.source : '';
  const srcId = typeof fm.source_id === 'string' ? fm.source_id : '';
  if (src && srcId) {
    await db.execute(
      `INSERT OR IGNORE INTO provenance (entry_id, source, source_id) VALUES (?, ?, ?)`,
      [fm.id, src, srcId]
    );
  }
  await db.execute(`INSERT INTO entries_fts (id, title, body) VALUES (?, ?, ?)`, [
    fm.id,
    fm.title,
    entry.body
  ]);
}

export interface RebuildReport {
  /** Files parsed and indexed this run (new or changed). */
  indexed: number;
  /** Unchanged files skipped via content_hash match. */
  skipped: number;
  /** Index rows deleted because their file no longer exists. */
  deleted: number;
  /** Files that could not be indexed, with the reason. */
  errors: { path: string; reason: string }[];
  full: boolean;
}

interface IndexedRow extends Row {
  id: string;
  source_path: string;
  content_hash: string;
}

/**
 * Rebuild the index from text.
 *
 * - Incremental (default): skip files whose hash matches the index, upsert new
 *   or changed files, and delete rows whose file has vanished.
 * - Full (`{ full: true }`): drop the tables first, then reindex everything.
 *
 * Always available, always safe — the text is canonical, so this can be run at
 * any time with no risk of data loss.
 */
export async function rebuild(
  platform: Platform,
  recordRoot: string,
  opts: { full?: boolean } = {}
): Promise<RebuildReport> {
  const { db, fs } = platform;
  const full = opts.full === true;

  if (full) await dropSchema(db);
  await ensureSchema(db);

  const report: RebuildReport = { indexed: 0, skipped: 0, deleted: 0, errors: [], full };

  // Discover the current set of entry files (record-relative paths).
  const entriesAbs = platform.joinPath(recordRoot, ENTRIES_DIR);
  const fileNames = (await fs.readDir(entriesAbs)).filter((n) => n.endsWith('.md'));
  const currentPaths = new Set(fileNames.map((n) => `${ENTRIES_DIR}/${n}`));

  // Drop index rows whose backing file is gone.
  const indexed = await db.select<IndexedRow>(`SELECT id, source_path, content_hash FROM entries`);
  const hashByPath = new Map<string, string>();
  for (const row of indexed) {
    if (!currentPaths.has(row.source_path)) {
      await deleteById(db, row.id);
      report.deleted++;
    } else {
      hashByPath.set(row.source_path, row.content_hash);
    }
  }

  // Upsert new / changed files.
  for (const relPath of currentPaths) {
    const abs = platform.joinPath(recordRoot, relPath);
    let text: string;
    try {
      text = await fs.readTextFile(abs);
    } catch (e) {
      report.errors.push({ path: relPath, reason: `read failed: ${String(e)}` });
      continue;
    }
    const hash = await platform.hash(text);
    if (hashByPath.get(relPath) === hash) {
      report.skipped++;
      continue;
    }
    const entry = parseEntry(text, relPath);
    const errs = entryErrors(entry);
    if (errs.length) {
      report.errors.push({ path: relPath, reason: errs.join('; ') });
      continue;
    }
    await upsertEntry(db, entry, relPath, hash);
    report.indexed++;
  }

  await setMeta(db, 'last_rebuild', new Date().toISOString());
  return report;
}

/**
 * Reindex a single file — step 3 of the write flow (spec §6). The text has
 * already been written; this brings the index into line with that one file.
 * Returns the indexed entry, or null if the file is gone or invalid (a stale
 * row for that path is removed either way).
 */
export async function reindexFile(
  platform: Platform,
  recordRoot: string,
  relPath: string
): Promise<Entry | null> {
  const { db, fs } = platform;
  const abs = platform.joinPath(recordRoot, relPath);
  if (!(await fs.exists(abs))) {
    await removeByPath(db, relPath);
    return null;
  }
  const text = await fs.readTextFile(abs);
  const hash = await platform.hash(text);
  const entry = parseEntry(text, relPath);
  if (entryErrors(entry).length) return null;
  await upsertEntry(db, entry, relPath, hash);
  return entry;
}

/** Remove any index rows backed by a given record-relative path. */
export async function removeByPath(db: Database, relPath: string): Promise<void> {
  const rows = await db.select<{ id: string }>(
    `SELECT id FROM entries WHERE source_path = ?`,
    [relPath]
  );
  for (const r of rows) await deleteById(db, r.id);
}

// ---------------------------------------------------------------------------
// Queries — the read side the dashboard / generators consume (spec §6).
// ---------------------------------------------------------------------------

export interface ListFilters {
  /** Include `private: true` entries. Default false — outward-safe by default. */
  includePrivate?: boolean;
  type?: string;
  tag?: string;
  /** Full-text query across title + body. */
  search?: string;
}

interface EntryRow extends Row {
  body: string;
  source_path: string;
  frontmatter: string;
}

function rowToEntry(row: EntryRow): Entry {
  const fm = JSON.parse(row.frontmatter);
  return { frontmatter: fm, body: row.body, path: row.source_path };
}

/**
 * List entries newest-first. Honors the privacy default (private excluded
 * unless explicitly requested) plus optional type/tag/search filters.
 */
export async function listEntries(db: Database, filters: ListFilters = {}): Promise<Entry[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!filters.includePrivate) where.push('e.private = 0');
  if (filters.type) {
    where.push('e.type = ?');
    params.push(filters.type);
  }
  if (filters.tag) {
    where.push('e.id IN (SELECT entry_id FROM tags WHERE tag = ?)');
    params.push(filters.tag);
  }
  if (filters.search && filters.search.trim()) {
    where.push('e.id IN (SELECT id FROM entries_fts WHERE entries_fts MATCH ?)');
    params.push(ftsQuery(filters.search));
  }

  const sql = `
    SELECT e.body, e.source_path, e.frontmatter
    FROM entries e
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.date DESC, e.created DESC
  `;
  const rows = await db.select<EntryRow>(sql, params);
  return rows.map(rowToEntry);
}

export async function getEntryById(db: Database, id: string): Promise<Entry | null> {
  const rows = await db.select<EntryRow>(
    `SELECT body, source_path, frontmatter FROM entries WHERE id = ?`,
    [id]
  );
  return rows.length ? rowToEntry(rows[0]) : null;
}

/**
 * The ingest dedupe lookup (ingest-reduce plan §1): the entry id that already
 * carries a given (source, source_id), or null. Re-running an adapter never
 * re-proposes an item whose provenance is already in the record.
 */
export async function findBySource(
  db: Database,
  source: string,
  sourceId: string
): Promise<string | null> {
  const rows = await db.select<{ entry_id: string }>(
    `SELECT entry_id FROM provenance WHERE source = ? AND source_id = ?`,
    [source, sourceId]
  );
  return rows.length ? rows[0].entry_id : null;
}

/** All source_ids already promoted for one source — bulk form of
 * {@link findBySource} so the pipeline dedupes a whole fetch in one query. */
export async function sourceIds(db: Database, source: string): Promise<Set<string>> {
  const rows = await db.select<{ source_id: string }>(
    `SELECT source_id FROM provenance WHERE source = ?`,
    [source]
  );
  return new Set(rows.map((r) => r.source_id));
}

/** Count of non-private entries per type, for dashboard summaries. */
export async function countsByType(
  db: Database,
  includePrivate = false
): Promise<Record<string, number>> {
  const rows = await db.select<{ type: string; n: number }>(
    `SELECT type, COUNT(*) AS n FROM entries
     ${includePrivate ? '' : 'WHERE private = 0'}
     GROUP BY type`
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.type] = Number(r.n);
  return out;
}

/** Distinct tags in use (non-private entries only by default). */
export async function allTags(db: Database, includePrivate = false): Promise<string[]> {
  const rows = await db.select<{ tag: string }>(
    `SELECT DISTINCT t.tag FROM tags t
     JOIN entries e ON e.id = t.entry_id
     ${includePrivate ? '' : 'WHERE e.private = 0'}
     ORDER BY t.tag`
  );
  return rows.map((r) => r.tag);
}

/**
 * Turn free user text into a safe FTS5 MATCH expression: each whitespace-split
 * term becomes a quoted prefix match, AND-ed together. Quoting avoids FTS5
 * syntax errors on characters like `-` or `"` in user input.
 */
function ftsQuery(input: string): string {
  const terms = input
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""'))
    .filter(Boolean)
    .map((t) => `"${t}"*`);
  return terms.join(' AND ');
}
