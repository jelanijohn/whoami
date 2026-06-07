/**
 * Personal-site generator → a single standalone `.html` file (spec §7).
 *
 * Self-contained (inline CSS, no external requests) so it can be dropped onto
 * any static host. Private entries are excluded defensively. The public
 * "how the world sees me" section is built only from non-private
 * `type: mention` entries (spec §7).
 */

import type { Entry, Profile } from '../types';
import { escapeHtml, groupByType, links, monthYear, publicEntries, str } from './shared';

export interface SiteInput {
  profile: Profile;
  entries: Entry[];
}

interface SiteSection {
  type: string;
  heading: string;
}

const DEFAULT_SECTIONS: SiteSection[] = [
  { type: 'role', heading: 'Experience' },
  { type: 'project', heading: 'Projects' },
  { type: 'win', heading: 'Highlights' },
  { type: 'education', heading: 'Education' },
  { type: 'skill', heading: 'Skills' },
  { type: 'milestone', heading: 'Milestones' }
];

function renderBodyHtml(body: string): string {
  // Minimal, safe Markdown-ish rendering: escape everything, then turn blank
  // lines into paragraph breaks. We never inject raw HTML from the record.
  const escaped = escapeHtml(body.trim());
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function renderEntry(e: Entry): string {
  const fm = e.frontmatter;
  const org = str(e, 'org');
  const role = str(e, 'role');
  const meta = [role, org].filter(Boolean).join(' · ');
  const ls = links(e);
  return `      <article class="entry">
        <h3>${escapeHtml(fm.title)}</h3>
        <p class="meta">${escapeHtml([meta, monthYear(fm.date)].filter(Boolean).join('  ·  '))}</p>
        ${e.body.trim() ? renderBodyHtml(e.body) : ''}
        ${
          ls.length
            ? `<p class="links">${ls
                .map((l) => `<a href="${escapeHtml(l)}" rel="noopener">${escapeHtml(l)}</a>`)
                .join(' · ')}</p>`
            : ''
        }
      </article>`;
}

function renderMention(e: Entry): string {
  const source = str(e, 'source');
  const ls = links(e);
  const href = ls[0];
  const title = escapeHtml(e.frontmatter.title);
  return `      <li class="mention">
        ${href ? `<a href="${escapeHtml(href)}" rel="noopener">${title}</a>` : title}
        ${source ? `<span class="source">— ${escapeHtml(source)}</span>` : ''}
        <span class="meta">${escapeHtml(monthYear(e.frontmatter.date))}</span>
      </li>`;
}

const STYLE = `
  :root { --ink:#1a1a1a; --muted:#666; --line:#e4e4df; --accent:#3b5bdb; }
  * { box-sizing: border-box; }
  body { margin:0; color:var(--ink); background:#fff;
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    line-height:1.55; }
  main { max-width: 46rem; margin: 0 auto; padding: 4rem 1.5rem; }
  header h1 { font-size: 2.25rem; margin: 0 0 .25rem; }
  header .headline { font-size: 1.15rem; color:var(--muted); margin:0 0 .75rem; }
  header .contact a { color: var(--accent); text-decoration: none; }
  header .contact { color: var(--muted); font-size:.95rem; }
  section { margin-top: 2.5rem; }
  section > h2 { font-size: .8rem; letter-spacing:.08em; text-transform:uppercase;
    color:var(--muted); border-bottom:1px solid var(--line); padding-bottom:.4rem; }
  .entry { margin: 1.25rem 0; }
  .entry h3 { margin: 0 0 .15rem; font-size: 1.1rem; }
  .entry .meta, .mention .meta { color: var(--muted); font-size:.85rem; margin:.1rem 0; }
  .entry p { margin:.4rem 0; }
  .links a, .mention a { color: var(--accent); text-decoration: none; }
  ul.mentions { list-style:none; padding:0; margin:0; }
  .mention { padding:.5rem 0; border-bottom:1px dashed var(--line); }
  .mention .source { color: var(--muted); }
  footer { margin-top:3rem; color:var(--muted); font-size:.8rem; text-align:center; }
`;

export function generateSiteHtml(input: SiteInput, sections = DEFAULT_SECTIONS): string {
  const entries = publicEntries(input.entries);
  const groups = groupByType(entries);
  const p = input.profile.frontmatter;
  const name = p.name || 'Personal Site';

  const contact: string[] = [];
  for (const [, url] of Object.entries(p.identities ?? {})) {
    if (url) contact.push(`<a href="${escapeHtml(String(url))}" rel="noopener">${escapeHtml(String(url))}</a>`);
  }
  if (p.location) contact.unshift(`<span>${escapeHtml(String(p.location))}</span>`);

  const sectionHtml = sections
    .map((s) => {
      const items = groups.get(s.type);
      if (!items || items.length === 0) return '';
      return `    <section>
      <h2>${escapeHtml(s.heading)}</h2>
${items.map(renderEntry).join('\n')}
    </section>`;
    })
    .filter(Boolean)
    .join('\n');

  const mentions = groups.get('mention') ?? [];
  const mentionsHtml = mentions.length
    ? `    <section>
      <h2>How the world sees me</h2>
      <ul class="mentions">
${mentions.map(renderMention).join('\n')}
      </ul>
    </section>`
    : '';

  const bio = input.profile.body.trim() ? renderBodyHtml(input.profile.body) : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(name)}</h1>
    ${p.headline ? `<p class="headline">${escapeHtml(String(p.headline))}</p>` : ''}
    ${contact.length ? `<p class="contact">${contact.join(' · ')}</p>` : ''}
  </header>
  ${bio ? `<section><h2>About</h2>${bio}</section>` : ''}
${sectionHtml}
${mentionsHtml}
  <footer>Generated by Who Am I — private record, public face.</footer>
</main>
</body>
</html>
`;
}
