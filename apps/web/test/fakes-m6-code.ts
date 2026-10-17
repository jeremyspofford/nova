// The fake Hub's M6 Code part (docs/10 §2, §7-§10): saved environments and their processes,
// Git hosts, pushes, pull requests and CI, the worktree registry, dev servers, auto-verify, side
// questions and budgets, in memory, with the Hub's rules:
// - environments: This Hub cannot be changed or removed (400 `built_in`); removing one active
//   sessions use answers 409 `in_use`; an SSH environment needs the credential its sign-in uses,
//   and a new host, user or sign-in needs it again (400 `credential_required`); views never carry
//   a secret; WSL distros come only from Windows devices (400 capability_missing).
// - Git hosts: a rejected token is not saved (400 `token_rejected`), a web address once
//   (409 `duplicate`), removal is refused while its pull requests are open (409 `in_use`).
// - worktrees: at most 15 per repository (409 `worktree_cap` naming the removable ones unless
//   `removeOldest`), renew only when leased (409 `not_leased`), release and remove refused while a
//   session works in it (409 `in_use`), remove refused while leased (409 `leased`) or dirty
//   without force (409 `dirty`).
// - sessions on another machine (ssh, wsl, device): branch, push, pull requests and dev servers
//   answer 400 capability_missing `remote_environment`.
// - push: a protected or the default branch needs `confirmBranch` equal to its name (403
//   `confirmation_required`), never force (403 `force_protected`); secret findings refuse it
//   (403 `secrets_found` with the findings).
// - dev servers: at most 4 running (409), an immediate exit is 409 `dev_server_exited` with its
//   output, no sandbox is 409 sandbox_unavailable.
// - auto-verify: one run at a time (409 `verify_running`).
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m6code: M6CodeState`,
// `createHub` defaults it to `m6CodeState()`, and `impl` spreads
// `...m6CodeImpl(state.m6code, { id, ts: () => ts(), maybeFail, m5: state.m5code })` AFTER
// `m5CodeImpl` (it replaces `createCodeSession` with the M6 version: worktreeId and budgets).
// Until then tests use `m6CodeHub()` / `openM6Session()`, which spread it over the hub's api.
/* eslint-disable @typescript-eslint/require-await */
import { screen, waitFor } from '@testing-library/react';
import { expect, vi, type Mock } from 'vitest';
import type { z } from 'zod';
import {
  createCodeSessionM6Schema,
  createEnvironmentSchema,
  createGitHostSchema,
  createPullRequestSchema,
  createWorktreeSchema,
  extendCodeBudgetSchema,
  pushSchema,
  sshCredentialSchema,
  updateEnvironmentSchema,
  type CiCheckView,
  type CodeBudgetView,
  type CodeSessionExtrasView,
  type CodeSessionView,
  type DeviceView,
  type DevServerCandidateView,
  type DevServerView,
  type EnvironmentConnectionView,
  type EnvironmentProcessView,
  type EnvironmentView,
  type GitHostView,
  type PullRequestView,
  type SavedEnvironmentView,
  type VerifyCheckView,
  type VerifyRunView,
  type WorktreeView,
  type WslDistroView,
} from '@nova/shared';
import { ApiError, type Api } from '../src/api.ts';
import type { CodeM6Api } from '../src/code/api-m6.ts';
import { sessionTitle } from '../src/code/labels.ts';
import { codeHub } from './code-helpers.tsx';
import { codeSession, type M5CodeState } from './fakes-m5-code.ts';
import { renderApp } from './render.tsx';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;

// ---- builders ---------------------------------------------------------------------------------

export function savedEnvironment(over: Partial<SavedEnvironmentView> = {}): SavedEnvironmentView {
  const kind = over.kind ?? 'local';
  const connection: EnvironmentConnectionView =
    over.connection ??
    (kind === 'container'
      ? { kind: 'container', image: 'node:22', setupScript: null }
      : kind === 'ssh'
        ? {
            kind: 'ssh',
            host: 'build.example.com',
            port: 22,
            user: 'me',
            auth: 'key',
            hostKey: null,
            root: null,
            hasCredential: true,
          }
        : kind === 'wsl'
          ? { kind: 'wsl', deviceId: 'dev-win', distro: 'Ubuntu' }
          : kind === 'device'
            ? { kind: 'device', deviceId: 'dev-mac', root: null }
            : { kind: 'local' });
  return {
    id: `env-${++n}`,
    kind,
    label: kind === 'local' ? 'This Hub' : `Env ${n}`,
    status: 'ok',
    detail: null,
    checkedAt: T0,
    builtIn: kind === 'local',
    connection,
    sessions: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function device(over: Partial<DeviceView> = {}): DeviceView {
  return {
    id: `dev-${++n}`,
    name: 'Laptop',
    roles: ['client'],
    status: 'active',
    platform: 'linux',
    novadVersion: '0.7.0',
    endpoint: null,
    capability: null,
    capabilities: [],
    updateRequired: false,
    configPending: false,
    routingEligible: true,
    modules: [],
    wake: { wakeable: false, macs: [] },
    lastSeenAt: T0,
    createdAt: T0,
    ...over,
  } as DeviceView;
}

export function gitHost(over: Partial<GitHostView> = {}): GitHostView {
  return {
    id: `gh-${++n}`,
    kind: 'github',
    label: 'github.com',
    apiUrl: 'https://api.github.com',
    webUrl: 'https://github.com',
    login: 'octo',
    status: 'ok',
    detail: null,
    checkedAt: T0,
    createdAt: T0,
    ...over,
  };
}

export function worktreeView(over: Partial<WorktreeView> = {}): WorktreeView {
  const name = (++n).toString(16).padStart(8, '0');
  return {
    id: `wt-${n}`,
    name,
    repoPath: '/home/me/app',
    path: `/home/me/app/.nova/worktrees/${name}`,
    branch: `nova/task-${n}`,
    sourceBranch: 'main',
    leasedBy: null,
    leaseExpiresAt: null,
    status: 'active',
    dirty: false,
    included: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function ciCheck(over: Partial<CiCheckView> = {}): CiCheckView {
  return {
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/team/app/runs/1',
    summary: null,
    ...over,
  };
}

export function pullRequest(
  sessionId: string,
  over: Partial<PullRequestView> = {},
): PullRequestView {
  return {
    id: `pr-${++n}`,
    sessionId,
    hostId: 'gh-1',
    repo: 'team/app',
    number: 12,
    url: 'https://github.com/team/app/pull/12',
    title: 'Fix the flaky test',
    state: 'open',
    headBranch: 'nova/fix',
    baseBranch: 'main',
    headSha: 'abc1234',
    ci: { status: 'running', checks: [ciCheck({ status: 'running', conclusion: null })] },
    polledAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function verifyCheck(over: Partial<VerifyCheckView> = {}): VerifyCheckView {
  return {
    name: 'test',
    command: 'npm test',
    status: 'passed',
    exitCode: 0,
    log: 'All 12 tests passed',
    durationMs: 4200,
    ...over,
  };
}

export function verifyRun(sessionId: string, over: Partial<VerifyRunView> = {}): VerifyRunView {
  return {
    id: `vr-${++n}`,
    sessionId,
    trigger: 'auto',
    status: 'passed',
    checks: [verifyCheck()],
    createdAt: T0,
    completedAt: T0,
    ...over,
  };
}

export function candidate(over: Partial<DevServerCandidateView> = {}): DevServerCandidateView {
  return {
    id: 'npm:dev',
    label: 'npm run dev',
    framework: 'Vite',
    command: 'npm run dev',
    cwd: '',
    port: 5173,
    source: 'package.json',
    ...over,
  };
}

export function devServer(sessionId: string, over: Partial<DevServerView> = {}): DevServerView {
  return {
    id: `ds-${++n}`,
    sessionId,
    candidateId: 'npm:dev',
    label: 'npm run dev',
    command: 'npm run dev -- --port 5173',
    status: 'running',
    url: 'http://127.0.0.1:5173/',
    port: 5173,
    execSessionId: 'x1',
    exitCode: null,
    startedAt: T0,
    stoppedAt: null,
    ...over,
  };
}

export function processView(
  environmentId: string,
  over: Partial<EnvironmentProcessView> = {},
): EnvironmentProcessView {
  return {
    id: `p-${++n}`,
    environmentId,
    sessionId: null,
    cmd: 'npm test -- --watch',
    cwd: '/home/me/app',
    running: true,
    exitCode: null,
    outputBytes: 0,
    startedAt: T0,
    ...over,
  };
}

export function budget(over: Partial<CodeBudgetView> = {}): CodeBudgetView {
  return {
    limits: { timeSeconds: null, tokens: null, costUsd: null },
    used: { timeSeconds: 0, tokens: 0, costUsd: 0 },
    reached: null,
    ...over,
  };
}

export interface SecretFindingInit {
  path: string;
  line: number;
  rule: string;
  preview: string;
}

// ---- state ------------------------------------------------------------------------------------

export interface M6CodeState {
  /** Devices running novad (`GET /devices?role=client`). */
  devices: DeviceView[];
  /** WSL distros each Windows device reports. */
  wslDistros: Record<string, WslDistroView[]>;
  /** What the keychain holds per environment (never in a view). */
  credentials: Record<string, unknown>;
  /** What a health check finds, per environment (default: ok). */
  checkResults: Record<string, { status: EnvironmentView['status']; detail: string }>;
  processes: EnvironmentProcessView[];
  /** Each process's buffered output and the bytes dropped before it. */
  outputs: Record<string, { data: string; dropped: number }>;
  gitHosts: GitHostView[];
  hostTokens: Record<string, string>;
  /** Tokens the host rejects. */
  rejectedTokens: string[];
  worktrees: WorktreeView[];
  /** Worktrees an active Code session works in. */
  inUse: string[];
  budgets: Record<string, CodeBudgetView>;
  setup: Record<string, CodeSessionExtrasView['setup']>;
  lineage: Record<string, { parentSessionId: string | null; role: string | null }>;
  pullRequests: PullRequestView[];
  pushes: { sessionId: string; body: Record<string, unknown> }[];
  /** Branches the Git host protects. */
  protectedBranches: string[];
  /** The repository's default branch. */
  defaultBranch: string;
  /** Findings of the secret scan of the commits to push (a push is refused while set). */
  secretFindings: SecretFindingInit[] | null;
  /** `owner/name` the remote URL names; null when it names none. */
  remoteRepo: string | null;
  candidates: Record<string, DevServerCandidateView[]>;
  devServers: DevServerView[];
  /** The next dev server start exits at once with this output. */
  devServerExit: string | null;
  /** Whether the Hub has a sandbox for dev servers. */
  sandbox: boolean;
  verifyRuns: VerifyRunView[];
  /** How the next verify run ends; null leaves it running. */
  nextVerify: { status: VerifyRunView['status']; checks: VerifyCheckView[] } | null;
  asks: { sessionId: string; question: string }[];
  answer: string;
  branches: { sessionId: string; name: string }[];
  /** Created sessions' M6 bodies (worktreeId, budgets). */
  created: Record<string, unknown>[];
}

export function m6CodeState(init: Partial<M6CodeState> = {}): M6CodeState {
  return {
    devices: [],
    wslDistros: {},
    credentials: {},
    checkResults: {},
    processes: [],
    outputs: {},
    gitHosts: [],
    hostTokens: {},
    rejectedTokens: [],
    worktrees: [],
    inUse: [],
    budgets: {},
    setup: {},
    lineage: {},
    pullRequests: [],
    pushes: [],
    protectedBranches: [],
    defaultBranch: 'main',
    secretFindings: null,
    remoteRepo: 'team/app',
    candidates: {},
    devServers: [],
    devServerExit: null,
    sandbox: true,
    verifyRuns: [],
    nextVerify: { status: 'passed', checks: [verifyCheck()] },
    asks: [],
    answer: 'It is fixing the flaky test in src/total.test.ts.',
    branches: [],
    created: [],
    ...init,
  };
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

const notFound = (what = 'Not found') => err(404, 'not_found', what);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success)
    throw err(400, 'validation', r.error.issues.map((i) => i.message).join('; ') || 'Invalid');
  return r.data;
}

const MAX_WORKTREES = 15;
const MAX_DEV_SERVERS = 4;

export type M6CodeFake = CodeM6Api & Pick<Api, 'createCodeSession'>;

export function m6CodeImpl(
  st: M6CodeState,
  helpers: {
    id: (prefix: string) => string;
    ts: () => string;
    maybeFail: (name: keyof M6CodeFake) => void;
    m5: M5CodeState;
  },
): M6CodeFake {
  const { id: newId, ts, maybeFail, m5 } = helpers;

  const session = (sid: string) => {
    const s = m5.sessions.find((x) => x.id === sid);
    if (!s) throw notFound();
    return s;
  };
  const envOf = (s: CodeSessionView) =>
    m5.environments.find((e) => e.id === s.environmentId) ?? null;
  const remote = (s: CodeSessionView) => {
    const k = envOf(s)?.kind;
    return !!k && k !== 'local' && k !== 'container';
  };
  const notOnHub = () =>
    err(400, 'capability_missing', 'this works only for sessions whose folder is on the Hub', {
      reason: 'remote_environment',
    });
  const saved = (e: EnvironmentView): SavedEnvironmentView => {
    const s = e as Partial<SavedEnvironmentView>;
    return {
      ...savedEnvironment({ kind: e.kind }),
      ...e,
      builtIn: s.builtIn ?? e.kind === 'local',
      connection: s.connection ?? savedEnvironment({ kind: e.kind }).connection,
      sessions: m5.sessions.filter((x) => x.environmentId === e.id).length,
      createdAt: s.createdAt ?? T0,
      updatedAt: s.updatedAt ?? T0,
    };
  };
  const env = (eid: string) => {
    const e = m5.environments.find((x) => x.id === eid);
    if (!e) throw notFound('environment not found');
    return e;
  };
  const putEnv = (e: SavedEnvironmentView) => {
    m5.environments = m5.environments.some((x) => x.id === e.id)
      ? m5.environments.map((x) => (x.id === e.id ? e : x))
      : [...m5.environments, e];
    return saved(e);
  };
  const knownDevice = (did: string) => {
    if (!st.devices.some((d) => d.id === did))
      throw err(404, 'not_found', 'device not found', { reason: 'unknown_device' });
  };
  const assertCredential = (auth: 'key' | 'password', c: Record<string, unknown>) => {
    if (auth === 'key' && !c.privateKey)
      throw err(400, 'validation', 'key sign-in needs a private key', {
        reason: 'credential_required',
      });
    if (auth === 'password' && !c.password)
      throw err(400, 'validation', 'password sign-in needs a password', {
        reason: 'credential_required',
      });
  };
  const worktree = (wid: string) => {
    const w = st.worktrees.find((x) => x.id === wid);
    if (!w) throw notFound('worktree not found');
    return w;
  };
  const putWorktree = (w: WorktreeView) => {
    st.worktrees = st.worktrees.some((x) => x.id === w.id)
      ? st.worktrees.map((x) => (x.id === w.id ? w : x))
      : [...st.worktrees, w];
    return { ...w };
  };
  const onDisk = (repo: string) =>
    st.worktrees.filter((w) => w.repoPath === repo && w.status !== 'removed');
  const createWorktreeRow = (input: {
    repo: string;
    sessionId?: string;
    branch?: string;
    ttlMinutes?: number;
    removeOldest?: boolean;
  }): WorktreeView => {
    const list = onDisk(input.repo);
    if (list.length >= MAX_WORKTREES) {
      const unleased = list.filter((w) => !w.leasedBy && !st.inUse.includes(w.id));
      const removable = unleased.filter((w) => w.dirty === false);
      const oldest = removable[0];
      if (input.removeOldest && oldest) putWorktree({ ...oldest, status: 'removed', dirty: false });
      else
        throw err(409, 'conflict', 'this repository already has 15 worktrees; remove one first', {
          reason: 'worktree_cap',
          unleased: unleased.map((w) => w.id),
          removable: removable.map((w) => w.id),
        });
    }
    const slug = (input.branch ?? 'change').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const taken = st.worktrees.some((w) => w.branch === `nova/${slug}`);
    const at = ts();
    return putWorktree(
      worktreeView({
        id: newId('wt'),
        repoPath: input.repo,
        branch: taken ? `nova/${slug}-1a2b` : `nova/${slug}`,
        leasedBy: input.sessionId ?? null,
        leaseExpiresAt:
          input.sessionId && input.ttlMinutes
            ? new Date(Date.parse(at) + input.ttlMinutes * 60_000).toISOString()
            : null,
        createdAt: at,
        updatedAt: at,
      }),
    );
  };
  const guardPush = (
    s: CodeSessionView,
    body: { confirmBranch?: string; force?: boolean },
  ): string => {
    if (remote(s)) throw notOnHub();
    const branch = s.repo?.branch;
    if (!s.repo) throw err(400, 'validation', 'the session folder is not a Git repository');
    if (!branch)
      throw err(409, 'conflict', 'HEAD is detached; commit on a branch first', {
        reason: 'detached_head',
      });
    const isProtected = st.protectedBranches.includes(branch);
    const isDefault = branch === st.defaultBranch;
    const what = isProtected ? 'a protected branch' : 'the default branch';
    if (body.force && (isProtected || isDefault))
      throw err(403, 'policy_denied', `force-pushing ${what} (${branch}) is never allowed`, {
        reason: 'force_protected',
        branch,
        protected: isProtected,
        default: isDefault,
      });
    if ((isProtected || isDefault) && body.confirmBranch !== branch)
      throw err(403, 'policy_denied', `pushing ${what} (${branch}) needs its name typed`, {
        reason: 'confirmation_required',
        branch,
        protected: isProtected,
        default: isDefault,
      });
    if (st.secretFindings)
      throw err(403, 'policy_denied', 'the commits to push look like they contain secrets', {
        reason: 'secrets_found',
        findings: st.secretFindings,
      });
    return branch;
  };
  const budgetOf = (sid: string) => st.budgets[sid] ?? budget();
  const latestPr = (sid: string) =>
    st.pullRequests.filter((p) => p.sessionId === sid).at(-1) ?? null;
  const touchSession = (sid: string, patch: Partial<CodeSessionView>) => {
    m5.sessions = m5.sessions.map((x) => (x.id === sid ? { ...x, ...patch, updatedAt: ts() } : x));
  };

  return {
    // ---- sessions (M6 create) ---------------------------------------------------------------
    createCodeSession: async (input) => {
      maybeFail('createCodeSession');
      const body = parse(createCodeSessionM6Schema, input);
      const e = body.environmentId ? env(body.environmentId) : null;
      const isRemote = !!e && e.kind !== 'local' && e.kind !== 'container';
      if (isRemote && (body.worktree || body.worktreeId))
        throw err(400, 'validation', 'worktrees are only available for folders on the Hub', {
          reason: 'worktree_unavailable',
        });
      if (body.worktreeId) {
        const w = worktree(body.worktreeId);
        if (w.status === 'removed')
          throw err(409, 'conflict', 'this worktree was removed', { reason: 'removed' });
        if (w.leasedBy || st.inUse.includes(w.id))
          throw err(409, 'conflict', 'this worktree is leased to another session', {
            reason: 'leased',
            sessionId: w.leasedBy,
          });
        if (body.folder !== w.repoPath && !body.folder.startsWith(`${w.repoPath}/`))
          throw err(400, 'validation', 'the worktree belongs to another repository', {
            reason: 'worktree_repo',
          });
      }
      const sid = newId('cs');
      let wt: WorktreeView | null = null;
      if (body.worktree)
        wt = createWorktreeRow({
          repo: body.folder,
          sessionId: sid,
          branch: body.title ?? 'session',
        });
      else if (body.worktreeId)
        wt = putWorktree({ ...worktree(body.worktreeId), leasedBy: sid, updatedAt: ts() });
      const s = codeSession({
        id: sid,
        title: body.title ?? null,
        environmentId: body.environmentId ?? null,
        folder: { path: body.folder, projectFolderId: null },
        worktreeId: wt?.id ?? null,
        permissionMode: body.permissionMode ?? 'manual',
        model: body.model ?? null,
        createdAt: ts(),
        updatedAt: ts(),
      });
      if (wt) st.inUse = [...st.inUse, wt.id];
      if (body.budgets)
        st.budgets[sid] = budget({
          limits: {
            timeSeconds: body.budgets.timeSeconds ?? null,
            tokens: body.budgets.tokens ?? null,
            costUsd: body.budgets.costUsd ?? null,
          },
        });
      st.created.push({ ...(input as Record<string, unknown>) });
      m5.sessions = [s, ...m5.sessions];
      m5.onCreate?.(s);
      return s;
    },

    // ---- environments ---------------------------------------------------------------------------
    listSavedEnvironments: async () => {
      maybeFail('listSavedEnvironments');
      return { items: m5.environments.map(saved) };
    },
    createEnvironment: async (input) => {
      maybeFail('createEnvironment');
      const req = parse(createEnvironmentSchema, input);
      const eid = newId('env');
      const at = ts();
      const base = { id: eid, label: req.label, status: 'unknown' as const, detail: null };
      switch (req.kind) {
        case 'container':
          return putEnv(
            savedEnvironment({
              ...base,
              kind: 'container',
              connection: {
                kind: 'container',
                image: req.connection.image,
                setupScript: req.connection.setupScript ?? null,
              },
              checkedAt: null,
              createdAt: at,
              updatedAt: at,
            }),
          );
        case 'ssh': {
          assertCredential(req.connection.auth, req.credential);
          st.credentials[eid] = req.credential;
          return putEnv(
            savedEnvironment({
              ...base,
              kind: 'ssh',
              connection: {
                kind: 'ssh',
                host: req.connection.host,
                port: req.connection.port,
                user: req.connection.user,
                auth: req.connection.auth,
                hostKey: req.connection.hostKey ?? null,
                root: req.connection.root ?? null,
                hasCredential: true,
              },
              checkedAt: null,
              createdAt: at,
              updatedAt: at,
            }),
          );
        }
        case 'wsl':
          knownDevice(req.connection.deviceId);
          return putEnv(
            savedEnvironment({
              ...base,
              kind: 'wsl',
              connection: { kind: 'wsl', ...req.connection },
              checkedAt: null,
              createdAt: at,
              updatedAt: at,
            }),
          );
        case 'device':
          knownDevice(req.connection.deviceId);
          return putEnv(
            savedEnvironment({
              ...base,
              kind: 'device',
              connection: {
                kind: 'device',
                deviceId: req.connection.deviceId,
                root: req.connection.root ?? null,
              },
              checkedAt: null,
              createdAt: at,
              updatedAt: at,
            }),
          );
      }
    },
    getEnvironment: async (eid) => {
      maybeFail('getEnvironment');
      return saved(env(eid));
    },
    updateEnvironment: async (eid, input) => {
      maybeFail('updateEnvironment');
      const req = parse(updateEnvironmentSchema, input);
      const before = saved(env(eid));
      if (before.builtIn)
        throw err(400, 'validation', 'the built-in environment cannot be changed', {
          reason: 'built_in',
        });
      let connection = before.connection;
      if (req.connection)
        connection = {
          ...connection,
          ...req.connection,
          kind: connection.kind,
        } as EnvironmentConnectionView;
      if (req.credential) {
        if (connection.kind !== 'ssh')
          throw err(400, 'validation', 'only SSH environments take a credential');
        assertCredential(connection.auth, parse(sshCredentialSchema, req.credential));
        st.credentials[eid] = req.credential;
      } else if (connection.kind === 'ssh' && before.connection.kind === 'ssh') {
        const a = before.connection;
        if (a.host !== connection.host || a.user !== connection.user || a.auth !== connection.auth)
          throw err(400, 'validation', 'a new host, user or sign-in method needs the credential', {
            reason: 'credential_required',
          });
      }
      if (connection.kind === 'ssh')
        connection = {
          ...connection,
          hasCredential:
            !!req.credential ||
            (before.connection.kind === 'ssh' && before.connection.hasCredential),
        };
      return putEnv({
        ...before,
        label: req.label ?? before.label,
        connection,
        status: 'unknown',
        detail: null,
        updatedAt: ts(),
      });
    },
    deleteEnvironment: async (eid) => {
      maybeFail('deleteEnvironment');
      const e = saved(env(eid));
      if (e.builtIn)
        throw err(400, 'validation', 'the built-in environment cannot be removed', {
          reason: 'built_in',
        });
      if (e.sessions)
        throw err(409, 'conflict', `${e.sessions} active Code session(s) use this environment`, {
          reason: 'in_use',
          sessions: e.sessions,
        });
      m5.environments = m5.environments.filter((x) => x.id !== eid);
      delete st.credentials[eid];
      return {};
    },
    checkEnvironment: async (eid) => {
      maybeFail('checkEnvironment');
      const e = saved(env(eid));
      const r = st.checkResults[eid] ?? { status: 'ok' as const, detail: 'all good' };
      return putEnv({ ...e, status: r.status, detail: r.detail, checkedAt: ts() });
    },
    listEnvironmentProcesses: async (eid) => {
      maybeFail('listEnvironmentProcesses');
      env(eid);
      return { items: st.processes.filter((p) => p.environmentId === eid) };
    },
    readEnvironmentOutput: async (eid, pid, offset = 0) => {
      maybeFail('readEnvironmentOutput');
      env(eid);
      const p = st.processes.find((x) => x.id === pid && x.environmentId === eid);
      if (!p) throw notFound('no such exec session');
      const out = st.outputs[pid] ?? { data: '', dropped: 0 };
      const from = Math.max(offset, out.dropped);
      return {
        processId: pid,
        data: out.data.slice(from - out.dropped),
        offset: out.dropped + out.data.length,
        dropped: offset < out.dropped ? out.dropped : 0,
        running: p.running,
        exitCode: p.exitCode,
      };
    },
    listWslDistros: async (did) => {
      maybeFail('listWslDistros');
      const d = st.devices.find((x) => x.id === did);
      if (!d) throw err(404, 'not_found', 'device not found');
      if (!/^win/i.test(d.platform ?? ''))
        throw err(400, 'capability_missing', 'WSL is available only on Windows devices', {
          reason: 'not_windows',
        });
      return { items: st.wslDistros[did] ?? [] };
    },
    listEnvironmentDevices: async () => {
      maybeFail('listEnvironmentDevices');
      return { items: st.devices };
    },

    // ---- Git hosts ----------------------------------------------------------------------------
    listGitHosts: async () => {
      maybeFail('listGitHosts');
      return { items: st.gitHosts };
    },
    createGitHost: async (input) => {
      maybeFail('createGitHost');
      const req = parse(createGitHostSchema, input);
      const webUrl = (req.webUrl ?? 'https://github.com').replace(/\/+$/, '');
      if (st.gitHosts.some((h) => h.webUrl === webUrl))
        throw err(409, 'conflict', `${webUrl} is already connected`, { reason: 'duplicate' });
      if (st.rejectedTokens.includes(req.token))
        throw err(400, 'validation', 'the Git host rejected the token', {
          reason: 'token_rejected',
        });
      const h = gitHost({
        id: newId('gh'),
        label: req.label ?? new URL(webUrl).host,
        webUrl,
        apiUrl: (req.apiUrl ?? 'https://api.github.com').replace(/\/+$/, ''),
        login: 'octo',
        checkedAt: ts(),
        createdAt: ts(),
      });
      st.hostTokens[h.id] = req.token;
      st.gitHosts = [...st.gitHosts, h];
      return h;
    },
    checkGitHost: async (hid) => {
      maybeFail('checkGitHost');
      const h = st.gitHosts.find((x) => x.id === hid);
      if (!h) throw notFound('Git host not found');
      const next = { ...h, status: 'ok' as const, detail: null, checkedAt: ts() };
      st.gitHosts = st.gitHosts.map((x) => (x.id === hid ? next : x));
      return next;
    },
    deleteGitHost: async (hid) => {
      maybeFail('deleteGitHost');
      if (!st.gitHosts.some((x) => x.id === hid)) throw notFound('Git host not found');
      const open = st.pullRequests.filter((p) => p.hostId === hid && p.state === 'open').length;
      if (open)
        throw err(409, 'conflict', 'pull requests opened through this host are still open', {
          reason: 'in_use',
          pullRequests: open,
        });
      st.gitHosts = st.gitHosts.filter((x) => x.id !== hid);
      delete st.hostTokens[hid];
      return {};
    },

    // ---- worktrees ----------------------------------------------------------------------------
    listWorktrees: async (q = {}) => {
      maybeFail('listWorktrees');
      const status = q.status ?? 'active';
      return {
        items: st.worktrees.filter(
          (w) =>
            (!q.repo || w.repoPath === q.repo) &&
            (status === 'all' ||
              (status === 'active' ? w.status !== 'removed' : w.status === status)),
        ),
      };
    },
    createWorktree: async (input) => {
      maybeFail('createWorktree');
      const req = parse(createWorktreeSchema, input);
      return createWorktreeRow({
        repo: req.repo,
        ...(req.sessionId ? { sessionId: req.sessionId } : {}),
        ...(req.branch ? { branch: req.branch } : {}),
        ...(req.ttlMinutes ? { ttlMinutes: req.ttlMinutes } : {}),
        ...(req.removeOldest ? { removeOldest: true } : {}),
      });
    },
    renewWorktree: async (wid, ttlMinutes) => {
      maybeFail('renewWorktree');
      const w = worktree(wid);
      if (!w.leasedBy)
        throw err(409, 'conflict', 'this worktree is not leased', { reason: 'not_leased' });
      const expires = new Date(Date.parse(ts()) + (ttlMinutes ?? 60) * 60_000).toISOString();
      return putWorktree({ ...w, leaseExpiresAt: expires });
    },
    releaseWorktree: async (wid) => {
      maybeFail('releaseWorktree');
      const w = worktree(wid);
      if (st.inUse.includes(wid))
        throw err(409, 'conflict', 'a Code session works in this worktree; archive it first', {
          reason: 'in_use',
        });
      return putWorktree({ ...w, leasedBy: null, leaseExpiresAt: null, status: 'released' });
    },
    removeWorktree: async (wid, force = false) => {
      maybeFail('removeWorktree');
      const w = worktree(wid);
      if (w.status === 'removed') return { ...w };
      if (st.inUse.includes(wid))
        throw err(409, 'conflict', 'a Code session works in this worktree; archive it first', {
          reason: 'in_use',
        });
      if (w.leasedBy)
        throw err(409, 'conflict', 'this worktree is leased; release it first', {
          reason: 'leased',
          sessionId: w.leasedBy,
        });
      if (!force && w.dirty)
        throw err(409, 'conflict', 'this worktree has uncommitted changes', { reason: 'dirty' });
      return putWorktree({ ...w, status: 'removed', dirty: false, updatedAt: ts() });
    },

    // ---- session extras, budgets, branch ------------------------------------------------------
    getCodeSessionExtras: async (sid) => {
      maybeFail('getCodeSessionExtras');
      const s = session(sid);
      const e = envOf(s);
      return {
        sessionId: sid,
        environment: e ? { id: e.id, kind: e.kind, label: e.label } : null,
        parentSessionId: st.lineage[sid]?.parentSessionId ?? null,
        role: st.lineage[sid]?.role ?? null,
        setup: st.setup[sid] ?? null,
        budget: budgetOf(sid),
        pullRequest: latestPr(sid),
        lastVerify: st.verifyRuns.filter((r) => r.sessionId === sid).at(-1) ?? null,
        devServers: st.devServers.filter((d) => d.sessionId === sid),
      };
    },
    extendCodeBudget: async (sid, input) => {
      maybeFail('extendCodeBudget');
      session(sid);
      const req = parse(extendCodeBudgetSchema, input);
      const b = budgetOf(sid);
      const add = (limit: number | null, used: number, more: number | undefined) =>
        more === undefined ? limit : (limit ?? used) + more;
      const next: CodeBudgetView = {
        used: b.used,
        reached: null,
        limits: {
          timeSeconds: add(b.limits.timeSeconds, b.used.timeSeconds, req.timeSeconds),
          tokens: add(b.limits.tokens, b.used.tokens, req.tokens),
          costUsd: add(b.limits.costUsd, b.used.costUsd, req.costUsd),
        },
      };
      st.budgets[sid] = next;
      return next;
    },
    createCodeBranch: async (sid, name) => {
      maybeFail('createCodeBranch');
      const s = session(sid);
      if (remote(s)) throw notOnHub();
      if (!s.repo) throw err(400, 'validation', 'the session folder is not a Git repository');
      const slug =
        name
          .replace(/^nova\//, '')
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^[-.]+|[-.]+$/g, '') || 'change';
      const branch = `nova/${slug}`;
      st.branches.push({ sessionId: sid, name });
      touchSession(sid, { repo: { ...s.repo, branch } });
      return { branch, from: s.repo.branch };
    },

    // ---- push and pull requests ---------------------------------------------------------------
    pushCodeSession: async (sid, input = {}) => {
      maybeFail('pushCodeSession');
      const s = session(sid);
      const req = parse(pushSchema, input);
      const branch = guardPush(s, req);
      st.pushes.push({ sessionId: sid, body: { ...req } });
      return {
        sessionId: sid,
        remote: req.remote ?? 'origin',
        branch,
        sha: '1f2e3d4c5b6a79881706f5e4d3c2b1a098765432',
        hooksRan: false,
        hooksNote: null,
      };
    },
    openPullRequest: async (sid, input) => {
      maybeFail('openPullRequest');
      const s = session(sid);
      const req = parse(createPullRequestSchema, input);
      if (remote(s)) throw notOnHub();
      const host = req.hostId ? st.gitHosts.find((h) => h.id === req.hostId) : st.gitHosts[0];
      if (!host)
        throw err(400, 'validation', 'connect a Git host for this remote first', {
          reason: 'no_git_host',
        });
      const repo = req.repo ?? st.remoteRepo;
      if (!repo)
        throw err(400, 'validation', 'the remote does not name a repository; give `repo`', {
          reason: 'repo_unknown',
        });
      const base = req.base ?? st.defaultBranch;
      const head = s.repo?.branch ?? null;
      if (head === base)
        throw err(400, 'validation', `the session works on ${base}`, {
          reason: 'same_branch',
          branch: base,
        });
      guardPush(s, req.confirmBranch !== undefined ? { confirmBranch: req.confirmBranch } : {});
      st.pushes.push({ sessionId: sid, body: { confirmBranch: req.confirmBranch } });
      const known = st.pullRequests.find(
        (p) => p.sessionId === sid && p.headBranch === head && p.state === 'open',
      );
      if (known) return { ...known };
      const number = 12 + st.pullRequests.length;
      const pr = pullRequest(sid, {
        id: newId('pr'),
        hostId: host.id,
        repo,
        number,
        url: `${host.webUrl}/${repo}/pull/${number}`,
        title: req.title,
        headBranch: head ?? 'HEAD',
        baseBranch: base,
        ci: { status: 'queued', checks: [] },
        polledAt: null,
        createdAt: ts(),
        updatedAt: ts(),
      });
      st.pullRequests = [...st.pullRequests, pr];
      touchSession(sid, { pullRequestUrl: pr.url, ciStatus: 'queued' });
      return pr;
    },
    getPullRequest: async (sid) => {
      maybeFail('getPullRequest');
      session(sid);
      const pr = latestPr(sid);
      if (!pr) throw notFound('this session has no pull request');
      return pr;
    },
    refreshPullRequest: async (sid) => {
      maybeFail('refreshPullRequest');
      session(sid);
      const pr = latestPr(sid);
      if (!pr) throw notFound('this session has no pull request');
      const next = { ...pr, polledAt: ts() };
      st.pullRequests = st.pullRequests.map((p) => (p.id === pr.id ? next : p));
      return next;
    },

    // ---- dev servers --------------------------------------------------------------------------
    listDevServers: async (sid) => {
      maybeFail('listDevServers');
      const s = session(sid);
      return {
        candidates: remote(s) ? [] : (st.candidates[sid] ?? []),
        items: st.devServers.filter((d) => d.sessionId === sid),
      };
    },
    startDevServer: async (sid, input = {}) => {
      maybeFail('startDevServer');
      const s = session(sid);
      if (remote(s))
        throw err(400, 'capability_missing', 'dev servers run only for folders on the Hub yet', {
          reason: 'remote_environment',
        });
      const list = st.candidates[sid] ?? [];
      const c = input.candidateId ? list.find((x) => x.id === input.candidateId) : list[0];
      if (!c)
        throw err(
          input.candidateId ? 404 : 400,
          input.candidateId ? 'not_found' : 'validation',
          'no dev server found',
          {
            reason: 'no_dev_server',
          },
        );
      const live = st.devServers.filter(
        (d) => d.sessionId === sid && (d.status === 'running' || d.status === 'starting'),
      );
      const same = live.find((d) => d.candidateId === c.id);
      if (same) return { ...same };
      if (live.length >= MAX_DEV_SERVERS)
        throw err(409, 'conflict', 'at most 4 dev servers run per session', {
          reason: 'too_many_dev_servers',
        });
      if (!st.sandbox)
        throw err(409, 'sandbox_unavailable', 'no sandbox is available to run the dev server');
      const port = input.port ?? c.port ?? 3000;
      const base = devServer(sid, {
        id: newId('ds'),
        candidateId: c.id,
        label: c.label,
        command: `${c.command} --port ${port}`,
        port,
        startedAt: ts(),
      });
      if (st.devServerExit !== null) {
        const failed = {
          ...base,
          status: 'failed' as const,
          url: null,
          exitCode: 1,
          stoppedAt: ts(),
        };
        st.devServers = [...st.devServers, failed];
        const output = st.devServerExit;
        st.devServerExit = null;
        throw err(409, 'conflict', 'the dev server exited at once (exit 1)', {
          reason: 'dev_server_exited',
          output,
          server: failed,
        });
      }
      const view = { ...base, url: `http://127.0.0.1:${port}/` };
      st.devServers = [...st.devServers, view];
      return view;
    },
    stopDevServer: async (sid, serverId) => {
      maybeFail('stopDevServer');
      session(sid);
      const d = st.devServers.find((x) => x.id === serverId && x.sessionId === sid);
      if (!d) throw notFound('dev server not found');
      const next = { ...d, status: 'stopped' as const, stoppedAt: ts() };
      st.devServers = st.devServers.map((x) => (x.id === serverId ? next : x));
      return next;
    },
    stopAllDevServers: async (sid) => {
      maybeFail('stopAllDevServers');
      session(sid);
      const at = ts();
      st.devServers = st.devServers.map((d) =>
        d.sessionId === sid && (d.status === 'running' || d.status === 'starting')
          ? { ...d, status: 'stopped' as const, stoppedAt: at }
          : d,
      );
      return { items: st.devServers.filter((d) => d.sessionId === sid) };
    },

    // ---- auto-verify --------------------------------------------------------------------------
    listVerifyRuns: async (sid) => {
      maybeFail('listVerifyRuns');
      session(sid);
      return {
        items: st.verifyRuns
          .filter((r) => r.sessionId === sid)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      };
    },
    runVerify: async (sid) => {
      maybeFail('runVerify');
      session(sid);
      if (st.verifyRuns.some((r) => r.sessionId === sid && r.status === 'running'))
        throw err(409, 'conflict', 'the checks are already running', { reason: 'verify_running' });
      const r = verifyRun(sid, {
        id: newId('vr'),
        trigger: 'manual',
        status: 'running',
        checks: [],
        createdAt: ts(),
        completedAt: null,
      });
      st.verifyRuns = [...st.verifyRuns, r];
      return { ...r };
    },
    getVerifyRun: async (sid, vid) => {
      maybeFail('getVerifyRun');
      session(sid);
      const r = st.verifyRuns.find((x) => x.id === vid && x.sessionId === sid);
      if (!r) throw notFound('verify run not found');
      return { ...r };
    },

    // ---- side questions -----------------------------------------------------------------------
    askCodeSession: async (sid, question) => {
      maybeFail('askCodeSession');
      session(sid);
      if (!question.trim()) throw err(400, 'validation', 'Too small');
      st.asks.push({ sessionId: sid, question });
      return { sessionId: sid, answer: st.answer, model: 'pa1/mock-smart' };
    },
  };
}

/** Finish the running verify run of a session the way `nextVerify` says. */
export function finishVerify(st: M6CodeState, sessionId: string): VerifyRunView | null {
  const r = st.verifyRuns.find((x) => x.sessionId === sessionId && x.status === 'running');
  if (!r || !st.nextVerify) return null;
  const done: VerifyRunView = {
    ...r,
    status: st.nextVerify.status,
    checks: st.nextVerify.checks,
    completedAt: '2026-10-02T09:10:00.000Z',
  };
  st.verifyRuns = st.verifyRuns.map((x) => (x.id === r.id ? done : x));
  return done;
}

// ---- test helpers -------------------------------------------------------------------------------

let seq = 0;
const nextId = (p: string) => `${p}-m6-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 0, clock++)).toISOString();

export type CodeM6Mocks = M6CodeFake &
  Record<keyof M6CodeFake, Mock<(...args: never[]) => unknown>>;

/**
 * The main fake Hub with Code sessions (code-helpers' `codeHub`) and the M6 part spread over its
 * client, as `createApi` will. `failNext` makes the next call of an M6 method fail.
 */
export type M6HubOptions = Parameters<typeof codeHub>[1] & {
  m6?: Partial<M6CodeState>;
  /** More sessions besides the opened one (openM6Session). */
  others?: CodeSessionView[];
};

export function m6CodeHub(sessions: CodeSessionView[], opts: M6HubOptions = {}) {
  const hub = codeHub(sessions, opts);
  const state = m6CodeState(opts.m6);
  const failNext: Partial<Record<keyof M6CodeFake, Error>> = {};
  const hubFail = hub.state.failNext as Partial<Record<string, Error>>;
  const impl = m6CodeImpl(state, {
    id: nextId,
    ts: nextTs,
    maybeFail: (name) => {
      const e = failNext[name] ?? hubFail[name];
      if (e) {
        delete failNext[name];
        delete hubFail[name];
        throw e;
      }
    },
    m5: hub.state.m5code,
  });
  const api = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as CodeM6Mocks;
  Object.assign(hub.api, api);
  return { hub, m6: state, api, failNext };
}

/** Render the app at `path` with the M6 Code part wired in. */
export async function renderM6(
  path: string,
  sessions: CodeSessionView[] = [],
  opts: M6HubOptions = {},
) {
  const parts = m6CodeHub(sessions, opts);
  const r = await renderApp({ hub: parts.hub, path });
  return { ...r, ...parts };
}

/** Open one Code session at /code/:id with the M6 part wired in. */
export async function openM6Session(over: Partial<CodeSessionView> = {}, opts: M6HubOptions = {}) {
  const s = codeSession(over);
  const parts = m6CodeHub([s, ...(opts.others ?? [])], opts);
  const r = await renderApp({ hub: parts.hub, path: `/code/${s.id}` });
  const view = await screen.findByRole('region', { name: `Code session: ${sessionTitle(s)}` });
  await waitFor(() => expect(parts.api.getCodeSessionExtras).toHaveBeenCalled());
  return { ...r, ...parts, s, view };
}
