import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Http, HttpResponse } from '../../types';
import { acquireWebsite } from './acquire';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

interface Stub {
  status?: number;
  body: string;
  contentType?: string;
}

/** An Http stub that answers from a url→response map and records call order. */
function stubHttp(map: Record<string, Stub>): Http & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(req): Promise<HttpResponse> {
      calls.push(req.url);
      const entry = map[req.url];
      if (!entry) return { status: 404, ok: false, headers: {}, text: 'not found' };
      const status = entry.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { 'content-type': entry.contentType ?? 'text/html' },
        text: entry.body
      };
    }
  };
}

/** A page body whose cleaned text comfortably clears WEBSITE_MIN_TEXT. */
const longPage = (label: string): string =>
  `<html><body><main><h1>${label}</h1><p>${'Real career content here. '.repeat(15)}</p></main></body></html>`;

describe('acquireWebsite', () => {
  it('sitemap_then_pages_fetched', async () => {
    const sitemapUrl = 'https://jane.example/sitemap.xml';
    const sitemapXml =
      '<?xml version="1.0"?><urlset>' +
      '<url><loc>https://jane.example/about</loc></url>' +
      '<url><loc>https://jane.example/work</loc></url>' +
      '</urlset>';
    const http = stubHttp({
      [sitemapUrl]: { body: sitemapXml, contentType: 'application/xml' },
      'https://jane.example/': { body: longPage('Home') },
      'https://jane.example/about': { body: longPage('About') },
      'https://jane.example/work': { body: longPage('Work') }
    });

    const result = await acquireWebsite(http, {
      urls: ['https://jane.example/'],
      sitemapUrl,
      delayMs: 0
    });

    expect(http.calls[0]).toBe(sitemapUrl); // sitemap fetched first
    expect(result.pages.map((p) => p.url)).toEqual([
      'https://jane.example/',
      'https://jane.example/about',
      'https://jane.example/work'
    ]);
    expect(result.errors).toEqual([]);
  });

  it('failed_page_reported_run_continues', async () => {
    const http = stubHttp({
      'https://jane.example/ok': { body: longPage('OK') },
      'https://jane.example/bad': { status: 500, body: 'boom' }
    });
    const result = await acquireWebsite(http, {
      urls: ['https://jane.example/ok', 'https://jane.example/bad'],
      delayMs: 0
    });
    expect(result.pages.map((p) => p.url)).toEqual(['https://jane.example/ok']);
    expect(result.errors.some((e) => e.includes('/bad'))).toBe(true);
  });

  it('short_page_treated_as_shell', async () => {
    const http = stubHttp({
      'https://jane.example/shell': { body: fixture('spa-shell.html') }
    });
    const result = await acquireWebsite(http, {
      urls: ['https://jane.example/shell'],
      delayMs: 0
    });
    expect(result.pages).toHaveLength(0);
    expect(result.errors.some((e) => /too little text/.test(e))).toBe(true);
  });
});
