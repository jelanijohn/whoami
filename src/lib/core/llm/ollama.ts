/**
 * Ollama provider (ingest-reduce plan §3) — local HTTP, no key needed.
 *
 * Pure over the {@link Http} seam: it builds the `/api/generate` request and
 * parses the response, but never opens a socket itself. That makes it trivially
 * fakeable in tests and identical on node and the Tauri webview.
 */

import type { Http, Llm } from '../types';
import { DEFAULT_MAX_TOKENS, DEFAULT_OLLAMA_URL, type LlmConfig } from './types';

export function makeOllamaLlm(http: Http, config: LlmConfig): Llm {
  const base = (config.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  return {
    async complete(req) {
      const res = await http.request({
        url: `${base}/api/generate`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          system: req.system,
          prompt: req.user,
          stream: false,
          options: {
            num_predict: req.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS
          }
        })
      });
      if (!res.ok) {
        throw new Error(`Ollama (${config.model}): HTTP ${res.status} — ${res.text.slice(0, 200)}`);
      }
      let data: unknown;
      try {
        data = JSON.parse(res.text);
      } catch {
        throw new Error(`Ollama (${config.model}): response was not JSON`);
      }
      const out = (data as { response?: unknown }).response;
      if (typeof out !== 'string') {
        throw new Error(`Ollama (${config.model}): no "response" field in reply`);
      }
      return out;
    }
  };
}
