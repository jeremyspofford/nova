// M8 marketplace (FR-049; docs/14 §5, docs/08 §7; ADR-097 D2): catalog sources with signed
// indexes, item checks, install, update with a permission diff, rollback, removal and local
// ratings. packages/core/src/index.ts re-exports it.

/**
 * The public key of the built-in sample catalog (`examples/catalog`, base64url Ed25519). It is a
 * test publisher key: its private half lives only in packages/core/test/fixtures/market, so it is
 * pinned for the built-in catalog alone and never added to the trusted publishers.
 */
export const SAMPLE_CATALOG_PUBLIC_KEY = 'KlKjf0jPaUSFthkQWHASvMCUmtOx5U9Ff1Hm6ju42Ds';
export const SAMPLE_CATALOG_ID = 'nova-sample';

export {
  artifactFormat,
  compareVersions as compareMarketVersions,
  expectedChecksum,
  marketIndexSchema,
  parseMarketIndex,
  pickMarketEntry,
  type ArtifactFormat,
  type MarketIndex,
  type MarketIndexEntry,
} from './catalog-index.ts';
export {
  PET_STATES,
  PetMarketInstaller,
  PluginMarketInstaller,
  extensionLines,
  pluginLines,
  readPetFolder,
  SkillMarketInstaller,
  ThemeMarketInstaller,
  type ExtensionInstaller,
  type MarketInspection,
  type MarketInstalledState,
  type MarketInstaller,
  type MarketInstallRequest,
  type PluginInstallerOptions,
  type StagedArtifact,
  type ThemeStore,
} from './installers.ts';
export { readArchive, writeArchive } from './archive.ts';
export {
  diffNeedsAcceptance,
  mcpPermissionLines,
  permissionDiff,
  pluginPermissionLines,
  skillPermissionLines,
  type PluginPermissionInput,
} from './permissions.ts';
export {
  Marketplace,
  MARKET_PREVIEW_TTL_MS,
  OPEN_MARKET_POLICY,
  type MarketInstallRequestBody,
  type MarketPolicy,
  type MarketplaceOptions,
  type MarketPreviewRequest,
  type MarketRatingRequest,
  type MarketSearchRequest,
} from './service.ts';
export {
  CATALOG_SIGNATURE_SUFFIX,
  folderDigest,
  publisherKeySchema,
  publisherView,
  signCatalogIndex,
  verifyCatalogIndex,
  type CatalogSignatureCheck,
  type CatalogSignatureFile,
  type TrustedPublisherKey,
} from './signing.ts';
export {
  MarketSources,
  marketCatalogKind,
  signatureUrl,
  type CatalogRead,
  type FetchedArtifact,
  type MarketCatalogConfig,
} from './sources.ts';
