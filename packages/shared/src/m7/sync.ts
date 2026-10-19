// M7 sync API shapes (owned by the sync area; FR-109, FR-112, FR-129, ADR-010, ADR-036, docs/13 §2,
// decisions 1-3 of ADR-095). The Hub is canonical: a client whose device session has the
// `offline-replica` scope keeps a local replica and syncs it through `/api/v1/sync/*`; conflicts
// are resolved per field, last writer wins by hybrid logical clock, and every overwritten value
// goes to the merge log.
import { z } from 'zod';

/** What is synced (docs/13 §2.1 as built). Secrets, audit, temporary chats and blobs never are. */
export const SYNC_KINDS = [
  'thread',
  'message',
  'project',
  'memory',
  'space',
  'page',
  'schedule',
  'setting',
] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

/** The field a tombstone uses: `{field: '_deleted', value: true}` deletes the entity. */
export const SYNC_TOMBSTONE = '_deleted';

/**
 * The fields of each kind. `write` fields take pushed ops; the others are sent to replicas but
 * refused on push (`read_only_field`). A message is one immutable `body` (append-only).
 */
export const SYNC_FIELDS = {
  thread: { write: ['title', 'pinned', 'archived', 'project'], read: ['mode', 'createdAt'] },
  message: { write: ['body'], read: [] },
  project: { write: ['name', 'instructions'], read: ['createdAt'] },
  memory: { write: ['content', 'status'], read: ['scope', 'category', 'createdAt'] },
  space: { write: ['name'], read: ['createdAt'] },
  page: { write: ['title', 'content'], read: ['space', 'version', 'createdAt'] },
  schedule: { write: ['enabled'], read: ['title'] },
  setting: { write: ['value'], read: [] },
} as const satisfies Record<SyncKind, { write: readonly string[]; read: readonly string[] }>;

/** Kinds a replica may create by pushing ops for a new id (others must exist on the Hub). */
export const SYNC_CREATABLE: readonly SyncKind[] = ['thread', 'message'];
/** Kinds a replica may delete with a tombstone op. */
export const SYNC_DELETABLE: readonly SyncKind[] = ['thread', 'project', 'memory', 'page'];

/**
 * A hybrid logical clock value: 15-digit physical milliseconds, 4 hex digits of logical counter
 * and the node (`hub` or the device id), e.g. `001760000000000-0000-hub`. Fixed widths make the
 * strings sort in clock order; the node breaks ties.
 */
export const HLC_PATTERN = /^(\d{15})-([0-9a-f]{4})-([A-Za-z0-9._:-]{1,100})$/;
export const hlcSchema = z.string().max(130).regex(HLC_PATTERN, 'expected an HLC value');

/**
 * A message a replica appends: a user message written offline (FR-112), or an answer the
 * device's own local model wrote (FR-128; only from a device with the `local-runtime` scope),
 * which names the message it answers and the model.
 */
export const syncMessageBodySchema = z.discriminatedUnion('role', [
  z
    .object({
      threadId: z.string().min(1).max(100),
      role: z.literal('user'),
      text: z.string().min(1).max(100_000),
      parentId: z.string().min(1).max(100).nullable().optional(),
    })
    .strict(),
  z
    .object({
      threadId: z.string().min(1).max(100),
      role: z.literal('assistant'),
      text: z.string().min(1).max(500_000),
      parentId: z.string().min(1).max(100),
      model: z.string().min(1).max(300),
      provenance: z.literal('offline'),
    })
    .strict(),
]);
export type SyncMessageBody = z.infer<typeof syncMessageBodySchema>;

/** One pushed field change. `base` is the HLC of the value the device's edit started from. */
export const syncOpSchema = z
  .object({
    kind: z.enum(SYNC_KINDS),
    id: z.string().min(1).max(200),
    field: z.string().min(1).max(100),
    value: z.unknown(),
    hlc: hlcSchema,
    base: hlcSchema.nullable().optional(),
  })
  .strict();
export type SyncOp = z.infer<typeof syncOpSchema>;

/** `POST /api/v1/sync/push`. */
export const syncPushSchema = z
  .object({
    deviceId: z.string().min(1).max(100),
    ops: z.array(syncOpSchema).min(1).max(500),
  })
  .strict();
export type SyncPushRequest = z.infer<typeof syncPushSchema>;

/** `GET /api/v1/sync/snapshot`. `cursor` is the page cursor a previous page returned. */
export const syncSnapshotQuerySchema = z.object({
  kind: z.enum(SYNC_KINDS).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** `GET /api/v1/sync/changes`. */
export const syncChangesQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/** `GET /api/v1/sync/merge-log`. */
export const syncMergeLogQuerySchema = z.object({
  status: z.enum(['open', 'restored', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().max(100).optional(),
});

export interface SyncFieldView {
  value: unknown;
  hlc: string;
  /** The device whose op set it; null for a change made on the Hub. */
  deviceId: string | null;
}

export interface SyncEntityView {
  kind: SyncKind;
  id: string;
  fields: Record<string, SyncFieldView>;
}

export interface SyncSnapshotView {
  kind: SyncKind;
  items: SyncEntityView[];
  /** The next page (of this kind or the next one); null after the last page. */
  nextCursor: string | null;
  /** The change feed's cursor when this page was read: pull changes since the first page's. */
  feedCursor: number;
}

export interface SyncChangeView {
  cursor: number;
  kind: SyncKind;
  id: string;
  field: string;
  value: unknown;
  hlc: string;
  deviceId: string | null;
}

export interface SyncChangesView {
  changes: SyncChangeView[];
  /** Pass as `since` next time. */
  cursor: number;
  more: boolean;
}

export type SyncOpStatus = 'accepted' | 'overwritten' | 'rejected';

export interface SyncOpResult {
  /** The op's index in the request. */
  index: number;
  kind: SyncKind;
  id: string;
  field: string;
  status: SyncOpStatus;
  /** Why an op was overwritten or rejected (`stale`, `deleted`, `clock_skew`, …). */
  reason?: string;
  /** The merge-log entry that keeps the value that lost. */
  entryId?: string;
  /** The field's clock after the push (the winner's). */
  hlc?: string;
  /** The value that won, for an overwritten op. */
  value?: unknown;
}

export interface SyncPushResult {
  results: SyncOpResult[];
  cursor: number;
  /** The Hub's clock now, so a replica can keep its own ahead of it. */
  hlc: string;
}

export type SyncMergeReason = 'concurrent' | 'stale' | 'restore';

export interface SyncMergeSideView {
  value: unknown;
  hlc: string;
  deviceId: string | null;
  deviceName: string | null;
}

export interface SyncMergeEntryView {
  id: string;
  kind: SyncKind;
  entityId: string;
  field: string;
  /**
   * `concurrent`: a newer op replaced a value its device had not seen; `stale`: an op lost to a
   * newer value; `restore`: a restore replaced this value.
   */
  reason: SyncMergeReason;
  lost: SyncMergeSideView;
  winner: SyncMergeSideView;
  status: 'open' | 'restored';
  createdAt: string;
  restoredAt: string | null;
}

export type SyncReplicaStatus = 'synced' | 'pending' | 'offline' | 'error';

export interface SyncReplicaView {
  deviceId: string;
  name: string;
  platform: string | null;
  /** The device has the `offline-replica` scope now. */
  granted: boolean;
  revoked: boolean;
  status: SyncReplicaStatus;
  cursor: number;
  /** Changes after its cursor. */
  behind: number;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
  resetAt: string | null;
}
