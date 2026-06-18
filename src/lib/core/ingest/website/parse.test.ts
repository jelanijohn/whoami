import { describe, expect, it } from 'vitest';
import { parseResumeItems } from '../resume/parse';
import { websiteSourceId } from './parse';
import { WEBSITE_SOURCE } from './types';

const SOURCE = [
  '--- PAGE: https://jane.example/about ---',
  'I led the platform team at Acme Corp from 2019, shipping the billing rewrite.',
  'Founded Open Atlas, an open-source mapping project, in 2021.'
].join('\n');

const reply = (items: unknown[]): string => JSON.stringify({ items });

const ROLE = {
  type: 'role',
  title: 'Senior Engineer',
  org: 'Acme Corp',
  role: 'Senior Engineer',
  start: '2019',
  excerpt: 'I led the platform team at Acme Corp from 2019, shipping the billing rewrite.'
};
const PROJECT = {
  type: 'project',
  title: 'Open Atlas',
  start: '2021',
  excerpt: 'Founded Open Atlas, an open-source mapping project, in 2021.'
};

const WEBSITE_OPTS = { source: WEBSITE_SOURCE, tag: 'website', makeSourceId: websiteSourceId };

describe('shared parser via website opts', () => {
  it('tags_and_source_are_website', () => {
    const items = parseResumeItems(reply([ROLE, PROJECT]), SOURCE, [], WEBSITE_OPTS);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.source).toBe('website');
      expect(item.suggestedTags).toEqual(['website']);
      expect(item.sourceId.startsWith('website:')).toBe(true);
    }
  });

  it('sourceId_is_url_independent', () => {
    // Same role lifted from two pages (different url) → identical sourceId, so
    // the pipeline dedupes it to one candidate.
    const fromAbout = { ...ROLE, url: 'https://jane.example/about' };
    const fromResume = { ...ROLE, url: 'https://jane.example/resume' };
    const items = parseResumeItems(reply([fromAbout, fromResume]), SOURCE, [], WEBSITE_OPTS);
    expect(items[0].sourceId).toBe(items[1].sourceId);
  });

  it('evidence_filter_drops_unverifiable_excerpt', () => {
    const errors: string[] = [];
    const fabricated = { ...PROJECT, excerpt: 'Won a Nobel Prize in 1998.' };
    const items = parseResumeItems(reply([fabricated]), SOURCE, errors, WEBSITE_OPTS);
    expect(items).toHaveLength(0);
    expect(errors.some((e) => /unverifiable/.test(e))).toBe(true);
  });

  it('undated_item_dropped_and_reported', () => {
    const errors: string[] = [];
    const undated = {
      type: 'win',
      title: 'Shipped the rewrite',
      start: 'someday',
      excerpt: 'shipping the billing rewrite'
    };
    const items = parseResumeItems(reply([undated]), SOURCE, errors, WEBSITE_OPTS);
    expect(items).toHaveLength(0);
    expect(errors.some((e) => /undated/.test(e))).toBe(true);
  });

  it('website undated carried when allowUndated', () => {
    const errors: string[] = [];
    const undated = {
      type: 'win',
      title: 'Shipped the rewrite',
      start: 'someday',
      excerpt: 'shipping the billing rewrite'
    };
    const items = parseResumeItems(reply([undated]), SOURCE, errors, {
      ...WEBSITE_OPTS,
      allowUndated: true
    });
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('website');
    expect(items[0].date).toBe('');
    expect(items[0].extraFrontmatter?.needs_date).toBe(true);
    expect(errors.some((e) => /staged/.test(e))).toBe(true);
  });

  it('resume_parse_unchanged_when_opts_absent', () => {
    // Regression (spec §11 Phase A): no opts ⇒ byte-for-byte résumé behavior.
    const items = parseResumeItems(reply([ROLE, PROJECT]), SOURCE);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.source).toBe('resume');
      expect(item.suggestedTags).toEqual(['resume']);
      expect(item.sourceId.startsWith('website:')).toBe(false);
    }
    // The role keys under `role:` (résumé scheme), not `website:role:`.
    expect(items[0].sourceId.startsWith('role:')).toBe(true);
  });
});
