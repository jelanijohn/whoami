/** Stage 2 — Reduce (ingest-reduce plan §4). The deterministic rollup plus the
 * LLM map/reduce pipeline, strict parse + evidence filter, render, and the
 * app-owned marker region. */
export * from './rollup';
export * from './schema';
export * from './alias';
export * from './chunk';
export * from './prompts';
export * from './parse';
export * from './render';
export * from './markers';
export * from './pipeline';
