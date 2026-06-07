import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from './platform-node';
import { RecordStore } from './record';
import type { Platform } from './types';

let root: string;
let platform: Platform;
let store: RecordStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whoami-'));
  platform = createNodePlatform(':memory:');
  store = new RecordStore(platform, root);
  await store.init();
});

afterEach(async () => {
  await platform.db.close();
  await rm(root, { recursive: true, force: true });
});

describe('init scaffolding (spec §2)', () => {
  it('creates the canonical layout and seed files', async () => {
    expect(await platform.fs.exists(join(root, 'profile.md'))).toBe(true);
    expect(await platform.fs.exists(join(root, '.gitignore'))).toBe(true);
    expect(await platform.fs.exists(join(root, 'README.md'))).toBe(true);
    expect(await platform.fs.exists(join(root, 'entries'))).toBe(true);

    const gitignore = await readFile(join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('index.db');
    expect(gitignore).toContain('dist/');
  });
});

describe('write-text-first CRUD (spec §6)', () => {
  it('createEntry writes the file then indexes it', async () => {
    const e = await store.createEntry({ type: 'win', title: 'Shipped X', body: 'did the thing' });
    // Text exists on disk...
    const onDisk = await readFile(join(root, e.path!), 'utf8');
    expect(onDisk).toContain('title: Shipped X');
    // ...and is queryable from the index.
    const list = await store.listEntries();
    expect(list.map((x) => x.frontmatter.id)).toContain(e.frontmatter.id);
    const got = await store.getEntry(e.frontmatter.id);
    expect(got?.body).toBe('did the thing');
  });

  it('updateEntry renames the file when the title changes, keeps id', async () => {
    const e = await store.createEntry({ type: 'project', title: 'Old Name', date: '2024-01-01' });
    const oldPath = e.path!;
    const updated = await store.updateEntry({
      ...e,
      frontmatter: { ...e.frontmatter, title: 'New Name' }
    });
    expect(updated.path).not.toBe(oldPath);
    expect(updated.path).toContain('new-name');
    expect(updated.frontmatter.id).toBe(e.frontmatter.id);
    // Old file is gone, new file exists, only one index row.
    expect(await platform.fs.exists(join(root, oldPath))).toBe(false);
    expect(await platform.fs.exists(join(root, updated.path!))).toBe(true);
    const all = await store.listEntries({ includePrivate: true });
    expect(all.filter((x) => x.frontmatter.id === e.frontmatter.id)).toHaveLength(1);
  });

  it('deleteEntry removes the file and the index row', async () => {
    const e = await store.createEntry({ type: 'journal', title: 'Temp' });
    await store.deleteEntry(e);
    expect(await platform.fs.exists(join(root, e.path!))).toBe(false);
    expect(await store.getEntry(e.frontmatter.id)).toBeNull();
  });
});

describe('privacy exclusion (spec §7)', () => {
  it('private entries are excluded from listings and outputs by default', async () => {
    await store.createEntry({ type: 'role', title: 'Public Role', extra: { org: 'Acme' } });
    await store.createEntry({ type: 'role', title: 'Secret Role', private: true, extra: { org: 'Hush' } });

    const publicList = await store.listEntries();
    expect(publicList.map((e) => e.frontmatter.title)).toEqual(['Public Role']);

    const allList = await store.listEntries({ includePrivate: true });
    expect(allList).toHaveLength(2);

    const resume = await store.resumeMarkdown();
    expect(resume).toContain('Public Role');
    expect(resume).not.toContain('Secret Role');
    expect(resume).not.toContain('Hush');

    const site = await store.siteHtml();
    expect(site).toContain('Public Role');
    expect(site).not.toContain('Secret Role');
  });

  it('counts never leak private entries', async () => {
    await store.createEntry({ type: 'win', title: 'a' });
    await store.createEntry({ type: 'win', title: 'b', private: true });
    const counts = await store.countsByType();
    expect(counts.win).toBe(1);
  });
});

describe('index rebuild (spec §5)', () => {
  it('incremental rebuild skips unchanged, picks up external edits', async () => {
    const e = await store.createEntry({ type: 'journal', title: 'Edit Me', body: 'before' });

    // First incremental pass: nothing changed since createEntry indexed it.
    const r1 = await store.reindex();
    expect(r1.skipped).toBe(1);
    expect(r1.indexed).toBe(0);

    // Edit the file directly on disk (as a hand-edit or another machine would).
    const path = join(root, e.path!);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('before', 'after'), 'utf8');

    const r2 = await store.reindex();
    expect(r2.indexed).toBe(1);
    const got = await store.getEntry(e.frontmatter.id);
    expect(got?.body).toBe('after');
  });

  it('full rebuild reconstructs the index from text after it is dropped', async () => {
    await store.createEntry({ type: 'role', title: 'One' });
    await store.createEntry({ type: 'project', title: 'Two' });

    const report = await store.fullRebuild();
    expect(report.full).toBe(true);
    expect(report.indexed).toBe(2);
    const all = await store.listEntries({ includePrivate: true });
    expect(all).toHaveLength(2);
  });

  it('rebuild deletes index rows whose file was removed out of band', async () => {
    const e = await store.createEntry({ type: 'journal', title: 'Gone Soon' });
    await rm(join(root, e.path!));
    const report = await store.reindex();
    expect(report.deleted).toBe(1);
    expect(await store.getEntry(e.frontmatter.id)).toBeNull();
  });
});

describe('full-text search', () => {
  it('finds entries by body content', async () => {
    await store.createEntry({ type: 'journal', title: 'Kafka migration', body: 'moved topics to kafka' });
    await store.createEntry({ type: 'journal', title: 'Lunch', body: 'had a sandwich' });
    const hits = await store.listEntries({ search: 'kafka' });
    expect(hits).toHaveLength(1);
    expect(hits[0].frontmatter.title).toBe('Kafka migration');
  });
});
