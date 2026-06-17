/**
 * Warp adapter — **import-only** (warp-adapter spec): turns one Warp Agent-mode
 * conversation into one review candidate. Like the Claude Code adapter, it is a
 * high-fidelity "what did I do" source: every AI query carries a
 * `working_directory`, so candidates are pre-anchored to a project with zero
 * inference, and only the human's typed prompts become the body.
 *
 * A pure mapper in the Claude Code mould: it takes already-read SQLite rows
 * (plain objects the platform read layer pulled from Warp's `warp.sqlite`) and
 * returns `RawItem`s. It never opens the database, reads disk, calls an LLM, or
 * cross-references git — those are the platform/reducer/triage layers' jobs.
 * One conversation = one candidate; the human's Save is the only commit gate.
 *
 * Source of truth is the `ai_queries` table — Warp stores the user's prompt text
 * locally there, but the assistant's responses live server-side (only a
 * `server_conversation_token` is kept locally), so the body is **human turns
 * only**, exactly like Claude Code. The `agent_conversations` row is optional
 * enrichment (todo lists, credit/token/tool usage).
 *
 * SECURITY STANCE (data, never instructions): the body and titles are external
 * content, stored verbatim as *data*. Any later LLM pass MUST fence them with an
 * explicit do-not-follow guard (types.ts security stance).
 */

import { slugify } from '../ids';
import { asNum, asStr, get, isoDate, type RawItem } from './types';

/** One `ai_queries` row (a single Agent-mode exchange). `input` is a JSON array
 * of tagged turns; a genuine user prompt is an element `{"Query":{text,…}}`. */
export interface WarpQueryRow {
  conversation_id: string;
  start_ts: string;
  /** JSON array text; `[]` for agent continuation/tool steps with no human turn. */
  input: string;
  working_directory?: string;
  output_status?: string;
  model_id?: string;
  planning_model_id?: string;
  coding_model_id?: string;
}

/** Optional `agent_conversations` enrichment for a conversation. */
export interface WarpConversationMeta {
  conversation_id: string;
  /** JSON: `{ server_conversation_token, todo_lists?, conversation_usage_metadata? }`. */
  conversation_data?: string;
  last_modified_at?: string;
}

/** A genuine human turn pulled from one `ai_queries.input`, with the context
 * Warp records alongside the prompt (pwd, git branch, OS, shell). */
export interface WarpTurn {
  text: string;
  pwd?: string;
  branch?: string;
  os?: string;
  shell?: string;
}

/** Pull the context fields Warp attaches to a `Query` (best-effort, all optional). */
function turnContext(query: unknown): Omit<WarpTurn, 'text'> {
  const ctx = get(query, 'context');
  const out: Omit<WarpTurn, 'text'> = {};
  if (!Array.isArray(ctx)) return out;
  for (const el of ctx) {
    const pwd = asStr(get(el, 'Directory', 'pwd'));
    if (pwd) out.pwd ??= pwd;
    const branch = asStr(get(el, 'Git', 'branch'));
    if (branch) out.branch ??= branch;
    const cat = asStr(get(el, 'ExecutionEnvironment', 'os', 'category'));
    const dist = asStr(get(el, 'ExecutionEnvironment', 'os', 'distribution'));
    if (cat) out.os ??= dist && dist !== cat ? `${cat}/${dist}` : cat;
    const shell = asStr(get(el, 'ExecutionEnvironment', 'shell_name'));
    if (shell) out.shell ??= shell;
  }
  return out;
}

/**
 * Parse one `ai_queries.input` JSON array → its genuine human turns. Elements
 * tagged `{"Query":{text,…}}` with non-empty text are kept; everything else
 * (empty `[]`, tool-step elements) is ignored. Never throws — a corrupt or
 * unexpected `input` yields `[]` (spec robustness, mirrors Claude's parseLines).
 */
export function parseWarpQueryInput(input: string): WarpTurn[] {
  const out: WarpTurn[] = [];
  let arr: unknown;
  try {
    arr = JSON.parse(input);
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const el of arr) {
    const query = get(el, 'Query');
    const text = asStr(get(query, 'text'));
    if (!text || !text.trim()) continue;
    out.push({ text, ...turnContext(query) });
  }
  return out;
}

/** Most frequent non-empty value, first-seen wins on ties. */
function mostFrequent(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** Last `/`- or `\`-segment of a path (handles POSIX and Windows working dirs). */
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Human-facing project name for a Warp `working_directory` (its basename). */
export function warpProjectName(workingDir: string): string {
  return basename(workingDir);
}

/** Normalize a Warp `start_ts` (`YYYY-MM-DD HH:MM:SS.fffffffff`, up to 9 frac
 * digits, space-separated) to an ISO-ish `YYYY-MM-DDTHH:MM:SS.fff`, or undefined.
 * Date.parse handles the result; the 9-digit fractional form does not parse. */
function warpIso(ts: string | undefined): string | undefined {
  const s = asStr(ts);
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
  if (!m) return undefined;
  return `${m[1]}T${m[2]}${m[3] ? '.' + m[3].slice(0, 3) : ''}`;
}

/** Minutes between two normalized ISO timestamps, one decimal, or undefined. */
function minutesBetween(a: string | undefined, b: string | undefined): number | undefined {
  if (!a || !b) return undefined;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? Math.round(ms / 6000) / 10 : undefined;
}

/** Fold the optional `agent_conversations` payload into frontmatter extras and a
 * title hint. Returns `{}` when absent or unparseable (never throws). */
function conversationMeta(meta: WarpConversationMeta | undefined): {
  extra: Record<string, unknown>;
  title?: string;
} {
  const extra: Record<string, unknown> = {};
  if (!meta?.conversation_data) return { extra };
  let data: unknown;
  try {
    data = JSON.parse(meta.conversation_data);
  } catch {
    return { extra };
  }

  const todos: string[] = [];
  const lists = get(data, 'todo_lists');
  if (Array.isArray(lists)) {
    for (const list of lists) {
      const done = get(list, 'completed_items');
      if (!Array.isArray(done)) continue;
      for (const item of done) {
        const t = asStr(get(item, 'title'));
        if (t) todos.push(t);
      }
    }
  }
  if (todos.length) extra.warp_todos = todos;

  const usage = get(data, 'conversation_usage_metadata');
  const credits = asNum(get(usage, 'credits_spent'));
  if (credits != null) extra.warp_credits_spent = Math.round(credits * 100) / 100;
  const tokenUsage = get(usage, 'token_usage');
  if (Array.isArray(tokenUsage)) {
    let total = 0;
    for (const t of tokenUsage) total += asNum(get(t, 'total_tokens')) ?? 0;
    if (total > 0) extra.warp_tokens = total;
  }
  const cmds = asNum(get(usage, 'tool_usage_metadata', 'run_command_stats', 'commands_executed'));
  if (cmds != null) extra.warp_commands_run = cmds;
  const diff = get(usage, 'tool_usage_metadata', 'apply_file_diff_stats');
  const filesChanged = asNum(get(diff, 'files_changed'));
  if (filesChanged != null) {
    extra.warp_files_changed = filesChanged;
    extra.warp_lines_added = asNum(get(diff, 'lines_added')) ?? 0;
    extra.warp_lines_removed = asNum(get(diff, 'lines_removed')) ?? 0;
  }

  return { extra, title: todos[0] };
}

/**
 * Map one conversation's `ai_queries` rows → its `RawItem`, or `null` when there
 * is no genuine human turn to record (an agent-only conversation, the analog of
 * Claude's `/clear`→`/exit` skip). `meta` is the optional `agent_conversations`
 * enrichment for the same `conversation_id`.
 */
export function mapWarpConversation(
  rows: WarpQueryRow[],
  meta?: WarpConversationMeta
): RawItem | null {
  // start_ts sorts lexicographically == chronologically for this format.
  const ordered = [...rows].sort((a, b) => (a.start_ts < b.start_ts ? -1 : a.start_ts > b.start_ts ? 1 : 0));

  const turns: WarpTurn[] = [];
  const models = new Set<string>();
  let firstGenuineTs: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let os: string | undefined;
  let shell: string | undefined;

  for (const row of ordered) {
    for (const m of [row.model_id, row.planning_model_id, row.coding_model_id]) {
      const name = asStr(m);
      if (name && name.trim()) models.add(name);
    }
    const rowTurns = parseWarpQueryInput(row.input);
    if (rowTurns.length === 0) continue;
    firstGenuineTs ??= row.start_ts;
    for (const t of rowTurns) {
      turns.push(t);
      gitBranch ??= t.branch;
      os ??= t.os;
      shell ??= t.shell;
    }
  }

  // No genuine human turn ⇒ nothing to record.
  if (turns.length === 0) return null;

  const conversationId = ordered[0]?.conversation_id;
  if (!conversationId) return null;

  cwd = mostFrequent(ordered.map((r) => r.working_directory));
  const project = cwd ? slugify(basename(cwd)) : undefined;
  const date = isoDate(warpIso(firstGenuineTs)) ?? '';

  const startedAt = warpIso(ordered[0]?.start_ts);
  const endedAt = warpIso(ordered[ordered.length - 1]?.start_ts);
  const sortedModels = [...models].sort();

  const fromMeta = conversationMeta(meta);
  const extra: Record<string, unknown> = {
    warp_conversation_id: conversationId,
    warp_turns: turns.length,
    warp_queries_total: ordered.length,
    ...fromMeta.extra
  };
  if (startedAt) extra.warp_started_at = startedAt;
  if (endedAt) extra.warp_ended_at = endedAt;
  const durationMin = minutesBetween(startedAt, endedAt);
  if (durationMin != null) extra.warp_duration_min = durationMin;
  if (sortedModels.length) extra.warp_models = sortedModels;
  if (gitBranch) extra.warp_git_branch = gitBranch;
  if (cwd) extra.warp_cwd = cwd;
  if (os) extra.warp_os = os;
  if (shell) extra.warp_shell = shell;

  const firstLine = turns[0].text.trim().split('\n')[0].trim();
  const title =
    fromMeta.title ||
    (firstLine.length > 80 ? firstLine.slice(0, 79).trimEnd() + '…' : firstLine) ||
    `${turns.length} turns — ${project ?? 'unknown'} — ${date || 'undated'}`;

  const tags = ['warp'];
  if (gitBranch && gitBranch !== 'main' && gitBranch !== 'master') tags.push(slugify(gitBranch));

  return {
    source: 'warp',
    sourceId: conversationId,
    title,
    date,
    body: turns.map((t) => t.text).join('\n\n'),
    suggestedType: 'journal',
    suggestedTags: tags,
    suggestedProject: project,
    extraFrontmatter: extra,
    meta: {}
  };
}

/**
 * Map many `ai_queries` rows → many `RawItem`s, one per conversation. Groups by
 * `conversation_id`, folds in the optional per-conversation `metas`, and maps
 * each group. One bad conversation never aborts the import — a group that throws
 * is skipped (spec robustness, mirrors importClaudeCodeSessions).
 */
export function importWarpConversations(
  rows: WarpQueryRow[],
  metas: Record<string, WarpConversationMeta> = {}
): RawItem[] {
  const groups = new Map<string, WarpQueryRow[]>();
  for (const row of rows) {
    const id = row.conversation_id;
    if (!id) continue;
    const g = groups.get(id);
    if (g) g.push(row);
    else groups.set(id, [row]);
  }
  const items: RawItem[] = [];
  for (const [id, group] of groups) {
    try {
      const item = mapWarpConversation(group, metas[id]);
      if (item) items.push(item);
    } catch {
      // One bad conversation never aborts the import.
    }
  }
  return items;
}
