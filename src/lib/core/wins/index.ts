/** Wins from Journal (wins-from-journal spec §2). Draft résumé-grade
 * accomplishments from a hand-picked set of journal entries via the LLM, gated
 * by a human accept step. Pure over the {@link Llm} seam; no platform, no I/O. */
export * from './schema';
export * from './prompts';
export * from './parse';
export * from './pipeline';
