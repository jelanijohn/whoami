import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolvePages } from './resolve';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

describe('resolvePages', () => {
  it('dedupes_trailing_slash_and_fragments', () => {
    const out = resolvePages({
      urls: [
        'https://jane.example/about',
        'https://jane.example/about/',
        'https://jane.example/about#bio'
      ]
    });
    expect(out).toEqual(['https://jane.example/about']);
  });

  it('keeps_only_allowlisted_origins', () => {
    const out = resolvePages({
      urls: ['https://jane.example/'],
      sitemapXml: fixture('sitemap.xml')
    });
    // The foreign-origin loc (evil.example) is dropped; so is the .jpg asset.
    expect(out).not.toContain('https://evil.example/phishing');
    expect(out.some((u) => u.includes('evil.example'))).toBe(false);
    expect(out.some((u) => u.endsWith('.jpg'))).toBe(false);
    expect(out).toContain('https://jane.example/about');
    // The &amp; in the sitemap loc is decoded and the query preserved.
    expect(out).toContain('https://jane.example/projects?tag=open&sort=date');
  });

  it('caps_at_maxPages_deterministic_order', () => {
    const out = resolvePages({
      urls: [
        'https://jane.example/a',
        'https://jane.example/b',
        'https://jane.example/c'
      ],
      maxPages: 2
    });
    expect(out).toEqual(['https://jane.example/a', 'https://jane.example/b']);
  });

  it('parses_urlset_and_first_level_sitemapindex', () => {
    const urlset = resolvePages({
      urls: ['https://jane.example/'],
      sitemapXml: fixture('sitemap.xml')
    });
    expect(urlset).toContain('https://jane.example/about');

    // A sitemapindex's first-level <loc>s (nested sitemap .xml URLs) are parsed
    // and returned — v1 does not recurse into them (spec D4), but parsing works.
    const index = resolvePages({
      urls: ['https://jane.example/'],
      sitemapXml: fixture('sitemap-index.xml')
    });
    expect(index).toContain('https://jane.example/sitemap-pages.xml');
    expect(index).toContain('https://jane.example/sitemap-posts.xml');
  });

  it('drops non-http(s) entered urls and trusts a sitemap-only origin', () => {
    // mailto:/javascript: are rejected; a sitemap-only run still resolves via
    // the sitemap URL's origin joining the allowlist.
    const out = resolvePages({
      urls: ['mailto:jane@example.com'],
      sitemapUrl: 'https://jane.example/sitemap.xml',
      sitemapXml: fixture('sitemap.xml')
    });
    expect(out).toContain('https://jane.example/about');
    expect(out.some((u) => u.startsWith('mailto:'))).toBe(false);
  });
});
