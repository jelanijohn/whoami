/**
 * Ingestion — public surface (ingest-reduce plan §1, Stage 1).
 */

export {
  asStr,
  asNum,
  get,
  isoDate,
  GITHUB_TOKEN_NAME,
  ASANA_TOKEN_NAME,
  GMAIL_TOKEN_NAME,
  SHORTCUT_TOKEN_NAME,
  type IngestSource,
  type RawItem,
  type IngestReport
} from './types';
export { getJson, postJson, getText, bearer, type FetchedText } from './http';
export {
  apiBase,
  graphqlUrl,
  githubSearchQuery,
  mapGithubGraphqlNode,
  mapGithubCommitNode,
  commitsQuery,
  fetchGithub,
  validateGithub,
  type GithubFetchOpts
} from './github';
export {
  AsanaPaymentRequiredError,
  mapAsanaTask,
  taskInvolvesMe,
  resolveMe,
  firstWorkspace,
  searchTasksForMe,
  listProjectTasksForMe,
  listAsanaProjects,
  fetchAsana,
  validateAsana,
  type AsanaFetchOpts,
  type AsanaProject
} from './asana';
export {
  DEFAULT_SHORTCUT_REF,
  extractShortcutRefs,
  mapShortcutStory,
  fetchShortcutResolutionMaps,
  fetchShortcutStories,
  shortcutEnrichment,
  stripShortcutBlock,
  enrichRawItemsWithShortcut,
  validateShortcut,
  type ShortcutStory,
  type ShortcutResolve
} from './shortcut';
export {
  internalDateToIso,
  header,
  mapGmailMessage,
  fetchGmail,
  validateGmail,
  type GmailFetchOpts
} from './gmail';
export {
  parseCsv,
  csvToRecords,
  liDate,
  mapLinkedinPositions,
  mapLinkedinProjects,
  mapLinkedinEducation,
  importLinkedinArchive
} from './linkedin';
export {
  RESUME_SOURCE,
  RESUME_TYPES,
  RESUME_TOKEN_BUDGET,
  buildResumePrompt,
  EXTRACTION_SCHEMA_NOTE,
  parseResumeItems,
  chunkResumeText,
  parseResume,
  type ResumeType,
  type ResumeItem,
  type ExtractParseOpts,
  type ParseResumeOpts,
  type ParseResumeResult
} from './resume';
export {
  WEBSITE_SOURCE,
  WEBSITE_MAX_PAGES,
  WEBSITE_MIN_TEXT,
  resolvePages,
  extractPage,
  harvestIdentities,
  acquireWebsite,
  websiteSourceId,
  buildWebsitePrompt,
  parseWebsite,
  type PageStructured,
  type ExtractedPage,
  type FetchedPage,
  type ResolveInput,
  type WebsiteFetchOpts,
  type AcquireResult,
  type ParseWebsiteResult
} from './website';
export {
  mapClaudeCodeSession,
  importClaudeCodeSessions,
  claudeCodeRootAllowed,
  claudeCodeProjectName,
  CLAUDE_CODE_DEFAULT_PROJECTS
} from './claude-code';
export {
  parseWarpQueryInput,
  mapWarpConversation,
  importWarpConversations,
  warpProjectName,
  type WarpQueryRow,
  type WarpConversationMeta,
  type WarpTurn
} from './warp';
export {
  NEUROSKILL_SOURCE,
  NEUROSKILL_GAP_SECONDS,
  NEUROSKILL_PEAK_WINDOW_EPOCHS,
  NEUROSKILL_METRIC_KEYS,
  defaultDateParts,
  segmentSessions,
  mapNeuroskillSession,
  importNeuroskillSessions,
  type NeuroskillEpochRow,
  type NeuroskillLabelRow,
  type NeuroskillSession,
  type DateParts
} from './neuroskill';
export { rawItemToEntryInput, stageItems, selectNewItems } from './pipeline';
