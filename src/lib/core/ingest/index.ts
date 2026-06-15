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
  type IngestSource,
  type RawItem,
  type IngestReport
} from './types';
export { getJson, postJson, bearer } from './http';
export {
  apiBase,
  graphqlUrl,
  githubSearchQuery,
  mapGithubGraphqlNode,
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
  parseResumeItems,
  chunkResumeText,
  parseResume,
  type ResumeType,
  type ResumeItem,
  type ParseResumeOpts,
  type ParseResumeResult
} from './resume';
export {
  mapClaudeCodeSession,
  importClaudeCodeSessions,
  claudeCodeRootAllowed,
  CLAUDE_CODE_DEFAULT_PROJECTS
} from './claude-code';
export { rawItemToEntryInput, stageItems, selectNewItems } from './pipeline';
