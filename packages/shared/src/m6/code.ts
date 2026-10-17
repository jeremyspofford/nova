// M6 Code additions (docs/10 §2, §7-§10; owned by the code area): saved environments and their
// health (FR-062, FR-078), Git hosts, pushes and pull requests with CI status (FR-070), the
// worktree registry (FR-073), dev servers (FR-097, FR-067), auto-verify (FR-068) and cross-session
// operations (FR-072). Secrets never appear here: credentials go to the keychain and views only
// say whether one is stored.
import { z } from 'zod';
import { createCodeSessionSchema, idSchema, type EnvironmentView } from '../api.ts';

// ---- environments (FR-062, FR-078) -------------------------------------------------------------

export const ENVIRONMENT_KINDS_M6 = ['container', 'ssh', 'wsl', 'device'] as const;
export type SavedEnvironmentKind = (typeof ENVIRONMENT_KINDS_M6)[number];

/** A host name or address: letters, digits, dots, hyphens, colons (IPv6) and brackets. */
const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:[\]-]+$/, 'a host name or address');
/** A user name on the remote host. */
const userSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._-]*$/, 'a user name');
/** An absolute POSIX path on the remote host. */
const remotePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .regex(/^\/[^\0]*$/, 'an absolute path');
/** A container image reference (`name[:tag][@digest]`), never shell syntax. */
const imageSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._/:@-]*$/, 'a container image reference');

/** Container: an image and a setup script run in the session folder on the sandbox substrate. */
export const containerConnectionSchema = z
  .object({
    image: imageSchema,
    setupScript: z.string().max(20_000).nullable().optional(),
  })
  .strict();

/**
 * SSH: Nova reaches the `novad` helper on the host (docs/10 §2). The private key or password goes
 * to the keychain and is never returned; `hostKey` pins the host's public key when given.
 */
export const sshConnectionSchema = z
  .object({
    host: hostSchema,
    port: z.number().int().min(1).max(65_535).default(22),
    user: userSchema,
    auth: z.enum(['key', 'password']),
    hostKey: z.string().trim().max(2000).nullable().optional(),
    /** Where sessions may work on the host (defaults to the user's home on first check). */
    root: remotePathSchema.nullable().optional(),
  })
  .strict();

/** WSL: a distro on a Windows device running `novad` (detected through the helper). */
export const wslConnectionSchema = z
  .object({
    deviceId: idSchema,
    distro: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/, 'a WSL distro name'),
  })
  .strict();

/** Device: a registered device running `novad`, under that device's grants (docs/23). */
export const deviceConnectionSchema = z
  .object({
    deviceId: idSchema,
    root: remotePathSchema.nullable().optional(),
  })
  .strict();

/** The credential for an SSH environment: stored in the keychain, never echoed. */
export const sshCredentialSchema = z
  .object({
    privateKey: z.string().min(1).max(20_000).optional(),
    passphrase: z.string().max(1000).optional(),
    password: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const createEnvironmentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('container'),
      label: z.string().trim().min(1).max(100),
      connection: containerConnectionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ssh'),
      label: z.string().trim().min(1).max(100),
      connection: sshConnectionSchema,
      credential: sshCredentialSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('wsl'),
      label: z.string().trim().min(1).max(100),
      connection: wslConnectionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('device'),
      label: z.string().trim().min(1).max(100),
      connection: deviceConnectionSchema,
    })
    .strict(),
]);

/** Change a saved environment: its label, its connection (same kind) or the SSH credential. */
export const updateEnvironmentSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    connection: z.record(z.string(), z.unknown()).optional(),
    credential: sshCredentialSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

/** What a saved environment's connection looks like in a view (no secret values). */
export type EnvironmentConnectionView =
  | { kind: 'local' }
  | { kind: 'container'; image: string; setupScript: string | null }
  | {
      kind: 'ssh';
      host: string;
      port: number;
      user: string;
      auth: 'key' | 'password';
      hostKey: string | null;
      root: string | null;
      /** Whether a key or password is stored in the keychain. */
      hasCredential: boolean;
    }
  | { kind: 'wsl'; deviceId: string; distro: string }
  | { kind: 'device'; deviceId: string; root: string | null };

/** EnvironmentView plus what Settings shows of a saved environment. */
export interface SavedEnvironmentView extends EnvironmentView {
  /** The built-in local environment cannot be edited or removed. */
  builtIn: boolean;
  connection: EnvironmentConnectionView;
  /** Active Code sessions bound to it. */
  sessions: number;
  createdAt: string;
  updatedAt: string;
}

/** A WSL distro a Windows device reports (FR-062). */
export interface WslDistroView {
  name: string;
  default: boolean;
  state: 'running' | 'stopped' | 'unknown';
  version: 1 | 2 | null;
}

/** A process the environment's helper runs; its output stays buffered while nobody reads it. */
export interface EnvironmentProcessView {
  id: string;
  environmentId: string;
  sessionId: string | null;
  cmd: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  /** Bytes of output so far; read them with `?offset=` to reattach (FR-078). */
  outputBytes: number;
  startedAt: string;
}

export interface EnvironmentOutputView {
  processId: string;
  /** Redacted output from `offset`. */
  data: string;
  /** Where the next read starts. */
  offset: number;
  /** Bytes dropped from the helper's buffer before `offset` (it keeps the newest). */
  dropped: number;
  running: boolean;
  exitCode: number | null;
}

export const environmentOutputQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Code sessions: binding, side questions, budgets ------------------------------------------

/** POST /code/sessions in M6: also binds an existing registry worktree (FR-073) and budgets. */
export const createCodeSessionM6Schema = createCodeSessionSchema
  .extend({
    /** Work in this unleased worktree of the registry (instead of `worktree: true`). */
    worktreeId: idSchema.optional(),
    /** Time, token and cost bounds for the session's turns (docs/09 §2); none by default. */
    budgets: z
      .object({
        timeSeconds: z
          .number()
          .int()
          .min(60)
          .max(7 * 24 * 3600)
          .nullable()
          .optional(),
        tokens: z.number().int().min(1_000).max(1_000_000_000).nullable().optional(),
        costUsd: z.number().min(0.01).max(100_000).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => !(v.worktree && v.worktreeId), 'use worktree or worktreeId, not both');

export const extendCodeBudgetSchema = z
  .object({
    timeSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 3600)
      .optional(),
    tokens: z.number().int().min(1_000).max(1_000_000_000).optional(),
    costUsd: z.number().min(0.01).max(100_000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to extend');

export interface CodeBudgetView {
  limits: { timeSeconds: number | null; tokens: number | null; costUsd: number | null };
  used: { timeSeconds: number; tokens: number; costUsd: number };
  /** The bound reached, when the last turn stopped on one. */
  reached: 'time' | 'tokens' | 'cost' | null;
}

/** M6 facts about a session the M5 view does not carry. */
export interface CodeSessionExtrasView {
  sessionId: string;
  environment: { id: string; kind: EnvironmentView['kind']; label: string } | null;
  /** The parent session when this one is a worker started with `task.spawn` (FR-073). */
  parentSessionId: string | null;
  role: string | null;
  setup: { status: 'running' | 'ok' | 'failed'; detail: string | null } | null;
  budget: CodeBudgetView;
  pullRequest: PullRequestView | null;
  lastVerify: VerifyRunView | null;
  devServers: DevServerView[];
}

/** A side question (Ctrl/Cmd+Alt+S): answered with the session's context, adding no turn. */
export const sideQuestionSchema = z
  .object({ question: z.string().trim().min(1).max(4000) })
  .strict();

export interface SideAnswerView {
  sessionId: string;
  answer: string;
  model: string | null;
}

// ---- Git hosts, pushes and pull requests (FR-070) ----------------------------------------------

export const GIT_HOST_KINDS = ['github'] as const;

export const createGitHostSchema = z
  .object({
    kind: z.enum(GIT_HOST_KINDS),
    label: z.string().trim().min(1).max(100).optional(),
    /** The REST API base (GitHub: https://api.github.com; GitHub Enterprise: <host>/api/v3). */
    apiUrl: z.string().trim().url().max(500).optional(),
    /** The web host remotes point at (GitHub: https://github.com). */
    webUrl: z.string().trim().url().max(500).optional(),
    /** A personal access token; stored in the keychain, never returned. */
    token: z.string().trim().min(1).max(2000),
  })
  .strict();

export interface GitHostView {
  id: string;
  kind: (typeof GIT_HOST_KINDS)[number];
  label: string;
  apiUrl: string;
  webUrl: string;
  /** The account the token signs in as, from the last check. */
  login: string | null;
  status: 'ok' | 'error' | 'unknown';
  detail: string | null;
  checkedAt: string | null;
  createdAt: string;
}

/**
 * Push the session's branch. A protected or default branch needs `confirmBranch` typed as the
 * branch's exact name (docs/10 §8); a force push is never made to a protected branch.
 */
export const pushSchema = z
  .object({
    remote: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    confirmBranch: z.string().trim().max(250).optional(),
    force: z.boolean().optional(),
    hostId: idSchema.optional(),
  })
  .strict();

export interface PushResultView {
  sessionId: string;
  remote: string;
  branch: string;
  sha: string;
  /** Whether the repository's pre-push hook ran (in the sandbox only, FR-211). */
  hooksRan: boolean;
  hooksNote: string | null;
}

export const createPullRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(256),
    body: z.string().max(60_000).optional(),
    /** The branch to merge into; the repository's default branch when omitted. */
    base: z.string().trim().min(1).max(250).optional(),
    draft: z.boolean().optional(),
    remote: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    /** `owner/name` on the host when the remote URL does not tell it. */
    repo: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(200)
      .optional(),
    hostId: idSchema.optional(),
    confirmBranch: z.string().trim().max(250).optional(),
  })
  .strict();

export type CiStatus = 'none' | 'queued' | 'running' | 'passed' | 'failed';

export interface CiCheckView {
  name: string;
  status: 'queued' | 'running' | 'completed';
  conclusion: string | null;
  url: string | null;
  /** The check's summary (from the host; untrusted text). */
  summary: string | null;
}

export interface PullRequestView {
  id: string;
  sessionId: string;
  hostId: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  ci: { status: CiStatus; checks: CiCheckView[] };
  /** When CI was last read from the host. */
  polledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- worktree registry (FR-073) ----------------------------------------------------------------

export interface WorktreeView {
  id: string;
  name: string;
  repoPath: string;
  path: string;
  branch: string;
  sourceBranch: string;
  /** The session holding the lease, if any. */
  leasedBy: string | null;
  /** When the lease ends unless renewed (null: until released or the session is archived). */
  leaseExpiresAt: string | null;
  status: 'active' | 'released' | 'removed';
  /** Uncommitted changes in the worktree (null when it could not be read). */
  dirty: boolean | null;
  /** Ignored files `.worktreeinclude` copied in when it was created. */
  included: number | null;
  createdAt: string;
  updatedAt: string;
}

export const worktreeListQuery = z.object({
  repo: z.string().trim().min(1).max(1000).optional(),
  deviceId: idSchema.optional(),
  status: z.enum(['active', 'released', 'removed', 'all']).optional(),
});

export const createWorktreeSchema = z
  .object({
    /** A folder inside the repository on the Hub. */
    repo: z.string().trim().min(1).max(1000),
    /** The session that holds the lease (none: unleased, for a session to bind later). */
    sessionId: idSchema.optional(),
    /** Branch slug for `nova/<slug>`. */
    branch: z.string().trim().min(1).max(200).optional(),
    /** Lease length; without it the lease lasts until released or the session is archived. */
    ttlMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .optional(),
    /** At the cap, remove the oldest unleased clean worktree first (the offer was accepted). */
    removeOldest: z.boolean().optional(),
  })
  .strict();

export const renewWorktreeSchema = z
  .object({
    ttlMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .optional(),
  })
  .strict();

export const removeWorktreeQuery = z.object({
  force: z.enum(['true', 'false']).optional(),
});

// ---- dev servers and the browser pane (FR-097, FR-067) -----------------------------------------

export interface DevServerCandidateView {
  /** Stable within the session, e.g. `npm:dev`, `django`, `launch:web`. */
  id: string;
  label: string;
  framework: string;
  command: string;
  /** Folder relative to the session folder ('' for the folder itself). */
  cwd: string;
  port: number | null;
  source: 'package.json' | 'manage.py' | 'rails' | 'go' | 'launch.json';
}

export interface DevServerView {
  id: string;
  sessionId: string;
  candidateId: string;
  label: string;
  command: string;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  /** Where the browser pane opens it (local dev hosts need the egress proxy's dev-server grant). */
  url: string | null;
  port: number | null;
  /** The exec session that runs it (listed in the terminal pane). */
  execSessionId: string | null;
  exitCode: number | null;
  startedAt: string;
  stoppedAt: string | null;
}

export const startDevServerSchema = z
  .object({
    /** A detected candidate; the first one when omitted. */
    candidateId: z.string().trim().min(1).max(200).optional(),
    port: z.number().int().min(1024).max(65_535).optional(),
  })
  .strict();

// ---- auto-verify (FR-068) -----------------------------------------------------------------------

export interface VerifyCheckView {
  name: string;
  command: string;
  status: 'passed' | 'failed' | 'timeout' | 'error' | 'skipped';
  exitCode: number | null;
  /** Redacted, capped output (head and tail). */
  log: string;
  durationMs: number;
}

export interface VerifyRunView {
  id: string;
  sessionId: string;
  trigger: 'auto' | 'manual';
  status: 'running' | 'passed' | 'failed' | 'error' | 'skipped';
  checks: VerifyCheckView[];
  createdAt: string;
  completedAt: string | null;
}
