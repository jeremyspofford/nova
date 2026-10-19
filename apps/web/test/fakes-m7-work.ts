// The fake Hub's M7 work part: the cloud runner, the M7 Code additions (handoff, merges, best-of-N
// attempts), the flagged features (script runs, agent adapters, delegations) and image generation,
// in memory, with the Hub's rules from apps/hub/src/{cloudrun,code,flagged,tools}.ts and the core
// services behind them:
// - runner (after its security review): an environment with network `setup` or `on` is refused
//   (400 `cloud_network_off`) unless `cloud.runner.unrestrictedNetwork` is on, and repository
//   URLs with credentials are refused (`credentials_in_url`).
// - runner: PUT checks the URL (https://, http:// only to this machine) and the token format,
//   needs a token unless one is stored (400 `token_required`), and refuses to turn on a runner that
//   fails its test (400 `runner_test_failed` with `test`); PATCH on needs it set up (400
//   `runner_unconfigured`) and a passing test; the view's state is `unconfigured` without URL or
//   token, `disabled` while off. Creating an environment needs the runner on (400
//   capability_missing `runner_unconfigured` / `runner_disabled`) and disk within the cap
//   (`over_cap`); deleting one sessions use is 409 `in_use`; rebuild and restore are 409 `busy`
//   while commands run; caps on an ended run are 409 `ended`, and a capped run with room again is
//   active; artifacts need the run's thread; a Work run needs a ready environment (409
//   `not_ready`).
// - handoff: 409 `handoff_running`, `same_location`; worktree targets for a session on another
//   machine 400 `worktree_unavailable`; a move starts `pending` and ends as the test settles it
//   (`settleHandoff`). Merges: sessions on another machine 400 `remote_environment`; scripted
//   conflicts refuse (409 `merge_conflict` with `mergeId` and `paths`, the merge kept as
//   `refused`) or write markers (`conflicted`); resolve is 409 `merge_conflicts` while markers are
//   left; abort of a settled merge 409 `merge_settled`. Attempts: 400 `remote_environment`,
//   `no_commits`; apply 409 `attempts_settled`, a scripted conflict 409 `merge_conflict`.
// - flagged: every route answers 404 "… turned off" while its setting is off, except reading and
//   cancelling one delegation; adapters refuse `permissionRouting: agent` (400
//   `permission_routing`), a secret reference outside their own vault part (400
//   `foreign_secret`) and a name in use (409); delegations refuse a turned-off adapter and a
//   second agent in a session (409).
// - images: `image.generate` is listed only while a provider can make images; a generated image
//   is saved as an image artifact of the thread; an approval answers like the 202 of the Hub.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m7work: M7WorkState`,
// `createHub` defaults it to `m7WorkState()`, and `impl` spreads `...m7WorkImpl(state.m7work, {
// id, ts: () => ts(), maybeFail, setting: (k) => resolveSetting(k, layers()).value, sessions: ()
// => state.m5code.sessions, addArtifact: (a) => { state.m3.artifacts = [...state.m3.artifacts,
// a]; } })`. Until then tests use `createWorkHub()` / `renderWithWork()` / `openM7Session()`.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { expect, vi, type Mock } from 'vitest';
import {
  createAgentAdapterSchema,
  isRunnerUrl,
  repoUrlHasCredentials,
  resolveSetting,
  runnerTokenSchema,
  type AgentAdapterCheck,
  type AgentAdapterView,
  type ArtifactView,
  type CloudEnvironmentView,
  type CloudFileView,
  type CloudRunView,
  type CloudRunnerTestView,
  type CloudRunnerView,
  type CloudSnapshotView,
  type CloudWorkView,
  type CodeAttemptSetView,
  type CodeAttemptView,
  type CodeMergeView,
  type CodeSessionView,
  type DelegationView,
  type HandoffReason,
  type MergeConflictView,
  type SavedEnvironmentView,
  type ScriptRunView,
  type SessionHandoffView,
  type SettingKey,
  type SettingValue,
  type ToolView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { CloudApi } from '../src/cloud/api.ts';
import type { CodeM7Api } from '../src/code/api-m7.ts';
import { sessionTitle } from '../src/code/labels.ts';
import type { FlaggedApi } from '../src/flagged/api.ts';
import type { ImagesApi } from '../src/images/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { codeSession } from './fakes-m5-code.ts';
import { m6CodeHub, type M6HubOptions } from './fakes-m6-code.ts';
import { renderApp } from './render.tsx';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;
const nid = (p: string) => `${p}-m7w-${++n}`;

export type M7WorkApi = CloudApi & CodeM7Api & FlaggedApi & ImagesApi;

// ---- builders ----------------------------------------------------------------------------------

export const GOOD_TOKEN = `nvrun_${'a'.repeat(43)}`;

export function runnerTest(over: Partial<CloudRunnerTestView> = {}): CloudRunnerTestView {
  return {
    ok: true,
    latencyMs: 42,
    version: '0.7.0',
    substrate: { kind: 'bubblewrap', ok: true, detail: 'bubblewrap 0.9' },
    detail: 'runner 0.7.0; bubblewrap 0.9',
    ...over,
  };
}

export function cloudEnv(over: Partial<CloudEnvironmentView> = {}): CloudEnvironmentView {
  const id = over.id ?? nid('cenv');
  return {
    id,
    label: 'App in the cloud',
    status: 'ok',
    detail: null,
    connection: {
      kind: 'cloud',
      runnerEnvironmentId: `r-${id}`,
      repoUrls: ['https://github.com/team/app.git'],
      setupScript: 'npm ci',
      baseImage: null,
      caches: ['npm'],
      network: 'off',
      diskMb: 10_240,
      folder: '/workspace/app',
    },
    runner: {
      status: 'ready',
      detail: null,
      substrate: 'bubblewrap',
      repos: [{ name: 'app', path: '/workspace/app', ref: 'main', head: 'abcdef1234567' }],
      caches: [{ name: 'npm', path: '/cache/npm' }],
      setup: {
        status: 'ok',
        exitCode: 0,
        log: 'added 120 packages',
        startedAt: T0,
        endedAt: T0,
      },
      usage: { diskBytes: 512 * 1024 * 1024 },
      caps: { diskBytes: 10 * 1024 * 1024 * 1024 },
      runs: { active: 0 },
      processes: { running: 0 },
      readyAt: T0,
    },
    sessions: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function cloudRun(over: Partial<CloudRunView> = {}): CloudRunView {
  return {
    id: nid('crun'),
    environmentId: 'cenv',
    threadId: null,
    kind: 'work',
    workRunId: null,
    sessionId: null,
    status: 'active',
    reason: null,
    caps: { cpuSeconds: 3600, wallSeconds: 14_400 },
    usage: { cpuSeconds: 600, wallSeconds: 1200, commands: 4 },
    warnings: [],
    createdAt: T0,
    updatedAt: T0,
    endedAt: null,
    ...over,
  };
}

export function snapshotView(over: Partial<CloudSnapshotView> = {}): CloudSnapshotView {
  return {
    id: nid('snap'),
    environmentId: 'cenv',
    label: 'Before the upgrade',
    reason: 'manual',
    sizeBytes: 3 * 1024 * 1024,
    createdAt: T0,
    restoredAt: null,
    ...over,
  };
}

export function handoffView(over: Partial<SessionHandoffView> = {}): SessionHandoffView {
  return {
    id: nid('ho'),
    threadId: 't-cs',
    sessionId: 'cs',
    from: 'hub',
    to: 'environment:env',
    fromLabel: 'This Hub: /home/me/app',
    toLabel: 'Build box: /srv/app',
    status: 'completed',
    reason: null,
    detail: null,
    source: 'keep',
    git: {
      branch: 'feature/x',
      head: 'abc1234def5678',
      tree: 'tree1',
      patchSha256: 'p'.repeat(64),
      patchBytes: 300,
      files: 2,
      bundleSha256: null,
      bundleCommits: 0,
      worktreeId: null,
      stateHash: 'f00dfeedbeefcafe0123',
    },
    folder: '/srv/app',
    createdAt: T0,
    completedAt: T0,
    ...over,
  };
}

export function conflictView(over: Partial<MergeConflictView> = {}): MergeConflictView {
  return {
    path: 'src/app.ts',
    binary: false,
    base: 'const a = 1;\n',
    ours: 'const a = 2;\n',
    theirs: 'const a = 3;\n',
    merged:
      '<<<<<<< ours\nconst a = 2;\n||||||| base\nconst a = 1;\n=======\nconst a = 3;\n>>>>>>> theirs\n',
    truncated: false,
    ...over,
  };
}

export function mergeView(over: Partial<CodeMergeView> = {}): CodeMergeView {
  return {
    id: nid('mg'),
    sessionId: 'cs',
    source: { kind: 'session', ref: 'cs-other' },
    status: 'applied',
    baseSha: 'abc1234',
    files: [{ path: 'src/app.ts', result: 'merged', conflicts: 0 }],
    conflicts: [],
    createdAt: T0,
    resolvedAt: null,
    ...over,
  };
}

export function attemptView(index: number, over: Partial<CodeAttemptView> = {}): CodeAttemptView {
  return {
    id: nid('att'),
    index,
    sessionId: nid('cs-att'),
    threadId: nid('t-att'),
    worktreeId: nid('wt'),
    branch: `nova/attempt-${index + 1}`,
    model: null,
    status: 'done',
    files: [
      {
        path: `src/f${index}.ts`,
        kind: 'modify',
        additions: 3 + index,
        deletions: 1,
        binary: false,
      },
    ],
    additions: 3 + index,
    deletions: 1,
    patch: `--- a/src/f${index}.ts\n+++ b/src/f${index}.ts\n@@ -1 +1 @@\n-old\n+new ${index}\n`,
    patchTruncated: false,
    tests: {
      id: nid('vr'),
      sessionId: 'x',
      trigger: 'auto',
      status: index === 0 ? 'passed' : 'failed',
      checks: [],
      createdAt: T0,
      completedAt: T0,
    },
    budget: {
      limits: { timeSeconds: 1800, tokens: null, costUsd: null },
      used: {
        timeSeconds: 300 + index * 60,
        tokens: 12_000 * (index + 1),
        costUsd: 0.12 * (index + 1),
      },
      reached: null,
    },
    reply: `Attempt ${index + 1} is done.`,
    ...over,
  };
}

export function attemptSet(over: Partial<CodeAttemptSetView> = {}): CodeAttemptSetView {
  return {
    id: nid('set'),
    sessionId: 'cs',
    objective: 'Make the parser faster',
    baseSha: 'abc1234def',
    status: 'ready',
    attempts: [attemptView(0), attemptView(1)],
    appliedAttemptId: null,
    mergeId: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function scriptRun(over: Partial<ScriptRunView> = {}): ScriptRunView {
  return {
    id: nid('sr'),
    threadId: 't-cs',
    turnId: 'turn1',
    status: 'ok',
    errorCode: null,
    calls: 2,
    cpuMs: 140,
    codeSha256: 'c'.repeat(64),
    createdAt: T0,
    endedAt: T0,
    nested: [
      {
        callId: nid('call'),
        tool: 'fs.read',
        status: 'ok',
        decision: 'allow',
        approvalId: null,
        createdAt: T0,
        durationMs: 12,
      },
      {
        callId: nid('call'),
        tool: 'fs.write',
        status: 'denied',
        decision: 'deny',
        approvalId: null,
        createdAt: T0,
        durationMs: 3,
      },
    ],
    ...over,
  };
}

export function adapterView(over: Partial<AgentAdapterView> = {}): AgentAdapterView {
  const id = over.id ?? nid('ad');
  return {
    id,
    name: 'Coder',
    command: 'coder-acp',
    args: ['--acp'],
    env: { CODER_KEY: `secret://agent-adapter/${id}/env/CODER_KEY` },
    network: ['api.coder.example'],
    permissionRouting: 'client',
    enabled: true,
    lastCheck: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function delegationView(over: Partial<DelegationView> = {}): DelegationView {
  return {
    id: nid('dl'),
    threadId: 't-cs',
    adapterId: 'ad',
    adapterName: 'Coder',
    status: 'completed',
    prompt: 'Fix the flaky test',
    output: 'I fixed the test.',
    stopReason: 'end_turn',
    error: null,
    agent: { name: 'coder', version: '1.2' },
    permissionRequests: 3,
    operations: 5,
    createdAt: T0,
    endedAt: T0,
    ...over,
  };
}

// ---- state -------------------------------------------------------------------------------------

export interface M7WorkState {
  // runner
  runner: { enabled: boolean; url: string; hasToken: boolean; state: 'unknown' | 'ok' | 'error' };
  runnerVersion: string | null;
  /** What the next runner test answers. */
  test: CloudRunnerTestView;
  envs: CloudEnvironmentView[];
  runs: CloudRunView[];
  snapshots: CloudSnapshotView[];
  /** Files by path, per environment id. */
  files: Record<string, Record<string, CloudFileView>>;
  /** Environments whose commands are running (rebuild and restore answer 409 `busy`). */
  busy: string[];
  /** Work runs started on a cloud environment. */
  work: CloudWorkView[];
  // code
  handoffs: SessionHandoffView[];
  merges: CodeMergeView[];
  /** The conflicts the next merge (or attempt apply) meets; none merges cleanly. */
  conflicts: MergeConflictView[];
  /** Files still holding markers when a merge is marked resolved. */
  markersLeft: string[];
  attemptSets: CodeAttemptSetView[];
  /** Sessions whose folder is on another machine (merges and attempts refuse them). */
  remoteSessions: string[];
  /** Sessions whose repository has no commit yet (attempts refuse them). */
  noCommits: string[];
  // flagged
  scriptRuns: ScriptRunView[];
  adapters: AgentAdapterView[];
  delegations: DelegationView[];
  /** What the next adapter check answers. */
  check: Omit<AgentAdapterCheck, 'at'>;
  // images
  imageTool: boolean;
  /** How the next image request ends. */
  imageOutcome: 'ok' | 'approval' | 'error';
  // spies on what the Hub received
  saved: { environments: unknown[]; adapters: unknown[] };
}

export function m7WorkState(init: Partial<M7WorkState> = {}): M7WorkState {
  return {
    runner: { enabled: false, url: '', hasToken: false, state: 'unknown' },
    runnerVersion: null,
    test: runnerTest(),
    envs: [],
    runs: [],
    snapshots: [],
    files: {},
    busy: [],
    work: [],
    handoffs: [],
    merges: [],
    conflicts: [],
    markersLeft: [],
    attemptSets: [],
    remoteSessions: [],
    noCommits: [],
    scriptRuns: [],
    adapters: [],
    delegations: [],
    check: { ok: true, agent: { name: 'coder', version: '1.2' }, protocolVersion: 1, reason: null },
    imageTool: false,
    imageOutcome: 'ok',
    saved: { environments: [], adapters: [] },
    ...init,
  };
}

/** A runner set up, on and passing its test. */
export function runnerOn(): M7WorkState['runner'] {
  return { enabled: true, url: 'https://runner.example.com', hasToken: true, state: 'ok' };
}

// ---- errors ------------------------------------------------------------------------------------

function err(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError(status, {
    code,
    message,
    retryable: false,
    ...(details ? { details } : {}),
  });
}
const notFound = (what = 'Not found') => err(404, 'not_found', what);

// ---- the fake ----------------------------------------------------------------------------------

export interface M7WorkHelpers {
  id: (p: string) => string;
  ts: () => string;
  maybeFail: (name: keyof M7WorkApi) => void;
  setting: <K extends SettingKey>(key: K) => SettingValue<K>;
  /** The Code sessions of the main fake (handoffs and merges read them). */
  sessions: () => CodeSessionView[];
  /** Saves an artifact where the main fake lists a thread's artifacts. */
  addArtifact: (a: ArtifactView) => void;
}

export function m7WorkImpl(st: M7WorkState, h: M7WorkHelpers): M7WorkApi {
  const { id, ts, maybeFail, setting } = h;

  const runnerView = (): CloudRunnerView => {
    const r = st.runner;
    const state = !r.url || !r.hasToken ? 'unconfigured' : !r.enabled ? 'disabled' : r.state;
    return {
      enabled: r.enabled,
      url: r.url,
      hasToken: r.hasToken,
      state,
      detail:
        state === 'unconfigured'
          ? 'no runner is set up'
          : state === 'disabled'
            ? 'the cloud runner is turned off'
            : state === 'error'
              ? st.test.detail
              : null,
      version: st.runnerVersion,
      substrate: st.runnerVersion ? st.test.substrate : null,
      checkedAt: st.runnerVersion ? ts() : null,
      caps: setting('cloud.runner.caps'),
    };
  };
  const usable = () => {
    const r = st.runner;
    if (!r.url || !r.hasToken)
      throw err(400, 'capability_missing', 'no cloud runner is set up', {
        reason: 'runner_unconfigured',
      });
    if (!r.enabled)
      throw err(400, 'capability_missing', 'the cloud runner is turned off', {
        reason: 'runner_disabled',
      });
  };
  const runTest = (): CloudRunnerTestView => {
    st.runnerVersion = st.test.version;
    st.runner = { ...st.runner, state: st.test.ok ? 'ok' : 'error' };
    return { ...st.test };
  };
  const env = (eid: string) => {
    const e = st.envs.find((x) => x.id === eid);
    if (!e) throw notFound('cloud environment not found');
    return e;
  };
  const run = (rid: string) => {
    const r = st.runs.find((x) => x.id === rid);
    if (!r) throw notFound('cloud run not found');
    return r;
  };
  const replaceRun = (r: CloudRunView) => {
    st.runs = st.runs.map((x) => (x.id === r.id ? r : x));
    return { ...r };
  };
  const session = (sid: string) => {
    const s = h.sessions().find((x) => x.id === sid);
    if (!s) throw notFound('session not found');
    return s;
  };
  const scriptsOn = () => {
    if (!setting('scripts.enabled')) throw notFound('scripted tool calls are turned off');
  };
  const agentsOn = () => {
    if (!setting('externalAgents.enabled'))
      throw notFound('external agent adapters are turned off');
  };
  const adapter = (aid: string) => {
    const a = st.adapters.find((x) => x.id === aid);
    if (!a) throw notFound('no such agent adapter');
    return a;
  };
  const storeEnv = (aid: string, envIn: Record<string, string>, saved: Record<string, string>) => {
    const own = `secret://agent-adapter/${aid}/`;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(envIn)) {
      if (value.startsWith('secret://') && !value.startsWith(own))
        throw err(400, 'validation', `env ${name}: enter the value, not a secret reference`, {
          field: `env.${name}`,
          reason: 'foreign_secret',
        });
      out[name] = value === '' && saved[name] ? saved[name] : `${own}env/${name}`;
    }
    return out;
  };
  const recordMerge = (
    sessionId: string,
    source: CodeMergeView['source'],
    onConflict: 'refuse' | 'markers',
  ): CodeMergeView => {
    const conflicts = st.conflicts;
    const m: CodeMergeView = {
      id: id('mg'),
      sessionId,
      source,
      status: conflicts.length ? (onConflict === 'markers' ? 'conflicted' : 'refused') : 'applied',
      baseSha: 'abc1234',
      files: conflicts.length
        ? conflicts.map((c) => ({
            path: c.path,
            result: c.binary ? 'binary_conflict' : 'conflict',
            conflicts: 1,
          }))
        : [{ path: 'src/app.ts', result: 'merged', conflicts: 0 }],
      conflicts,
      createdAt: ts(),
      resolvedAt: null,
    };
    st.merges = [m, ...st.merges];
    if (m.status === 'refused')
      throw err(
        409,
        'conflict',
        "the work conflicts with the session's files; nothing was written",
        {
          reason: 'merge_conflict',
          mergeId: m.id,
          paths: conflicts.map((c) => c.path),
        },
      );
    return m;
  };

  return {
    // ---- cloud runner ----------------------------------------------------------------------------
    getCloudRunner: async () => {
      maybeFail('getCloudRunner');
      return runnerView();
    },
    configureCloudRunner: async (body) => {
      maybeFail('configureCloudRunner');
      if (!body.url || !isRunnerUrl(body.url)) throw err(400, 'validation', 'not a runner URL');
      if (body.token !== undefined && !runnerTokenSchema.safeParse(body.token).success)
        throw err(400, 'validation', 'a runner token (nvrun_…)');
      if (!body.token && !st.runner.hasToken)
        throw err(400, 'validation', 'the runner token is required', { reason: 'token_required' });
      const enabled = body.enabled ?? st.runner.enabled;
      const t = runTest();
      if (enabled && !t.ok)
        throw err(400, 'validation', `the runner did not pass its test: ${t.detail}`, {
          reason: 'runner_test_failed',
          test: t,
        });
      st.runner = { ...st.runner, url: body.url, hasToken: true, enabled };
      return runnerView();
    },
    setCloudRunnerEnabled: async (enabled) => {
      maybeFail('setCloudRunnerEnabled');
      if (enabled) {
        if (!st.runner.url || !st.runner.hasToken)
          throw err(400, 'validation', 'set up the runner first', {
            reason: 'runner_unconfigured',
          });
        const t = runTest();
        if (!t.ok)
          throw err(400, 'validation', `the runner did not pass its test: ${t.detail}`, {
            reason: 'runner_test_failed',
            test: t,
          });
      }
      st.runner = { ...st.runner, enabled };
      return runnerView();
    },
    testCloudRunner: async () => {
      maybeFail('testCloudRunner');
      if (!st.runner.url || !st.runner.hasToken)
        return {
          ok: false,
          latencyMs: null,
          version: null,
          substrate: null,
          detail: 'no runner is set up',
        };
      return runTest();
    },
    forgetCloudRunner: async () => {
      maybeFail('forgetCloudRunner');
      st.runner = { enabled: false, url: '', hasToken: false, state: 'unknown' };
      st.runnerVersion = null;
      return { ok: true } as const;
    },
    listCloudEnvironments: async () => {
      maybeFail('listCloudEnvironments');
      const on = st.runner.enabled && !!st.runner.url;
      return { items: st.envs.map((e) => (on ? { ...e } : { ...e, runner: null })) };
    },
    getCloudEnvironment: async (eid) => {
      maybeFail('getCloudEnvironment');
      return { ...env(eid) };
    },
    createCloudEnvironment: async (label, connection) => {
      maybeFail('createCloudEnvironment');
      usable();
      st.saved.environments.push({ label, connection });
      if ((connection.network ?? 'off') !== 'off' && !setting('cloud.runner.unrestrictedNetwork'))
        throw err(
          400,
          'validation',
          'cloud environments get network only when cloud.runner.unrestrictedNetwork is on',
          { reason: 'cloud_network_off', field: 'network' },
        );
      if ((connection.repoUrls ?? []).some(repoUrlHasCredentials))
        throw err(400, 'validation', 'repository URLs may not carry credentials', {
          reason: 'credentials_in_url',
          field: 'repoUrls',
        });
      const caps = setting('cloud.runner.caps');
      if ((connection.diskMb ?? 0) > caps.diskMb)
        throw err(400, 'validation', `at most ${caps.diskMb} MB of disk per cloud environment`, {
          reason: 'over_cap',
          field: 'diskMb',
        });
      const e = cloudEnv({ label });
      const made: CloudEnvironmentView = {
        ...e,
        connection: {
          ...e.connection,
          repoUrls: connection.repoUrls ?? [],
          setupScript: connection.setupScript ?? null,
          baseImage: connection.baseImage ?? null,
          caches: connection.caches ?? [],
          network: connection.network ?? 'off',
          diskMb: connection.diskMb ?? caps.diskMb,
          folder: connection.folder ?? '/workspace',
        },
        runner: e.runner ? { ...e.runner, status: 'provisioning', readyAt: null } : null,
      };
      st.envs = [...st.envs, made];
      const saved: SavedEnvironmentView = {
        id: made.id,
        kind: 'cloud',
        label,
        status: 'unknown',
        detail: null,
        checkedAt: null,
        builtIn: false,
        connection: made.connection,
        sessions: 0,
        createdAt: ts(),
        updatedAt: ts(),
      };
      return saved;
    },
    deleteCloudEnvironment: async (eid) => {
      maybeFail('deleteCloudEnvironment');
      const e = env(eid);
      if (e.sessions > 0)
        throw err(409, 'conflict', 'active sessions use this environment', { reason: 'in_use' });
      st.envs = st.envs.filter((x) => x.id !== eid);
      return {};
    },
    rebuildCloudEnvironment: async (eid) => {
      maybeFail('rebuildCloudEnvironment');
      usable();
      const e = env(eid);
      if (st.busy.includes(eid))
        throw err(409, 'conflict', 'commands are running in this environment', { reason: 'busy' });
      const next: CloudEnvironmentView = {
        ...e,
        runner: e.runner
          ? { ...e.runner, status: 'provisioning', setup: { ...e.runner.setup, status: 'running' } }
          : null,
      };
      st.envs = st.envs.map((x) => (x.id === eid ? next : x));
      return { ...next };
    },
    readCloudFile: async (eid, path) => {
      maybeFail('readCloudFile');
      usable();
      env(eid);
      const f = st.files[eid]?.[path];
      if (!f) throw err(404, 'not_found', `no folder at ${path}`, { reason: 'not_a_folder' });
      return f;
    },
    listCloudSnapshots: async (eid) => {
      maybeFail('listCloudSnapshots');
      env(eid);
      return { items: st.snapshots.filter((s) => s.environmentId === eid) };
    },
    createCloudSnapshot: async (eid, label) => {
      maybeFail('createCloudSnapshot');
      usable();
      env(eid);
      const s = snapshotView({
        id: id('snap'),
        environmentId: eid,
        label: label ?? null,
        createdAt: ts(),
      });
      st.snapshots = [s, ...st.snapshots];
      return { ...s };
    },
    restoreCloudSnapshot: async (sid, keepCurrent) => {
      maybeFail('restoreCloudSnapshot');
      const s = st.snapshots.find((x) => x.id === sid);
      if (!s) throw notFound('snapshot not found');
      usable();
      if (st.busy.includes(s.environmentId))
        throw err(409, 'conflict', 'commands are running in this environment', { reason: 'busy' });
      if (keepCurrent)
        st.snapshots = [
          snapshotView({
            id: id('snap'),
            environmentId: s.environmentId,
            label: 'before restore',
            reason: 'before_restore',
            createdAt: ts(),
          }),
          ...st.snapshots,
        ];
      const next = { ...s, restoredAt: ts() };
      st.snapshots = st.snapshots.map((x) => (x.id === sid ? next : x));
      return next;
    },
    deleteCloudSnapshot: async (sid) => {
      maybeFail('deleteCloudSnapshot');
      if (!st.snapshots.some((x) => x.id === sid)) throw notFound('snapshot not found');
      st.snapshots = st.snapshots.filter((x) => x.id !== sid);
      return { ok: true } as const;
    },
    listCloudRuns: async (q = {}) => {
      maybeFail('listCloudRuns');
      return {
        items: st.runs.filter(
          (r) =>
            (!q.environmentId || r.environmentId === q.environmentId) &&
            (!q.threadId || r.threadId === q.threadId) &&
            (q.status !== 'active' || r.status === 'active' || r.status === 'capped'),
        ),
      };
    },
    getCloudRun: async (rid) => {
      maybeFail('getCloudRun');
      return { ...run(rid) };
    },
    setCloudRunCaps: async (rid, caps) => {
      maybeFail('setCloudRunCaps');
      const r = run(rid);
      if (r.status !== 'active' && r.status !== 'capped')
        throw err(409, 'conflict', 'the cloud run has ended', { reason: 'ended' });
      const next: CloudRunView = {
        ...r,
        caps: {
          cpuSeconds: caps.cpuSeconds ?? r.caps.cpuSeconds,
          wallSeconds: caps.wallSeconds ?? r.caps.wallSeconds,
        },
      };
      if (
        next.status === 'capped' &&
        next.usage.cpuSeconds < next.caps.cpuSeconds &&
        next.usage.wallSeconds < next.caps.wallSeconds
      ) {
        next.status = 'active';
        next.reason = null;
        next.warnings = [];
      }
      return replaceRun(next);
    },
    cancelCloudRun: async (rid) => {
      maybeFail('cancelCloudRun');
      const r = run(rid);
      if (r.status !== 'active' && r.status !== 'capped') return { ...r };
      return replaceRun({ ...r, status: 'cancelled', reason: 'cancelled', endedAt: ts() });
    },
    collectCloudArtifact: async (rid, body) => {
      maybeFail('collectCloudArtifact');
      const r = run(rid);
      if (!r.threadId)
        throw err(400, 'validation', 'this cloud run has no thread to keep artifacts in');
      const a: ArtifactView = {
        id: id('art'),
        threadId: r.threadId,
        messageId: null,
        kind: 'file',
        title: body.title ?? body.path.split('/').pop() ?? body.path,
        mime: 'application/octet-stream',
        language: null,
        version: 1,
        live: false,
        size: 10,
        createdAt: ts(),
        updatedAt: ts(),
      };
      h.addArtifact(a);
      return a;
    },
    startCloudWork: async (body) => {
      maybeFail('startCloudWork');
      usable();
      const e = env(body.environmentId);
      if (e.runner?.status !== 'ready')
        throw err(409, 'conflict', `the cloud environment is ${e.runner?.status ?? 'unknown'}`, {
          reason: 'not_ready',
          status: e.runner?.status,
        });
      const runId = id('run');
      const threadId = id('t-run');
      const cr = cloudRun({ id: id('crun'), environmentId: e.id, threadId, workRunId: runId });
      st.runs = [...st.runs, cr];
      const view: CloudWorkView = {
        runId,
        threadId,
        environmentId: e.id,
        cloudRun: cr,
        snapshot:
          body.snapshot === false
            ? null
            : snapshotView({ environmentId: e.id, reason: 'run_start' }),
      };
      st.work = [...st.work, view];
      return view;
    },

    // ---- Code: handoff, merges, attempts -------------------------------------------------------
    handoffCodeSession: async (sid, body) => {
      maybeFail('handoffCodeSession');
      const s = session(sid);
      if (
        st.handoffs.some(
          (x) => x.sessionId === sid && (x.status === 'pending' || x.status === 'running'),
        )
      )
        throw err(409, 'conflict', 'this session is already being handed off', {
          reason: 'handoff_running',
        });
      const to = body.to;
      if (to.worktree !== undefined && st.remoteSessions.includes(sid))
        throw err(400, 'validation', 'worktrees are only available for folders on the Hub', {
          reason: 'worktree_unavailable',
        });
      if (
        to.environmentId !== undefined &&
        to.environmentId === s.environmentId &&
        to.folder?.replace(/\/+$/, '') === s.folder.path.replace(/\/+$/, '')
      )
        throw err(409, 'conflict', 'the session already works there', { reason: 'same_location' });
      if (to.worktree === 'main' && !s.worktreeId)
        throw err(409, 'conflict', 'the session already works in the main checkout', {
          reason: 'same_location',
        });
      const v = handoffView({
        id: id('ho'),
        threadId: s.threadId,
        sessionId: sid,
        fromLabel: `This Hub: ${s.folder.path}`,
        toLabel:
          to.environmentId !== undefined
            ? `${to.environmentId}: ${to.folder ?? ''}`
            : to.worktree === 'new'
              ? 'a new worktree'
              : to.worktree === 'main'
                ? 'the main checkout'
                : 'a worktree',
        to:
          to.environmentId !== undefined
            ? `environment:${to.environmentId}`
            : `worktree:${to.worktree ?? ''}`,
        status: 'pending',
        source: body.source ?? setting('code.handoffSource'),
        git: null,
        folder: to.folder ?? null,
        createdAt: ts(),
        completedAt: null,
      });
      st.handoffs = [v, ...st.handoffs];
      return { ...v };
    },
    listCodeHandoffs: async (sid) => {
      maybeFail('listCodeHandoffs');
      session(sid);
      return { items: st.handoffs.filter((x) => x.sessionId === sid) };
    },
    getHandoff: async (hid) => {
      maybeFail('getHandoff');
      const v = st.handoffs.find((x) => x.id === hid);
      if (!v) throw notFound('handoff not found');
      return { ...v };
    },
    handoffThread: async (threadId, deviceId) => {
      maybeFail('handoffThread');
      return handoffView({ id: id('ho'), threadId, sessionId: null, to: `device:${deviceId}` });
    },
    mergeIntoSession: async (sid, from, onConflict = 'refuse') => {
      maybeFail('mergeIntoSession');
      session(sid);
      if ('sessionId' in from) {
        if (from.sessionId === sid)
          throw err(400, 'validation', 'a session cannot merge into itself', {
            reason: 'same_session',
          });
        if (st.remoteSessions.includes(sid) || st.remoteSessions.includes(from.sessionId))
          throw err(400, 'capability_missing', 'merging sessions needs both folders on the Hub', {
            reason: 'remote_environment',
          });
        return recordMerge(sid, { kind: 'session', ref: from.sessionId }, onConflict);
      }
      if (from.base && !/^[0-9a-f]{7,64}$/.test(from.base))
        throw err(400, 'validation', 'not a commit');
      return recordMerge(sid, { kind: 'patch', ref: null }, onConflict);
    },
    listMerges: async (sid) => {
      maybeFail('listMerges');
      return { items: st.merges.filter((m) => m.sessionId === sid) };
    },
    getMerge: async (sid, mid) => {
      maybeFail('getMerge');
      const m = st.merges.find((x) => x.id === mid && x.sessionId === sid);
      if (!m) throw notFound('merge not found');
      return { ...m };
    },
    resolveMerge: async (sid, mid) => {
      maybeFail('resolveMerge');
      const m = st.merges.find((x) => x.id === mid && x.sessionId === sid);
      if (!m) throw notFound('merge not found');
      if (m.status !== 'conflicted')
        throw err(409, 'conflict', `the merge is ${m.status}`, { reason: 'merge_settled' });
      if (st.markersLeft.length)
        throw err(409, 'conflict', `conflict markers are left in ${st.markersLeft.join(', ')}`, {
          reason: 'merge_conflicts',
          mergeId: mid,
          paths: st.markersLeft,
        });
      const next: CodeMergeView = { ...m, status: 'resolved', resolvedAt: ts() };
      st.merges = st.merges.map((x) => (x.id === mid ? next : x));
      return next;
    },
    abortMerge: async (sid, mid) => {
      maybeFail('abortMerge');
      const m = st.merges.find((x) => x.id === mid && x.sessionId === sid);
      if (!m) throw notFound('merge not found');
      if (m.status !== 'conflicted')
        throw err(409, 'conflict', `the merge is ${m.status}`, { reason: 'merge_settled' });
      const next: CodeMergeView = { ...m, status: 'aborted', resolvedAt: ts() };
      st.merges = st.merges.map((x) => (x.id === mid ? next : x));
      return next;
    },
    startAttempts: async (sid, body) => {
      maybeFail('startAttempts');
      session(sid);
      if (st.remoteSessions.includes(sid))
        throw err(400, 'capability_missing', 'attempts need a folder on the Hub (worktrees)', {
          reason: 'remote_environment',
        });
      if (st.noCommits.includes(sid))
        throw err(400, 'validation', 'attempts need a Git repository with a commit', {
          reason: 'no_commits',
        });
      const count = body.count ?? setting('code.attempts').count;
      const set = attemptSet({
        id: id('set'),
        sessionId: sid,
        objective: body.objective,
        status: 'running',
        attempts: Array.from({ length: count }, (_, i) =>
          attemptView(i, {
            status: 'running',
            model: body.models?.[i] ?? null,
            files: [],
            additions: 0,
            deletions: 0,
            patch: '',
            tests: null,
            reply: null,
          }),
        ),
        createdAt: ts(),
      });
      st.attemptSets = [set, ...st.attemptSets];
      return set;
    },
    listAttempts: async (sid) => {
      maybeFail('listAttempts');
      return { items: st.attemptSets.filter((s) => s.sessionId === sid) };
    },
    getAttempts: async (setId) => {
      maybeFail('getAttempts');
      const s = st.attemptSets.find((x) => x.id === setId);
      if (!s) throw notFound('attempts not found');
      return s;
    },
    applyAttempt: async (setId, body) => {
      maybeFail('applyAttempt');
      const s = st.attemptSets.find((x) => x.id === setId);
      if (!s) throw notFound('attempts not found');
      if (s.status === 'applied' || s.status === 'discarded')
        throw err(409, 'conflict', `these attempts were ${s.status}`, {
          reason: 'attempts_settled',
        });
      const chosen = s.attempts.find((a) => a.id === body.attemptId);
      if (!chosen) throw notFound('attempt not found');
      const merge = recordMerge(
        s.sessionId,
        { kind: 'attempt', ref: chosen.sessionId },
        body.onConflict ?? 'refuse',
      );
      const next: CodeAttemptSetView = {
        ...s,
        status: 'applied',
        appliedAttemptId: chosen.id,
        mergeId: merge.id,
        attempts: s.attempts.map((a) => ({
          ...a,
          status: a.id === chosen.id ? 'applied' : 'discarded',
        })),
      };
      st.attemptSets = st.attemptSets.map((x) => (x.id === setId ? next : x));
      return { set: next, merge };
    },
    discardAttempts: async (setId) => {
      maybeFail('discardAttempts');
      const s = st.attemptSets.find((x) => x.id === setId);
      if (!s) throw notFound('attempts not found');
      if (s.status === 'applied' || s.status === 'discarded') return s;
      const next: CodeAttemptSetView = {
        ...s,
        status: 'discarded',
        attempts: s.attempts.map((a) => ({ ...a, status: 'discarded' })),
      };
      st.attemptSets = st.attemptSets.map((x) => (x.id === setId ? next : x));
      return next;
    },

    // ---- flagged -------------------------------------------------------------------------------
    listScriptRuns: async (q = {}) => {
      maybeFail('listScriptRuns');
      scriptsOn();
      // Newest first, a page at a time; the cursor is the offset of the next page.
      const all = st.scriptRuns
        .filter((r) => !q.threadId || r.threadId === q.threadId)
        .sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1));
      const from = q.cursor ? Number(q.cursor.replace(/^o:/, '')) : 0;
      const limit = q.limit ?? 100;
      const page = all.slice(from, from + limit);
      return {
        items: page.map(({ nested: _nested, ...rest }) => rest),
        nextCursor: from + limit < all.length ? `o:${from + limit}` : null,
      };
    },
    getScriptRun: async (rid) => {
      maybeFail('getScriptRun');
      scriptsOn();
      const r = st.scriptRuns.find((x) => x.id === rid);
      if (!r) throw notFound('no such script run');
      return r;
    },
    listAgentAdapters: async () => {
      maybeFail('listAgentAdapters');
      agentsOn();
      return { items: st.adapters.map((a) => ({ ...a })) };
    },
    createAgentAdapter: async (body) => {
      maybeFail('createAgentAdapter');
      agentsOn();
      st.saved.adapters.push(body);
      const parsed = createAgentAdapterSchema.safeParse(body);
      if (!parsed.success)
        throw err(400, 'validation', parsed.error.issues[0]?.message ?? 'invalid');
      if (parsed.data.permissionRouting !== 'client')
        throw err(
          400,
          'validation',
          'this adapter cannot route its permission requests to Nova, so it cannot be added',
          { reason: 'permission_routing' },
        );
      if (st.adapters.some((a) => a.name === parsed.data.name))
        throw err(409, 'conflict', 'an adapter with this name exists');
      const aid = id('ad');
      const a: AgentAdapterView = {
        id: aid,
        name: parsed.data.name,
        command: parsed.data.command,
        args: parsed.data.args,
        env: storeEnv(aid, parsed.data.env, {}),
        network: parsed.data.network,
        permissionRouting: 'client',
        enabled: parsed.data.enabled,
        lastCheck: null,
        createdAt: ts(),
        updatedAt: ts(),
      };
      st.adapters = [...st.adapters, a];
      return { ...a };
    },
    updateAgentAdapter: async (aid, body) => {
      maybeFail('updateAgentAdapter');
      agentsOn();
      const a = adapter(aid);
      st.saved.adapters.push(body);
      if (body.name && body.name !== a.name && st.adapters.some((x) => x.name === body.name))
        throw err(409, 'conflict', 'an adapter with this name exists');
      const next: AgentAdapterView = {
        ...a,
        ...(body.name ? { name: body.name } : {}),
        ...(body.args ? { args: body.args } : {}),
        ...(body.env ? { env: storeEnv(aid, body.env, a.env) } : {}),
        ...(body.network ? { network: body.network } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        updatedAt: ts(),
      };
      st.adapters = st.adapters.map((x) => (x.id === aid ? next : x));
      return { ...next };
    },
    deleteAgentAdapter: async (aid) => {
      maybeFail('deleteAgentAdapter');
      agentsOn();
      adapter(aid);
      st.adapters = st.adapters.filter((x) => x.id !== aid);
      return { ok: true } as const;
    },
    checkAgentAdapter: async (aid, sid) => {
      maybeFail('checkAgentAdapter');
      agentsOn();
      const a = adapter(aid);
      session(sid);
      const c: AgentAdapterCheck = { ...st.check, at: ts() };
      st.adapters = st.adapters.map((x) => (x.id === a.id ? { ...x, lastCheck: c } : x));
      return c;
    },
    listDelegations: async (sid) => {
      maybeFail('listDelegations');
      agentsOn();
      const s = session(sid);
      return { items: st.delegations.filter((d) => d.threadId === s.threadId) };
    },
    startDelegation: async (sid, body) => {
      maybeFail('startDelegation');
      agentsOn();
      const s = session(sid);
      const a = adapter(body.adapterId);
      if (!a.enabled) throw err(409, 'conflict', 'the adapter is turned off');
      if (
        st.delegations.some(
          (d) => d.threadId === s.threadId && (d.status === 'starting' || d.status === 'running'),
        )
      )
        throw err(409, 'conflict', 'an external agent is already working in this session');
      const d = delegationView({
        id: id('dl'),
        threadId: s.threadId,
        adapterId: a.id,
        adapterName: a.name,
        status: 'starting',
        prompt: body.prompt,
        output: null,
        stopReason: null,
        agent: null,
        permissionRequests: 0,
        operations: 0,
        createdAt: ts(),
        endedAt: null,
      });
      st.delegations = [d, ...st.delegations];
      return { ...d };
    },
    getDelegation: async (did) => {
      maybeFail('getDelegation');
      const d = st.delegations.find((x) => x.id === did);
      if (!d) throw notFound('no such delegation');
      return { ...d };
    },
    cancelDelegation: async (did) => {
      maybeFail('cancelDelegation');
      const d = st.delegations.find((x) => x.id === did);
      if (!d) throw notFound('no such delegation');
      if (d.status !== 'starting' && d.status !== 'running') return { ...d };
      const next: DelegationView = {
        ...d,
        status: 'cancelled',
        stopReason: 'cancelled',
        endedAt: ts(),
      };
      st.delegations = st.delegations.map((x) => (x.id === did ? next : x));
      return next;
    },

    // ---- images --------------------------------------------------------------------------------
    imageGenerationTool: async () => {
      maybeFail('imageGenerationTool');
      if (!st.imageTool) return null;
      const t: ToolView = {
        name: 'image.generate',
        title: 'Generate an image',
        description: 'Generate an image from a text prompt.',
        source: 'builtin',
        inputSchema: { type: 'object' },
        userDefault: null,
        effective: { effect: 'allow', reason: 'default', tier: 'pre_approvable' },
      };
      return t;
    },
    generateImage: async (threadId, prompt, size) => {
      maybeFail('generateImage');
      if (!st.imageTool) throw notFound('no such tool');
      if (st.imageOutcome === 'approval') return { approvalId: id('ap'), callId: id('call') };
      if (st.imageOutcome === 'error')
        return {
          ok: false,
          text: '',
          error: { code: 'provider_error', message: 'The image provider is busy. Try again.' },
        };
      const a: ArtifactView = {
        id: id('img'),
        threadId,
        messageId: null,
        kind: 'image',
        title: prompt.slice(0, 80),
        mime: 'image/png',
        language: null,
        version: 1,
        live: false,
        size: 2048,
        createdAt: ts(),
        updatedAt: ts(),
      };
      h.addArtifact(a);
      return {
        ok: true,
        text: `Generated a ${size} image with openai/gpt-image (artifact id ${a.id}).`,
        meta: {
          artifact: { id: a.id, kind: a.kind, title: a.title, version: a.version },
          prompt,
          model: 'openai/gpt-image',
          size,
          revisedPrompt: null,
        },
      };
    },
  };
}

/** Ends a pending move as the Hub would (the test then sends `session.handedOff`). */
export function settleHandoff(
  st: M7WorkState,
  hid: string,
  status: SessionHandoffView['status'],
  reason: HandoffReason | null = null,
): SessionHandoffView {
  const v = st.handoffs.find((x) => x.id === hid);
  if (!v) throw new Error(`no handoff ${hid}`);
  const next: SessionHandoffView = {
    ...v,
    status,
    reason,
    git: handoffView().git,
    completedAt: status === 'completed' || status === 'refused' || status === 'failed' ? T0 : null,
  };
  st.handoffs = st.handoffs.map((x) => (x.id === hid ? next : x));
  return next;
}

// ---- standalone client and render --------------------------------------------------------------

export type WorkMocks = M7WorkApi & Record<keyof M7WorkApi, Mock>;

let tick = 0;
const nextTs = () => new Date(Date.parse(T0) + ++tick * 1000).toISOString();

/**
 * The M7 work part as its own client over a main fake Hub `hub`: settings, sessions and
 * artifacts come from it. `failNext` makes the next call to a method fail.
 */
export function createWorkHub(hub: ReturnType<typeof createHub>, init: Partial<M7WorkState> = {}) {
  const state = m7WorkState(init);
  const failNext: Partial<Record<keyof M7WorkApi, Error>> = {};
  const impl = m7WorkImpl(state, {
    id: nid,
    ts: nextTs,
    maybeFail: (name) => {
      const e = failNext[name];
      if (e) {
        delete failNext[name];
        throw e;
      }
    },
    setting: (k) =>
      resolveSetting(k, { global: hub.state.settings, managed: hub.state.managed }).value,
    sessions: () => hub.state.m5code.sessions,
    addArtifact: (a) => {
      hub.state.m3.artifacts = [...hub.state.m3.artifacts, a];
    },
  });
  const api = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as WorkMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` inside the providers the M7 work views need, with the main fake Hub's client and the
 * work part spread over it (what `createApi` will do).
 */
export async function renderWithWork(
  ui: ReactNode,
  opts: {
    work?: Partial<M7WorkState>;
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
    sessions?: CodeSessionView[];
    /** Calls that fail the first time (the view's first load). */
    fail?: Partial<Record<keyof M7WorkApi, Error>>;
  } = {},
) {
  const hub = createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  if (opts.sessions) hub.state.m5code.sessions = opts.sessions;
  const work = createWorkHub(hub, opts.work);
  Object.assign(work.failNext, opts.fail);
  const api = { ...hub.api, ...work.api };
  const { settings } = await hub.api.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, { children: ui }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { hub, work, api: work.api, state: work.state, ...utils };
}

/** Open one Code session at /code/:id with the M6 part and this M7 part wired in. */
export async function openM7Session(
  over: Partial<CodeSessionView> = {},
  opts: M6HubOptions & { work?: Partial<M7WorkState> } = {},
) {
  const s = codeSession(over);
  const parts = m6CodeHub([s, ...(opts.others ?? [])], opts);
  const work = createWorkHub(parts.hub, opts.work);
  Object.assign(parts.hub.api, work.api);
  const r = await renderApp({ hub: parts.hub, path: `/code/${s.id}` });
  const view = await screen.findByRole('region', { name: `Code session: ${sessionTitle(s)}` });
  await waitFor(() => expect(parts.api.getCodeSessionExtras).toHaveBeenCalled());
  return { ...r, ...parts, work, workApi: work.api, state: work.state, s, view };
}
