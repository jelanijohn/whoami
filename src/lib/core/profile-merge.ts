/**
 * Profile merge — identity links (profile-merge spec §2). PURE.
 *
 * A producer-agnostic propose → review → merge step for adding identity links
 * (LinkedIn, GitHub, Twitter/X, Vimeo, …) to `Profile.identities`. Its first
 * producer is the website importer's `harvestIdentities`, but nothing here knows
 * about websites — it classifies a proposed `{ platform: url }` map against the
 * profile's current identities and applies only the rows the user ticked.
 *
 * Both functions are the trust boundary: they live between an automated producer
 * and the profile write path, so they re-validate URLs and never mutate input.
 * Nothing here writes the profile — the accept gate in state composes these with
 * `saveProfile` after an explicit human tick.
 */

/** One proposed identity link, classified against the current profile. */
export interface IdentityProposalRow {
  platform: string; // normalized key, e.g. 'linkedin' | 'github' | 'twitter' | 'vimeo'
  url: string; // the proposed value (validated http(s))
  status: 'new' | 'conflict' | 'present';
  existingUrl?: string; // present for 'conflict' & 'present'
}

export interface IdentityProposal {
  rows: IdentityProposalRow[];
  /** True when at least one row is actionable ('new' or 'conflict'). */
  hasActionable: boolean;
}

/** Normalize a platform key for comparison and storage: lowercase + trim. */
function normPlatform(platform: string): string {
  return platform.trim().toLowerCase();
}

/** True for an `http(s)://…` URL — the trust boundary against non-web values. */
function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Trivial URL normalization for same-value detection: trim + drop a single
 * trailing slash. Deliberately conservative — not a full canonicalization. */
function normUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

const STATUS_ORDER: Record<IdentityProposalRow['status'], number> = {
  new: 0,
  conflict: 1,
  present: 2
};

/**
 * Classify each proposed identity link against the profile's existing ones.
 *
 * - not in `existing` → `new`
 * - in `existing`, same url (trim + trailing-slash) → `present`
 * - in `existing`, different url → `conflict` (carries `existingUrl`)
 *
 * Proposed entries whose url is not `http(s)://…` are dropped. Rows are ordered
 * new → conflict → present, stable by platform name within each group.
 */
export function buildIdentityProposal(
  existing: Record<string, string> | undefined,
  proposed: Record<string, string>
): IdentityProposal {
  // Normalize the existing map's keys once so lookups match proposed keys.
  const existingByKey: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing ?? {})) existingByKey[normPlatform(k)] = v;

  const rows: IdentityProposalRow[] = [];
  for (const [rawPlatform, rawUrl] of Object.entries(proposed)) {
    const url = rawUrl.trim();
    if (!isHttpUrl(url)) continue; // trust boundary — defensive even though the producer filters
    const platform = normPlatform(rawPlatform);
    const existingUrl = existingByKey[platform];
    if (existingUrl === undefined) {
      rows.push({ platform, url, status: 'new' });
    } else if (normUrl(existingUrl) === normUrl(url)) {
      rows.push({ platform, url, status: 'present', existingUrl });
    } else {
      rows.push({ platform, url, status: 'conflict', existingUrl });
    }
  }

  rows.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.platform.localeCompare(b.platform)
  );

  return { rows, hasActionable: rows.some((r) => r.status !== 'present') };
}

/**
 * Merge the ticked rows into the existing identities. `selected` is the
 * `platform → url` map the user chose to write (new keys and the conflicts they
 * opted to replace). Returns a new map; never mutates input and never deletes a
 * key the user didn't act on.
 */
export function applyIdentityMerge(
  existing: Record<string, string> | undefined,
  selected: Record<string, string>
): Record<string, string> {
  // selected wins for conflicts the user ticked; untouched platforms preserved.
  // Keys arrive already-normalized (proposal rows / the profile form), so this is
  // a plain non-destructive overlay — never mutate input, never delete a key.
  return { ...(existing ?? {}), ...selected };
}
