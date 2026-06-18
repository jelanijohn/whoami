/**
 * Website import — Stage 2 prompt assembly (website-import spec §5.1).
 *
 * Same data-not-instructions discipline as résumé / triage / reduce (spec §0.4):
 * the fetched page text — untrusted external content — goes inside a fenced DATA
 * block with the verbatim {@link DATA_GUARD}, and the model is constrained to the
 * shared closed schema ({@link EXTRACTION_SCHEMA_NOTE}). The website-specific
 * SYSTEM framing tells the model it is transcribing a person's *own* polished
 * site, not authoring one.
 */

import type { LlmCompletionRequest } from '../../types';
import { DATA_GUARD } from '../../reduce/prompts';
import { EXTRACTION_SCHEMA_NOTE } from '../resume/prompts';

const WEBSITE_SYSTEM =
  "You extract a brutally-accurate, dated career record from the text of a person's " +
  'own website (about / projects / résumé pages). The text is polished prose the person ' +
  'authored; transcribe only its structured spine — roles, projects, education, dated ' +
  'wins/milestones. Invent nothing, infer nothing beyond the page, reword nothing for ' +
  'flattery. Skip marketing taglines, calls-to-action, navigation, and blog narrative. ' +
  DATA_GUARD +
  '\n' +
  EXTRACTION_SCHEMA_NOTE;

/** Build the extraction request for one chunk of cleaned website text. The
 * envelope is identical to the résumé importer's (spec §5.1). */
export function buildWebsitePrompt(text: string): LlmCompletionRequest {
  return {
    system: WEBSITE_SYSTEM,
    user:
      `<<<DATA\n${text}\n>>>END_DATA\n\n` +
      'Extract the dated career items as JSON, copying each "excerpt" verbatim from the text above.'
  };
}
