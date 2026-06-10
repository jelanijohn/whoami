/**
 * LinkedIn adapter — **import-only** (ingest-reduce plan §1): LinkedIn has no
 * usable live API, so this parses the CSVs inside the official LinkedIn data
 * export archive (Settings → Data privacy → Get a copy of your data). The
 * caller unzips and hands over file contents; this module is pure text→items.
 *
 * Source ids are derived deterministically from the row's identifying fields,
 * so re-importing the same archive dedupes cleanly against the provenance
 * index and the inbox.
 */

import { slugify } from '../ids';
import type { RawItem } from './types';

/** Minimal RFC-4180 CSV parser: quoted fields, embedded commas/quotes/newlines.
 * Pure — unit-tested. Tolerates CRLF and a UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/** First row = headers → array of {header: value} records. */
export function csvToRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = (cells[i] ?? '').trim();
    });
    return rec;
  });
}

const LI_MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

/** LinkedIn export dates ("Mar 2019", "2019", "Mar 2019 12:00 AM") →
 * YYYY-MM-DD (day pinned to 01), or undefined. Pure — unit-tested. */
export function liDate(s: string | undefined): string | undefined {
  const v = s?.trim();
  if (!v) return undefined;
  let m = /^([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(v);
  if (m) {
    const month = LI_MONTHS[m[1].toLowerCase()];
    if (month) return `${m[2]}-${month}-01`;
  }
  m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(v);
  if (m) return `${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}`;
  return undefined;
}

/** Deterministic source id from a row's identity fields. */
function rowId(kind: string, ...fields: (string | undefined)[]): string {
  return `${kind}:${fields.map((f) => slugify(f ?? '')).join(':')}`;
}

/** `Positions.csv`: Company Name, Title, Description, Location, Started On,
 * Finished On → `type: role` items. Rows with no parseable start date are
 * skipped (a role with no date can't sit on the timeline). */
export function mapLinkedinPositions(csv: string): RawItem[] {
  const out: RawItem[] = [];
  for (const r of csvToRecords(csv)) {
    const company = r['Company Name'];
    const title = r['Title'];
    const started = liDate(r['Started On']);
    if (!company || !title || !started) continue;
    const finished = liDate(r['Finished On']);
    const extra: Record<string, unknown> = { org: company, role: title };
    if (finished) extra.end = finished;
    out.push({
      source: 'linkedin',
      sourceId: rowId('position', company, title, started),
      title: `${title} — ${company}`,
      date: started,
      body: r['Description'] ?? '',
      suggestedType: 'role',
      suggestedTags: ['linkedin'],
      suggestedProject: undefined,
      extraFrontmatter: extra,
      meta: r['Location'] ? { location: r['Location'] } : {}
    });
  }
  return out;
}

/** `Projects.csv`: Title, Description, Url, Started On, Finished On →
 * `type: project` items. */
export function mapLinkedinProjects(csv: string): RawItem[] {
  const out: RawItem[] = [];
  for (const r of csvToRecords(csv)) {
    const title = r['Title'];
    const started = liDate(r['Started On']);
    if (!title || !started) continue;
    const finished = liDate(r['Finished On']);
    const extra: Record<string, unknown> = {};
    if (finished) extra.end = finished;
    out.push({
      source: 'linkedin',
      sourceId: rowId('project', title, started),
      title,
      date: started,
      url: r['Url'] || undefined,
      body: r['Description'] ?? '',
      suggestedType: 'project',
      suggestedTags: ['linkedin'],
      suggestedProject: slugify(title),
      extraFrontmatter: extra,
      meta: {}
    });
  }
  return out;
}

/** `Education.csv`: School Name, Start Date, End Date, Notes, Degree Name,
 * Activities → `type: education` items. */
export function mapLinkedinEducation(csv: string): RawItem[] {
  const out: RawItem[] = [];
  for (const r of csvToRecords(csv)) {
    const school = r['School Name'];
    const started = liDate(r['Start Date']);
    if (!school || !started) continue;
    const degree = r['Degree Name'];
    const finished = liDate(r['End Date']);
    const extra: Record<string, unknown> = { org: school };
    if (finished) extra.end = finished;
    const bodyParts = [r['Notes'], r['Activities']].filter(Boolean);
    out.push({
      source: 'linkedin',
      sourceId: rowId('education', school, degree, started),
      title: degree ? `${degree} — ${school}` : school,
      date: started,
      body: bodyParts.join('\n\n'),
      suggestedType: 'education',
      suggestedTags: ['linkedin'],
      extraFrontmatter: extra,
      meta: {}
    });
  }
  return out;
}

/** Import a whole unzipped archive: filename → file text. Recognized CSVs are
 * mapped; everything else is ignored. */
export function importLinkedinArchive(files: Record<string, string>): RawItem[] {
  const items: RawItem[] = [];
  for (const [name, text] of Object.entries(files)) {
    const base = name.split('/').pop()?.toLowerCase() ?? '';
    if (base === 'positions.csv') items.push(...mapLinkedinPositions(text));
    else if (base === 'projects.csv') items.push(...mapLinkedinProjects(text));
    else if (base === 'education.csv') items.push(...mapLinkedinEducation(text));
  }
  return items;
}
