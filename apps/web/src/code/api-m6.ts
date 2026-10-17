// Hub client calls for the M6 Code additions (docs/10 §2, §7-§10), in the conventions of
// src/api.ts: saved environments and their processes (FR-062, FR-078), Git hosts, pushes, pull
// requests and CI (FR-070), the worktree registry (FR-073), dev servers (FR-097, FR-067),
// auto-verify (FR-068), side questions (FR-072) and session budgets (docs/09 §2). `createApi`
// spreads `codeM6Api(call)` into the client; until it does, `useCodeM6Api` sends the same
// requests itself (as src/code/extras.ts does), so the views work either way.
import { useMemo } from 'react';
import type { z } from 'zod';
import type {
  CodeBudgetView,
  CodeSessionExtrasView,
  DeviceView,
  DevServerCandidateView,
  DevServerView,
  EnvironmentOutputView,
  EnvironmentProcessView,
  GitHostView,
  PullRequestView,
  PushResultView,
  SavedEnvironmentView,
  SideAnswerView,
  VerifyRunView,
  WorktreeView,
  createEnvironmentSchema,
  createGitHostSchema,
  createPullRequestSchema,
  createWorktreeSchema,
  extendCodeBudgetSchema,
  pushSchema,
  startDevServerSchema,
  updateEnvironmentSchema,
  WslDistroView,
} from '@nova/shared';
import { ApiError, type ApiErrorBody } from '../api.ts';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const env = (id: string) => `${V1}/environments/${enc(id)}`;
const host = (id: string) => `${V1}/code/githosts/${enc(id)}`;
const worktree = (id: string) => `${V1}/code/worktrees/${enc(id)}`;
const session = (id: string) => `${V1}/code/sessions/${enc(id)}`;

export interface WorktreeListQuery {
  repo?: string;
  status?: 'active' | 'released' | 'removed' | 'all';
}

export function codeM6Api(call: HubCall) {
  return {
    // ---- M6: saved environments (FR-062, FR-078) ----------------------------------------------
    /** Every environment with its connection (no secret values) and health; "This Hub" first. */
    listSavedEnvironments: () =>
      call<{ items: SavedEnvironmentView[] }>('GET', `${V1}/environments`),
    createEnvironment: (body: z.input<typeof createEnvironmentSchema>) =>
      call<SavedEnvironmentView>('POST', `${V1}/environments`, body),
    getEnvironment: (id: string) => call<SavedEnvironmentView>('GET', env(id)),
    /** Label, connection (same kind) or a new SSH credential; the health resets to unknown. */
    updateEnvironment: (id: string, body: z.input<typeof updateEnvironmentSchema>) =>
      call<SavedEnvironmentView>('PATCH', env(id), body),
    /** 409 `in_use` while active sessions use it; 400 `built_in` for This Hub. */
    deleteEnvironment: (id: string) => call<unknown>('DELETE', env(id)),
    checkEnvironment: (id: string) => call<SavedEnvironmentView>('POST', `${env(id)}/check`, {}),
    /** Processes the environment's helper runs (output stays buffered while nobody reads it). */
    listEnvironmentProcesses: (id: string) =>
      call<{ items: EnvironmentProcessView[] }>('GET', `${env(id)}/processes`),
    /** Output from `offset` (reattach: read from where the last read stopped). */
    readEnvironmentOutput: (id: string, processId: string, offset = 0) =>
      call<EnvironmentOutputView>(
        'GET',
        `${env(id)}/processes/${enc(processId)}/output${query({ offset })}`,
      ),
    /** The WSL distros a Windows device reports. */
    listWslDistros: (deviceId: string) =>
      call<{ items: WslDistroView[] }>(
        'GET',
        `${V1}/environments/wsl/distros${query({ deviceId })}`,
      ),
    /** Devices running `novad` that a device or WSL environment can use. */
    listEnvironmentDevices: () =>
      call<{ items: DeviceView[] }>('GET', `${V1}/devices${query({ role: 'client' })}`),

    // ---- M6: Git hosts (FR-070) --------------------------------------------------------------
    listGitHosts: () => call<{ items: GitHostView[] }>('GET', `${V1}/code/githosts`),
    /** The token goes to the keychain; a rejected token is not saved (400). */
    createGitHost: (body: z.input<typeof createGitHostSchema>) =>
      call<GitHostView>('POST', `${V1}/code/githosts`, body),
    checkGitHost: (id: string) => call<GitHostView>('POST', `${host(id)}/check`, {}),
    /** 409 `in_use` while pull requests opened through it are open. */
    deleteGitHost: (id: string) => call<unknown>('DELETE', host(id)),

    // ---- M6: worktree registry (FR-073) ------------------------------------------------------
    listWorktrees: (q: WorktreeListQuery = {}) =>
      call<{ items: WorktreeView[] }>('GET', `${V1}/code/worktrees${query({ ...q })}`),
    /** 409 `worktree_cap` at 15 per repository unless `removeOldest` accepts the offer. */
    createWorktree: (body: z.input<typeof createWorktreeSchema>) =>
      call<WorktreeView>('POST', `${V1}/code/worktrees`, body),
    renewWorktree: (id: string, ttlMinutes?: number) =>
      call<WorktreeView>(
        'POST',
        `${worktree(id)}/renew`,
        ttlMinutes === undefined ? {} : { ttlMinutes },
      ),
    /** 409 `in_use` while a Code session works in it. */
    releaseWorktree: (id: string) => call<WorktreeView>('POST', `${worktree(id)}/release`, {}),
    /** 409 `in_use`, `leased`, or `dirty` (unless `force`). */
    removeWorktree: (id: string, force = false) =>
      call<WorktreeView>(
        'DELETE',
        `${worktree(id)}${query({ force: force ? 'true' : undefined })}`,
      ),

    // ---- M6: session facts, budgets, Git (docs/09 §2, FR-070) ---------------------------------
    getCodeSessionExtras: (id: string) =>
      call<CodeSessionExtrasView>('GET', `${session(id)}/extras`),
    /** Each amount is added to its limit; a session without one gets used + amount. */
    extendCodeBudget: (id: string, body: z.input<typeof extendCodeBudgetSchema>) =>
      call<CodeBudgetView>('POST', `${session(id)}/budget/extend`, body),
    /** Creates `nova/<slug>` at HEAD and switches to it without a checkout. */
    createCodeBranch: (id: string, name: string) =>
      call<{ branch: string; from: string | null }>('POST', `${session(id)}/branch`, { name }),
    /** 403 `confirmation_required` / `force_protected` / `secrets_found` (with findings). */
    pushCodeSession: (id: string, body: z.input<typeof pushSchema> = {}) =>
      call<PushResultView>('POST', `${session(id)}/push`, body),
    /** Pushes the branch, then opens the pull request (or returns the open one). */
    openPullRequest: (id: string, body: z.input<typeof createPullRequestSchema>) =>
      call<PullRequestView>('POST', `${session(id)}/pr`, body),
    getPullRequest: (id: string) => call<PullRequestView>('GET', `${session(id)}/pr`),
    refreshPullRequest: (id: string) =>
      call<PullRequestView>('POST', `${session(id)}/pr/refresh`, {}),

    // ---- M6: dev servers (FR-097, FR-067) ----------------------------------------------------
    listDevServers: (id: string) =>
      call<{ candidates: DevServerCandidateView[]; items: DevServerView[] }>(
        'GET',
        `${session(id)}/devservers`,
      ),
    startDevServer: (id: string, body: z.input<typeof startDevServerSchema> = {}) =>
      call<DevServerView>('POST', `${session(id)}/devservers`, body),
    stopDevServer: (id: string, serverId: string) =>
      call<DevServerView>('POST', `${session(id)}/devservers/${enc(serverId)}/stop`, {}),
    stopAllDevServers: (id: string) =>
      call<{ items: DevServerView[] }>('POST', `${session(id)}/devservers/stop-all`, {}),

    // ---- M6: auto-verify (FR-068) ------------------------------------------------------------
    listVerifyRuns: (id: string) =>
      call<{ items: VerifyRunView[] }>('GET', `${session(id)}/verify`),
    /** 202 with the running run; 409 when checks already run. */
    runVerify: (id: string) => call<VerifyRunView>('POST', `${session(id)}/verify`, {}),
    getVerifyRun: (id: string, verifyId: string) =>
      call<VerifyRunView>('GET', `${session(id)}/verify/${enc(verifyId)}`),

    // ---- M6: side questions (FR-072) ---------------------------------------------------------
    /** Answered from the session's context; adds nothing to its thread. */
    askCodeSession: (id: string, question: string) =>
      call<SideAnswerView>('POST', `${session(id)}/ask`, { question }),
  };
}

export type CodeM6Api = ReturnType<typeof codeM6Api>;

/** The same request function as `createApi`'s, for calls the client does not have yet. */
export function fetchCall(fetchImpl: typeof fetch = (...a) => fetch(...a)): HubCall {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...init.headers, 'content-type': 'application/json' };
    }
    const res = await fetchImpl(path, init);
    const data = (await res.json().catch(() => ({}))) as { error?: ApiErrorBody } & T;
    if (!res.ok)
      throw new ApiError(
        res.status,
        data.error ?? { code: 'server_error', message: res.statusText, retryable: true },
      );
    return data;
  };
}

/** The client's own methods where it has them, else the same requests sent here. */
export function codeM6With(api: unknown, fetchImpl?: typeof fetch): CodeM6Api {
  const own = api as Partial<Record<keyof CodeM6Api, unknown>>;
  const out: Record<string, unknown> = { ...codeM6Api(fetchCall(fetchImpl)) };
  for (const key of Object.keys(out)) {
    const fn = own[key as keyof CodeM6Api];
    if (typeof fn === 'function') out[key] = fn;
  }
  return out as CodeM6Api;
}

/** The M6 Code calls of the app's client. */
export function useCodeM6Api(): CodeM6Api {
  const { api } = useServices();
  return useMemo(() => codeM6With(api), [api]);
}
