import { describe, it, expect } from 'vitest';
import { makeOllamaLlm, makeAnthropicLlm, makeLlm, ANTHROPIC_KEY_NAME } from './index';
import type { Http, HttpRequest, HttpResponse, Platform, Secrets } from '../types';

/** A fake Http seam that records requests and returns a scripted response. */
function fakeHttp(reply: (req: HttpRequest) => HttpResponse): { http: Http; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  return {
    calls,
    http: {
      async request(req) {
        calls.push(req);
        return reply(req);
      }
    }
  };
}

function ok(text: string): HttpResponse {
  return { status: 200, ok: true, headers: {}, text };
}

function memSecrets(seed: Record<string, string> = {}): Secrets {
  const m = new Map(Object.entries(seed));
  return {
    async get(k) {
      return m.get(k) ?? null;
    },
    async set(k, v) {
      m.set(k, v);
    },
    async delete(k) {
      m.delete(k);
    }
  };
}

describe('Ollama provider (plan §3)', () => {
  it('posts to /api/generate and returns the response text', async () => {
    const { http, calls } = fakeHttp(() => ok(JSON.stringify({ response: 'hi there' })));
    const llm = makeOllamaLlm(http, { provider: 'ollama', model: 'llama3.2' });

    const out = await llm.complete({ system: 'be brief', user: 'hello', maxTokens: 32 });

    expect(out).toBe('hi there');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:11434/api/generate');
    const body = JSON.parse(calls[0].body!);
    expect(body).toMatchObject({
      model: 'llama3.2',
      system: 'be brief',
      prompt: 'hello',
      stream: false,
      options: { num_predict: 32 }
    });
  });

  it('honors a custom baseUrl and strips a trailing slash', async () => {
    const { http, calls } = fakeHttp(() => ok(JSON.stringify({ response: '' })));
    const llm = makeOllamaLlm(http, {
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://box:11434/'
    });
    await llm.complete({ system: '', user: 'x' });
    expect(calls[0].url).toBe('http://box:11434/api/generate');
  });

  it('throws on a non-OK HTTP status', async () => {
    const { http } = fakeHttp(() => ({ status: 500, ok: false, headers: {}, text: 'boom' }));
    const llm = makeOllamaLlm(http, { provider: 'ollama', model: 'llama3.2' });
    await expect(llm.complete({ system: '', user: 'x' })).rejects.toThrow(/HTTP 500/);
  });
});

describe('Anthropic provider (plan §3)', () => {
  it('sends the key + version headers and parses text content blocks', async () => {
    const { http, calls } = fakeHttp(() =>
      ok(
        JSON.stringify({
          content: [
            { type: 'text', text: 'part one. ' },
            { type: 'thinking', thinking: 'ignored' },
            { type: 'text', text: 'part two.' }
          ]
        })
      )
    );
    const llm = makeAnthropicLlm(http, memSecrets({ [ANTHROPIC_KEY_NAME]: 'sk-test' }), {
      provider: 'anthropic',
      model: 'claude-opus-4-8'
    });

    const out = await llm.complete({ system: 'sys', user: 'ask', maxTokens: 100 });

    expect(out).toBe('part one. part two.');
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers).toMatchObject({
      'x-api-key': 'sk-test',
      'anthropic-version': '2023-06-01'
    });
    const body = JSON.parse(calls[0].body!);
    expect(body).toMatchObject({
      model: 'claude-opus-4-8',
      max_tokens: 100,
      system: 'sys',
      messages: [{ role: 'user', content: 'ask' }]
    });
    // No sampling params — Opus-tier rejects temperature/top_p/top_k.
    expect(body.temperature).toBeUndefined();
  });

  it('throws a clear error when the key is missing', async () => {
    const { http, calls } = fakeHttp(() => ok('{}'));
    const llm = makeAnthropicLlm(http, memSecrets(), {
      provider: 'anthropic',
      model: 'claude-opus-4-8'
    });
    await expect(llm.complete({ system: '', user: 'x' })).rejects.toThrow(/API key not set/);
    expect(calls).toHaveLength(0); // never hit the network without a key
  });
});

describe('makeLlm factory', () => {
  const cfg = { provider: 'ollama' as const, model: 'llama3.2' };

  it('returns null when the platform has no Http seam', () => {
    expect(makeLlm({} as Platform, cfg)).toBeNull();
  });

  it('builds an Ollama provider from just an Http seam', () => {
    const { http } = fakeHttp(() => ok('{}'));
    expect(makeLlm({ http } as unknown as Platform, cfg)).not.toBeNull();
  });

  it('returns null for Anthropic when no Secrets seam is present', () => {
    const { http } = fakeHttp(() => ok('{}'));
    const out = makeLlm({ http } as unknown as Platform, {
      provider: 'anthropic',
      model: 'claude-opus-4-8'
    });
    expect(out).toBeNull();
  });
});
