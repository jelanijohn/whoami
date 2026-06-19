/**
 * Entry <-> file round-trip (spec §3).
 *
 * `parseEntry` reads a `.md` file's text into an {@link Entry}, normalizing the
 * required fields without ever discarding unknown ones. `serializeEntry` writes
 * it back in canonical key order. `makeEntry` mints a new entry with a fresh
 * ULID and timestamps.
 *
 * Parsing is intentionally lenient: the record is hand-editable, so a slightly
 * malformed file should be reported (see {@link entryErrors}) rather than crash
 * the whole index rebuild.
 */

import type { Entry, EntryFrontmatter } from './types';
import { orderKeys, parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { entryRelPath, isUlid, newId, slugify } from './ids';

/** Canonical frontmatter key order for a diff-friendly file. `slug` sits next
 * to identity (it only appears on project entries); `project` next to `tags` as
 * the other cross-cutting affiliation key. */
const ENTRY_KEY_ORDER = [
  'id',
  'type',
  'slug',
  'date',
  'created',
  'updated',
  'title',
  'private',
  'tags',
  'project',
  // A win nests under this role/project entry id; sits by `project`, the other
  // cross-cutting affiliation key (wins-from-journal spec §1).
  'parent'
] as const;

/** Current wall-clock time as an ISO 8601 string. Injectable for tests. */
export function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Coerce raw frontmatter into the typed shape, preserving every key.
 * `private` is forced to a real boolean; `tags` to a string[]; the rest of the
 * required string fields are left as-is (validation is separate).
 */
function normalizeFrontmatter(raw: Record<string, unknown>): EntryFrontmatter {
  const fm: EntryFrontmatter = {
    ...raw,
    id: asString(raw.id) ?? '',
    type: asString(raw.type) ?? 'journal',
    date: asString(raw.date) ?? '',
    title: asString(raw.title) ?? '',
    private: raw.private === true
  };
  // Only set tags when present so we never invent the key on a file that
  // deliberately omitted it — but normalize its type when it is there.
  if ('tags' in raw) fm.tags = asStringArray(raw.tags);
  return fm;
}

/** Parse a `.md` file's text into an Entry. `path` is the record-relative path. */
export function parseEntry(text: string, path?: string): Entry {
  const { data, body } = parseFrontmatter(text);
  return { frontmatter: normalizeFrontmatter(data), body, path };
}

/** Serialize an Entry to canonical file text. Ensures `tags` and `private`
 * exist so freshly-written files carry the documented minimum schema. */
export function serializeEntry(entry: Entry): string {
  const fm: Record<string, unknown> = { ...entry.frontmatter };
  if (fm.private === undefined) fm.private = false;
  if (fm.tags === undefined) fm.tags = [];
  return serializeFrontmatter(orderKeys(fm, ENTRY_KEY_ORDER), entry.body);
}

export interface NewEntryInput {
  type: string;
  title: string;
  /** Event date, YYYY-MM-DD. Defaults to today's date (UTC). */
  date?: string;
  private?: boolean;
  tags?: string[];
  body?: string;
  /** Any extra type-specific frontmatter (org, role, links, source, …). */
  extra?: Record<string, unknown>;
}

/** Mint a new Entry with a fresh ULID, timestamps, and a computed path. */
export function makeEntry(input: NewEntryInput, now: string = nowIso()): Entry {
  const id = newId();
  const date = input.date ?? now.slice(0, 10);
  const frontmatter: EntryFrontmatter = {
    id,
    type: input.type,
    date,
    created: now,
    updated: now,
    title: input.title,
    private: input.private ?? false,
    tags: input.tags ?? [],
    ...(input.extra ?? {})
  };
  // A project entry needs a stable slug other entries point at (plan §2.1).
  // An explicit slug (via `extra`) wins; otherwise derive one from the title.
  // Only project entries carry a slug — for everything else it's meaningless.
  if (frontmatter.type === 'project' && typeof frontmatter.slug !== 'string') {
    frontmatter.slug = slugify(input.title);
  }
  return {
    frontmatter,
    body: input.body ?? '',
    path: entryRelPath(date, input.title, id)
  };
}

/**
 * Return the record-relative path an entry should live at, derived from its
 * current date/title/id. The app renames the file when date or title changes so
 * the filename stays meaningful; identity still travels in the `id` field.
 */
export function expectedPath(entry: Entry): string {
  return entryRelPath(entry.frontmatter.date, entry.frontmatter.title, entry.frontmatter.id);
}

/** Set `updated` to `now`, returning a new Entry (does not mutate input). */
export function touchEntry(entry: Entry, now: string = nowIso()): Entry {
  return {
    ...entry,
    frontmatter: { ...entry.frontmatter, updated: now }
  };
}

/** Human-readable validation problems, or [] if the entry is well-formed. */
export function entryErrors(entry: Entry): string[] {
  const fm = entry.frontmatter;
  const errs: string[] = [];
  if (!fm.id) errs.push('missing required field: id');
  else if (!isUlid(fm.id)) errs.push(`id is not a valid ULID: ${fm.id}`);
  if (!fm.type) errs.push('missing required field: type');
  if (!fm.date) errs.push('missing required field: date');
  else if (!/^\d{4}-\d{2}-\d{2}/.test(fm.date)) errs.push(`date is not ISO 8601: ${fm.date}`);
  if (!fm.title) errs.push('missing required field: title');
  if (typeof fm.private !== 'boolean') errs.push('missing required field: private');
  return errs;
}

export function entryIsValid(entry: Entry): boolean {
  return entryErrors(entry).length === 0;
}
