/**
 * Asana adapter — port of waid's `provider/asana.rs`, reoriented for history:
 * tasks assigned to me in a workspace, **including completed ones** when a
 * `completedSince` floor is given (waid pins `completed_since=now`, i.e.
 * incomplete-only; for reconstruction we want what got finished).
 */

import type { Http } from '../types';
import { slugify } from '../ids';
import { bearer, getJson } from './http';
import { asStr, get, isoDate, type RawItem } from './types';

const BASE = 'https://app.asana.com/api/1.0';

/** `opt_fields` requested per task — exactly what `mapAsanaTask` reads. */
const TASK_FIELDS =
  'name,permalink_url,completed,completed_at,created_at,modified_at,assignee.name,due_on,memberships.project.name';

export interface AsanaFetchOpts {
  token: string;
  /** Workspace gid. When absent the user's first workspace is used. */
  workspace?: string;
  /** ISO floor for `completed_since` — include tasks completed after this.
   * Default `'now'` (incomplete tasks only, waid's behavior). */
  completedSince?: string;
  /** Max tasks. Default 50, clamped 1..100. */
  limit?: number;
}

/** Map one Asana task into a RawItem. Pure — fixture-tested. */
export function mapAsanaTask(v: unknown): RawItem {
  const completed = get(v, 'completed') === true;
  const completedAt = isoDate(get(v, 'completed_at'));
  const createdAt = isoDate(get(v, 'created_at'));
  const modifiedAt = isoDate(get(v, 'modified_at'));
  const project = asStr(get(v, 'memberships', 0, 'project', 'name'));
  const due = asStr(get(v, 'due_on'));

  const meta: Record<string, string> = { status: completed ? 'completed' : 'open' };
  if (project) meta.project = project;
  if (due) meta.due = due;

  const bodyLines = [
    `Asana task${project ? ` in ${project}` : ''}.`,
    `Status: ${meta.status}.`,
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

/** First workspace gid for the token's user (waid's `first_workspace`). */
export async function firstWorkspace(http: Http, token: string): Promise<string> {
  const json = await getJson(http, `${BASE}/workspaces`, bearer(token), 'Asana');
  const gid = asStr(get(json, 'data', 0, 'gid'));
  if (!gid) throw new Error('Asana account has no workspaces.');
  return gid;
}

export async function fetchAsana(http: Http, opts: AsanaFetchOpts): Promise<RawItem[]> {
  const workspace = opts.workspace?.trim() || (await firstWorkspace(http, opts.token));
  const max = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const completedSince = encodeURIComponent(opts.completedSince?.trim() || 'now');
  const url =
    `${BASE}/tasks?assignee=me&workspace=${workspace}` +
    `&completed_since=${completedSince}&limit=${max}&opt_fields=${TASK_FIELDS}`;
  const json = await getJson(http, url, bearer(opts.token), 'Asana');
  const data = get(json, 'data');
  if (!Array.isArray(data)) throw new Error('unexpected Asana response (no data)');
  return data.map(mapAsanaTask);
}

/** Cheap credential check: GET /users/me. */
export async function validateAsana(http: Http, token: string): Promise<void> {
  await getJson(http, `${BASE}/users/me`, bearer(token), 'Asana');
}
