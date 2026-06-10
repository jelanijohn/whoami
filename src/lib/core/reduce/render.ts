/**
 * Render an accepted {@link Retrospective} as the Markdown inner block written
 * between the reduce markers (ingest-reduce plan §4.4). Evidence ULIDs render as
 * short bracketed references the dashboard links back to the entries.
 */

import { id6 } from '../ids';
import { RETRO_KEYS, type Fact, type Retrospective, type RetroKey } from './schema';

const HEADINGS: Record<RetroKey, string> = {
  worked_on: 'Worked on',
  successes: 'Successes',
  failures: 'Failures',
  lessons: 'Lessons'
};

function renderRefs(evidence: string[]): string {
  if (!evidence.length) return '';
  return ' ' + evidence.map((id) => `[${id6(id)}]`).join(' ');
}

function renderList(facts: Fact[]): string {
  if (!facts.length) return '- _none recorded_';
  return facts.map((f) => `- ${f.text}${renderRefs(f.evidence)}`).join('\n');
}

export interface RenderMeta {
  /** How many entries the reduction was computed over. */
  entryCount: number;
  /** Generation date (YYYY-MM-DD). Injected for testability. */
  generated: string;
}

/** The inner block (no markers) — what gets upserted into the project body. */
export function renderRetrospective(retro: Retrospective, meta: RenderMeta): string {
  const lines: string[] = [];
  lines.push(
    `_Generated ${meta.generated} from ${meta.entryCount} ` +
      `${meta.entryCount === 1 ? 'entry' : 'entries'} — regenerable; do not hand-edit inside the markers._`
  );
  for (const key of RETRO_KEYS) {
    lines.push('', `## ${HEADINGS[key]}`, renderList(retro[key]));
  }
  return lines.join('\n');
}
