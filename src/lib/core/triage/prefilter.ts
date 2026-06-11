/**
 * The always-on deterministic prefilter (triage spec §4).
 *
 * Pure, local, free — runs on every import with no configuration and no network
 * (spec §0 decision 1). Reads `RawItem.title`, `RawItem.source`, and the adapter
 * `meta` map (`from` for Gmail; `state` for GitHub; `status` for Asana). Returns
 * one of three verdicts; only `keep`/`frivolous` are confident. **When in doubt,
 * return `unsure`, not `frivolous`** — a false `keep` costs one manual reject, a
 * false `frivolous` risks burying a real memory (spec §4).
 */

import type { RawItem } from '../ingest/types';
import type { TriageRubric, TriageVerdict } from './types';

export interface PrefilterOutcome {
  verdict: TriageVerdict;
  reason: string;
}

/** Compile a regex source case-insensitively; an invalid pattern never throws,
 * it just doesn't match (a bad rubric override must not abort an import). */
function matches(text: string, patterns: string[]): boolean {
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) return true;
    } catch {
      /* skip an unparseable override pattern */
    }
  }
  return false;
}

const keep = (reason: string): PrefilterOutcome => ({ verdict: 'keep', reason });
const frivolous = (reason: string): PrefilterOutcome => ({ verdict: 'frivolous', reason });
const unsure = (): PrefilterOutcome => ({ verdict: 'unsure', reason: 'no deterministic signal' });

/** Gmail — the noisiest source (spec §4). Owner-authored mail is checked first
 * so a self-sent message can never be buried by a frivolous subject line. */
function prefilterGmail(item: RawItem, rubric: TriageRubric): PrefilterOutcome {
  const from = (item.meta?.from ?? '').toLowerCase();
  const subject = item.title ?? '';
  if (rubric.ownerEmails?.some((e) => e.trim() && from.includes(e.trim().toLowerCase()))) {
    return keep('self-authored email');
  }
  if (matches(from, rubric.gmailFrivolousFrom)) return frivolous('automated or bulk sender');
  if (matches(subject, rubric.gmailFrivolousSubject)) return frivolous('boilerplate subject line');
  return unsure();
}

/** GitHub — items are self-authored (`author:user`). A trivial title wins even
 * over a merged state (spec §4). */
function prefilterGithub(item: RawItem, rubric: TriageRubric): PrefilterOutcome {
  if (matches(item.title ?? '', rubric.githubTrivial)) return frivolous('trivial change');
  if (item.meta?.state === 'merged') return keep('shipped (merged)');
  return unsure();
}

/** Asana — a boilerplate title wins over a completed status (spec §4). */
function prefilterAsana(item: RawItem, rubric: TriageRubric): PrefilterOutcome {
  if (matches(item.title ?? '', rubric.asanaBoilerplate)) return frivolous('routine/boilerplate task');
  if (item.meta?.status === 'completed') return keep('completed task');
  return unsure();
}

/**
 * Classify one item deterministically. LinkedIn archive rows are roles /
 * projects / education — inherently record-grade, so they are always `keep` and
 * never sent to the LLM (spec §4). An unknown source defaults to `unsure`.
 */
export function prefilterItem(item: RawItem, rubric: TriageRubric): PrefilterOutcome {
  switch (String(item.source)) {
    case 'gmail':
      return prefilterGmail(item, rubric);
    case 'github':
      return prefilterGithub(item, rubric);
    case 'asana':
      return prefilterAsana(item, rubric);
    case 'linkedin':
      return keep('profile/archive record');
    default:
      return unsure();
  }
}
