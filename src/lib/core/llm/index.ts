/**
 * LLM seam — public surface (ingest-reduce plan §3).
 *
 * `makeLlm` is waid's `make_provider`: it turns a persisted {@link LlmConfig}
 * plus the platform's `http` / `secrets` seams into an {@link Llm}, or returns
 * null when the seams a provider needs are absent (the caller then shows a
 * "no provider configured" message rather than crashing).
 */

import type { Llm, Platform } from '../types';
import { makeOllamaLlm } from './ollama';
import { makeAnthropicLlm } from './anthropic';
import type { LlmConfig } from './types';

export * from './types';
export { makeOllamaLlm } from './ollama';
export { makeAnthropicLlm } from './anthropic';

/** Build an {@link Llm} for `config` from the platform seams, or null when the
 * platform can't satisfy it (no Http at all, or no Secrets for Anthropic). */
export function makeLlm(platform: Platform, config: LlmConfig): Llm | null {
  if (!platform.http) return null;
  switch (config.provider) {
    case 'ollama':
      return makeOllamaLlm(platform.http, config);
    case 'anthropic':
      if (!platform.secrets) return null;
      return makeAnthropicLlm(platform.http, platform.secrets, config);
    default:
      return null;
  }
}
