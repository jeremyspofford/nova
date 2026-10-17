// Thin client for the Hub API (contracts/hub-api.md). The session lives in an HttpOnly cookie,
// so the UI never sees or stores a credential.

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export interface ResolvedSetting {
  key: string;
  value: unknown;
  source: 'default' | 'global' | 'project' | 'managed';
  locked: boolean;
}

export interface Hello {
  name: string;
  version: string;
  apiVersions: string[];
  setupRequired: boolean;
}

export interface Session {
  accountId: string | null;
  displayName: string | null;
}

type Fetch = typeof fetch;

export function createApi(fetchImpl: Fetch = (...a) => fetch(...a)) {
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
    if (!res.ok) {
      throw new ApiError(
        res.status,
        data.error ?? { code: 'server_error', message: res.statusText, retryable: true },
      );
    }
    return data;
  }
  return {
    hello: () => call<Hello>('GET', '/api/v1/hello'),
    session: () => call<Session>('GET', '/api/v1/session'),
    setup: (code: string, displayName?: string) =>
      call<{ accountId: string }>(
        'POST',
        '/api/v1/auth/setup',
        displayName ? { code, displayName } : { code },
      ),
    logout: () => call<{ ok: true }>('POST', '/api/v1/auth/logout'),
    settings: () => call<{ settings: ResolvedSetting[] }>('GET', '/api/v1/settings'),
    setSetting: (key: string, value: unknown) =>
      call<{ settings: ResolvedSetting[] }>('PATCH', '/api/v1/settings', { key, value }),
  };
}

export type Api = ReturnType<typeof createApi>;
