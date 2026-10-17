// Hub calls the Code views need that src/api.ts does not have yet: a terminal bound to a Code
// session (FR-066) and the agent's interactive exec sessions (FR-184). Once the client gains
// methods with these names they are used; until then the same requests go out here with the
// conventions of api.ts (same-origin cookie, JSON, ApiError on failure).
import { useMemo } from 'react';
import type { TerminalView } from '@nova/shared';
import { ApiError, type Api, type ApiErrorBody } from '../api.ts';
import { useServices } from '../services.tsx';

/**
 * A command the agent left running (FR-184), as GET /api/v1/exec/sessions lists it; mirrors
 * `ExecSessionView` in packages/core/src/tools/exec-sessions.ts until @nova/shared has it.
 */
export interface ExecSessionView {
  id: string;
  threadId: string;
  /** The turn that started it. */
  turnId: string;
  /** The tool call that started it: the "agent" chip shows it (docs/10 §6). */
  callId: string | null;
  /** The command line, redacted. */
  cmd: string;
  cwd: string;
  startedAt: string;
  /** Kept after its turn ended. */
  retained: boolean;
}

export interface CodeExtrasApi {
  /** POST /api/v1/code/sessions/:id/terminal: a shell in the session's environment and folder. */
  createSessionTerminal: (sessionId: string) => Promise<TerminalView>;
  /** GET /api/v1/exec/sessions?threadId= */
  listExecSessions: (threadId: string) => Promise<{ items: ExecSessionView[] }>;
  /** DELETE /api/v1/exec/sessions/:id */
  killExecSession: (id: string) => Promise<{ ok: true }>;
}

const V1 = '/api/v1';
const enc = encodeURIComponent;

export function codeExtras(
  api: Api,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): CodeExtrasApi {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  }
  const own = api as Api & Partial<CodeExtrasApi>;
  return {
    createSessionTerminal:
      own.createSessionTerminal ??
      ((id) =>
        call<TerminalView>('POST', `${V1}/code/sessions/${enc(id)}/terminal`, {
          cols: 100,
          rows: 30,
        })),
    listExecSessions:
      own.listExecSessions ??
      ((threadId) =>
        call<{ items: ExecSessionView[] }>('GET', `${V1}/exec/sessions?threadId=${enc(threadId)}`)),
    killExecSession:
      own.killExecSession ??
      ((id) => call<{ ok: true }>('DELETE', `${V1}/exec/sessions/${enc(id)}`)),
  };
}

export function useCodeExtras(): CodeExtrasApi {
  const { api } = useServices();
  return useMemo(() => codeExtras(api), [api]);
}
