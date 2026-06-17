/**
 * Journal Views design palette (design handoff).
 *
 * Colors are expressed as `var(--jv-*)` tokens defined in `src/app.css`, so the
 * dots/pills/labels they drive flip automatically in dark mode. Alpha-composited
 * backgrounds (selected chips, table pills) use {@link alpha}, which wraps the
 * token in a `color-mix()` rather than baking a hex — keeping dark mode correct.
 */

import { ENTRY_TYPES, type EntryType } from '$lib/core';

export interface TypeMeta {
  label: string;
  /** A `var(--jv-type-*)` reference (dark-mode aware). */
  color: string;
}

/** Label + color for every canonical entry type, in `ENTRY_TYPES` order. */
export const TYPE_META: Record<EntryType, TypeMeta> = {
  journal: { label: 'Journal', color: 'var(--jv-type-journal)' },
  role: { label: 'Role', color: 'var(--jv-type-role)' },
  project: { label: 'Project', color: 'var(--jv-type-project)' },
  win: { label: 'Win', color: 'var(--jv-type-win)' },
  skill: { label: 'Skill', color: 'var(--jv-type-skill)' },
  education: { label: 'Education', color: 'var(--jv-type-education)' },
  milestone: { label: 'Milestone', color: 'var(--jv-type-milestone)' },
  mention: { label: 'Mention', color: 'var(--jv-type-mention)' }
};

/** Meta for a (possibly unknown) type string — unknown types fall back to the
 * journal gray with the raw value as the label, matching the read-tolerant
 * spirit of {@link EntryFrontmatter}. */
export function typeMeta(type: string): TypeMeta {
  return (TYPE_META as Record<string, TypeMeta>)[type] ?? { label: type, color: 'var(--jv-type-journal)' };
}

/** Canonical order index for a type (for sorting Type groups). Unknown ⇒ end. */
export function typeOrder(type: string): number {
  const i = (ENTRY_TYPES as readonly string[]).indexOf(type);
  return i === -1 ? ENTRY_TYPES.length : i;
}

/** Six rotating project-section colors; index by project order. */
export const PROJECT_COLORS = [
  'var(--jv-proj-0)',
  'var(--jv-proj-1)',
  'var(--jv-proj-2)',
  'var(--jv-proj-3)',
  'var(--jv-proj-4)',
  'var(--jv-proj-5)'
];

/** Color for the project at `index` in the project list (wraps the palette). */
export function projectColor(index: number): string {
  return PROJECT_COLORS[index % PROJECT_COLORS.length];
}

/** The gray used for the "Unaffiliated" project group. */
export const UNAFFILIATED_COLOR = 'var(--jv-proj-none)';

/** A `color-mix()` that fades a token color to `pct`% opacity over transparent —
 * the dark-mode-safe replacement for the prototype's `{hex}1f` style alpha. */
export function alpha(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}
