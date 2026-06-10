/**
 * Who Am I — core public API.
 *
 * Framework-agnostic. Import this from the Tauri frontend (wiring in
 * Tauri-backed Platform implementations) or from the test/CLI harness (node
 * implementations). The core never imports Tauri or the browser.
 */

export type {
  Entry,
  EntryFrontmatter,
  EntryType,
  Profile,
  ProfileFrontmatter,
  Platform,
  FileSystem,
  Database,
  GitRunner,
  GitResult,
  Row,
  Http,
  HttpRequest,
  HttpResponse,
  Secrets
} from './types';
export { ENTRY_TYPES } from './types';

export { newId, id6, slugify, entryFilename, entryRelPath, isUlid } from './ids';
export {
  parseFrontmatter,
  serializeFrontmatter,
  orderKeys,
  type RawDoc
} from './frontmatter';
export {
  parseEntry,
  serializeEntry,
  makeEntry,
  touchEntry,
  expectedPath,
  entryErrors,
  entryIsValid,
  nowIso,
  type NewEntryInput
} from './entry';
export {
  parseProfile,
  serializeProfile,
  emptyProfile,
  PROFILE_PATH
} from './profile';

export {
  ensureSchema,
  dropSchema,
  rebuild,
  reindexFile,
  removeByPath,
  listEntries,
  getEntryById,
  findBySource,
  sourceIds,
  countsByType,
  allTags,
  getMeta,
  SCHEMA_VERSION,
  type ListFilters,
  type RebuildReport
} from './index-db';

export { RecordStore, INBOX_DIR, provenanceKey } from './record';

export {
  status as gitStatus,
  sync as gitSync,
  init as gitInit,
  type GitStatus,
  type SyncResult,
  type SyncStep,
  type SyncOptions
} from './git';

export { generateResumeMarkdown, type ResumeInput, type ResumeOptions } from './generators/resume';
export { generateSiteHtml, type SiteInput } from './generators/site';

export * from './ingest';
