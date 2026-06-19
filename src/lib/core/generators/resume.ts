/**
 * Resume generator → Markdown (spec §7).
 *
 * Reads the (already index-sourced) entries + profile and renders a Markdown
 * resume. Private entries are excluded here too, defensively — the generator
 * never trusts that the caller filtered.
 *
 * This is the *output* stage: formatting and selection happen here. The raw
 * record is never rewritten (spec §9).
 */

import type { Entry, Profile } from '../types';
import { groupByType, links, monthYear, partitionWins, publicEntries, str } from './shared';

export interface ResumeInput {
  profile: Profile;
  entries: Entry[];
}

export interface ResumeOptions {
  /** Entry types to include, in render order. Defaults to a standard resume. */
  sections?: ResumeSection[];
}

interface ResumeSection {
  type: string;
  heading: string;
}

const DEFAULT_SECTIONS: ResumeSection[] = [
  { type: 'role', heading: 'Experience' },
  { type: 'project', heading: 'Projects' },
  { type: 'win', heading: 'Highlights' },
  { type: 'education', heading: 'Education' },
  { type: 'skill', heading: 'Skills' }
];

function entryDateRange(e: Entry): string {
  const end = str(e, 'end') || str(e, 'ended');
  const start = monthYear(e.frontmatter.date);
  return end ? `${start} – ${monthYear(end)}` : start;
}

/** Render one win as a Markdown bullet: its title, with the body (if any) on a
 * following plain line. The same shape wherever a win appears (spec §4). */
function renderWinBullet(w: Entry): string {
  const body = w.body.trim();
  return body ? `- ${w.frontmatter.title}\n  ${body}` : `- ${w.frontmatter.title}`;
}

function renderEntry(e: Entry, byParent: Map<string, Entry[]>): string {
  const fm = e.frontmatter;
  const org = str(e, 'org');
  const role = str(e, 'role');
  const subtitleParts = [role, org].filter(Boolean);
  const lines: string[] = [];

  // Heading line: title — role at org · date
  let head = `### ${fm.title}`;
  lines.push(head);

  const meta = [subtitleParts.join(' · '), entryDateRange(e)].filter(Boolean).join('  ·  ');
  if (meta) lines.push(`*${meta}*`);

  const body = e.body.trim();
  if (body) {
    lines.push('');
    lines.push(body);
  }

  const ls = links(e);
  if (ls.length) {
    lines.push('');
    lines.push(ls.map((l) => `[${l}](${l})`).join(' · '));
  }

  // Nest any wins that resolve to this role/project as bullets beneath it.
  const nested = byParent.get(String(fm.id));
  if (nested?.length) {
    lines.push('');
    for (const w of nested) lines.push(renderWinBullet(w));
  }
  return lines.join('\n');
}

export function generateResumeMarkdown(input: ResumeInput, opts: ResumeOptions = {}): string {
  const sections = opts.sections ?? DEFAULT_SECTIONS;
  const entries = publicEntries(input.entries);
  const groups = groupByType(entries);
  const { byParent, nestedIds } = partitionWins(entries);
  const p = input.profile.frontmatter;

  const out: string[] = [];

  // Header
  out.push(`# ${p.name || 'Unnamed'}`);
  if (p.headline) out.push(`**${p.headline}**`);
  const contact: string[] = [];
  if (p.location) contact.push(String(p.location));
  for (const [, url] of Object.entries(p.identities ?? {})) {
    if (url) contact.push(String(url));
  }
  if (contact.length) out.push(contact.join(' · '));

  // Summary from profile body
  const bio = input.profile.body.trim();
  if (bio) {
    out.push('');
    out.push('## Summary');
    out.push(bio);
  }

  // Sections
  for (const section of sections) {
    const items = groups.get(section.type);
    if (!items || items.length === 0) continue;
    // Wins render as a flat bullet list of the orphans only — any win nested
    // under a role/project is already rendered there. If that empties the group,
    // the skip-empty guard above drops the "Highlights" heading entirely.
    if (section.type === 'win') {
      const orphans = items.filter((w) => !nestedIds.has(String(w.frontmatter.id)));
      if (orphans.length === 0) continue;
      out.push('');
      out.push(`## ${section.heading}`);
      out.push('');
      for (const w of orphans) out.push(renderWinBullet(w));
      continue;
    }
    out.push('');
    out.push(`## ${section.heading}`);
    for (const e of items) {
      out.push('');
      out.push(renderEntry(e, byParent));
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
