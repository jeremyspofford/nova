// Hub client calls for the M7 Code additions (docs/10 §9, §14, §15), in the conventions of
// src/api.ts: session handoff with the Git state (FR-213), three-way merges of another session's
// work or a patch, with conflicts resolved or aborted (FR-073), and best-of-N attempts compared and
// applied (FR-212). `createApi` spreads `codeM7Api(call)` into the client, so `Api` includes
// these; until then `useCodeM7Api` reads them from the services object.
import type { z } from 'zod';
import type {
  CodeAttemptSetView,
  CodeMergeView,
  SessionHandoffView,
  applyAttemptSchema,
  sessionHandoffSchema,
  startAttemptsSchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;
const session = (id: string) => `${V1}/code/sessions/${enc(id)}`;

export type HandoffBody = z.input<typeof sessionHandoffSchema>;
export type StartAttemptsBody = z.input<typeof startAttemptsSchema>;
export type ApplyAttemptBody = z.input<typeof applyAttemptSchema>;
export type MergeConflictMode = 'refuse' | 'markers';

export function codeM7Api(call: HubCall) {
  return {
    // ---- handoff (FR-213) ----------------------------------------------------------------------
    /**
     * 202 with the pending move; it finishes in the background (`session.handedOff`). Request
     * errors throw: 409 `handoff_running`, `same_location`; 400 `worktree_unavailable`,
     * `worktree_repo`; 404 for an unknown environment. A refusal (target dirty, diverged, …) is
     * a result: the move ends `refused` with its `reason`.
     */
    handoffCodeSession: (id: string, body: HandoffBody) =>
      call<SessionHandoffView>('POST', `${session(id)}/handoff`, body),
    /** The session's moves, newest first (its history). */
    listCodeHandoffs: (id: string) =>
      call<{ items: SessionHandoffView[] }>('GET', `${session(id)}/handoffs`),
    getHandoff: (id: string) => call<SessionHandoffView>('GET', `${V1}/handoffs/${enc(id)}`),
    /** A chat moves to another of the account's devices (recorded and announced). */
    handoffThread: (threadId: string, deviceId: string, interrupt = false) =>
      call<SessionHandoffView>('POST', `${V1}/threads/${enc(threadId)}/handoff`, {
        to: { deviceId },
        ...(interrupt ? { interrupt } : {}),
      }),

    // ---- three-way merges (FR-073) -------------------------------------------------------------
    /**
     * 201 with the merge. With `refuse` (default) a conflict writes nothing and answers 409
     * `merge_conflict` with `mergeId` and `paths`; with `markers` the files get conflict markers to
     * resolve. 400 `remote_environment`, `other_repository`, `patch_mismatch`, `missing_base`.
     */
    mergeIntoSession: (
      id: string,
      from: { sessionId: string } | { patch: string; base?: string },
      onConflict: MergeConflictMode = 'refuse',
    ) => call<CodeMergeView>('POST', `${session(id)}/merge`, { from, onConflict }),
    listMerges: (id: string) => call<{ items: CodeMergeView[] }>('GET', `${session(id)}/merges`),
    getMerge: (id: string, mergeId: string) =>
      call<CodeMergeView>('GET', `${session(id)}/merges/${enc(mergeId)}`),
    /** 409 `merge_conflicts` (with `paths`) while markers are left in files. */
    resolveMerge: (id: string, mergeId: string) =>
      call<CodeMergeView>('POST', `${session(id)}/merges/${enc(mergeId)}/resolve`, {}),
    /** Puts the files back as they were before the merge; 409 `merge_settled`. */
    abortMerge: (id: string, mergeId: string) =>
      call<CodeMergeView>('POST', `${session(id)}/merges/${enc(mergeId)}/abort`, {}),

    // ---- best-of-N attempts (FR-212) -----------------------------------------------------------
    /** 201; 400 `remote_environment` (attempts need worktrees on the Hub), `no_commits`. */
    startAttempts: (id: string, body: StartAttemptsBody) =>
      call<CodeAttemptSetView>('POST', `${session(id)}/attempts`, body),
    listAttempts: (id: string) =>
      call<{ items: CodeAttemptSetView[] }>('GET', `${session(id)}/attempts`),
    getAttempts: (setId: string) =>
      call<CodeAttemptSetView>('GET', `${V1}/code/attempts/${enc(setId)}`),
    /**
     * Merges the chosen attempt into the session and removes the others. 409 `merge_conflict`
     * (refuse mode, nothing written), `attempts_settled`.
     */
    applyAttempt: (setId: string, body: ApplyAttemptBody) =>
      call<{ set: CodeAttemptSetView; merge: CodeMergeView }>(
        'POST',
        `${V1}/code/attempts/${enc(setId)}/apply`,
        body,
      ),
    discardAttempts: (setId: string) =>
      call<CodeAttemptSetView>('POST', `${V1}/code/attempts/${enc(setId)}/discard`, {}),
  };
}

export type CodeM7Api = ReturnType<typeof codeM7Api>;

/** The M7 Code calls of the app's client (part of `Api` once `createApi` spreads them). */
export function useCodeM7Api(): CodeM7Api {
  const api: unknown = useServices().api;
  return api as CodeM7Api;
}
