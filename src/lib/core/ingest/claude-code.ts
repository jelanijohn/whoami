/**
 * Claude Code adapter — **import-only** (claude-code-adapter spec): turns one
 * Claude Code session JSONL into one review candidate. The highest-fidelity
 * "what did I do" source available, because every message line carries a `cwd`
 * so candidates are pre-anchored to a project with zero inference.
 *
 * A pure mapper in the LinkedIn mould: it takes already-read file text and
 * returns `RawItem`s. It never reads disk, calls an LLM, clusters sessions, or
 * cross-references git — those are the platform/reducer/triage layers' jobs.
 * One session = one candidate; the human's Save is the only commit gate.
 *
 * SECURITY STANCE (data, never instructions): the body and the recap text are
 * external content, stored verbatim as *data*. Any later LLM pass MUST fence
 * them with an explicit do-not-follow guard (types.ts security stance).
 */

import { slugify } from '../ids';
import { asNum, asStr, get, isoDate, type RawItem } from './types';

/**
 * Default per-project import scope (spec §7): the first import is deliberately
 * narrowed to these two roots; every other project under `~/.claude/projects/`
 * is out of scope until added here on purpose. Chat history is the most
 * sensitive source in the system, so the read layer opts in by project rather
 * than dumping the whole projects dir. The core mapper holds no privacy logic —
 * this is the platform read layer's allowlist input.
 */
export const CLAUDE_CODE_DEFAULT_PROJECTS = ['whoami', 'waid'] as const;

/**
 * Is a sanitized-cwd root directory (e.g. `-root-Projects-whoami`) in scope?
 * The dir name encodes the absolute cwd with `/`→`-`, so its project basename
 * is the trailing segment. A root is allowed iff its name equals an allowed
 * project or ends with `-<project>` — portable across machines / home paths
 * (`/root/Projects/whoami` and `/Users/x/code/whoami` both match `whoami`).
 */
export function claudeCodeRootAllowed(rootDir: string, allow: readonly string[]): boolean {
  return allow.some((p) => rootDir === p || rootDir.endsWith('-' + p));
}

/**
 * Human-facing project name for a sanitized-cwd root dir. The dir name encodes
 * the absolute cwd with `/`→`-`, so the project basename is its trailing
 * `-`-segment (`-root-Projects-whoami` → `whoami`). Falls back to the raw dir
 * name when it has no segments. Used to label the import picker.
 */
export function claudeCodeProjectName(rootDir: string): string {
  return rootDir.split('-').filter(Boolean).pop() ?? rootDir;
}

/** Tools whose `file_path` input is a genuine file mutation (excludes `Read`). */
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Command-wrapper prefixes that mark a `user` string line as slash-command
 * plumbing rather than an authored prompt (§4.1 predicate 5). */
const COMMAND_WRAPPERS = ['<command-name>', '<command-message>', '<local-command-stdout>', '<local-command-caveat>'];

/** Parse JSONL text into objects, skipping any corrupt line (never throws). */
function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object') out.push(o as Record<string, unknown>);
    } catch {
      // One corrupt line is skipped, never thrown (spec §3, §10 robustness).
    }
  }
  return out;
}

/**
 * A genuine human turn (§4.1): `type:'user'`, not meta, not a subagent prompt,
 * with **string** content (array content is a `tool_result` echo) that is not a
 * slash-command wrapper. `promptSource:'typed'` is a strong positive but not
 * required (older lines may lack it).
 */
function genuineHumanTurn(o: Record<string, unknown>): string | null {
  if (o.type !== 'user') return null;
  if (o.isMeta === true || o.isSidechain === true) return null;
  const content = get(o, 'message', 'content');
  if (typeof content !== 'string') return null;
  const trimmed = content.trimStart();
  if (COMMAND_WRAPPERS.some((p) => trimmed.startsWith(p))) return null;
  return content;
}

/** Repo-relative path when `p` is under `cwd`, else the path as stored. */
function relToCwd(p: string, cwd: string | undefined): string {
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}

/** Slugified project guess from a session file path, used only when no message
 * line carried a `cwd`. The parent dir is the sanitized cwd
 * (`/root/Projects/whoami` → `-root-Projects-whoami`); its last `-`-segment is a
 * best-effort project basename. */
function projectFromFilePath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const parts = filePath.split('/').filter(Boolean);
  const dir = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  const seg = dir?.split('-').filter(Boolean).pop();
  return seg ? slugify(seg) : undefined;
}

/** Minutes between two ISO timestamps, one decimal, or undefined. */
function minutesBetween(a: string | undefined, b: string | undefined): number | undefined {
  if (!a || !b) return undefined;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? Math.round(ms / 6000) / 10 : undefined;
}

/**
 * Map one session file's full text → its `RawItem`, or `null` when there is no
 * genuine human turn to record (e.g. a `/clear`→`/exit` session — §4.1, §10).
 * `filePath` supplies a sessionId / project fallback when message lines omit it.
 */
export function mapClaudeCodeSession(jsonlText: string, filePath?: string): RawItem | null {
  const lines = parseLines(jsonlText);

  const humanTurns: string[] = [];
  let firstHumanTs: string | undefined;
  let userTurns = 0;
  let assistantTurns = 0;
  const messageTimestamps: string[] = [];

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let slug: string | undefined;
  let aiTitle: string | undefined;
  let awaySummary: string | undefined;
  let activeMs = 0;
  let hasActive = false;

  const tools = new Set<string>();
  const filesTouched = new Set<string>();
  const models = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  const filesEdited = new Set<string>();

  for (const o of lines) {
    // Provenance fields ride every message line; first non-empty wins.
    sessionId ??= asStr(o.sessionId);
    cwd ??= asStr(o.cwd);
    gitBranch ??= asStr(o.gitBranch);
    slug ??= asStr(o.slug);

    const ts = asStr(o.timestamp);

    if (o.type === 'user') {
      const turn = genuineHumanTurn(o);
      if (turn !== null) {
        humanTurns.push(turn);
        userTurns++;
        if (ts) {
          messageTimestamps.push(ts);
          firstHumanTs ??= ts;
        }
      }
    } else if (o.type === 'assistant') {
      assistantTurns++;
      if (ts) messageTimestamps.push(ts);
      const model = asStr(get(o, 'message', 'model'));
      if (model) models.add(model);
      const content = get(o, 'message', 'content');
      if (Array.isArray(content)) {
        for (const block of content) {
          if (get(block, 'type') !== 'tool_use') continue;
          const name = asStr(get(block, 'name'));
          if (name) tools.add(name);
          const fp = asStr(get(block, 'input', 'file_path'));
          if (fp && name && MUTATING_TOOLS.has(name)) filesTouched.add(relToCwd(fp, cwd));
        }
      }
    } else if (o.type === 'ai-title') {
      // Emitted more than once as the title is refined — take the last (§2).
      aiTitle = asStr(o.aiTitle) ?? aiTitle;
    } else if (o.type === 'system') {
      if (o.subtype === 'away_summary') awaySummary ??= asStr(o.content);
      else if (o.subtype === 'turn_duration') {
        const d = asNum(o.durationMs);
        if (d != null) {
          activeMs += d;
          hasActive = true;
        }
      }
    }

    // Edit/Write change-size rides the tool_result echo (`toolUseResult`),
    // independent of line type — the strongest deterministic change-size source.
    const patch = get(o, 'toolUseResult', 'structuredPatch');
    if (Array.isArray(patch)) {
      const fp = asStr(get(o, 'toolUseResult', 'filePath'));
      if (fp) filesEdited.add(relToCwd(fp, cwd));
      for (const hunk of patch) {
        const hunkLines = get(hunk, 'lines');
        if (!Array.isArray(hunkLines)) continue;
        for (const l of hunkLines) {
          if (typeof l !== 'string') continue;
          if (l.startsWith('+')) linesAdded++;
          else if (l.startsWith('-')) linesRemoved++;
        }
      }
    }
  }

  // No genuine human turn ⇒ nothing to record (spec §3, §10).
  if (humanTurns.length === 0) return null;

  sessionId ??= filePath?.split('/').pop()?.replace(/\.jsonl$/, '');
  if (!sessionId) return null;

  const startedAt = messageTimestamps[0];
  const endedAt = messageTimestamps[messageTimestamps.length - 1];
  const date = isoDate(firstHumanTs) ?? '';

  const project = cwd ? slugify(cwd.split('/').filter(Boolean).pop() ?? '') : projectFromFilePath(filePath);

  const totalTurns = userTurns + assistantTurns;
  const authorship = totalTurns > 0 ? Math.round((userTurns / totalTurns) * 100) / 100 : 1;

  const sortedTools = [...tools].sort();
  const sortedFiles = [...filesTouched].sort();
  const sortedModels = [...models].sort();

  const extra: Record<string, unknown> = {
    cc_session_id: sessionId,
    cc_turns_user: userTurns,
    cc_turns_assistant: assistantTurns,
    cc_authorship: authorship
  };
  if (startedAt) extra.cc_started_at = startedAt;
  if (endedAt) extra.cc_ended_at = endedAt;
  const durationMin = minutesBetween(startedAt, endedAt);
  if (durationMin != null) extra.cc_duration_min = durationMin;
  if (hasActive) extra.cc_active_min = Math.round(activeMs / 6000) / 10;
  if (sortedTools.length) extra.cc_tools = sortedTools;
  if (sortedFiles.length) extra.cc_files_touched = sortedFiles;
  if (filesEdited.size) {
    extra.cc_lines_added = linesAdded;
    extra.cc_lines_removed = linesRemoved;
    extra.cc_files_edited = filesEdited.size;
  }
  if (sortedModels.length) extra.cc_models = sortedModels;
  if (gitBranch) extra.cc_git_branch = gitBranch;
  if (cwd) extra.cc_cwd = cwd;

  const title =
    aiTitle ||
    awaySummary?.split('\n')[0]?.trim() ||
    slug ||
    `${userTurns} turns — ${project ?? 'unknown'} — ${date || 'undated'}`;

  const tags = ['claude-code'];
  if (gitBranch && gitBranch !== 'main' && gitBranch !== 'master') tags.push(slugify(gitBranch));

  return {
    source: 'claude-code',
    sourceId: sessionId,
    title,
    date,
    body: humanTurns.join('\n\n'),
    suggestedType: 'journal',
    suggestedTags: tags,
    suggestedProject: project,
    extraFrontmatter: extra,
    meta: {}
  };
}

/**
 * Map many session files → many `RawItem`s. The keys are file paths (supplying
 * the sessionId / project fallback); the values are file text. One bad session
 * never aborts the import — a session that throws is skipped (spec §3).
 */
export function importClaudeCodeSessions(files: Record<string, string>): RawItem[] {
  const items: RawItem[] = [];
  for (const [path, text] of Object.entries(files)) {
    try {
      const item = mapClaudeCodeSession(text, path);
      if (item) items.push(item);
    } catch {
      // One bad session never aborts the import (spec §3).
    }
  }
  return items;
}
