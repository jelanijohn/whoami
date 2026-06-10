import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from './platform-node';
import { RecordStore } from './record';
import { makeEntry } from './entry';
import type { Llm, LlmCompletionRequest, Platform } from './types';

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

describe('project dimension (plan §2)', () => {
  it('auto-derives a stable slug for project entries, persisted to text', async () => {
    const p = await store.createEntry({ type: 'project', title: 'Bloomberg — Core Data' });
    expect(p.frontmatter.slug).toBe('bloomberg-core-data');
    const onDisk = await readFile(join(root, p.path!), 'utf8');
    expect(onDisk).toContain('slug: bloomberg-core-data');
  });

  it('honors an explicit slug and never invents one for non-project entries', async () => {
    const p = await store.createEntry({
      type: 'project',
      title: 'Who Am I',
      extra: { slug: 'whoami' }
    });
    expect(p.frontmatter.slug).toBe('whoami');
    const j = await store.createEntry({ type: 'journal', title: 'Just a note' });
    expect(j.frontmatter.slug).toBeUndefined();
  });

  it('filters entries by project affiliation (json_extract, plan §2.3)', async () => {
    await store.createEntry({ type: 'project', title: 'Who Am I', extra: { slug: 'whoami' } });
    await store.createEntry({ type: 'win', title: 'Shipped ingest', extra: { project: 'whoami' } });
    await store.createEntry({ type: 'journal', title: 'Unrelated' });

    const affiliated = await store.listEntries({ project: 'whoami' });
    expect(affiliated.map((e) => e.frontmatter.title)).toEqual(['Shipped ingest']);
  });

  it('listProjects returns each project with its affiliated-entry count', async () => {
    await store.createEntry({ type: 'project', title: 'Who Am I', extra: { slug: 'whoami' } });
    await store.createEntry({ type: 'project', title: 'waid', extra: { slug: 'waid' } });
    await store.createEntry({ type: 'win', title: 'a', extra: { project: 'whoami' } });
    await store.createEntry({ type: 'journal', title: 'b', extra: { project: 'whoami' } });
    await store.createEntry({ type: 'win', title: 'c', extra: { project: 'waid' } });

    const projects = await store.listProjects();
    const bySlug = Object.fromEntries(projects.map((p) => [p.slug, p.count]));
    expect(bySlug).toEqual({ whoami: 2, waid: 1 });
  });

  it('excludes private affiliated entries from counts unless asked', async () => {
    await store.createEntry({ type: 'project', title: 'Who Am I', extra: { slug: 'whoami' } });
    await store.createEntry({ type: 'win', title: 'public', extra: { project: 'whoami' } });
    await store.createEntry({
      type: 'journal',
      title: 'secret',
      private: true,
      extra: { project: 'whoami' }
    });

    const pub = await store.listProjects();
    expect(pub.find((p) => p.slug === 'whoami')!.count).toBe(1);
    const all = await store.listProjects(true);
    expect(all.find((p) => p.slug === 'whoami')!.count).toBe(2);
  });

  it('promote assigns the picked project and marks the item reviewed (plan §2.4)', async () => {
    const candidate = makeEntry({
      type: 'journal',
      title: 'Fixed the build',
      private: true,
      extra: { source: 'github', source_id: 'gh-1', reviewed: false }
    });
    const staged = await store.stageCandidate(candidate);
    const promoted = await store.promoteCandidate(staged.path!, { project: 'whoami' });

    expect(promoted.frontmatter.project).toBe('whoami');
    expect(promoted.frontmatter.reviewed).toBe(true);
    // End-to-end: the promoted entry is now reachable through the project filter.
    const affiliated = await store.listEntries({ includePrivate: true, project: 'whoami' });
    expect(affiliated.map((e) => e.frontmatter.id)).toContain(promoted.frontmatter.id);
  });

  it('an empty project override clears a suggested affiliation on promote', async () => {
    const candidate = makeEntry({
      type: 'journal',
      title: 'Maybe whoami',
      private: true,
      extra: { source: 'github', source_id: 'gh-2', project: 'whoami' }
    });
    const staged = await store.stageCandidate(candidate);
    const promoted = await store.promoteCandidate(staged.path!, { project: '' });
    expect(promoted.frontmatter.project).toBeUndefined();
  });
});

/**
 * A fake LLM (plan §4.3) that echoes back whatever entry ULIDs it sees in the
 * prompt as evidence — plus one fact citing a fabricated ULID, to prove the
 * evidence filter drops unverifiable claims. Map vs reduce is told apart by the
 * `MAP_OUTPUTS` marker the reduce prompt carries.
 */
const GHOST_ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
function fakeReduceLlm(): { llm: Llm; calls: LlmCompletionRequest[] } {
  const calls: LlmCompletionRequest[] = [];
  const ULID = /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/g;
  const llm: Llm = {
    async complete(req) {
      calls.push(req);
      const ids = [...new Set(req.user.match(ULID) ?? [])].filter((id) => id !== GHOST_ULID);
      if (req.user.includes('MAP_OUTPUTS')) {
        return JSON.stringify({
          worked_on: ids.length ? [{ text: 'Did the work', evidence: [ids[0]] }] : [],
          successes: ids.length ? [{ text: 'Shipped it', evidence: ids }] : [],
          failures: [],
          lessons: [
            ...(ids.length ? [{ text: 'Learned a lot', evidence: [ids[0]] }] : []),
            { text: 'Hallucinated lesson', evidence: [GHOST_ULID] }
          ]
        });
      }
      return JSON.stringify({
        worked_on: ids.map((id) => ({ text: `Touched ${id.slice(-4)}`, evidence: [id] })),
        successes: [],
        failures: [],
        lessons: [{ text: 'Injected lesson', evidence: [GHOST_ULID] }]
      });
    }
  };
  return { llm, calls };
}

const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('reduce pipeline (plan §4)', () => {
  it('produces a four-list retrospective whose every fact resolves to a real ULID', async () => {
    const project = await store.createEntry({
      type: 'project',
      title: 'Who Am I',
      extra: { slug: 'whoami' },
      body: 'My own notes about the project.'
    });
    const e1 = await store.createEntry({
      type: 'win',
      title: 'Shipped ingest',
      date: '2024-01-01',
      extra: { project: 'whoami' }
    });
    const e2 = await store.createEntry({
      type: 'journal',
      title: 'Reduced things',
      date: '2024-02-01',
      extra: { project: 'whoami' }
    });
    const validIds = new Set([e1.frontmatter.id, e2.frontmatter.id]);

    const { llm, calls } = fakeReduceLlm();
    const proposal = await store.reduceProject(llm, 'whoami', { now: '2026-06-10' });

    const allEvidence = [
      ...proposal.retro.worked_on,
      ...proposal.retro.successes,
      ...proposal.retro.failures,
      ...proposal.retro.lessons
    ].flatMap((f) => f.evidence);
    expect(allEvidence.length).toBeGreaterThan(0);
    for (const id of allEvidence) expect(validIds.has(id)).toBe(true);
    expect(allEvidence).not.toContain(GHOST_ULID);

    // At least one map call + one reduce call.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // It's a proposal: nothing is written to disk yet.
    const onDisk = await readFile(join(root, project.path!), 'utf8');
    expect(onDisk).not.toContain('whoami:reduce');
  });

  it('save writes the region, preserves prose, and re-running regenerates in place', async () => {
    await store.createEntry({
      type: 'project',
      title: 'Proj',
      extra: { slug: 'proj' },
      body: 'Human prose here.'
    });
    await store.createEntry({
      type: 'win',
      title: 'w',
      date: '2024-01-01',
      extra: { project: 'proj' }
    });

    const { llm } = fakeReduceLlm();
    const p1 = await store.reduceProject(llm, 'proj', { now: '2026-06-10' });
    const saved = await store.saveProjectReduction(p1.projectEntryId, p1.inner);
    expect(saved.body).toContain('Human prose here.');
    expect(saved.body).toContain('## Worked on');
    expect(countOf(saved.body, 'whoami:reduce:start')).toBe(1);

    const p2 = await store.reduceProject(llm, 'proj', { now: '2026-06-11' });
    const saved2 = await store.saveProjectReduction(p2.projectEntryId, p2.inner);
    expect(countOf(saved2.body, 'whoami:reduce:start')).toBe(1);
    expect(countOf(saved2.body, 'whoami:reduce:end')).toBe(1);
    expect(saved2.body).toContain('Human prose here.');
    expect(saved2.body).toContain('2026-06-11');
    expect(saved2.body).not.toContain('2026-06-10');
  });

  it('the resume/site generators exclude the reduce region (plan §4.5)', async () => {
    const project = await store.createEntry({
      type: 'project',
      title: 'Public Proj',
      private: false,
      extra: { slug: 'pp' },
      body: 'Visible prose.'
    });
    await store.createEntry({ type: 'win', title: 'w', date: '2024-01-01', extra: { project: 'pp' } });

    const { llm } = fakeReduceLlm();
    const p = await store.reduceProject(llm, 'pp', { now: '2026-06-10' });
    const saved = await store.saveProjectReduction(p.projectEntryId, p.inner);
    expect(saved.body).toContain('whoami:reduce'); // present in the record…

    const md = await store.resumeMarkdown();
    const html = await store.siteHtml();
    expect(md).not.toContain('whoami:reduce'); // …but never in outputs
    expect(md).not.toContain('Generated 2026-06-10');
    expect(html).not.toContain('whoami:reduce');
  });

  it('fails visibly when no fact survives evidence verification', async () => {
    await store.createEntry({ type: 'project', title: 'Empty', extra: { slug: 'empty' }, body: '' });
    await store.createEntry({ type: 'win', title: 'w', date: '2024-01-01', extra: { project: 'empty' } });
    // An LLM that only ever cites the ghost ULID → everything gets filtered out.
    const llm: Llm = {
      async complete() {
        return JSON.stringify({
          worked_on: [{ text: 'ghost', evidence: [GHOST_ULID] }],
          successes: [],
          failures: [],
          lessons: []
        });
      }
    };
    await expect(store.reduceProject(llm, 'empty')).rejects.toThrow(/no verifiable facts/);
  });
});
