// M4 profile (FR-113), usage insights (FR-114) and import from other assistants (FR-200).
// Active provider accounts (FR-115) live in the provider registry (../registry.ts).
export {
  AVATAR_MAX_BYTES,
  AVATAR_MIMES,
  prepareAvatar,
  sniffImage,
  stripJpeg,
  stripMetadata,
  stripPng,
  stripWebp,
  type AvatarMime,
} from './avatar.ts';
export {
  ProfileService,
  type AvatarImage,
  type ProfileServiceOptions,
  type UpdateProfileRequest,
} from './account.ts';
export { UsageService, type UsageRange, type UsageServiceOptions } from './usage.ts';
// M8 spend caps and provider limits (FR-116, FR-115; ADR-097).
export {
  SpendCaps,
  capReachedError,
  spendCapHref,
  spendPeriod,
  withSpendCaps,
  type SpendCapsOptions,
  type SpendReservation,
  type SpendVerdict,
} from './spend.ts';
export { ImportService, type ImportServiceOptions, type ImportTargets } from './import/service.ts';
export {
  SCAN_LIMITS as IMPORT_SCAN_LIMITS,
  scanPaths as scanImportPaths,
  type ScannedItem as ImportScannedItem,
} from './import/scan.ts';
export {
  findMcpServers as findImportMcpServers,
  planMcpServer as planImportMcpServer,
  readChats as readChatExport,
  type ChatExport,
  type McpServerPlan as ImportMcpServerPlan,
} from './import/formats.ts';
export { isSecret as isImportSecret, maskSecret as maskImportSecret } from './import/secrets.ts';
// M8: hooks of other plugin layouts converted on import (FR-200).
export { commandArgv, convertForeignHooks, type ConvertedHooks } from './import/hooks.ts';
