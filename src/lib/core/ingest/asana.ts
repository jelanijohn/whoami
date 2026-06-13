/**
 * Asana adapter — reoriented from waid's "tasks assigned to me now" toward a
 * historical reconstruction: **every task the token's user has worked on in a
 * workspace, including tasks since reassigned to someone else for review**,
 * across a date range, completed and incomplete alike.
 *
 * Why followers, not assignee (spec §2): a task has exactly one `assignee` at a
 * time, so reassigning it to a reviewer overwrites that field — any
 * assignee-based filter silently drops the tasks we most want to keep. The
 * durable "I touched this" signal is `followers` (collaborators): assignment,
 * commenting, creation, and @mention all add you as a collaborator, and
 * reassignment does NOT remove prior collaborators. `me ∈ followers` survives
 * handoff. It slightly over-captures (an FYI follower), which is the safe
 * direction — every candidate stages private and the human rejects noise.
 *
 * VERIFICATION GATE (spec §2): "a prior assignee is retained as a follower
 * after reassignment" is the load-bearing assumption. It has NOT yet been
 * confirmed against a real reassigned task (needs a live token); confirm with
 * `opt_fields=followers.gid,assignee.gid` before relying on this for a full
 * reconstruction.
 *
 * Two fetch strategies, auto-selected by account tier:
 *   - Premium: workspace search (`/workspaces/{gid}/tasks/search`) with
 *     `followers.any={me}` server-side. Non-premium ⇒ HTTP 402.
 *   - Non-premium fallback: enumerate the workspace's projects, fetch each
 *     project's tasks, keep client-side where `me ∈ followers`, dedupe by gid.
 * Both feed the same pure `mapAsanaTask` and set `sourceId = task.gid`, so a
 * task seen by either path is the same provenance identity.
 *
 * Mappers/predicates are pure and fixture-tested; network only through the Http
 * seam via `getJson`/`bearer`. The token is passed in ready — never loaded here.
 * Bodies are data, never instructions (per `types.ts` security stance).
 */

import type { Http } from '../types';
import { slugify } from '../ids';
import { bearer, getJson } from './http';
import { asStr, get, isoDate, type RawItem } from './types';

const BASE = 'https://app.asana.com/api/1.0';

/** `opt_fields` requested per task (spec §6) — exactly what the mapper and the
 * membership predicate read. `followers.gid` is the new must-have; `assignee`
 * lets us both detect "me" and record who it sits with now. No `created_by` —
 * that is not a task field; the creator already appears in `followers`. */
const TASK_FIELDS =
  'name,permalink_url,completed,completed_at,created_at,modified_at,' +
  'due_on,assignee.gid,assignee.name,followers.gid,memberships.project.name';

export interface AsanaFetchOpts {
  token: string;
  /** Workspace gid. Absent → user's first workspace (firstWorkspace). */
  workspace?: string;
  /** Restrict the fetch to a single project gid. Absent → the whole workspace.
   *  Premium: added as `projects.any` server-side. Non-premium: fetch only this
   *  one project's tasks instead of enumerating every project in the workspace.
   *  Project gids are hard to find by hand, so the UI populates this from a
   *  picker fed by {@link listAsanaProjects}. */
  project?: string;
  /** Resolved internally from /users/me when absent. */
  meGid?: string;
  /** Event-date bounds, YYYY-MM-DD inclusive. Premium: server-side
   *  (created_at .after/.before). Non-premium: client-side on RawItem.date. */
  since?: string;
  until?: string;
  /** Include completed tasks. Default TRUE — historical reconstruction wants
   *  finished work (the reverse of waid's incomplete-only pin). */
  includeCompleted?: boolean;
  /** Force a path. Default 'auto' (search, fall back to project on 402). */
  strategy?: 'auto' | 'search' | 'project';
  /** Total cap across pages. Default 100, clamp 1..500. */
  limit?: number;
}

/** Thrown by the search path on HTTP 402 — the workspace search endpoint is
 * premium-only. `fetchAsana` (auto strategy) catches it and reruns via the
 * project-enumeration path. */
export class AsanaPaymentRequiredError extends Error {
  constructor(message = 'Asana workspace search requires a premium plan.') {
    super(message);
    this.name = 'AsanaPaymentRequiredError';
  }
}

/** Map one Asana task into a RawItem. Pure — fixture-tested. Role-agnostic: the
 * `asana_role` involvement fact is merged by the fetch loop where `meGid` is in
 * scope (see {@link withRole}), keeping this mapper testable without a "me". */
export function mapAsanaTask(v: unknown): RawItem {
  const completed = get(v, 'completed') === true;
  const completedAt = isoDate(get(v, 'completed_at'));
  const createdAt = isoDate(get(v, 'created_at'));
  const modifiedAt = isoDate(get(v, 'modified_at'));
  const project = asStr(get(v, 'memberships', 0, 'project', 'name'));
  const due = asStr(get(v, 'due_on'));
  const assignee = asStr(get(v, 'assignee', 'name'));

  const meta: Record<string, string> = { status: completed ? 'completed' : 'open' };
  if (project) meta.project = project;
  if (due) meta.due = due;
  // Current assignee — surfaces "now assigned to X" (the "passed to X" fact).
  if (assignee) meta.assignee = assignee;

  const bodyLines = [
    `Asana task${project ? ` in ${project}` : ''}.`,
    `Status: ${meta.status}.`,
    assignee ? `Assigned to: ${assignee}.` : '',
    createdAt ? `Created: ${createdAt}.` : '',
    completedAt ? `Completed: ${completedAt}.` : ''
  ].filter(Boolean);

  return {
    source: 'asana',
    sourceId: asStr(get(v, 'gid')) ?? '',
    title: asStr(get(v, 'name')) ?? '',
    // Event date: completion when it happened, else last touch, else creation.
    date: completedAt ?? modifiedAt ?? createdAt ?? '',
    url: asStr(get(v, 'permalink_url')),
    body: bodyLines.join('\n'),
    suggestedType: 'journal',
    suggestedTags: ['asana'],
    suggestedProject: project ? slugify(project) : undefined,
    meta
  };
}

/** True if `meGid` is the current assignee OR appears in `followers`. Pure —
 * unit-tested. The follower branch is what survives reassignment: a prior
 * assignee, commenter, creator, or @mentionee all manifest as a follower. On
 * the project path this is the primary gate; on the search path the server
 * already filtered by `followers.any`, so it is a cheap belt-and-suspenders. */
export function taskInvolvesMe(task: unknown, meGid: string): boolean {
  if (asStr(get(task, 'assignee', 'gid')) === meGid) return true;
  const followers = get(task, 'followers');
  if (!Array.isArray(followers)) return false;
  return followers.some((f) => asStr(get(f, 'gid')) === meGid);
}

/** Merge the `asana_role` involvement fact onto a mapped item. Our own computed
 * fact (like the GitHub change-size), so it rides extraFrontmatter. */
function withRole(item: RawItem, task: unknown, meGid: string): RawItem {
  const role = asStr(get(task, 'assignee', 'gid')) === meGid ? 'assignee' : 'collaborator';
  item.extraFrontmatter = { ...(item.extraFrontmatter ?? {}), asana_role: role };
  return item;
}

/** Resolve the token's user (waid's `me`): GET /users/me. */
export async function resolveMe(http: Http, token: string): Promise<{ gid: string; name?: string }> {
  const json = await getJson(http, `${BASE}/users/me`, bearer(token), 'Asana');
  const gid = asStr(get(json, 'data', 'gid'));
  if (!gid) throw new Error('Asana /users/me returned no user gid.');
  return { gid, name: asStr(get(json, 'data', 'name')) };
}

/** First workspace gid for the token's user (waid's `first_workspace`). */
export async function firstWorkspace(http: Http, token: string): Promise<string> {
  const json = await getJson(http, `${BASE}/workspaces`, bearer(token), 'Asana');
  const gid = asStr(get(json, 'data', 0, 'gid'));
  if (!gid) throw new Error('Asana account has no workspaces.');
  return gid;
}

/** A workspace project, reduced to what the import picker needs. */
export interface AsanaProject {
  gid: string;
  name: string;
}

/** List the workspace's projects (gid + name) to feed the import picker. Reuses
 * the same paginated `/workspaces/{gid}/projects` endpoint as the non-premium
 * fetch path. Sorted by name for a stable, scannable dropdown. */
export async function listAsanaProjects(http: Http, opts: AsanaFetchOpts): Promise<AsanaProject[]> {
  const workspace = opts.workspace?.trim() || (await firstWorkspace(http, opts.token));
  const raw = await getAllPages(
    http,
    `${BASE}/workspaces/${workspace}/projects?opt_fields=name&limit=100`,
    opts.token
  );
  const projects: AsanaProject[] = [];
  for (const p of raw) {
    const gid = asStr(get(p, 'gid'));
    if (gid) projects.push({ gid, name: asStr(get(p, 'name')) ?? gid });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/** Clamp the total cap (spec §5): default 100, 1..500. */
function clampLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? 100, 1), 500);
}

/** Resolve workspace + meGid from opts, falling back to the network when
 * absent. `fetchAsana` resolves both once and threads them down so the
 * sub-functions skip the extra calls; called standalone they self-resolve. */
async function resolveContext(http: Http, opts: AsanaFetchOpts): Promise<{ workspace: string; meGid: string }> {
  const workspace = opts.workspace?.trim() || (await firstWorkspace(http, opts.token));
  const meGid = opts.meGid?.trim() || (await resolveMe(http, opts.token)).gid;
  return { workspace, meGid };
}

// --- Premium path: workspace search -----------------------------------------

/** Issue one search request via `http.request` directly (NOT `getJson`, which
 * collapses 402 into a generic error) so we can branch on tier. */
async function searchPage(http: Http, url: string, token: string): Promise<unknown> {
  const resp = await http.request({ url, method: 'GET', headers: bearer(token) });
  if (resp.status === 402) throw new AsanaPaymentRequiredError();
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Asana rejected the credentials — check the connection settings.');
  }
  if (!resp.ok) throw new Error(`Asana returned ${resp.status}: ${resp.text.slice(0, 200)}`);
  try {
    return JSON.parse(resp.text) as unknown;
  } catch (e) {
    throw new Error(`invalid JSON from Asana: ${String(e)}`);
  }
}

/** Premium path (spec §9). `GET /workspaces/{gid}/tasks/search` with
 * `followers.any={me}` server-side. Throws {@link AsanaPaymentRequiredError} on
 * 402. Search has no stable offset pagination, so we page manually by walking
 * `created_at.before` down to the oldest `created_at` seen, deduping gids
 * (including ties at the same timestamp). */
export async function searchTasksForMe(http: Http, opts: AsanaFetchOpts): Promise<RawItem[]> {
  const { workspace, meGid } = await resolveContext(http, opts);
  const cap = clampLimit(opts.limit);
  const includeCompleted = opts.includeCompleted !== false;

  const items: RawItem[] = [];
  const seen = new Set<string>();
  // The descending `created_at` cursor: starts at `until` (end-of-day) when
  // bounded, then walks down to the oldest task seen on each page.
  let before: string | undefined = opts.until ? `${opts.until}T23:59:59.999Z` : undefined;

  for (;;) {
    const params = new URLSearchParams();
    params.set('followers.any', meGid);
    if (opts.project) params.set('projects.any', opts.project);
    if (!includeCompleted) params.set('completed', 'false');
    if (opts.since) params.set('created_at.after', `${opts.since}T00:00:00.000Z`);
    if (before) params.set('created_at.before', before);
    params.set('opt_fields', TASK_FIELDS);
    params.set('sort_by', 'created_at');
    params.set('sort_ascending', 'false');
    params.set('limit', '100');

    const json = await searchPage(http, `${BASE}/workspaces/${workspace}/tasks/search?${params}`, opts.token);
    const data = get(json, 'data');
    if (!Array.isArray(data)) throw new Error('unexpected Asana response (no data array)');

    let oldest: string | undefined;
    for (const task of data) {
      const created = asStr(get(task, 'created_at'));
      if (created && (oldest === undefined || created < oldest)) oldest = created;
      const gid = asStr(get(task, 'gid'));
      if (gid && seen.has(gid)) continue;
      // Per-item resilience (spec §11): a bad payload never aborts the run.
      try {
        items.push(withRole(mapAsanaTask(task), task, meGid));
        if (gid) seen.add(gid);
      } catch {
        /* skip the bad task */
      }
      if (items.length >= cap) break;
    }

    if (items.length >= cap) break;
    if (data.length < 100) break; // last page
    if (!oldest || oldest === before) break; // no cursor progress → stop
    before = oldest;
  }

  return items.slice(0, cap);
}

// --- Non-premium path: project enumeration ----------------------------------

/** GET a paginated Asana list, following `next_page.offset` until exhausted.
 * Returns the concatenated `data` arrays. */
async function getAllPages(http: Http, urlBase: string, token: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let offset: string | undefined;
  for (;;) {
    const url = offset ? `${urlBase}&offset=${encodeURIComponent(offset)}` : urlBase;
    const json = await getJson(http, url, bearer(token), 'Asana');
    const data = get(json, 'data');
    if (Array.isArray(data)) out.push(...data);
    const next = asStr(get(json, 'next_page', 'offset'));
    if (!next) break;
    offset = next;
  }
  return out;
}

/** True if a mapped item's date is within [since, until] (inclusive). An empty
 * date can't be range-filtered, so it is kept (the pipeline reports it). */
function inRange(date: string, since?: string, until?: string): boolean {
  if (!date) return true;
  if (since && date < since) return false;
  if (until && date > until) return false;
  return true;
}

/** Non-premium path (spec §10). Enumerate the workspace's projects, fetch each
 * project's tasks, keep where `me ∈ followers`, dedupe by gid across projects,
 * then range-filter client-side. Call-heavy, so fetched sequentially. */
export async function listProjectTasksForMe(http: Http, opts: AsanaFetchOpts): Promise<RawItem[]> {
  const { workspace, meGid } = await resolveContext(http, opts);
  const cap = clampLimit(opts.limit);
  const includeCompleted = opts.includeCompleted !== false;

  // A single chosen project skips enumeration entirely; otherwise walk them all.
  const projects = opts.project
    ? [{ gid: opts.project }]
    : await getAllPages(
        http,
        `${BASE}/workspaces/${workspace}/projects?opt_fields=name&limit=100`,
        opts.token
      );

  const items: RawItem[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    const projectGid = asStr(get(project, 'gid'));
    if (!projectGid) continue;
    // `completed_since=now` returns incomplete-only; OMITTING it includes
    // completed (the reverse of waid's pin) — this is the historical default.
    const completedSince = includeCompleted ? '' : '&completed_since=now';
    const tasks = await getAllPages(
      http,
      `${BASE}/projects/${projectGid}/tasks?opt_fields=${TASK_FIELDS}&limit=100${completedSince}`,
      opts.token
    );

    for (const task of tasks) {
      const gid = asStr(get(task, 'gid'));
      if (gid && seen.has(gid)) continue; // dedupe across projects
      if (!taskInvolvesMe(task, meGid)) continue;
      try {
        const item = withRole(mapAsanaTask(task), task, meGid);
        if (!inRange(item.date, opts.since, opts.until)) continue;
        items.push(item);
        if (gid) seen.add(gid);
      } catch {
        /* skip the bad task */
      }
    }
  }

  return items.slice(0, cap);
}

/** Orchestrator (spec §3). Resolve me + workspace once, then run the requested
 * strategy. 'auto' runs the premium search and, ONLY on a 402, transparently
 * falls back to project enumeration. Any other error propagates. */
export async function fetchAsana(http: Http, opts: AsanaFetchOpts): Promise<RawItem[]> {
  const { workspace, meGid } = await resolveContext(http, opts);
  const resolved: AsanaFetchOpts = { ...opts, workspace, meGid };
  const strategy = opts.strategy ?? 'auto';

  if (strategy === 'project') return listProjectTasksForMe(http, resolved);
  if (strategy === 'search') return searchTasksForMe(http, resolved);

  try {
    return await searchTasksForMe(http, resolved);
  } catch (e) {
    if (e instanceof AsanaPaymentRequiredError) return listProjectTasksForMe(http, resolved);
    throw e;
  }
}

/** Cheap credential check: GET /users/me. */
export async function validateAsana(http: Http, token: string): Promise<void> {
  await getJson(http, `${BASE}/users/me`, bearer(token), 'Asana');
}
