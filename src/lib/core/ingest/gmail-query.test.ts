import { describe, expect, it } from 'vitest';
import type { Llm, LlmCompletionRequest } from '../types';
import {
  GMAIL_QUERY_SYSTEM,
  buildGmailQueryPrompt,
  sanitizeSearchQuery,
  suggestGmailQuery
} from './gmail-query';

describe('gmail query helper', () => {
  describe('buildGmailQueryPrompt', () => {
    it('uses the Gmail system prompt and the trimmed description as user', () => {
      const req = buildGmailQueryPrompt('  unread from my manager this week  ');
      expect(req.system).toBe(GMAIL_QUERY_SYSTEM);
      expect(req.user).toBe('unread from my manager this week');
      expect(req.maxTokens).toBe(200);
    });

    it('caps very long descriptions', () => {
      const req = buildGmailQueryPrompt('x'.repeat(5000));
      expect(req.user.length).toBe(2000);
    });
  });

  describe('sanitizeSearchQuery', () => {
    it('passes a clean query through untouched', () => {
      expect(sanitizeSearchQuery('from:acme is:unread newer_than:7d')).toBe(
        'from:acme is:unread newer_than:7d'
      );
    });

    it('takes the first non-empty line and drops trailing prose', () => {
      expect(sanitizeSearchQuery('\nin:sent after:2019/01/01\nThis query finds…')).toBe(
        'in:sent after:2019/01/01'
      );
    });

    it('skips code fences and strips wrapping backticks/quotes', () => {
      expect(sanitizeSearchQuery('```\n`from:jane has:attachment`\n```')).toBe(
        'from:jane has:attachment'
      );
      expect(sanitizeSearchQuery('"is:starred"')).toBe('is:starred');
    });

    it('strips a leading label but keeps real Gmail operators', () => {
      expect(sanitizeSearchQuery('Query: from:acme')).toBe('from:acme');
      expect(sanitizeSearchQuery('gmail: subject:invoice')).toBe('subject:invoice');
      expect(sanitizeSearchQuery('from:query@acme.com')).toBe('from:query@acme.com');
    });

    it('returns empty when nothing usable remains', () => {
      expect(sanitizeSearchQuery('')).toBe('');
      expect(sanitizeSearchQuery('```\n```')).toBe('');
      expect(sanitizeSearchQuery('   \n\n')).toBe('');
    });
  });

  describe('suggestGmailQuery', () => {
    const llmReturning = (out: string): Llm & { seen: LlmCompletionRequest[] } => {
      const seen: LlmCompletionRequest[] = [];
      return {
        seen,
        async complete(req) {
          seen.push(req);
          return out;
        }
      };
    };

    it('completes and sanitizes', async () => {
      const llm = llmReturning('`from:boss@acme.com is:unread newer_than:7d`\n');
      await expect(suggestGmailQuery(llm, 'unread from my boss this week')).resolves.toBe(
        'from:boss@acme.com is:unread newer_than:7d'
      );
      expect(llm.seen[0].system).toBe(GMAIL_QUERY_SYSTEM);
    });

    it('rejects an empty description without calling the LLM', async () => {
      const llm = llmReturning('from:acme');
      await expect(suggestGmailQuery(llm, '   ')).rejects.toThrow(/describe/i);
      expect(llm.seen.length).toBe(0);
    });

    it('rejects when the model returns nothing usable', async () => {
      const llm = llmReturning('```\n```');
      await expect(suggestGmailQuery(llm, 'anything')).rejects.toThrow(/usable search/i);
    });
  });
});
