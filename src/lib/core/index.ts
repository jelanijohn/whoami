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
  Secrets,
  Llm,
  LlmCompletionRequest,
  DocExtract,
  ExtractedDoc
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
  buildIdentityProposal,
  applyIdentityMerge,
  type IdentityProposal,
  type IdentityProposalRow
} from './profile-merge';

export {
  ensureSchema,
  dropSchema,
  rebuild,
  reindexFile,
  removeByPath,
  listEntries,
  listProjects,
  getEntryById,
  findBySource,
  sourceIds,
  countsByType,
  allTags,
  tagCounts,
  getMeta,
  SCHEMA_VERSION,
  type ListFilters,
  type SortKey,
  type SortDir,
  type ProjectSummary,
  type RebuildReport
} from './index-db';

export {
  RecordStore,
  INBOX_DIR,
  provenanceKey,
  type PromoteOverrides,
  type WinProposal,
  type AcceptedWin
} from './record';

export {
  ticketOf,
  normalizedTitleKey,
  buildMergedEntry,
  mergedTitleDefault,
  mergeLedger,
  shortcutStoryTitle,
  type MergeOverrides
} from './merge';

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
export {
  isPickerKind,
  withFeedDefaults,
  buildFeed,
  effectiveLiveParams,
  aggregateRefreshReport,
  type Feed,
  type FeedKind,
  type FeedFormInput,
  type FeedRunResult,
  type RefreshReport
} from './feeds';
export * from './llm';
export * from './reduce';
export * from './wins';
export * from './triage';
