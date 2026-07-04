import { describe, it, expect } from 'vitest';
import {
  withFeedDefaults,
  buildFeed,
  effectiveLiveParams,
  aggregateRefreshReport,
  isPickerKind,
  type Feed,
  type FeedRunResult
} from './feeds';
import type { IngestReport } from './ingest/types';

function report(over: Partial<IngestReport> = {}): IngestReport {
  return { fetched: 0, staged: 0, skippedPromoted: 0, skippedRejected: 0, skippedSuperseded: 0, errors: [], ...over };
}

describe('withFeedDefaults (spec §4.1.1, §10.1, §10.5)', () => {
  it('fills every missing field', () => {
    const feed = withFeedDefaults({ id: 'a', kind: 'github' });
    expect(feed).toEqual({
      id: 'a',
      label: '',
      kind: 'github',
      enabled: true,
      params: {},
      project: '',
      private: true,
      useLlm: false,
      window: 'fixed',
      lastRunAt: undefined,
      runOnOpen: false
    });
  });

  it('leaves a fully-specified feed unchanged and round-trips through JSON', () => {
    const feed: Feed = {
      id: 'b',
      label: 'My GitHub',
      kind: 'github',
      enabled: false,
      params: { user: 'octocat', since: '2020-01-01' },
      project: 'whoami',
      private: false,
      useLlm: true,
      window: 'rolling',
      lastRunAt: '2026-06-01T12:00:00.000Z',
      runOnOpen: true
    };
    expect(withFeedDefaults(feed)).toEqual(feed);
    expect(withFeedDefaults(JSON.parse(JSON.stringify(feed)))).toEqual(feed);
  });

  it('forces picker kinds private + prefilter-only even if stored otherwise (§5.2)', () => {
    const cc = withFeedDefaults({ id: 'c', kind: 'claude-code', private: false, useLlm: true });
    expect(cc.private).toBe(true);
    expect(cc.useLlm).toBe(false);
    const warp = withFeedDefaults({ id: 'd', kind: 'warp', private: false, useLlm: true });
    expect(warp.private).toBe(true);
    expect(warp.useLlm).toBe(false);
  });

  it('loads a payload missing newer fields without throwing (§10.5)', () => {
    const legacy = { id: 'e', label: 'old', kind: 'asana', params: { workspace: '1' } };
    const feed = withFeedDefaults(legacy as Partial<Feed>);
    expect(feed.window).toBe('fixed');
    expect(feed.runOnOpen).toBe(false);
    expect(feed.enabled).toBe(true);
    expect(feed.private).toBe(true);
  });

  it('identifies picker kinds', () => {
    expect(isPickerKind('claude-code')).toBe(true);
    expect(isPickerKind('warp')).toBe(true);
    expect(isPickerKind('neuroskill')).toBe(true);
    expect(isPickerKind('github')).toBe(false);
    expect(isPickerKind('asana')).toBe(false);
    expect(isPickerKind('gmail')).toBe(false);
  });
});

describe('buildFeed (spec §4.2.4, §10.4)', () => {
  it('snapshots live-API params and honors the form flags', () => {
    const feed = buildFeed({
      id: 'x',
      label: 'gh',
      kind: 'github',
      project: 'whoami',
      liveParams: { user: 'octocat', since: '2020-01-01', importPrivate: true },
      importPrivate: false,
      useLlm: true
    });
    expect(feed.kind).toBe('github');
    expect(feed.params).toEqual({ user: 'octocat', since: '2020-01-01', importPrivate: true });
    expect(feed.project).toBe('whoami');
    expect(feed.private).toBe(false); // from importPrivate
    expect(feed.useLlm).toBe(true);
    expect(feed.window).toBe('fixed');
  });

  it('snapshots commit-mode github params wholesale (commits spec §6, no feeds.ts change)', () => {
    const feed = buildFeed({
      id: 'gc',
      label: 'commits',
      kind: 'github',
      project: '',
      liveParams: { user: 'octocat', repo: 'acme/waid', mode: 'commits', branch: 'main', excludeMerges: false },
      importPrivate: true
    });
    // The mode/branch/excludeMerges snapshot rides through buildFeed untouched…
    expect(feed.params.mode).toBe('commits');
    expect(feed.params.branch).toBe('main');
    expect(feed.params.excludeMerges).toBe(false);
    // …and survives the effective-params clone (where toGithubParams then reads it).
    const p = effectiveLiveParams(feed);
    expect(p.mode).toBe('commits');
    expect(p.branch).toBe('main');
    expect(p.excludeMerges).toBe(false);
    // A feed saved before this change (no mode key) carries none — toGithubParams
    // then defaults it to 'items' / excludeMerges:true.
    const legacy = buildFeed({ id: 'g0', label: 'old', kind: 'github', project: '', liveParams: { user: 'octocat' } });
    expect(effectiveLiveParams(legacy).mode).toBeUndefined();
  });

  it('defaults asana/gmail private true regardless of importPrivate', () => {
    const a = buildFeed({ id: 'a', label: 'as', kind: 'asana', project: '', importPrivate: false });
    expect(a.private).toBe(true);
    const g = buildFeed({ id: 'g', label: 'gm', kind: 'gmail', project: '', importPrivate: false });
    expect(g.private).toBe(true);
  });

  it('shapes claude-code params as { roots } and forces picker flags', () => {
    const feed = buildFeed({
      id: 'c',
      label: 'cc',
      kind: 'claude-code',
      project: '',
      roots: ['-root-x', '-root-y'],
      useLlm: true
    });
    expect(feed.params).toEqual({ roots: ['-root-x', '-root-y'] });
    expect(feed.private).toBe(true);
    expect(feed.useLlm).toBe(false);
  });

  it('shapes warp params as { dirs } and forces picker flags', () => {
    const feed = buildFeed({ id: 'w', label: 'wp', kind: 'warp', project: '', dirs: ['/home/x'] });
    expect(feed.params).toEqual({ dirs: ['/home/x'] });
    expect(feed.private).toBe(true);
    expect(feed.useLlm).toBe(false);
  });

  it('shapes neuroskill params as { dataDir } and forces picker flags (spec §6)', () => {
    const feed = buildFeed({
      id: 'n',
      label: 'ns',
      kind: 'neuroskill',
      project: '',
      dataDir: '/mnt/c/Users/x/AppData/Local/NeuroSkill',
      useLlm: true
    });
    expect(feed.params).toEqual({ dataDir: '/mnt/c/Users/x/AppData/Local/NeuroSkill' });
    expect(feed.private).toBe(true);
    expect(feed.useLlm).toBe(false);
  });
});

describe('effectiveLiveParams — window derivation (spec §3.4, §10.2)', () => {
  const base: Omit<Feed, 'kind' | 'window' | 'lastRunAt' | 'params'> = {
    id: 'f',
    label: 'l',
    enabled: true,
    project: '',
    private: true,
    useLlm: false,
    runOnOpen: false
  };

  it('rolling github derives since from lastRunAt, overriding params.since', () => {
    const feed: Feed = {
      ...base,
      kind: 'github',
      window: 'rolling',
      lastRunAt: '2026-05-10T08:30:00.000Z',
      params: { since: '2020-01-01', until: '2026-01-01' }
    };
    const p = effectiveLiveParams(feed);
    expect(p.since).toBe('2026-05-10');
    expect(p.until).toBe('2026-01-01'); // untouched
    expect(feed.params.since).toBe('2020-01-01'); // original not mutated
  });

  it('rolling asana with no lastRunAt leaves since as-is', () => {
    const feed: Feed = { ...base, kind: 'asana', window: 'rolling', params: { since: '2019-01-01' } };
    expect(effectiveLiveParams(feed).since).toBe('2019-01-01');
  });

  it('rolling shortcut derives since from lastRunAt; fixed passes params verbatim (T10)', () => {
    const rolling: Feed = {
      ...base,
      kind: 'shortcut',
      window: 'rolling',
      lastRunAt: '2026-05-10T08:30:00.000Z',
      params: { since: '2020-01-01', until: '2026-01-01' }
    };
    const p = effectiveLiveParams(rolling);
    expect(p.since).toBe('2026-05-10');
    expect(p.until).toBe('2026-01-01'); // untouched
    const fixed: Feed = { ...rolling, window: 'fixed' };
    expect(effectiveLiveParams(fixed)).toEqual({ since: '2020-01-01', until: '2026-01-01' });
  });

  it('fixed github uses params.since verbatim even with lastRunAt set', () => {
    const feed: Feed = {
      ...base,
      kind: 'github',
      window: 'fixed',
      lastRunAt: '2026-05-10T08:30:00.000Z',
      params: { since: '2020-01-01' }
    };
    expect(effectiveLiveParams(feed).since).toBe('2020-01-01');
  });

  it('gmail ignores window — query untouched', () => {
    const feed: Feed = {
      ...base,
      kind: 'gmail',
      window: 'rolling',
      lastRunAt: '2026-05-10T08:30:00.000Z',
      params: { query: 'in:sent', since: '2020-01-01' }
    };
    const p = effectiveLiveParams(feed);
    expect(p.query).toBe('in:sent');
    expect(p.since).toBe('2020-01-01'); // not rewritten
  });

  it('claude-code / warp ignore window — params untouched', () => {
    const cc: Feed = {
      ...base,
      kind: 'claude-code',
      window: 'rolling',
      lastRunAt: '2026-05-10T08:30:00.000Z',
      params: { roots: ['-a'] }
    };
    expect(effectiveLiveParams(cc)).toEqual({ roots: ['-a'] });
    const warp: Feed = { ...base, kind: 'warp', window: 'rolling', lastRunAt: '2026-05-10T00:00:00.000Z', params: { dirs: ['/x'] } };
    expect(effectiveLiveParams(warp)).toEqual({ dirs: ['/x'] });
  });
});

describe('aggregateRefreshReport (spec §4.4.1, §10.3)', () => {
  it('sums totals over non-null reports and excludes errored feeds', () => {
    const results: FeedRunResult[] = [
      { id: '1', label: 'a', kind: 'github', report: report({ fetched: 10, staged: 3 }) },
      { id: '2', label: 'b', kind: 'asana', report: null, error: 'boom' },
      { id: '3', label: 'c', kind: 'gmail', report: report({ fetched: 5, staged: 2 }) }
    ];
    const agg = aggregateRefreshReport('2026-06-17T00:00:00.000Z', results);
    expect(agg.totalFetched).toBe(15);
    expect(agg.totalStaged).toBe(5);
    expect(agg.results).toBe(results);
    expect(agg.startedAt).toBe('2026-06-17T00:00:00.000Z');
    // the errored feed is retained in results with its error
    expect(agg.results[1]).toMatchObject({ report: null, error: 'boom' });
  });

  it('is zero for an empty run', () => {
    const agg = aggregateRefreshReport('t', []);
    expect(agg.totalFetched).toBe(0);
    expect(agg.totalStaged).toBe(0);
  });
});
