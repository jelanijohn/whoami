/**
 * Inbox triage — public surface (triage spec). A deterministic prefilter that
 * always runs, plus an optional LLM pass over the ambiguous remainder. Triage
 * annotates a `keep | frivolous` sort signal onto inbox candidates; it never
 * deletes, hides, or auto-rejects (spec §0). Signals are stripped on promote
 * (record.ts) so nothing reaches the record.
 */
export {
  type TriageVerdict,
  type TriageSignal,
  type TriageResult,
  type TriageRubric,
  TRIAGE_KEYS,
  DEFAULT_RUBRIC
} from './types';
export { prefilterItem, type PrefilterOutcome } from './prefilter';
export { buildTriagePrompt, triageItemView } from './prompts';
export { parseVerdicts, type Verdict } from './parse';
export { triageItems, type TriageOpts } from './pipeline';
