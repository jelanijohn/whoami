/**
 * Résumé import — shared types (résumé import spec §4).
 *
 * The résumé importer is just another producer of `RawItem[]`: the LLM
 * structures pre-curated human prose into per-item {@link ResumeItem}s, which
 * {@link parseResumeItems} validates and maps onto the same `RawItem` shape
 * every adapter emits (spec §2). No schema change, no new persisted store.
 */

/** The literal `source` every résumé-derived item carries (spec §1 rule 5). */
export const RESUME_SOURCE = 'resume';

/** The closed set of entry types v1 accepts off a résumé — the dated spine
 * (spec §0.3). Skills go to the profile by a separate path and are NOT here. */
export const RESUME_TYPES = ['role', 'project', 'education', 'win', 'milestone'] as const;
export type ResumeType = (typeof RESUME_TYPES)[number];

/**
 * One item the model emits per the closed schema (spec §5). This is the raw LLM
 * output shape — `parseResumeItems` validates it, applies the source-span
 * evidence filter, normalizes dates, and maps survivors onto `RawItem`.
 */
export interface ResumeItem {
  type: ResumeType;
  title: string;
  /** Employer / school; required for `role` & `education`. */
  org?: string;
  /** Job title, for `type: role`. */
  role?: string;
  /** Raw start date as written: `YYYY-MM-DD` | `YYYY-MM` | `YYYY`. */
  start: string;
  /** Raw end date, or `present`/`current` (⇒ omitted on the entry). */
  end?: string;
  location?: string;
  url?: string;
  /** The VERBATIM résumé span this item was lifted from — the evidence the
   * anti-hallucination filter checks against the source text (spec §1 rule 2). */
  excerpt: string;
}
