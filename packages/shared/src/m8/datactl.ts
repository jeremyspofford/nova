// M8 data controls (FR-105, FR-116, FR-115, FR-121; ADR-097 D5): views and zod requests for
// /api/v1/data (export, delete-all, import, retention, crash reports) and for the spend caps,
// provider limits and "clear usage data" under /api/v1/usage.
//
// An export is a `.novaexport` file: a zip holding `manifest.json`, one JSON-lines file per table
// (`tables/<name>.jsonl`) and the data folder's files (`files/<path>`). With a passphrase the whole
// zip is sealed (scrypt, then AES-256-GCM) and carries the vault's secrets in `secrets.json`;
// without one the secrets are left out and listed as "to re-enter".
import { z } from 'zod';

// ---- constants ---------------------------------------------------------------------------------

/** The `.novaexport` format this build writes and reads. */
export const DATA_EXPORT_FORMAT = 1;
/** A passphrase is at least this long (it is the only thing protecting the sealed secrets). */
export const EXPORT_PASSPHRASE_MIN = 12;
/** Audit entries are never pruned sooner than this (ADR-097: the floor for `retention.auditDays`). */
export const AUDIT_RETENTION_FLOOR_DAYS = 365;
/** A chat deleted by the user or by retention can be recovered this long before it is purged. */
export const DELETED_RECOVERY_DAYS = 30;

export const RETENTION_ITEMS = ['threads', 'runs', 'audit', 'artifacts', 'traces'] as const;
export type RetentionItem = (typeof RETENTION_ITEMS)[number];

/** The setting that holds each item's retention in days (`null`: kept until deleted). */
export const RETENTION_SETTING_KEYS = {
  threads: 'retention.threadsDays',
  runs: 'retention.runsDays',
  audit: 'retention.auditDays',
  artifacts: 'retention.artifactsDays',
  traces: 'retention.tracesDays',
} as const satisfies Record<RetentionItem, string>;

// ---- export ------------------------------------------------------------------------------------

/** `POST /api/v1/data/export`: the body (JSON, or a form post from the web app). */
export const dataExportSchema = z
  .object({
    /** Seals the archive and includes the vault's secrets; without it they are left out. */
    passphrase: z.string().min(EXPORT_PASSPHRASE_MIN).max(1024).optional(),
    /**
     * A sealed export carries every vault secret: the owner types the Hub's name to confirm, from
     * a session of the Hub itself (never a device's).
     */
    confirm: z.string().min(1).max(253).optional(),
  })
  .strict();
export type DataExportRequest = z.infer<typeof dataExportSchema>;

/** One table in an export (rows and the SHA-256 of its JSON-lines file). */
export const exportTableSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
  rows: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * One file of the data folder. `path` is relative to the data folder. `seal` names the label the
 * importing Hub seals the file with again (it was stored encrypted with the Hub's data key and is
 * carried decrypted); `raw` marks a file carried still sealed (only in a sealed archive, whose
 * secrets hold that key).
 */
export const exportBlobSchema = z.object({
  path: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().min(0),
  seal: z.string().min(1).max(300).optional(),
  raw: z.literal(true).optional(),
});

/** Something left out of an export, and why. */
export const exportOmissionSchema = z.object({
  kind: z.enum(['secret', 'table', 'file']),
  ref: z.string().max(1024),
  reason: z.string().max(300),
});

export const exportManifestSchema = z.object({
  format: z.number().int(),
  hubVersion: z.string().max(100),
  /** The last migration the exporting Hub had applied. */
  schemaVersion: z.number().int().min(1),
  createdAt: z.string(),
  /** M8 exports the whole Hub (every account on it); the owner exports it. */
  accountScope: z.literal('hub'),
  ownerAccountId: z.string().max(100).nullable(),
  /** The exporting Hub's data folder: an import moves absolute paths under it to its own. */
  dataDir: z.string().min(1).max(4096).optional(),
  encrypted: z.boolean(),
  tables: z.array(exportTableSchema).max(2000),
  blobs: z.array(exportBlobSchema).max(5_000_000),
  /** In a sealed archive: how many vault entries `secrets.json` holds, and its SHA-256. */
  secrets: z
    .object({ count: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
    .nullable(),
  /** Secrets left out of an archive without a passphrase: to re-enter after an import. */
  toReEnter: z.array(z.string().max(500)).max(100_000),
  omitted: z.array(exportOmissionSchema).max(1_000_000),
});
export type ExportManifest = z.infer<typeof exportManifestSchema>;
export type ExportTable = z.infer<typeof exportTableSchema>;
export type ExportBlob = z.infer<typeof exportBlobSchema>;
export type ExportOmission = z.infer<typeof exportOmissionSchema>;

/** `GET /api/v1/data`: what an export would hold now, the Hub's name and whether it is empty. */
export interface DataOverviewView {
  /** What delete-all asks the owner to type. */
  hubName: string;
  hubVersion: string;
  schemaVersion: number;
  tables: number;
  rows: number;
  files: { count: number; bytes: number };
  secrets: { count: number };
  /** Nothing but what setup writes: an import is allowed. */
  empty: boolean;
  /** Tables holding data that block an import (empty when `empty`). */
  blockingTables: string[];
}

// ---- delete-all --------------------------------------------------------------------------------

/** `POST /api/v1/data/delete-all`: the owner types the Hub's name. */
export const dataDeleteAllSchema = z.object({ confirm: z.string().min(1).max(253) }).strict();
export type DataDeleteAllRequest = z.infer<typeof dataDeleteAllSchema>;

export interface DataDeleteResultView {
  deletedAt: string;
  tables: number;
  rows: number;
  files: number;
  secrets: number;
  /** Entries of the data folder delete-all does not know, left alone. */
  keptPaths: string[];
  /** The Hub restarts its services to start from the empty data. */
  restartRequired: true;
}

// ---- import ------------------------------------------------------------------------------------

export interface DataImportUploadView {
  uploadId: string;
  bytes: number;
  encrypted: boolean;
  expiresAt: string;
}

export const dataImportCheckSchema = z
  .object({
    uploadId: z.string().regex(/^[0-9a-f-]{36}$/),
    passphrase: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type DataImportCheckRequest = z.infer<typeof dataImportCheckSchema>;

export const dataImportSchema = dataImportCheckSchema
  .extend({
    /** The import replaces everything on this Hub (which must be empty). */
    confirm: z.literal(true),
  })
  .strict();
export type DataImportRequest = z.infer<typeof dataImportSchema>;

/** What an archive holds and whether this Hub can take it (nothing is written by a check). */
export interface DataImportCheckView {
  format: number;
  hubVersion: string;
  schemaVersion: number;
  /** Set when the archive is older and its data is migrated forward from this version. */
  migratesFrom: number | null;
  createdAt: string;
  encrypted: boolean;
  tables: { name: string; rows: number }[];
  rows: number;
  files: { count: number; bytes: number };
  secrets: { included: boolean; count: number };
  toReEnter: string[];
  omitted: ExportOmission[];
  /** Whether this Hub is empty (an import needs it to be). */
  hubEmpty: boolean;
  blockingTables: string[];
}

export interface DataImportResultView {
  importedAt: string;
  tables: number;
  rows: number;
  files: number;
  secrets: number;
  /** Every table was compared with the archive's checksum after it was written. */
  verified: true;
  toReEnter: string[];
  /**
   * Tables kept from this Hub instead of the archive: without its secrets an archive cannot carry
   * the Hub's own keys (its identity, local CA and Relay key), so paired devices are added again.
   */
  keptTables: string[];
  /**
   * What an archive cannot vouch for comes back off: stdio MCP servers, plugins (and the
   * extensions they carry) and external agent programs disabled, hooks untrusted, and every
   * sign-in session but the importing one revoked.
   */
  restoredOff: {
    mcpServers: number;
    plugins: number;
    agentAdapters: number;
    hooks: number;
    sessions: number;
  };
  restartRequired: true;
}

// ---- retention ---------------------------------------------------------------------------------

export interface RetentionItemView {
  item: RetentionItem;
  setting: string;
  /** Days; null keeps everything. */
  days: number | null;
  /** The least the item may be set to (the audit floor; 1 for the rest). */
  floorDays: number;
  /** Before this instant an item is due (null when `days` is null). */
  cutoff: string | null;
  /** What the next sweep would remove now. */
  due: number;
}

export interface RetentionSweepView {
  id: string;
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  removed: Partial<Record<RetentionItem, number>>;
  skipped: Partial<Record<RetentionItem, number>>;
  error: string | null;
}

export interface RetentionView {
  items: RetentionItemView[];
  lastSweep: RetentionSweepView | null;
  nextSweepAt: string;
}

// ---- crash reports -----------------------------------------------------------------------------

/**
 * `privacy.crashReportEndpoint`: where crash reports go when the owner turns them on. https, or
 * http only to this machine; no credentials, query or fragment. Empty: nowhere (nothing is sent).
 */
export const crashReportEndpointSchema = z.union([
  z.literal(''),
  z
    .string()
    .max(500)
    .refine((v) => {
      try {
        const u = new URL(v);
        const loopback = /^(localhost|\[::1\]|127(\.\d{1,3}){3})$/i.test(u.hostname);
        const scheme = u.protocol === 'https:' || (u.protocol === 'http:' && loopback);
        return scheme && !u.username && !u.password && !u.search && !u.hash;
      } catch {
        return false;
      }
    }, 'an https:// URL (http:// only to this machine), without credentials, query or fragment'),
]);

/** Days for a retention setting: null keeps everything; at least `floor` (at most 100 years). */
export function retentionDaysSchema(floor = 1) {
  return z.number().int().min(floor).max(36_500).nullable();
}

export const CRASH_KINDS = ['uncaughtException', 'unhandledRejection'] as const;
export type CrashKind = (typeof CRASH_KINDS)[number];

/** Exactly what a crash report sends: no message text, no content, paths made relative. */
export interface CrashReportBody {
  v: 1;
  id: string;
  kind: CrashKind;
  createdAt: string;
  error: { name: string; code: string | null; stack: string[] };
  app: { name: 'nova-hub'; version: string };
  runtime: { node: string; platform: string; arch: string; release: string };
  process: { uptimeSeconds: number; rssMb: number };
}

export interface CrashReportView {
  id: string;
  kind: CrashKind;
  createdAt: string;
  errorName: string;
  sentAt: string | null;
  lastError: string | null;
}

export interface CrashReportPreviewView {
  /** The JSON text that would be sent, byte for byte. */
  body: string;
  endpoint: string | null;
  /** Whether it would be sent now (`privacy.crashReports` on and an endpoint set). */
  wouldSend: boolean;
  reason: 'off' | 'no_endpoint' | null;
}

// ---- spend caps and provider limits (FR-116, FR-115) --------------------------------------------

export const SPEND_PERIODS = ['day', 'month'] as const;
export type SpendPeriod = (typeof SPEND_PERIODS)[number];

/** `PUT /api/v1/usage/caps/:provider`. */
export const spendCapSchema = z
  .object({
    limitUsd: z.number().positive().max(1_000_000),
    period: z.enum(SPEND_PERIODS).default('month'),
    /** The warning fires once a period when spend reaches this share of the cap. */
    warnAt: z.number().min(0.05).max(0.99).default(0.8),
    /** Stop model calls to the provider at the cap; off, the cap only warns. */
    hardStop: z.boolean().default(true),
  })
  .strict();
export type SpendCapRequest = z.infer<typeof spendCapSchema>;

export const spendProviderSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/);

export interface SpendCapView {
  provider: string;
  limitUsd: number;
  period: SpendPeriod;
  warnAt: number;
  hardStop: boolean;
  periodStart: string;
  resetsAt: string;
  spentUsd: number;
  /** spent / limit. */
  fraction: number;
  state: 'ok' | 'warning' | 'reached';
  updatedAt: string;
}

/** A limit the provider reported on a call (credit used up, rate limited). */
export interface ProviderReportedLimit {
  code: 'over_budget' | 'rate_limited';
  message: string;
  at: string;
  retryAfterMs: number | null;
}

export interface ProviderLimitView {
  providerAccountId: string;
  provider: string;
  label: string;
  active: boolean;
  /** A local model server or the offline mock: no cost, no cap. */
  local: boolean;
  /** The plan and limits stored for the account (`provider_account.entitlements`). */
  entitlements: {
    plan: string | null;
    limit: number | null;
    used: number | null;
    resetAt: string | null;
  } | null;
  lastReported: ProviderReportedLimit | null;
  /** This calendar month (UTC), from the usage records. */
  spentThisMonthUsd: number;
  spendCap: SpendCapView | null;
}

/** `POST /api/v1/usage/clear`. */
export const clearUsageSchema = z.object({ confirm: z.literal(true) }).strict();
