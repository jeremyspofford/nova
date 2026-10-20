// M6 spaces module: Spaces and Pages (FR-036), Sites (FR-037), visualizations (FR-076); M8 adds
// remote hosting targets for sites.
export {
  SpaceService,
  USER as SPACE_USER,
  slugify,
  type Author as SpaceAuthor,
} from './service.ts';
export type {
  CreateSpaceInput,
  ProposeInput,
  SavePageInput,
  SpaceServiceOptions,
} from './service.ts';
export { anchorForQuote, blocksOf, checkAnchor, reanchor } from './anchors.ts';
export { markdownToHtml, safeUrl, type MarkdownOptions } from './markdown.ts';
export { DATA_LIMITS, dataFormatOf, parseCsv, parseData, type DataRow } from './data.ts';
export { renderArtifactSite, renderSpaceSite, vizFence, type RenderedSite } from './site-render.ts';
export { SITE_MARKER, SiteService } from './sites.ts';
export type { PublishOutcome, SiteInput, SiteServiceOptions } from './sites.ts';
// M8: hosting targets (the Hub's folder and WebDAV) and their egress check.
export {
  HubFolderTarget,
  SiteTargetService,
  egressFetch,
  hostingEgress,
  hostingEgressProblem,
  hostingUrl,
} from './hosting.ts';
export type {
  CreateHostingTargetInput,
  HostedFile,
  HostingEgress,
  HostingTarget,
  SiteTargetServiceOptions,
  UpdateHostingTargetInput,
} from './hosting.ts';
export { WebDavTarget, contentTypeOf, type WebDavTargetOptions } from './webdav.ts';
export {
  applyEdits,
  createVisualization,
  pageCommentTool,
  pageEditTool,
  pageReadTool,
  spacesToolSource,
  visualizationDoc,
  visualizeTool,
  type VisualizationInput,
} from './tools.ts';
