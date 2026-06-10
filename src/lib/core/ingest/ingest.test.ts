import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodePlatform } from '../platform-node';
import { RecordStore, provenanceKey } from '../record';
import { findBySource } from '../index-db';
import { RECORD_GITIGNORE } from '../templates';
import type { Platform } from '../types';
import { mapGithubIssue, githubSearchQuery, apiBase, repoFromApiUrl } from './github';
import { mapAsanaTask } from './asana';
import { mapGmailMessage, internalDateToIso, header } from './gmail';
import {
  parseCsv,
  csvToRecords,
  liDate,
  mapLinkedinPositions,
  importLinkedinArchive
} from './linkedin';
import { rawItemToEntryInput, stageItems } from './pipeline';
import type { RawItem } from './types';

// --- GitHub mapper (fixtures ported from waid's provider/github.rs tests) ---

const GH_PR = {
  id: 9876,
  title: 'Add provider dispatch',
  html_url: 'https://github.com/acme/waid/pull/12',
  state: 'closed',
  created_at: '2026-05-20T09:00:00Z',
  closed_at: '2026-06-01T10:00:00Z',
  updated_at: '2026-06-01T10:00:00Z',
  assignee: { login: 'jelani' },
  repository_url: 'https://api.github.com/repos/acme/waid',
  pull_request: {
    url: 'https://api.github.com/repos/acme/waid/pulls/12',
    merged_at: '2026-06-01T10:00:00Z'
  }
};

describe('github adapter', () => {
  it('maps a merged PR', () => {
    const item = mapGithubIssue(GH_PR);
    expect(item.source).toBe('github');
    expect(item.sourceId).toBe('9876');
    expect(item.title).toBe('Add provider dispatch');
    expect(item.url).toBe('https://github.com/acme/waid/pull/12');
    expect(item.date).toBe('2026-06-01'); // closed_at wins
    expect(item.meta?.type).toBe('PR');
    expect(item.meta?.state).toBe('merged');
    expect(item.meta?.repo).toBe('acme/waid');
    expect(item.suggestedProject).toBe('acme-waid');
  });

  it('maps a plain issue as Issue and tolerates missing fields', () => {
    const item = mapGithubIssue({
      id: 1,
      title: 'bug',
      html_url: 'https://github.com/acme/waid/issues/3',
      state: 'open',
      created_at: '2026-01-02T00:00:00Z',
      repository_url: 'https://api.github.com/repos/acme/waid'
    });
    expect(item.meta?.type).toBe('Issue');
    expect(item.meta?.state).toBe('open');
    expect(item.date).toBe('2026-01-02'); // falls back to created_at
    expect(mapGithubIssue({}).sourceId).toBe('');
  });

  it('builds search queries', () => {
    expect(githubSearchQuery({ user: 'jelani' })).toBe('author:jelani');
    expect(
      githubSearchQuery({ user: 'jelani', repo: 'acme/waid', since: '2019-01-01', until: '2019-12-31' })
    ).toBe('author:jelani repo:acme/waid created:2019-01-01..2019-12-31');
    expect(githubSearchQuery({ user: 'j', since: '2019-01-01' })).toBe('author:j created:>=2019-01-01');
    expect(githubSearchQuery({ user: 'j', until: '2020-01-01' })).toBe('author:j created:<=2020-01-01');
  });

  it('derives api base and repo', () => {
    expect(apiBase()).toBe('https://api.github.com');
    expect(apiBase('https://ghe.corp/')).toBe('https://ghe.corp/api/v3');
    expect(repoFromApiUrl('https://api.github.com/repos/acme/waid')).toBe('acme/waid');
    expect(repoFromApiUrl('https://api.github.com/nope')).toBeUndefined();
  });
});

// --- Asana mapper (fixture ported from waid's provider/asana.rs tests) ------

describe('asana adapter', () => {
  it('maps a completed task', () => {
    const item = mapAsanaTask({
      gid: '12345',
      name: 'Write the spec',
      permalink_url: 'https://app.asana.com/0/12345/12345',
      completed: true,
      completed_at: '2026-06-02T16:00:00.000Z',
      created_at: '2026-05-01T08:00:00.000Z',
      modified_at: '2026-06-02T16:00:00.000Z',
      assignee: { name: 'Jelani John' },
      due_on: '2026-06-10',
      memberships: [{ project: { name: 'Roadmap' } }]
    });
    expect(item.sourceId).toBe('12345');
    expect(item.title).toBe('Write the spec');
    expect(item.url).toBe('https://app.asana.com/0/12345/12345');
    expect(item.date).toBe('2026-06-02'); // completed_at wins
    expect(item.meta?.status).toBe('completed');
    expect(item.meta?.project).toBe('Roadmap');
    expect(item.meta?.due).toBe('2026-06-10');
    expect(item.suggestedProject).toBe('roadmap');
  });

  it('tolerates missing fields', () => {
    const item = mapAsanaTask({ gid: '9', name: 'bare' });
    expect(item.title).toBe('bare');
    expect(item.date).toBe('');
    expect(item.meta?.status).toBe('open');
    expect(item.suggestedProject).toBeUndefined();
  });
});

// --- Gmail mapper (fixtures ported from waid's provider/gmail.rs tests) -----

const GMAIL_MSG = {
  id: '18f0a1b2c3d4e5f6',
  labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
  internalDate: '1717372800000',
  snippet: '  Hey — wanted to check in on the redesign timeline before Friday.  ',
  payload: {
    headers: [
      { name: 'Delivered-To', value: 'me@acme.com' },
      { name: 'From', value: 'Dana Lee <dana@acme.com>' },
      { name: 'Subject', value: 'Acme redesign — timeline' },
      { name: 'Date', value: 'Mon, 03 Jun 2024 00:00:00 +0000' }
    ]
  }
};

describe('gmail adapter', () => {
  it('parses internalDate (epoch-ms string) to ISO', () => {
    // 1717372800000 ms = 2024-06-03T00:00:00Z (waid's fixture).
    expect(internalDateToIso('1717372800000')).toBe('2024-06-03T00:00:00.000Z');
    expect(internalDateToIso('not-a-number')).toBeUndefined();
    expect(internalDateToIso(undefined)).toBeUndefined();
  });

  it('looks up headers case-insensitively', () => {
    expect(header(GMAIL_MSG, 'subject')).toBe('Acme redesign — timeline');
    expect(header(GMAIL_MSG, 'FROM')).toBe('Dana Lee <dana@acme.com>');
    expect(header({}, 'Subject')).toBeUndefined();
  });

  it('maps a message', () => {
    const item = mapGmailMessage(GMAIL_MSG);
    expect(item.sourceId).toBe('18f0a1b2c3d4e5f6');
    expect(item.title).toBe('Acme redesign — timeline');
    expect(item.url).toBe('https://mail.google.com/mail/u/0/#all/18f0a1b2c3d4e5f6');
    expect(item.date).toBe('2024-06-03');
    expect(item.meta?.from).toBe('Dana Lee <dana@acme.com>');
    expect(item.body).toContain('redesign timeline before Friday.');
  });

  it('tolerates a bare message', () => {
    const item = mapGmailMessage({ id: 'abc', internalDate: '1717372800000' });
    expect(item.title).toBe('(no subject)');
    expect(item.date).toBe('2024-06-03');
    expect(item.meta?.from).toBeUndefined();
  });
});

// --- LinkedIn archive import -------------------------------------------------

describe('linkedin import', () => {
  it('parses RFC-4180 CSV with quotes, embedded commas and newlines', () => {
    const csv = 'a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\nplain,2,3\n';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'he said "hi"', 'line1\nline2'],
      ['plain', '2', '3']
    ]);
    const recs = csvToRecords(csv);
    expect(recs[0]['a']).toBe('x, y');
    expect(recs[1]['c']).toBe('3');
  });

  it('parses LinkedIn-style dates', () => {
    expect(liDate('Mar 2019')).toBe('2019-03-01');
    expect(liDate('2019')).toBe('2019-01-01');
    expect(liDate('2019-07-15')).toBe('2019-07-15');
    expect(liDate('Sep 2021')).toBe('2021-09-01');
    expect(liDate('')).toBeUndefined();
    expect(liDate('garbage')).toBeUndefined();
  });

  it('maps Positions.csv rows to role items and skips date-less rows', () => {
    const csv = [
      'Company Name,Title,Description,Location,Started On,Finished On',
      '"Bloomberg L.P.","Software Engineer","Built ""terminal"" infra, etc.","New York, NY",Mar 2019,Sep 2021',
      'NoDate Inc,Engineer,,,,'
    ].join('\n');
    const items = mapLinkedinPositions(csv);
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.source).toBe('linkedin');
    expect(it0.suggestedType).toBe('role');
    expect(it0.title).toBe('Software Engineer — Bloomberg L.P.');
    expect(it0.date).toBe('2019-03-01');
    expect(it0.extraFrontmatter?.org).toBe('Bloomberg L.P.');
    expect(it0.extraFrontmatter?.end).toBe('2021-09-01');
    expect(it0.body).toContain('Built "terminal" infra');
    // Deterministic source id → re-import dedupes.
    expect(it0.sourceId).toBe(mapLinkedinPositions(csv)[0].sourceId);
  });

  it('dispatches archive files by basename', () => {
    const files = {
      'Positions.csv':
        'Company Name,Title,Description,Location,Started On,Finished On\nAcme,Dev,,,Jan 2020,',
      'somefolder/Education.csv':
        'School Name,Start Date,End Date,Notes,Degree Name,Activities\nMIT,Sep 2014,Jun 2018,,BSc,',
      'Ignored.csv': 'a,b\n1,2'
    };
    const items = importLinkedinArchive(files);
    expect(items.map((i) => i.suggestedType).sort()).toEqual(['education', 'role']);
  });
});

// --- Pipeline round-trip ------------------------------------------------------

describe('staging pipeline', () => {
  let root: string;
  let platform: Platform;
  let store: RecordStore;

  const item = (n: number): RawItem => ({
    source: 'github',
    sourceId: `id-${n}`,
    title: `Item ${n}`,
    date: '2026-01-0' + n,
    url: `https://github.com/acme/waid/pull/${n}`,
    body: `Body ${n}`,
    suggestedType: 'journal',
    suggestedTags: ['github'],
    suggestedProject: 'acme-waid'
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'whoami-ingest-'));
    platform = createNodePlatform(':memory:');
    store = new RecordStore(platform, root);
    await store.init();
  });

  afterEach(async () => {
    await platform.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('maps RawItem → entry input with provenance, privacy, and project', () => {
    const input = rawItemToEntryInput(item(1), '2026-06-10T00:00:00.000Z');
    expect(input.private).toBe(true);
    expect(input.extra?.source).toBe('github');
    expect(input.extra?.source_id).toBe('id-1');
    expect(input.extra?.reviewed).toBe(false);
    expect(input.extra?.project).toBe('acme-waid');
    expect(input.extra?.links).toEqual(['https://github.com/acme/waid/pull/1']);
    expect(input.extra?.ingested_at).toBe('2026-06-10T00:00:00.000Z');
  });

  it('stages, dedupes, promotes, and rejects', async () => {
    // First run: both staged.
    const r1 = await stageItems(store, [item(1), item(2)]);
    expect(r1).toMatchObject({ fetched: 2, staged: 2, skippedPromoted: 0, skippedRejected: 0 });
    let candidates = await store.listCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.frontmatter.private === true)).toBe(true);

    // Re-run: idempotent (deterministic filenames → still 2 candidates).
    await stageItems(store, [item(1), item(2)]);
    expect(await store.listCandidates()).toHaveLength(2);

    // Promote item 1 → it becomes a real entry with a provenance row.
    candidates = await store.listCandidates();
    const cand1 = candidates.find((c) => c.frontmatter.source_id === 'id-1')!;
    const promoted = await store.promoteCandidate(cand1.path!);
    expect(promoted.path!.startsWith('entries/')).toBe(true);
    expect(await findBySource(platform.db, 'github', 'id-1')).toBe(promoted.frontmatter.id);
    expect(await store.listCandidates()).toHaveLength(1);

    // Promoted entries are private and excluded from outputs by default.
    expect(await store.listEntries()).toHaveLength(0);
    expect(await store.listEntries({ includePrivate: true })).toHaveLength(1);

    // Reject item 2 → remembered in rejected.tsv, file gone.
    const cand2 = (await store.listCandidates())[0];
    await store.rejectCandidate(cand2.path!);
    expect(await store.listCandidates()).toHaveLength(0);
    expect((await store.rejectedKeys()).has(provenanceKey('github', 'id-2'))).toBe(true);

    // Third run: nothing restages — one already promoted, one rejected.
    const r3 = await stageItems(store, [item(1), item(2)]);
    expect(r3).toMatchObject({ fetched: 2, staged: 0, skippedPromoted: 1, skippedRejected: 1 });
    expect(await store.listCandidates()).toHaveLength(0);
  });

  it('survives bad items without aborting the batch', async () => {
    const bad: RawItem = { source: 'github', sourceId: '', title: 'no id', date: '2026-01-01' };
    const r = await stageItems(store, [bad, item(3)]);
    expect(r.staged).toBe(1);
    expect(r.errors).toHaveLength(1);
  });

  it('full rebuild repopulates provenance from text', async () => {
    await stageItems(store, [item(1)]);
    const cand = (await store.listCandidates())[0];
    const promoted = await store.promoteCandidate(cand.path!);
    await store.fullRebuild();
    expect(await findBySource(platform.db, 'github', 'id-1')).toBe(promoted.frontmatter.id);
  });

  it('keeps the inbox out of version control', () => {
    expect(RECORD_GITIGNORE).toContain('.inbox/');
  });
});
