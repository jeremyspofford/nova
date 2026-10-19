// M7 sync (FR-109, FR-112, FR-129; docs/13 §2, ADR-010, ADR-036, ADR-095 decisions 1-2): hybrid
// logical clocks, the change feed and per-field merge with its merge log, the readers and writers
// of each synced kind, and the idempotency store for queued writes. packages/core/src/index.ts
// re-exports it.
export {
  HLC_MAX_COUNTER,
  HybridClock,
  compareHlc,
  formatHlc,
  hlcProblem,
  maxHlc,
  parseHlc,
  type Hlc,
  type HybridClockOptions,
} from './hlc.ts';
export {
  SYNC_FIELD_SCHEMAS,
  knownField,
  messagesChangedAfter,
  syncReaders,
  syncableSetting,
  writableFields,
  type SyncEntity,
  type SyncReader,
} from './entities.ts';
export {
  serviceWriters,
  type SyncWriteContext,
  type SyncWriter,
  type SyncWriterServices,
  type SyncWriters,
} from './writers.ts';
export {
  SYNC_MAX_SKEW_S,
  SYNC_SWEEP_INTERVAL_MS,
  SyncService,
  type SyncActor,
  type SyncServiceOptions,
  type SyncSettings,
} from './service.ts';
export {
  IDEMPOTENCY_IN_FLIGHT_MS,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_MAX_RESPONSE_BYTES,
  IDEMPOTENCY_TTL_MS,
  IdempotencyStore,
  carriesCredential,
  hashRequestBody,
  type IdempotencyRef,
  type IdempotencyStart,
  type IdempotencyStoreOptions,
} from './idempotency.ts';
