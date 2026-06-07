import { describe, expect, it } from 'vitest';
import { parseFrontmatter, serializeFrontmatter, orderKeys } from './frontmatter';
import { parseEntry, serializeEntry } from './entry';

describe('frontmatter round-trip', () => {
  it('parses frontmatter and body', () => {
    const text = `---\ntitle: Hello\nprivate: false\n---\n\nBody text here.\n`;
    const { data, body } = parseFrontmatter(text);
    expect(data.title).toBe('Hello');
    expect(data.private).toBe(false);
    expect(body).toBe('Body text here.');
  });

  it('keeps date-like scalars as strings (core schema, not Date)', () => {
    const { data } = parseFrontmatter(`---\ndate: 2024-03-14\ncreated: 2024-03-14T09:22:00Z\n---\n`);
    expect(typeof data.date).toBe('string');
    expect(data.date).toBe('2024-03-14');
    expect(typeof data.created).toBe('string');
  });

  it('returns whole text as body when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('just a body\n');
    expect(data).toEqual({});
    expect(body).toBe('just a body\n');
  });

  it('orderKeys puts preferred keys first, preserves the rest', () => {
    const ordered = orderKeys({ z: 1, title: 't', a: 2, id: 'x' }, ['id', 'title']);
    expect(Object.keys(ordered)).toEqual(['id', 'title', 'z', 'a']);
  });
});

describe('unknown key preservation (spec §3)', () => {
  it('round-trips unknown frontmatter keys untouched', () => {
    const original = `---
id: 01HXYZP3K7QWERTY8N7G8H9J
type: role
date: 2024-03-14
created: 2024-03-14T09:22:00Z
updated: 2024-03-14T09:22:00Z
title: Shipped the X dashboard
private: false
tags:
  - bloomberg
  - frontend
org: Bloomberg
role: Software Engineer
some_future_field: keep me
nested:
  a: 1
  b: two
---

Rough notes here.
`;
    const entry = parseEntry(original);
    // Fields this version never declared must survive.
    expect(entry.frontmatter.some_future_field).toBe('keep me');
    expect(entry.frontmatter.nested).toEqual({ a: 1, b: 'two' });
    expect(entry.frontmatter.org).toBe('Bloomberg');

    const out = serializeEntry(entry);
    const reparsed = parseEntry(out);
    expect(reparsed.frontmatter.some_future_field).toBe('keep me');
    expect(reparsed.frontmatter.nested).toEqual({ a: 1, b: 'two' });
    expect(reparsed.frontmatter.tags).toEqual(['bloomberg', 'frontend']);
    expect(reparsed.body).toBe('Rough notes here.');

    // A second round-trip must be byte-stable (idempotent serialization).
    expect(serializeEntry(reparsed)).toBe(out);
  });

  it('forces private to a real boolean', () => {
    const entry = parseEntry(`---\nid: x\ntype: journal\ndate: 2024-01-01\ntitle: t\nprivate: true\n---\n`);
    expect(entry.frontmatter.private).toBe(true);
  });

  it('serializeFrontmatter renders empty body with no trailing blank line', () => {
    const out = serializeFrontmatter({ id: 'x' }, '');
    expect(out).toBe('---\nid: x\n---\n');
  });
});
