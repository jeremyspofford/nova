// M7 cloud runner API shapes (owned by the runner area; FR-108, FR-071, FR-116; docs/13 §3,
// docs/10 §12, contracts/rest-api.md §5, ADR-095 decision 4). The Hub keeps the agent loop and the
// policy gate; a `cloud` environment's commands and files run on the runner. The runner token
// lives in the vault (`secret://cloud/runner/token`) and never appears in a view.
import { z } from 'zod';
import { RUN_AUTONOMY, idSchema } from '../api.ts';

/** Where the runner token is kept (the vault; docs/12 §5). */
export const RUNNER_TOKEN_REF = 'secret://cloud/runner/token';
/** The hosted runner (contracts/rest-api.md); a self-hosted one is the same service at a URL. */
export const RUNNER_HOSTED_URL = 'https://runner.arialabs.ai';

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * A runner base URL: https:// (http:// only to this machine, so the token never crosses a
 * network in clear), no credentials, query or fragment; '' for none.
 */
export function isRunnerUrl(v: string): boolean {
  if (v === '') return true;
  try {
    const u = new URL(v);
    const ok = u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname));
    return ok && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

export const runnerUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(isRunnerUrl, 'an https:// URL (http:// only to this machine), without credentials');

/** A runner token as `nova-runner token add` prints it. */
export const runnerTokenSchema = z
  .string()
  .trim()
  .regex(/^nvrun_[A-Za-z0-9_-]{43}$/, 'a runner token (nvrun_…)');

/** `PUT /api/v1/cloud/runner`: register (or change) the runner; the token goes to the vault. */
export const putRunnerSchema = z
  .object({
    url: runnerUrlSchema.refine((v) => v !== '', 'a URL is required'),
    token: runnerTokenSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type PutRunnerRequest = z.infer<typeof putRunnerSchema>;

/** `PATCH /api/v1/cloud/runner`: turn it on or off. */
export const patchRunnerSchema = z.object({ enabled: z.boolean() }).strict();

/** Caps for one cloud run (FR-116); a hard stop at each. */
export const cloudCapsSchema = z
  .object({
    cpuSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400),
    wallSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400),
    diskMb: z.number().int().min(16).max(1_048_576),
    /** Share of a cap at which a warning goes out. */
    warnAt: z.number().min(0.5).max(0.99),
  })
  .strict();
export type CloudCaps = z.infer<typeof cloudCapsSchema>;
export const DEFAULT_CLOUD_CAPS: CloudCaps = {
  cpuSeconds: 3_600,
  wallSeconds: 4 * 3_600,
  diskMb: 10_240,
  warnAt: 0.8,
};

/**
 * A repository: https:// (optionally `#branch`), or file:// when the runner allows its own disk.
 * Never with credentials in it: they would end up in the clone's Git config and its snapshots.
 */
const repoUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .regex(/^(https|file):\/\/[^\s]+$/, 'an https:// repository URL')
  .refine((v) => !repoUrlHasCredentials(v), 'a repository URL without a user name or password');

/** Whether a repository URL carries user information (`user:token@`). */
export function repoUrlHasCredentials(v: string): boolean {
  try {
    const u = new URL(v);
    return !!(u.username || u.password);
  } catch {
    // Unparsable: the scheme check refuses it; an `@` before the path is still credentials.
    return /^[a-z]+:\/\/[^/]*@/i.test(v);
  }
}

/**
 * A folder inside a cloud environment: /workspace or below it, with no `..` part and no control
 * characters. Paths the runner reports are checked with it before the Hub uses them.
 */
export function isCloudFolder(p: string): boolean {
  if (!/^\/workspace(\/|$)/.test(p) || p.length > 1_000) return false;
  // No control characters (a newline would split what the folder means downstream).
  if ([...p].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return false;
  return !p.split('/').some((part) => part === '..' || part === '.');
}
/** A container image reference (`name[:tag][@digest]`), never shell syntax. */
const imageSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._/:@-]*$/, 'a container image reference');

/** A cloud environment (FR-071): repositories side by side, a setup script run once, caches. */
export const cloudConnectionSchema = z
  .object({
    repoUrls: z.array(repoUrlSchema).max(10).default([]),
    setupScript: z.string().max(20_000).nullable().optional(),
    baseImage: imageSchema.nullable().optional(),
    caches: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'a cache name'))
      .max(8)
      .optional(),
    /** `setup`: only the setup script may reach the network. */
    network: z.enum(['off', 'setup', 'on']).default('off'),
    diskMb: z.number().int().min(16).max(1_048_576).optional(),
    /** The folder sessions and runs work in (default: the first repository, else /workspace). */
    folder: z
      .string()
      .trim()
      .max(1_000)
      .refine(isCloudFolder, 'a folder under /workspace')
      .optional(),
  })
  .strict();
export type CloudConnection = z.infer<typeof cloudConnectionSchema>;

/** `POST /api/v1/environments` (and `/api/v1/cloud/environments`) with kind `cloud`. */
export const createCloudEnvironmentSchema = z
  .object({
    kind: z.literal('cloud'),
    label: z.string().trim().min(1).max(100),
    connection: cloudConnectionSchema,
  })
  .strict();

export const cloudSnapshotSchema = z
  .object({ label: z.string().trim().min(1).max(200).optional() })
  .strict();

/** `PATCH /api/v1/cloud/runs/:id`: new caps for a run (a capped run with room is active again). */
export const cloudRunCapsSchema = z
  .object({
    cpuSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400)
      .optional(),
    wallSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400)
      .optional(),
  })
  .strict()
  .refine((v) => v.cpuSeconds !== undefined || v.wallSeconds !== undefined, 'nothing to change');

/** `POST /api/v1/cloud/runs/:id/artifacts`: keep a file of the workdir in the thread. */
export const collectCloudArtifactSchema = z
  .object({
    path: z.string().trim().min(1).max(4_096),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const cloudFileQuery = z.object({ path: z.string().min(1).max(4_096) });

export const cloudRunsQuery = z.object({
  environmentId: idSchema.optional(),
  threadId: idSchema.optional(),
  status: z.enum(['active', 'all']).default('all'),
});

/** `POST /api/v1/cloud/work`: a Work run whose commands run on a cloud environment. */
export const startCloudWorkSchema = z
  .object({
    environmentId: idSchema,
    objective: z.string().trim().min(1).max(8000),
    title: z.string().trim().min(1).max(200).optional(),
    projectId: idSchema.optional(),
    autonomy: z.enum(RUN_AUTONOMY).optional(),
    budgets: z
      .object({
        timeSeconds: z
          .number()
          .int()
          .min(60)
          .max(7 * 86_400)
          .optional(),
        tokens: z.number().int().min(1_000).max(100_000_000).optional(),
        costUsd: z.number().min(0).max(100_000).nullable().optional(),
      })
      .strict()
      .optional(),
    model: z.string().max(200).optional(),
    caps: z
      .object({
        cpuSeconds: z
          .number()
          .int()
          .min(60)
          .max(7 * 86_400)
          .optional(),
        wallSeconds: z
          .number()
          .int()
          .min(60)
          .max(7 * 86_400)
          .optional(),
      })
      .strict()
      .optional(),
    /** Take a snapshot before the run starts (default true), to restore on failure. */
    snapshot: z.boolean().optional(),
  })
  .strict();
export type StartCloudWorkRequest = z.infer<typeof startCloudWorkSchema>;

// ---- views --------------------------------------------------------------------------------------

export type CloudRunnerState = 'disabled' | 'unconfigured' | 'unknown' | 'ok' | 'error';

/** `GET /api/v1/cloud/runner`. */
export interface CloudRunnerView {
  enabled: boolean;
  url: string;
  /** Whether a token is in the vault (the token itself is never returned). */
  hasToken: boolean;
  state: CloudRunnerState;
  detail: string | null;
  version: string | null;
  substrate: { kind: string | null; ok: boolean; detail: string } | null;
  checkedAt: string | null;
  caps: CloudCaps;
}

/** `POST /api/v1/cloud/runner/test`. */
export interface CloudRunnerTestView {
  ok: boolean;
  latencyMs: number | null;
  version: string | null;
  substrate: { kind: string | null; ok: boolean; detail: string } | null;
  detail: string;
}

/** A cloud environment's connection as a saved environment shows it (no secret values). */
export interface CloudConnectionView {
  kind: 'cloud';
  runnerEnvironmentId: string;
  /** Without user information. */
  repoUrls: string[];
  setupScript: string | null;
  baseImage: string | null;
  caches: string[];
  network: 'off' | 'setup' | 'on';
  diskMb: number;
  folder: string;
}

/** What the runner reports of an environment. */
export interface CloudRunnerEnvironmentView {
  status: 'provisioning' | 'ready' | 'failed' | 'deleting';
  detail: string | null;
  substrate: string | null;
  repos: { name: string; path: string; ref: string | null; head: string | null }[];
  caches: { name: string; path: string }[];
  setup: {
    status: 'none' | 'running' | 'ok' | 'failed';
    exitCode: number | null;
    /** Redacted tail. */
    log: string;
    startedAt: string | null;
    endedAt: string | null;
  };
  usage: { diskBytes: number };
  caps: { diskBytes: number };
  runs: { active: number };
  processes: { running: number };
  readyAt: string | null;
}

export interface CloudEnvironmentView {
  /** The saved environment's id (`/api/v1/environments/:id`). */
  id: string;
  label: string;
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  detail: string | null;
  connection: CloudConnectionView;
  /** Null while the runner cannot be reached. */
  runner: CloudRunnerEnvironmentView | null;
  sessions: number;
  createdAt: string;
  updatedAt: string;
}

export type CloudRunStatus = 'active' | 'completed' | 'cancelled' | 'capped' | 'failed' | 'lost';

/** A Code session's or Work run's lease on a cloud environment, with its metering (FR-116). */
export interface CloudRunView {
  id: string;
  environmentId: string;
  threadId: string | null;
  kind: 'code' | 'work' | 'system';
  /** The Work run, for `work`. */
  workRunId: string | null;
  /** The Code session, for `code` (its thread's session); the Hub always fills it. */
  sessionId?: string | null;
  status: CloudRunStatus;
  /** Why it was capped or ended: `cpu`, `wall`, `cancelled`, ... */
  reason: string | null;
  caps: { cpuSeconds: number; wallSeconds: number };
  usage: { cpuSeconds: number; wallSeconds: number; commands: number };
  /** Resources past the warning share. */
  warnings: string[];
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface CloudSnapshotView {
  id: string;
  environmentId: string;
  label: string | null;
  /** `manual`, `run_start` (before a Work run) or `before_restore`. */
  reason: 'manual' | 'run_start' | 'before_restore';
  sizeBytes: number;
  createdAt: string;
  restoredAt: string | null;
}

export type CloudFileView =
  | {
      kind: 'dir';
      path: string;
      entries: { name: string; kind: 'file' | 'dir' | 'link' | 'other'; size: number }[];
      truncated: boolean;
    }
  | {
      kind: 'file';
      path: string;
      size: number;
      /** UTF-8 text, or null for binary content. */
      text: string | null;
      truncated: boolean;
    };

/** `POST /api/v1/cloud/work`. */
export interface CloudWorkView {
  runId: string;
  threadId: string;
  environmentId: string;
  cloudRun: CloudRunView;
  snapshot: CloudSnapshotView | null;
}
