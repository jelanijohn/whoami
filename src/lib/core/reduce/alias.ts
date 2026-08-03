/**
 * Evidence aliasing — short prompt-local ids the model cites instead of ULIDs.
 *
 * A quoted 26-char ULID costs ~15 output tokens; `"E12"` costs ~2. Making the
 * model cite aliases keeps a large project's retrospective JSON well under the
 * output cap (the §3.4 truncation failure), and short indices are copied
 * verbatim far more reliably than base32 strings.
 *
 * THE INVARIANT: aliases exist only between prompt assembly and reply parsing.
 * Everything upstream (entries, map outputs) and downstream (filters, render,
 * the record) speaks real ULIDs. Expansion is deliberately a pass-through for
 * unknown strings — the trust-nothing evidence filters (`filterByEvidence`,
 * `filterWinsByEvidence`) remain the single place unverifiable citations die,
 * so a hallucinated "E999" or stray non-alias gets exactly the treatment a
 * hallucinated ULID always got. A real input id can never collide with an
 * alias (ULIDs are 26 chars; aliases match /^E\d+$/).
 */

import { RETRO_KEYS, type Fact, type Retrospective } from './schema';

export interface AliasTable {
  /** real entry id → alias (`E1`..`En`, input order). */
  forward: ReadonlyMap<string, string>;
  /** alias → real entry id. */
  reverse: ReadonlyMap<string, string>;
}

/** Number the ids `E1`..`En` in input order. A duplicate id keeps its first
 * alias, so `reverse` stays a bijection onto the distinct ids. */
export function buildAliasTable(ids: readonly string[]): AliasTable {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  for (const id of ids) {
    if (forward.has(id)) continue;
    const alias = `E${forward.size + 1}`;
    forward.set(id, alias);
    reverse.set(alias, id);
  }
  return { forward, reverse };
}

/** Map alias evidence back to real ids; unknown strings pass through unchanged
 * (the evidence filters drop whatever doesn't resolve to an input entry). */
export function expandIds(evidence: readonly string[], table: AliasTable): string[] {
  return evidence.map((id) => table.reverse.get(id) ?? id);
}

/** Apply `fn` to every fact's evidence, returning a new retrospective. */
function mapEvidence(retro: Retrospective, fn: (evidence: string[]) => string[]): Retrospective {
  const out = {} as Retrospective;
  for (const key of RETRO_KEYS) {
    out[key] = retro[key].map((f): Fact => ({ ...f, evidence: fn(f.evidence) }));
  }
  return out;
}

/** Expand every fact's alias evidence back to real ids (new object). */
export function expandRetro(retro: Retrospective, table: AliasTable): Retrospective {
  return mapEvidence(retro, (evidence) => expandIds(evidence, table));
}

/** Alias every fact's real-id evidence for embedding in a prompt (new object);
 * ids without an alias pass through unchanged. */
export function aliasRetro(retro: Retrospective, table: AliasTable): Retrospective {
  return mapEvidence(retro, (evidence) => evidence.map((id) => table.forward.get(id) ?? id));
}
