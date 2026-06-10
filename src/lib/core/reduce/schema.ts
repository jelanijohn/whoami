/**
 * The closed schema the LLM is constrained to (ingest-reduce plan §4.3).
 *
 * A `Fact` cites the entry ULIDs it was derived from; the pipeline DROPS any
 * fact whose evidence references a ULID outside the input set, so an
 * unverifiable claim cannot survive by construction.
 */

export interface Fact {
  text: string;
  /** Entry ULIDs this fact was derived from. */
  evidence: string[];
  /** Optional event date (YYYY-MM-DD). */
  date?: string;
}

export interface Retrospective {
  worked_on: Fact[];
  successes: Fact[];
  failures: Fact[];
  lessons: Fact[];
}

export const RETRO_KEYS = ['worked_on', 'successes', 'failures', 'lessons'] as const;
export type RetroKey = (typeof RETRO_KEYS)[number];

/** An empty retrospective (all four lists present, empty). */
export function emptyRetro(): Retrospective {
  return { worked_on: [], successes: [], failures: [], lessons: [] };
}

/** Total facts across all four lists. */
export function factCount(retro: Retrospective): number {
  return RETRO_KEYS.reduce((n, k) => n + retro[k].length, 0);
}
