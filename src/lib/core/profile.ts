/**
 * The singleton profile (spec §4): `profile.md`.
 *
 * Structured identity in YAML frontmatter, narrative bio in the Markdown body.
 * Like entries, unknown keys round-trip untouched. The profile is
 * presentation-layer, not the raw record.
 */

import type { Profile, ProfileFrontmatter } from './types';
import { orderKeys, parseFrontmatter, serializeFrontmatter } from './frontmatter';

const PROFILE_KEY_ORDER = ['name', 'headline', 'identities', 'location'] as const;

/** The record-relative path of the profile file. */
export const PROFILE_PATH = 'profile.md';

export function parseProfile(text: string): Profile {
  const { data, body } = parseFrontmatter(text);
  return { frontmatter: data as ProfileFrontmatter, body };
}

export function serializeProfile(profile: Profile): string {
  return serializeFrontmatter(
    orderKeys(profile.frontmatter as Record<string, unknown>, PROFILE_KEY_ORDER),
    profile.body
  );
}

/** A sensible empty profile for first-run scaffolding. */
export function emptyProfile(): Profile {
  return {
    frontmatter: { name: '', headline: '', identities: {}, location: '' },
    body: ''
  };
}
