/**
 * Résumé import — public surface (résumé import spec §4).
 *
 * A pure text → `RawItem[]` pipeline: chunk a CV, structure each chunk with the
 * `Llm` seam, and validate the result against the closed schema + the source-
 * span evidence filter. I/O only through the `Llm`; binary extraction lives
 * behind the `DocExtract` platform seam, never here.
 */

export { RESUME_SOURCE, RESUME_TYPES, type ResumeType, type ResumeItem } from './types';
export { buildResumePrompt, EXTRACTION_SCHEMA_NOTE } from './prompts';
export { parseResumeItems, type ExtractParseOpts } from './parse';
export { chunkResumeText, RESUME_TOKEN_BUDGET } from './chunk';
export { parseResume, type ParseResumeOpts, type ParseResumeResult } from './pipeline';
