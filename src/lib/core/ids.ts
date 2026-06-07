/**
 * Identity & filename construction (spec §3).
 *
 * The canonical identity of an entry is its ULID `id` field. The filename is
 * for humans and Git only: `{YYYY-MM-DD}-{slug}-{id6}.md`, where `id6` is the
 * last six characters of the ULID. That suffix makes filenames collision-proof
 * across machines journaling offline.
 */

import { ulid } from 'ulid';

/** Generate a fresh ULID. Time-sortable, no central coordinator. */
export function newId(): string {
  return ulid();
}

/** The filename suffix: last 6 chars of the ULID, lowercased for tidy paths. */
export function id6(id: string): string {
  return id.slice(-6).toLowerCase();
}

/**
 * Derive a short kebab-case slug from a title.
 * - lowercased, non-alphanumerics collapsed to single hyphens
 * - trimmed of leading/trailing hyphens
 * - capped to keep filenames sane
 * Falls back to `entry` if the title has no usable characters.
 */
export function slugify(title: string, maxLen = 50): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug || 'entry';
}

/**
 * Build the entry filename (not including the `entries/` prefix).
 * `date` is the event date (YYYY-MM-DD); only its date part is used.
 */
export function entryFilename(date: string, title: string, id: string): string {
  const day = date.slice(0, 10);
  return `${day}-${slugify(title)}-${id6(id)}.md`;
}

/** The relative path of an entry within the record root. */
export function entryRelPath(date: string, title: string, id: string): string {
  return `entries/${entryFilename(date, title, id)}`;
}

/** True if a ULID looks structurally valid (26 Crockford base32 chars). */
export function isUlid(value: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(value);
}
