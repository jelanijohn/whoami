/**
 * Anthropic provider (ingest-reduce plan §3) — the Messages API over the
 * {@link Http} seam, with the key pulled from the {@link Secrets} seam at call
 * time (never from config, never from the record).
 *
 * The request sends only model / max_tokens / system / messages — no sampling
 * params — so it is compatible with current Opus-tier models, which reject
 * `temperature` / `top_p` / `top_k`. Text is read from the `content` blocks
 * whose `type` is `text`.
 */

import type { Http, Llm, Secrets } from '../types';
import { ANTHROPIC_KEY_NAME, DEFAULT_MAX_TOKENS, type LlmConfig } from './types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export function makeAnthropicLlm(http: Http, secrets: Secrets, config: LlmConfig): Llm {
  return {
    async complete(req) {
      const key = await secrets.get(ANTHROPIC_KEY_NAME);
      if (!key) {
        throw new Error(`Anthropic API key not set (keyring entry "${ANTHROPIC_KEY_NAME}")`);
      }
      const res = await http.request({
        url: ANTHROPIC_URL,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: req.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: req.system,
          messages: [{ role: 'user', content: req.user }]
        })
      });
      if (!res.ok) {
        throw new Error(`Anthropic (${config.model}): HTTP ${res.status} — ${res.text.slice(0, 300)}`);
      }
      let data: unknown;
      try {
        data = JSON.parse(res.text);
      } catch {
        throw new Error(`Anthropic (${config.model}): response was not JSON`);
      }
      const content = (data as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        throw new Error(`Anthropic (${config.model}): no "content" array in reply`);
      }
      return content
        .filter(
          (b): b is { type: 'text'; text: string } =>
            !!b &&
            typeof b === 'object' &&
            (b as { type?: unknown }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string'
        )
        .map((b) => b.text)
        .join('');
    }
  };
}
