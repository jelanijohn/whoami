/**
 * Ingestion — public surface (ingest-reduce plan §1, Stage 1).
 */

export {
  asStr,
  get,
  isoDate,
  GITHUB_TOKEN_NAME,
  ASANA_TOKEN_NAME,
  GMAIL_TOKEN_NAME,
  type IngestSource,
  type RawItem,
  type IngestReport
} from './types';
export { getJson, bearer } from './http';
export {
  apiBase,
  githubSearchQuery,
  repoFromApiUrl,
  mapGithubIssue,
  fetchGithub,
  validateGithub,
  type GithubFetchOpts
} from './github';
export {
  mapAsanaTask,
  firstWorkspace,
  fetchAsana,
  validateAsana,
  type AsanaFetchOpts
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
export { rawItemToEntryInput, stageItems, selectNewItems } from './pipeline';
