/**
 * Website import — public surface (website-import spec §7.4).
 *
 * Stage 1 (acquisition) is deterministic, LLM-free, and pure where possible;
 * Stage 2 (`parseWebsite`) is the single LLM pass, run in the action layer
 * before `stageItems`. The identity harvest is built and exported but wired to
 * no UI in v1 (spec §4 / D5).
 */

export {
  WEBSITE_SOURCE,
  WEBSITE_MAX_PAGES,
  WEBSITE_MIN_TEXT,
  type PageStructured,
  type ExtractedPage,
  type FetchedPage
} from './types';
export { resolvePages, type ResolveInput } from './resolve';
export { extractPage } from './extract';
export { harvestIdentities } from './identities';
export { acquireWebsite, type WebsiteFetchOpts, type AcquireResult } from './acquire';
export { websiteSourceId } from './parse';
export { buildWebsitePrompt } from './prompts';
export { parseWebsite, type ParseWebsiteResult } from './pipeline';
