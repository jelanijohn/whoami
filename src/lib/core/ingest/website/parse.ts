/**
 * Website import — deterministic sourceId (website-import spec §5.3).
 *
 * Keyed on type + identity + date, NOT on URL — so the same role appearing on
 * both `/about` and `/resume` dedupes to one candidate, and an edited site
 * re-proposes only changed items. Mirrors `resumeSourceId`'s shape, namespaced
 * under `website:`. Passed to the shared `parseResumeItems` via its
 * `makeSourceId` opt (spec §2.3.1), so the validate/evidence/date path is reused
 * unchanged.
 */

import { slugify } from '../../ids';
import type { ResumeItem } from '../resume/types';

export function websiteSourceId(item: ResumeItem, start: string): string {
  const slug = (s: string | undefined): string => slugify(s ?? '');
  switch (item.type) {
    case 'role':
      return `website:role:${slug(item.org)}:${slug(item.role ?? item.title)}:${slug(start)}`;
    case 'project':
      return `website:project:${slug(item.title)}:${slug(start)}`;
    case 'education':
      return `website:education:${slug(item.org)}:${slug(item.title)}:${slug(start)}`;
    default: // win | milestone — both key under `win:` (spec §5.3)
      return `website:win:${slug(item.title)}:${slug(start)}`;
  }
}
