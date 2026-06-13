/**
 * Prompt assembly for the résumé extraction pass (résumé import spec §5).
 *
 * Same data-not-instructions discipline as `triage/` and `reduce/` (spec §1
 * rule 3): the résumé text goes inside a fenced DATA block with the verbatim
 * {@link DATA_GUARD}, and the model is constrained to a closed JSON schema. The
 * SYSTEM prompt forbids invention, inference, and flattering rewordings — the
 * model transcribes a pre-curated document, it does not author one (spec §1
 * rule 2). A `.docx` can carry injected text in white-on-white runs, so the
 * fence + guard are load-bearing, not ceremony.
 */

import type { LlmCompletionRequest } from '../../types';
import { DATA_GUARD } from '../../reduce/prompts';

const SCHEMA_NOTE =
  'Respond with ONLY a JSON object (no prose, no code fence) of this exact shape:\n' +
  '{"items":[{' +
  '"type":"role|project|education|win|milestone",' +
  '"title": string,' +
  '"org"?: string,' + // employer / school; required for role & education
  '"role"?: string,' + // job title, for type: role
  '"start":"YYYY-MM-DD|YYYY-MM|YYYY",' +
  '"end"?:"YYYY-MM-DD|YYYY-MM|YYYY|present",' +
  '"location"?: string,' +
  '"url"?: string,' +
  '"excerpt": string' + // the VERBATIM résumé text this item came from
  '}]}\n' +
  'Each item\'s "excerpt" MUST be copied verbatim from the résumé text — it is the ' +
  'evidence the item is real, and any item whose excerpt is not found in the text is ' +
  'discarded. If a date or field is absent from the résumé, omit it rather than guess.';

const RESUME_SYSTEM =
  'You extract a brutally-accurate, dated career record from a résumé / CV. ' +
  'The text is a polished document the person already authored; your job is to ' +
  'transcribe its structured spine — roles, projects, education, and dated wins / ' +
  'milestones — into fields. Extract ONLY what is literally written: invent nothing, ' +
  'infer nothing beyond what is on the page, and reword nothing for flattery. ' +
  'Skip objective/summary blurbs, skills lists, and references. ' +
  DATA_GUARD +
  '\n' +
  SCHEMA_NOTE;

/** Build the extraction request for one chunk of résumé text. */
export function buildResumePrompt(text: string): LlmCompletionRequest {
  return {
    system: RESUME_SYSTEM,
    user:
      `<<<DATA\n${text}\n>>>END_DATA\n\n` +
      'Extract the dated career items as JSON, copying each "excerpt" verbatim from the text above.'
  };
}
