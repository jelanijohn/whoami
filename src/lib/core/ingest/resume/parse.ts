/**
 * Strict parse + evidence filter for the résumé extraction reply (spec §5).
 *
 * Trust the résumé, verify the model (spec §0.1). In order:
 *   1. stripFence + JSON.parse; a non-`{items:[…]}` shape THROWS (the caller
 *      reports that chunk into `errors`, never aborting the run).
 *   2. Schema-validate each item; silently drop malformed ones.
 *   3. EVIDENCE FILTER (spec §1 rule 2): drop any item whose `excerpt` is not a
 *      (whitespace-normalized) substring of the source text — the anti-
 *      hallucination gate. Reported as "unverifiable".
 *   4. Normalize the date via `liDate` (reused from linkedin.ts); an item with
 *      no parseable start is dropped and reported (never defaulted to today,
 *      spec §8). `end` of present/current ⇒ omitted.
 *   5. Map survivors onto `RawItem` (spec §2 table), `body` = the verbatim
 *      `excerpt` and `sourceId` derived deterministically (spec §2.1).
 */

import { slugify } from '../../ids';
import { stripFence } from '../../reduce/parse';
import { liDate } from '../linkedin';
import type { RawItem } from '../types';
import { RESUME_SOURCE, RESUME_TYPES, type ResumeItem, type ResumeType } from './types';

const RESUME_TYPE_SET = new Set<string>(RESUME_TYPES);

/**
 * Optional overrides that let a sibling front-end (the website importer,
 * website-import spec §2.3.1) reuse this exact validate/evidence/date path with
 * its own `source`, `suggestedTags`, and `sourceId` scheme. Omitted entirely ⇒
 * byte-for-byte résumé behavior, so the existing call site is unchanged.
 */
export interface ExtractParseOpts {
  /** The `RawItem.source` to stamp (default {@link RESUME_SOURCE}). */
  source?: string;
  /** The single `suggestedTags` entry (default `'resume'`). */
  tag?: string;
  /** Deterministic id from the item's identity (default {@link resumeSourceId}). */
  makeSourceId?: (item: ResumeItem, start: string) => string;
}

/** Collapse all whitespace runs to single spaces — résumé text often re-flows
 * when extracted from columns, so the evidence filter must be whitespace-
 * tolerant while staying a strict substring match (spec §5 step 3). */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Validate one raw model item against the closed schema (spec §5). Returns the
 * narrowed {@link ResumeItem} or null to drop it silently (malformed). */
function asResumeItem(v: unknown): ResumeItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.type !== 'string' || !RESUME_TYPE_SET.has(o.type)) return null;
  const type = o.type as ResumeType;
  const str = (x: unknown): string | undefined =>
    typeof x === 'string' && x.trim() ? x.trim() : undefined;

  const title = str(o.title);
  const start = str(o.start);
  const excerpt = typeof o.excerpt === 'string' && o.excerpt.trim() ? o.excerpt : undefined;
  if (!title || !start || !excerpt) return null;

  const org = str(o.org);
  // `org` is required for role & education (closed schema §5).
  if ((type === 'role' || type === 'education') && !org) return null;

  const item: ResumeItem = { type, title, start, excerpt };
  if (org) item.org = org;
  const role = str(o.role);
  if (role) item.role = role;
  const end = str(o.end);
  if (end) item.end = end;
  const location = str(o.location);
  if (location) item.location = location;
  const url = str(o.url);
  if (url) item.url = url;
  return item;
}

/** `end` → normalized date, or undefined for present/current/ongoing or an
 * unparseable value (end is advisory; never fails the item). */
function normalizeEnd(end: string | undefined): string | undefined {
  if (!end) return undefined;
  if (/^(present|current|now|ongoing|to date)$/i.test(end)) return undefined;
  return liDate(end);
}

/** Deterministic source id from the item's identity fields (spec §2.1) — slug
 * the identity, never hash the file, so an edited résumé re-proposes only the
 * changed items. Mirrors `linkedin.ts`'s `rowId`. */
function resumeSourceId(item: ResumeItem, start: string): string {
  const slug = (s: string | undefined): string => slugify(s ?? '');
  switch (item.type) {
    case 'role':
      return `role:${slug(item.org)}:${slug(item.role ?? item.title)}:${slug(start)}`;
    case 'project':
      return `project:${slug(item.title)}:${slug(start)}`;
    case 'education':
      return `education:${slug(item.org)}:${slug(item.title)}:${slug(start)}`;
    default: // win | milestone — both key under `win:` (spec §2.1)
      return `win:${slug(item.title)}:${slug(start)}`;
  }
}

/** Map a validated, dated item onto a `RawItem` (spec §2 table). `start` is the
 * already-normalized YYYY-MM-DD date. `opts` lets a sibling front-end (website)
 * stamp its own source/tag/sourceId; absent ⇒ résumé defaults. */
function mapItem(item: ResumeItem, start: string, opts: ExtractParseOpts = {}): RawItem {
  const source = opts.source ?? RESUME_SOURCE;
  const tag = opts.tag ?? 'resume';
  const makeSourceId = opts.makeSourceId ?? resumeSourceId;
  const end = normalizeEnd(item.end);
  const base = item.type === 'role' ? (item.role ?? item.title) : item.title;
  // role/education titles read like a LinkedIn-sourced candidate: "X — Org".
  const title =
    (item.type === 'role' || item.type === 'education') && item.org && !base.includes(item.org)
      ? `${base} — ${item.org}`
      : base;

  const extra: Record<string, unknown> = {};
  if (item.org) extra.org = item.org;
  if (item.type === 'role' && item.role) extra.role = item.role;
  if (end) extra.end = end;

  const out: RawItem = {
    source,
    sourceId: makeSourceId(item, start),
    title,
    date: start,
    body: item.excerpt, // the verbatim span — the human's at-a-glance check
    suggestedType: item.type,
    suggestedTags: [tag],
    extraFrontmatter: extra,
    meta: item.location ? { location: item.location } : {}
  };
  if (item.url) out.url = item.url;
  if (item.type === 'project') out.suggestedProject = slugify(item.title);
  return out;
}

/**
 * Parse one model reply into `RawItem[]`, appending per-item drop reasons
 * (unverifiable / undated) to `errors`. THROWS on a non-`{items:[…]}` shape so
 * the caller can report that whole chunk (spec §5 step 1).
 */
export function parseResumeItems(
  raw: string,
  sourceText: string,
  errors: string[] = [],
  opts: ExtractParseOpts = {}
): RawItem[] {
  let data: unknown;
  try {
    data = JSON.parse(stripFence(raw));
  } catch {
    throw new Error('resume: model reply was not valid JSON');
  }
  const list =
    data && typeof data === 'object' ? (data as Record<string, unknown>).items : undefined;
  if (!Array.isArray(list)) {
    throw new Error('resume: model reply had no "items" array');
  }

  const normSource = normalizeWs(sourceText);
  const out: RawItem[] = [];
  for (const v of list) {
    const item = asResumeItem(v);
    if (!item) continue; // malformed → silent drop (spec §5 step 2)

    // Evidence filter (spec §1 rule 2): the excerpt must appear in the résumé.
    if (!normSource.includes(normalizeWs(item.excerpt))) {
      errors.push(`unverifiable (excerpt not found in résumé): "${item.title}"`);
      continue;
    }

    // A timeline item with no parseable date can't be placed — drop, never
    // default to today (spec §8). Reported so the owner can add it by hand.
    const start = liDate(item.start);
    if (!start) {
      errors.push(`undated ${item.type} dropped (no parseable date): "${item.title}"`);
      continue;
    }

    out.push(mapItem(item, start, opts));
  }
  return out;
}
