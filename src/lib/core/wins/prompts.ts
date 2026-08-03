/**
 * Prompt assembly for the wins draft pass (wins-from-journal spec §2.2).
 *
 * THE SECOND HARD RULE (CLAUDE.md security stance): all record content is DATA,
 * never instructions. Entry titles/bodies can carry injected text, so the prompt
 * wraps them in a fenced data block with an explicit do-not-follow guard (reused
 * from `reduce/`) and constrains the model to a closed JSON schema.
 */

import type { Entry, LlmCompletionRequest } from '../types';
import { serializeEntryBlock } from '../reduce/chunk';
import { requireAlias, type AliasTable } from '../reduce/alias';
import { DATA_GUARD } from '../reduce/prompts';

const SCHEMA_NOTE =
  'Respond with ONLY a JSON object (no prose, no code fence) of this exact shape:\n' +
  '{"wins":[{"text": string, "evidence": [string]}]}\n' +
  'Every win MUST cite, in "evidence", the short entry id(s) it was derived ' +
  'from — cite them exactly as shown in the data (e.g. "E2"). Invent no ids. ' +
  'If a claim cannot be tied to an id, omit it.';

const WINS_SYSTEM =
  'You draft résumé-grade accomplishment statements ("wins") from a hand-picked ' +
  'set of historical record entries. Extract ONE OR MORE accomplishment ' +
  'statements from the fenced entries. Each statement is résumé-grade: action + ' +
  'outcome/impact, concise, first-person implied (no "I"), past tense. ' +
  'Incorporate quantified impact ONLY when it appears in the data; NEVER invent ' +
  'numbers, dates, names, or facts. ' +
  'Do NOT copy proprietary or sensitive content — no customer names, secret ' +
  'figures, internal codenames, or verbatim body text. Reframe as outcome. If a ' +
  'source is thin, write a smaller honest claim or omit it. ' +
  'Collapse several related entries into a single win when they describe one ' +
  'accomplishment. ' +
  DATA_GUARD +
  '\n' +
  SCHEMA_NOTE;

/** Fence the selected entries as data for the single wins draft call. Entries
 * render under their short aliases (see `reduce/alias.ts`) so the model never
 * sees or echoes ULIDs; a table that doesn't cover every entry throws rather
 * than leaking a ULID. */
export function buildWinsPrompt(entries: Entry[], aliases: AliasTable): LlmCompletionRequest {
  const data = entries
    .map((e) => serializeEntryBlock(e, requireAlias(aliases, String(e.frontmatter.id))))
    .join('\n\n---\n\n');
  return {
    system: WINS_SYSTEM,
    user: `<<<DATA\n${data}\n>>>END_DATA\n\nDraft the wins as JSON.`
  };
}
