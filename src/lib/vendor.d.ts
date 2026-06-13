/**
 * Ambient declarations for the binary document parsers used behind the
 * {@link DocExtract} seam (résumé import spec §3). `mammoth` ships no types of
 * its own; `pdf-parse` and `pdfjs-dist` do. The `vite/client` reference brings
 * in the `?url` virtual-module typing the Tauri PDF worker import relies on.
 */

/// <reference types="vite/client" />

declare module 'mammoth' {
  export interface MammothResult {
    value: string;
    messages: unknown[];
  }
  export type MammothInput =
    | { path: string }
    | { buffer: Buffer }
    | { arrayBuffer: ArrayBuffer };
  /** Extract the document's plain text (no styling). */
  export function extractRawText(input: MammothInput): Promise<MammothResult>;
  const mammoth: { extractRawText: typeof extractRawText };
  export default mammoth;
}

/** The self-contained browser bundle (no Node built-ins) — used in the webview. */
declare module 'mammoth/mammoth.browser.js' {
  export * from 'mammoth';
  export { default } from 'mammoth';
}
