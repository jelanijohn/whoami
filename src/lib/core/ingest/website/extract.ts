/**
 * Website import — HTML → content extraction (website-import spec §3.3). PURE.
 *
 * Implemented with `htmlparser2`'s streaming parser (spec D1): it runs
 * identically in the Tauri webview and under vitest, so this stays a pure,
 * fixture-tested core function — never the webview's `DOMParser`/native `fetch`.
 *
 * It strips boilerplate (script/style/nav/header/footer/aside, and comments —
 * which the parser delivers separately from text, so they are excluded for
 * free), prefers `<main>`/`<article>`/`[role=main]` content over the whole body,
 * collapses whitespace while preserving paragraph breaks for the chunker, and
 * records JSON-LD / Open Graph / meta plus the document's outbound links — the
 * latter as DATA only, never followed (spec §0.2, §0.4).
 */

import { Parser } from 'htmlparser2';
import type { ExtractedPage, PageStructured } from './types';

/** Boilerplate containers whose text is dropped wholesale (spec §3.3). */
const SKIP_TAGS = new Set(['nav', 'header', 'footer', 'aside']);

/** Containers that mark the page's primary content (spec §3.3). `[role=main]`
 * on any element counts too. */
const MAIN_TAGS = new Set(['main', 'article']);

/** Block-level elements: a paragraph break is emitted at their open and close
 * so the cleaned text keeps `\n\n` boundaries for `chunkResumeText`. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr',
  'table', 'tr', 'td', 'th', 'thead', 'tbody', 'blockquote', 'pre',
  'figure', 'figcaption', 'dl', 'dt', 'dd', 'address'
]);

/** What an open element contributes to the nesting counters — reversed exactly
 * on its close, so depths stay balanced regardless of nesting or implied closes. */
interface Frame {
  skip: boolean;
  main: boolean;
  title: boolean;
  ld: boolean;
}

/** Collapse whitespace but keep paragraph breaks (spec §3.3): inline runs → one
 * space, spaces around newlines trimmed, blank-line runs capped at one. */
function normalizeText(s: string): string {
  return s
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}

/** Set a key only if unset — deterministic first-occurrence-wins (spec §3.3). */
function setOnce(obj: Record<string, string>, key: string, value: string): void {
  if (key && value != null && !(key in obj)) obj[key] = value;
}

/**
 * Extract cleaned content + structured signals from one page's HTML.
 * `pageUrl` is the base for resolving relative `<a href>`s to absolute.
 */
export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const jsonLd: unknown[] = [];
  const openGraph: Record<string, string> = {};
  const meta: Record<string, string> = {};
  let titleBuf = '';

  const bodyParts: string[] = [];
  const mainParts: string[] = [];
  const links: string[] = [];
  const seenLinks = new Set<string>();

  const stack: Frame[] = [];
  let skipDepth = 0; // inside nav/header/footer/aside/style/non-ld script
  let mainDepth = 0; // inside main/article/[role=main]
  let titleDepth = 0;
  let ldDepth = 0; // inside an application/ld+json script
  let ldBuffer = '';

  /** Append text to the body buffer (and the main buffer when inside a main
   * region), so we can prefer main content at the end. */
  const emit = (text: string): void => {
    bodyParts.push(text);
    if (mainDepth > 0) mainParts.push(text);
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const lower = name.toLowerCase();
        const role = (attribs.role ?? '').toLowerCase();
        const type = (attribs.type ?? '').toLowerCase();
        const isScript = lower === 'script';
        const isLdJson = isScript && type === 'application/ld+json';

        if (BLOCK_TAGS.has(lower)) emit('\n');

        const frame: Frame = {
          skip: SKIP_TAGS.has(lower) || lower === 'style' || (isScript && !isLdJson),
          main: MAIN_TAGS.has(lower) || role === 'main',
          title: lower === 'title',
          ld: isLdJson
        };
        stack.push(frame);
        if (frame.skip) skipDepth++;
        if (frame.main) mainDepth++;
        if (frame.title) titleDepth++;
        if (frame.ld) {
          ldDepth++;
          ldBuffer = '';
        }

        if (lower === 'meta' && attribs.content != null) {
          const prop = (attribs.property ?? '').toLowerCase();
          const nm = (attribs.name ?? '').toLowerCase();
          if (prop.startsWith('og:')) setOnce(openGraph, prop.slice(3), attribs.content);
          else if (nm.startsWith('og:')) setOnce(openGraph, nm.slice(3), attribs.content);
          else if (nm) setOnce(meta, nm, attribs.content);
        }

        if (lower === 'a' && attribs.href) {
          let abs: URL | null = null;
          try {
            abs = new URL(attribs.href, pageUrl);
          } catch {
            abs = null;
          }
          if (abs && (abs.protocol === 'http:' || abs.protocol === 'https:')) {
            if (!seenLinks.has(abs.href)) {
              seenLinks.add(abs.href);
              links.push(abs.href);
            }
          }
        }
      },
      ontext(text) {
        if (titleDepth > 0) {
          titleBuf += text;
          return;
        }
        if (ldDepth > 0) {
          ldBuffer += text;
          return;
        }
        if (skipDepth > 0) return;
        emit(text);
      },
      onclosetag(name) {
        const lower = name.toLowerCase();
        const frame = stack.pop();
        if (frame) {
          if (frame.skip && skipDepth > 0) skipDepth--;
          if (frame.main && mainDepth > 0) mainDepth--;
          if (frame.title && titleDepth > 0) titleDepth--;
          if (frame.ld) {
            if (ldDepth > 0) ldDepth--;
            try {
              jsonLd.push(JSON.parse(ldBuffer.trim()) as unknown);
            } catch {
              /* malformed JSON-LD is ignored — it is advisory structured data */
            }
            ldBuffer = '';
          }
        }
        if (BLOCK_TAGS.has(lower)) emit('\n');
      }
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();

  const mainText = normalizeText(mainParts.join('')) || normalizeText(bodyParts.join(''));
  const title = titleBuf.trim().replace(/\s+/g, ' ') || openGraph.title;
  const structured: PageStructured = { jsonLd, openGraph, meta, title };

  const page: ExtractedPage = { mainText, structured, outboundLinks: links };
  if (title) page.title = title;
  return page;
}
