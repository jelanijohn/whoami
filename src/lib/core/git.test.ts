import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodePlatform } from './platform-node';
import { RecordStore } from './record';
import { gitInit, gitStatus, gitSync } from './index';
import type { Platform } from './types';

let root: string;
let platform: Platform;
let store: RecordStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'whoami-git-'));
  platform = createNodePlatform(':memory:');
  store = new RecordStore(platform, root);
  await store.init();
  await gitInit(platform.git, root);
  // Local identity so commits work regardless of global config.
  await platform.git.run(['config', 'user.email', 'test@example.com'], root);
  await platform.git.run(['config', 'user.name', 'Test'], root);
});

afterEach(async () => {
  await platform.db.close();
  await rm(root, { recursive: true, force: true });
});

describe('git status (spec §8)', () => {
  it('reports a fresh repo as dirty (untracked scaffold) with no upstream', async () => {
    const s = await gitStatus(platform.git, root);
    expect(s.isRepo).toBe(true);
    expect(s.hasUpstream).toBe(false);
    expect(s.clean).toBe(false);
    expect(s.changedFiles).toBeGreaterThan(0);
  });
});

describe('git sync (spec §8)', () => {
  it('commits local changes; reports no upstream to push to', async () => {
    await store.createEntry({ type: 'win', title: 'First commit win' });
    const result = await gitSync(platform.git, root, { message: 'journal: test' });
    expect(result.ok).toBe(true);
    // No remote configured, so it commits locally and says so.
    expect(result.message).toMatch(/no upstream/i);

    const log = await platform.git.run(['log', '--oneline'], root);
    expect(log.stdout).toContain('journal: test');

    const after = await gitStatus(platform.git, root);
    expect(after.clean).toBe(true);
  });

  it('is a no-op when there is nothing to commit', async () => {
    // Commit the scaffold first.
    await gitSync(platform.git, root, { message: 'journal: scaffold' });
    const second = await gitSync(platform.git, root, { message: 'journal: again' });
    expect(second.ok).toBe(true);
    expect(second.noop).toBe(true);
  });

  it('refuses to sync a non-repo', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'whoami-plain-'));
    try {
      const result = await gitSync(platform.git, plain, {});
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not a git repository/i);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
