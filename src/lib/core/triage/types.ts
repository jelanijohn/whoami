/**
 * Inbox triage — shared types (triage spec §2, §4.1).
 *
 * Triage attaches an advisory `keep | frivolous` signal to each candidate so
 * the inbox can surface real work first. It is a sort/annotate step, never a
 * delete step (spec §0 hard rule 1): promote and reject stay the human gates.
 *
 * The signal rides the candidate's existing `[key: string]: unknown`
 * frontmatter pass-through — NO schema change, NO migration (spec §2). It lives
 * only on candidate files in the gitignored `.inbox/` and is stripped on
 * promote, so it never reaches `entries/*.md` or the index (spec §5 rule 5).
 */

/** Prefilter/LLM output: a verdict, where `unsure` routes to the optional LLM. */
export type TriageVerdict = 'keep' | 'frivolous' | 'unsure';

/** What actually persists onto a candidate (never `unsure`). */
export type TriageSignal = 'keep' | 'frivolous';

/** The annotation persisted onto a candidate's frontmatter. */
export interface TriageResult {
  signal: TriageSignal;
  /** Short, human-readable ("automated notification email"). */
  reason: string;
  /** Which stage decided. */
  source: 'prefilter' | 'llm';
  /** `provider:model` when `source === 'llm'`. */
  model?: string;
  /** ISO timestamp of the decision. */
  at: string;
}

/** The five frontmatter keys a {@link TriageResult} flattens onto. Promote
 * strips exactly these (record.ts), so triage never enters the record. */
export const TRIAGE_KEYS = [
  'triage_signal',
  'triage_reason',
  'triage_source',
  'triage_model',
  'triage_at'
] as const;

/**
 * Owner-editable criteria for the deterministic prefilter (spec §4.1).
 * "Frivolous" is subjective, so the patterns are overridable. Pattern lists are
 * regex *sources*, matched case-insensitively. Overrides persist in
 * `importSettings` (localStorage) — NEVER the record repo (spec §5 rule 5).
 */
export interface TriageRubric {
  /** Gmail `from` patterns marking mail frivolous: automated senders + bulk
   * domains (`no-reply`, `newsletter`, `mailchimp`, …). */
  gmailFrivolousFrom: string[];
  /** Gmail subject patterns marking mail frivolous (`unsubscribe`, receipts…). */
  gmailFrivolousSubject: string[];
  /** The owner's own addresses (substring match on `from`). Self-authored mail
   * is high signal → `keep` (the `in:sent` Bloomberg-gap workhorse, spec §4). */
  ownerEmails?: string[];
  /** GitHub title patterns for trivial changes → frivolous (`^bump `, `^chore`…). */
  githubTrivial: string[];
  /** Asana title patterns for boilerplate tasks → frivolous (`standup`, `1:1`…). */
  asanaBoilerplate: string[];
  /** Natural-language definition of "frivolous", fed to the optional LLM pass's
   * SYSTEM prompt (the owner's notion drives the call, spec §5). */
  frivolousCriteria: string;
  /** NeuroSkill: minimum session length (minutes) to count as `keep`; shorter →
   *  `frivolous` (calibration blips). Owner-editable; persists in importSettings
   *  (never the record repo). */
  neuroskillMinMinutes: number;
}

/** Shipped defaults (spec §4 pattern lists). The owner can override any field
 * via `importSettings`; absent overrides fall back here. */
export const DEFAULT_RUBRIC: TriageRubric = {
  gmailFrivolousFrom: [
    'no-?reply',
    'do-?not-reply',
    'notifications?@',
    'mailer-daemon',
    'postmaster',
    'bounce',
    'newsletter',
    'updates@',
    // Bulk-sender domains.
    'mailchimp',
    'sendgrid',
    'substack',
    'sparkpostmail',
    'mandrillapp'
  ],
  gmailFrivolousSubject: [
    'unsubscribe',
    'your receipt',
    'order confirmation',
    'verify your email',
    'password reset',
    // Promotional "[…]" subject prefix.
    '^\\s*\\[[^\\]]+\\]'
  ],
  githubTrivial: [
    '^bump ',
    'bump .* from .* to ',
    '^chore',
    '^(deps|deps-dev):',
    'lockfile',
    '^update (readme|changelog|version)',
    '^fix typo',
    '^typo',
    '^wip\\b',
    '^merge branch',
    // Branch-promotion merges — environment plumbing, not work. Validated
    // against rejected items, which take every shape: either direction, with or
    // without the literal "merge" word, and a "from" phrasing —
    //   "dev > prod merge - …", "prod < dev merge", "merge main > staging",
    //   "dev > prod - landing page", "Update prod from dev".
    // Both sides must be an environment word, so real titles ("main > index
    // refactor") are untouched.
    '\\w+\\s*>\\s*\\w+ merge\\b',
    '\\b(dev|develop|development|stage|staging|main|master|prod|production|release|launch|qa|uat)\\s*[<>]\\s*(dev|develop|development|stage|staging|main|master|prod|production|release|launch|qa|uat)\\b',
    '\\b(prod|production|staging|stage|main|master)\\s+from\\s+(dev|develop|development|staging|stage)\\b',
    // "[do not merge]" / "do-not-merge" — explicitly not meant to land.
    'do[\\s_-]?not[\\s_-]?merge',
    '^\\[skip ci\\]'
  ],
  asanaBoilerplate: ['standup', 'timesheet', 'weekly sync', '1:1', 'submit hours', 'fill out '],
  frivolousCriteria:
    'An item is "frivolous" if it is low-signal noise with no lasting value for a ' +
    'professional historical record: automated notifications, newsletters, receipts, ' +
    'dependency version bumps, lockfile updates, and routine recurring chores ' +
    '(standups, timesheets, status pings). An item is worth keeping ("keep") if it ' +
    'reflects real work, a decision, a shipped change, a substantive conversation, or ' +
    'anything a person would want to remember about their career. When genuinely ' +
    'ambiguous, prefer keep — a wrongly-kept item costs one manual reject, a wrongly-' +
    'discarded one buries a real memory.',
  neuroskillMinMinutes: 5
};
