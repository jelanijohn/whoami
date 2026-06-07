/**
 * Git sync (spec §8).
 *
 * The app is Git-agnostic at its core: create/read/edit never need Git. This
 * module adds an *optional, explicit* Sync action that shells out to the system
 * `git` (no embedded git library, spec §9).
 *
 * Two hard guardrails (spec §8):
 *   - MUST NOT auto-push silently — pushing is an explicit user action, which is
 *     exactly what calling {@link sync} is.
 *   - MUST NOT auto-resolve conflicts — on a rebase conflict we stop and report,
 *     leaving the working tree for the user to resolve by hand.
 */

import type { GitRunner } from './types';

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  hasUpstream: boolean;
  /** No uncommitted changes in the working tree. */
  clean: boolean;
  /** Count of changed/untracked paths. */
  changedFiles: number;
  /** Commits ahead of / behind upstream (0 when no upstream). */
  ahead: number;
  behind: number;
  /** A rebase/merge is mid-flight and needs manual resolution. */
  inProgress: boolean;
}

export interface SyncStep {
  name: string;
  code: number;
  stdout: string;
  stderr: string;
}

export interface SyncResult {
  ok: boolean;
  /** True when a pull --rebase hit a conflict the user must resolve by hand. */
  conflict: boolean;
  /** True when there was nothing to pull, commit, or push. */
  noop: boolean;
  steps: SyncStep[];
  message: string;
}

async function git(
  runner: GitRunner,
  root: string,
  name: string,
  args: string[]
): Promise<SyncStep> {
  const r = await runner.run(args, root);
  return { name, code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** Inspect the working tree so the UI can show clean / dirty / ahead / behind
 * (spec §8: surface state, but never block editing on it). */
export async function status(runner: GitRunner, root: string): Promise<GitStatus> {
  const isRepo = (await git(runner, root, 'is-repo', ['rev-parse', '--is-inside-work-tree']))
    .code === 0;
  if (!isRepo) {
    return {
      isRepo: false,
      branch: null,
      hasUpstream: false,
      clean: true,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
      inProgress: false
    };
  }

  const branchStep = await git(runner, root, 'branch', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchStep.code === 0 ? branchStep.stdout : null;

  const upstreamStep = await git(runner, root, 'upstream', [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}'
  ]);
  const hasUpstream = upstreamStep.code === 0;

  const porcelain = await git(runner, root, 'status', ['status', '--porcelain']);
  const changedFiles = porcelain.stdout ? porcelain.stdout.split('\n').filter(Boolean).length : 0;

  let ahead = 0;
  let behind = 0;
  if (hasUpstream) {
    const counts = await git(runner, root, 'ahead-behind', [
      'rev-list',
      '--left-right',
      '--count',
      '@{u}...HEAD'
    ]);
    if (counts.code === 0) {
      const [b, a] = counts.stdout.split(/\s+/).map((n) => parseInt(n, 10) || 0);
      behind = b ?? 0;
      ahead = a ?? 0;
    }
  }

  // A rebase or merge in progress leaves these state files/refs behind.
  const rebaseDir = await git(runner, root, 'rebase-check', [
    'rev-parse',
    '--verify',
    '--quiet',
    'REBASE_HEAD'
  ]);
  const mergeHead = await git(runner, root, 'merge-check', [
    'rev-parse',
    '--verify',
    '--quiet',
    'MERGE_HEAD'
  ]);
  const inProgress = rebaseDir.code === 0 || mergeHead.code === 0;

  return {
    isRepo: true,
    branch,
    hasUpstream,
    clean: changedFiles === 0,
    changedFiles,
    ahead,
    behind,
    inProgress
  };
}

/** Initialize a git repo in the record folder (explicit, user-triggered). */
export async function init(runner: GitRunner, root: string): Promise<SyncStep> {
  return git(runner, root, 'init', ['init']);
}

export interface SyncOptions {
  /** Commit message. Defaults to a timestamped journal message. */
  message?: string;
}

/**
 * The one-click Sync: `pull --rebase`, then `add -A` + `commit` + `push`.
 *
 * Stops immediately and reports if the rebase conflicts — it does not abort the
 * rebase or pick sides, so the user resolves it by hand (README guidance).
 * Returns a step-by-step trace for transparent UI feedback.
 */
export async function sync(
  runner: GitRunner,
  root: string,
  opts: SyncOptions = {}
): Promise<SyncResult> {
  const steps: SyncStep[] = [];
  const message = opts.message ?? `journal: sync ${new Date().toISOString()}`;

  const pre = await status(runner, root);
  if (!pre.isRepo) {
    return {
      ok: false,
      conflict: false,
      noop: false,
      steps,
      message: 'Not a git repository. Initialize one first.'
    };
  }
  if (pre.inProgress) {
    return {
      ok: false,
      conflict: true,
      noop: false,
      steps,
      message: 'A rebase/merge is already in progress. Resolve it by hand, then sync again.'
    };
  }

  // 1. Pull --rebase (only if there is an upstream to pull from).
  if (pre.hasUpstream) {
    const pull = await git(runner, root, 'pull --rebase', ['pull', '--rebase']);
    steps.push(pull);
    if (pull.code !== 0) {
      // Could not apply cleanly. Confirm whether we're now mid-rebase.
      const post = await status(runner, root);
      return {
        ok: false,
        conflict: post.inProgress,
        noop: false,
        steps,
        message: post.inProgress
          ? 'Pull hit a conflict. Open the conflicted file, resolve it, then run `git rebase --continue` and sync again.'
          : `Pull failed: ${pull.stderr || pull.stdout}`
      };
    }
  }

  // 2. Stage everything.
  const add = await git(runner, root, 'add -A', ['add', '-A']);
  steps.push(add);
  if (add.code !== 0) {
    return { ok: false, conflict: false, noop: false, steps, message: `git add failed: ${add.stderr}` };
  }

  // 3. Commit only if something is staged.
  const staged = await git(runner, root, 'diff --cached', ['diff', '--cached', '--quiet']);
  const hasStaged = staged.code !== 0; // non-zero = differences present
  if (hasStaged) {
    const commit = await git(runner, root, 'commit', ['commit', '-m', message]);
    steps.push(commit);
    if (commit.code !== 0) {
      return {
        ok: false,
        conflict: false,
        noop: false,
        steps,
        message: `Commit failed: ${commit.stderr || commit.stdout}`
      };
    }
  }

  // 4. Push if there's anything local the remote doesn't have.
  const after = await status(runner, root);
  const needsPush = after.ahead > 0 || (hasStaged && after.hasUpstream);
  if (after.hasUpstream && needsPush) {
    const push = await git(runner, root, 'push', ['push']);
    steps.push(push);
    if (push.code !== 0) {
      return {
        ok: false,
        conflict: false,
        noop: false,
        steps,
        message: `Push failed: ${push.stderr || push.stdout}`
      };
    }
  } else if (!after.hasUpstream && hasStaged) {
    return {
      ok: true,
      conflict: false,
      noop: false,
      steps,
      message: 'Committed locally. No upstream is set, so nothing was pushed — set a remote to sync.'
    };
  }

  const noop = !hasStaged && (pre.hasUpstream ? after.ahead === 0 : true) && steps.every((s) => s.code === 0);
  return {
    ok: true,
    conflict: false,
    noop,
    steps,
    message: noop ? 'Already up to date — nothing to sync.' : 'Synced.'
  };
}
