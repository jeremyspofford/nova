// M8 data controls (FR-105, FR-121; ADR-097 D5): export, delete-all and import of the whole Hub,
// retention, crash reports and the `nova data` subcommand. Spend caps (FR-116) live in ../profile.
// packages/core/src/index.ts re-exports this module.
export { DataControls, type DataControlsOptions } from './service.ts';
export {
  HUB_KEY_DEPENDENTS,
  HUB_KEY_TABLES,
  HUB_SECRET_PREFIXES,
  exportArchive,
  hubMadeSecret,
  snapshotDatabase,
  whenIdle,
  workDir as dataWorkDir,
  type ExportOptions,
} from './exporter.ts';
export {
  IMPORT_LIMITS,
  applyStaged,
  checkView,
  hubEmptiness,
  stageArchive,
  type ApplyOptions,
  type ApplyResult,
  type StageOptions,
  type StagedArchive,
} from './importer.ts';
export { wipeHub, type WipeOptions, type WipeResult } from './wipe.ts';
export {
  DERIVED_TABLES,
  dataTables,
  decodeCell,
  encodeCell,
  storedTables,
  tableLines,
  type TableInfo,
} from './codec.ts';
export {
  EXPORT_ROOTS,
  KEEP_ENTRIES,
  WIPE_ROOTS,
  listDataFiles,
  sealLabels,
  type DataFile,
} from './files.ts';
export {
  DEFAULT_SCRYPT,
  SEALED_MAGIC,
  createSealer,
  isSealedFile,
  unsealFile,
  type ScryptParams,
  type Sealer,
} from './seal.ts';
export { ZipWriter, listZip, readZipEntry, type ZipEntry, type ZipReadLimits } from './zip.ts';
export { auditAnchor, pruneAuditBefore, verifyAuditChain, type AuditAnchor } from './anchor.ts';
export {
  RetentionService,
  SWEEP_INTERVAL_MS,
  TRACE_TABLES,
  type RetentionServiceOptions,
} from './retention.ts';
export {
  CrashReports,
  buildCrashReport,
  crashDir,
  installCrashReporting,
  writeCrashDump,
  type CrashReportInput,
  type CrashReportsOptions,
  type CrashSource,
} from './crash.ts';
export { DATA_CLI_USAGE, runDataCommand, type DataCliIo } from './cli.ts';
