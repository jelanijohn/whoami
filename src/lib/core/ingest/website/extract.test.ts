import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPage } from './extract';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

const PAGE_URL = 'https://jane.example/about';

describe('extractPage', () => {
  it('strips_nav_header_footer_script_style', () => {
    const { mainText } = extractPage(fixture('about.html'), PAGE_URL);
    expect(mainText).not.toContain('Navigation banner boilerplate');
    expect(mainText).not.toContain('Sidebar promo');
    expect(mainText).not.toContain('tracking junk'); // <script>
    expect(mainText).not.toContain('color: red'); // <style>
    expect(mainText).not.toContain('Find me elsewhere'); // <footer>
  });

  it('prefers_main_article_over_body', () => {
    const { mainText } = extractPage(fixture('about.html'), PAGE_URL);
    expect(mainText).toContain('I led the platform team at Acme Corp');
    expect(mainText).toContain('Founded Open Atlas');
    // The <header><h1>Jane Roe</h1> banner lives outside <main>, so it is excluded.
    expect(mainText).not.toContain('Navigation banner boilerplate');
  });

  it('captures_jsonld_and_open_graph', () => {
    const { structured } = extractPage(fixture('about.html'), PAGE_URL);
    expect(structured.openGraph.title).toBe('Jane Roe');
    expect(structured.openGraph.description).toBe('Designer and engineer in Detroit.');
    expect(structured.meta.description).toBe('Designer and engineer.');
    expect(structured.jsonLd).toHaveLength(1);
    const person = structured.jsonLd[0] as { '@type'?: string; sameAs?: string[] };
    expect(person['@type']).toBe('Person');
    expect(person.sameAs).toContain('https://github.com/janeroe');
  });

  it('resolves_relative_hrefs_to_absolute', () => {
    const { outboundLinks } = extractPage(fixture('about.html'), PAGE_URL);
    // /projects (root-relative) and about.html (path-relative) → absolute.
    expect(outboundLinks).toContain('https://jane.example/projects');
    expect(outboundLinks).toContain('https://jane.example/about.html');
    expect(outboundLinks).toContain('https://github.com/janeroe');
    // Deduped: the footer's github link plus any others collapse to one entry.
    expect(outboundLinks.filter((u) => u === 'https://github.com/janeroe')).toHaveLength(1);
  });

  it('empty_shell_yields_short_mainText', () => {
    const { mainText } = extractPage(fixture('spa-shell.html'), 'https://spa.example/');
    expect(mainText.length).toBeLessThan(200); // WEBSITE_MIN_TEXT — flagged as a shell
  });
});
