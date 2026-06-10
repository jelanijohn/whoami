/**
 * LLM provider configuration (ingest-reduce plan §3).
 *
 * The provider + model choice is an app setting (persisted outside the record
 * repo). The Anthropic key never rides this config — it lives in the keyring
 * via the {@link Secrets} seam under {@link ANTHROPIC_KEY_NAME}.
 */

export type LlmProvider = 'ollama' | 'anthropic';

export interface LlmConfig {
  provider: LlmProvider;
  /** Provider model id (e.g. `llama3.2`, `claude-opus-4-8`). */
  model: string;
  /** Ollama base URL; ignored for Anthropic. Defaults to {@link DEFAULT_OLLAMA_URL}. */
  baseUrl?: string;
  /** Default soft cap on output tokens when a request omits one. */
  maxTokens?: number;
}

/** Ollama's default local endpoint (same default waid ships). */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'llama3.2';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

/** Keyring entry name for the Anthropic API key (mirrors waid). */
export const ANTHROPIC_KEY_NAME = 'anthropic.api_key';

/** Fallback output cap when neither the request nor the config sets one. */
export const DEFAULT_MAX_TOKENS = 4096;
