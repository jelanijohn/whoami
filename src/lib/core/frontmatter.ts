/**
 * YAML frontmatter parsing & serialization.
 *
 * Hard requirement (spec §3): unknown frontmatter keys MUST be preserved on
 * read/write. We parse the whole block into a plain object, mutate only the
 * fields we understand, and re-serialize the entire object — so fields this
 * version has never heard of survive untouched.
 *
 * We pin the YAML `core` schema (YAML 1.2) so date-like scalars such as
 * `2024-03-14` parse as plain strings, never as JS `Date` objects. That keeps
 * dates byte-stable across round-trips.
 */

import { parse, stringify } from 'yaml';

export interface RawDoc {
  data: Record<string, unknown>;
  body: string;
}

const YAML_OPTS = { schema: 'core' as const };
// lineWidth: 0 disables wrapping so long URLs stay on one line.
const STRINGIFY_OPTS = { ...YAML_OPTS, lineWidth: 0 };

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split a Markdown document into its frontmatter object and body.
 * If there is no leading `---` block, returns empty data and the full text as
 * body. The body is normalized to drop the single blank line that conventionally
 * follows the closing `---`, so round-trips are stable.
 */
export function parseFrontmatter(text: string): RawDoc {
  const t = stripBom(text);
  if (!/^---\r?\n/.test(t)) {
    return { data: {}, body: t };
  }
  const lines = t.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // Opening delimiter with no close — treat as bodyless / malformed; don't
    // guess. Return the text as body so nothing is lost.
    return { data: {}, body: t };
  }
  const yamlText = lines.slice(1, end).join('\n');
  // Normalize the body the same way serialization does: drop the blank line
  // that conventionally follows the closing `---`, and the file's trailing
  // newline. This makes body values round-trip exactly (parse∘serialize = id).
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  const parsed = parse(yamlText, YAML_OPTS) as unknown;
  const data =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { data, body };
}

/**
 * Render a frontmatter object + body back into a Markdown document.
 * Produces exactly one blank line between the closing `---` and the body, and
 * a single trailing newline — matching the canonical entry format.
 */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlText = stringify(data, STRINGIFY_OPTS).replace(/\n+$/, '');
  const block = `---\n${yamlText}\n---\n`;
  const trimmedBody = body.replace(/^\n+/, '').replace(/\s+$/, '');
  return trimmedBody ? `${block}\n${trimmedBody}\n` : block;
}

/**
 * Return a new object whose keys are ordered: `preferred` keys first (in the
 * given order, when present), then all remaining keys in their existing order.
 * Used to keep entry/profile files diff-friendly without dropping extra keys.
 */
export function orderKeys(
  data: Record<string, unknown>,
  preferred: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of preferred) {
    if (key in data) out[key] = data[key];
  }
  for (const key of Object.keys(data)) {
    if (!(key in out)) out[key] = data[key];
  }
  return out;
}
