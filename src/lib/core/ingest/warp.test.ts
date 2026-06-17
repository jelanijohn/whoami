import { describe, expect, it } from 'vitest';
import {
  parseWarpQueryInput,
  mapWarpConversation,
  importWarpConversations,
  warpProjectName,
  type WarpQueryRow,
  type WarpConversationMeta
} from './warp';

/** Build a genuine `ai_queries.input` array (one typed Query with context). */
function genuine(text: string, branch = 'main', pwd = '/root/Projects/glue'): string {
  return JSON.stringify([
    {
      Query: {
        text,
        context: [
          { Directory: { pwd, home_dir: '/root', are_file_symbols_indexed: false } },
          { Git: { head: 'main', branch } },
          { CurrentTime: { current_time: '2026-06-03T14:18:46.652737-04:00' } },
          {
            ExecutionEnvironment: {
              os: { category: 'Linux', distribution: 'Ubuntu' },
              shell_name: 'bash',
              shell_version: '5.1.16(1)-release'
            }
          }
        ],
        referenced_attachments: {}
      }
    }
  ]);
}

function row(over: Partial<WarpQueryRow> & Pick<WarpQueryRow, 'conversation_id' | 'start_ts' | 'input'>): WarpQueryRow {
  return {
    working_directory: '/root/Projects/glue',
    output_status: '"Completed"',
    model_id: 'auto-genius',
    planning_model_id: '',
    coding_model_id: '',
    ...over
  };
}

const META: WarpConversationMeta = {
  conversation_id: 'conv-A',
  conversation_data: JSON.stringify({
    server_conversation_token: 'tok-1',
    todo_lists: [
      {
        completed_items: [
          { id: '1', title: 'Set up database backups', description: '…' },
          { id: '2', title: 'Verify AWS credentials', description: '…' }
        ],
        pending_items: []
      }
    ],
    conversation_usage_metadata: {
      credits_spent: 101.35923,
      token_usage: [{ model_id: 'claude 4.5 sonnet', total_tokens: 1649834, byok_tokens: 0 }],
      tool_usage_metadata: {
        run_command_stats: { count: 20, commands_executed: 18 },
        apply_file_diff_stats: { count: 6, lines_added: 45, lines_removed: 18, files_changed: 1 }
      }
    }
  })
};

describe('parseWarpQueryInput', () => {
  it('extracts the typed prompt and its context', () => {
    const turns = parseWarpQueryInput(genuine('hello there', 'feature/x'));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      text: 'hello there',
      pwd: '/root/Projects/glue',
      branch: 'feature/x',
      os: 'Linux/Ubuntu',
      shell: 'bash'
    });
  });

  it('returns [] for agent continuation steps (empty array)', () => {
    expect(parseWarpQueryInput('[]')).toEqual([]);
  });

  it('skips Query elements with empty/whitespace text', () => {
    expect(parseWarpQueryInput(JSON.stringify([{ Query: { text: '   ' } }]))).toEqual([]);
  });

  it('never throws on malformed JSON', () => {
    expect(parseWarpQueryInput('{not json')).toEqual([]);
    expect(parseWarpQueryInput('"a string"')).toEqual([]);
  });
});

describe('mapWarpConversation', () => {
  const rows: WarpQueryRow[] = [
    row({ conversation_id: 'conv-A', start_ts: '2026-06-03 19:03:28.879044300', input: genuine('first prompt', 'feature/x') }),
    // agent continuation step between the two human turns — counted, not bodied
    row({ conversation_id: 'conv-A', start_ts: '2026-06-03 19:03:29.012118700', input: '[]' }),
    row({ conversation_id: 'conv-A', start_ts: '2026-06-03 19:04:21.239063300', input: genuine('second prompt', 'feature/x'), coding_model_id: 'claude-sonnet' })
  ];

  it('maps one conversation to one human-turns-only candidate', () => {
    const item = mapWarpConversation(rows, META);
    expect(item).not.toBeNull();
    expect(item!.source).toBe('warp');
    expect(item!.sourceId).toBe('conv-A');
    expect(item!.body).toBe('first prompt\n\nsecond prompt'); // continuation excluded
    expect(item!.date).toBe('2026-06-03');
    expect(item!.suggestedType).toBe('journal');
    expect(item!.suggestedProject).toBe('glue');
    expect(item!.suggestedTags?.[0]).toBe('warp');
    expect(item!.suggestedTags).toHaveLength(2); // warp + branch (non-main)
  });

  it('derives deterministic warp_* frontmatter', () => {
    const fm = mapWarpConversation(rows, META)!.extraFrontmatter!;
    expect(fm.warp_conversation_id).toBe('conv-A');
    expect(fm.warp_turns).toBe(2); // genuine prompts
    expect(fm.warp_queries_total).toBe(3); // all exchanges incl. continuation
    expect(fm.warp_models).toEqual(['auto-genius', 'claude-sonnet']);
    expect(fm.warp_git_branch).toBe('feature/x');
    expect(fm.warp_cwd).toBe('/root/Projects/glue');
    expect(fm.warp_os).toBe('Linux/Ubuntu');
    expect(fm.warp_shell).toBe('bash');
    // a finite duration from the 9-fractional-digit timestamps (not NaN)
    expect(typeof fm.warp_duration_min).toBe('number');
    expect(Number.isFinite(fm.warp_duration_min as number)).toBe(true);
  });

  it('folds the agent_conversations enrichment in', () => {
    const item = mapWarpConversation(rows, META)!;
    const fm = item.extraFrontmatter!;
    expect(item.title).toBe('Set up database backups'); // first completed todo
    expect(fm.warp_todos).toEqual(['Set up database backups', 'Verify AWS credentials']);
    expect(fm.warp_credits_spent).toBe(101.36);
    expect(fm.warp_tokens).toBe(1649834);
    expect(fm.warp_commands_run).toBe(18);
    expect(fm.warp_files_changed).toBe(1);
    expect(fm.warp_lines_added).toBe(45);
    expect(fm.warp_lines_removed).toBe(18);
  });

  it('falls back to the first prompt line for the title when no meta', () => {
    const item = mapWarpConversation(rows)!;
    expect(item.title).toBe('first prompt');
    expect(item.extraFrontmatter!.warp_todos).toBeUndefined();
    expect(item.extraFrontmatter!.warp_credits_spent).toBeUndefined();
  });

  it('returns null for an agent-only conversation (no genuine prompt)', () => {
    const agentOnly: WarpQueryRow[] = [
      row({ conversation_id: 'conv-Z', start_ts: '2026-06-03 19:03:28.0', input: '[]' }),
      row({ conversation_id: 'conv-Z', start_ts: '2026-06-03 19:03:29.0', input: '[]' })
    ];
    expect(mapWarpConversation(agentOnly)).toBeNull();
  });

  it('anchors a Windows working_directory to its basename project', () => {
    const win: WarpQueryRow[] = [
      row({
        conversation_id: 'conv-W',
        start_ts: '2026-06-03 19:03:28.0',
        input: JSON.stringify([{ Query: { text: 'on windows' } }]),
        working_directory: 'C:\\Users\\jelan\\code\\myapp'
      })
    ];
    const item = mapWarpConversation(win)!;
    expect(item.suggestedProject).toBe('myapp');
    expect(item.extraFrontmatter!.warp_cwd).toBe('C:\\Users\\jelan\\code\\myapp');
  });
});

describe('importWarpConversations', () => {
  it('groups rows by conversation and drops agent-only ones', () => {
    const rows: WarpQueryRow[] = [
      row({ conversation_id: 'A', start_ts: '2026-06-03 10:00:00.0', input: genuine('a1') }),
      row({ conversation_id: 'B', start_ts: '2026-06-03 11:00:00.0', input: '[]' }), // agent-only → dropped
      row({ conversation_id: 'C', start_ts: '2026-06-03 12:00:00.0', input: genuine('c1') })
    ];
    const items = importWarpConversations(rows);
    expect(items.map((i) => i.sourceId).sort()).toEqual(['A', 'C']);
  });

  it('ignores rows with no conversation_id', () => {
    const rows = [row({ conversation_id: '', start_ts: '2026-06-03 10:00:00.0', input: genuine('x') })];
    expect(importWarpConversations(rows)).toEqual([]);
  });
});

describe('warpProjectName', () => {
  it('returns the basename for POSIX and Windows paths', () => {
    expect(warpProjectName('/root/Projects/glue')).toBe('glue');
    expect(warpProjectName('C:\\Users\\jelan\\code\\myapp')).toBe('myapp');
  });
});
