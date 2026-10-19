// The Hub calls a person makes before they have a session (decision 5 of ADR-095, FR-113): the
// public `POST /api/v1/team/join/preview` and `POST /api/v1/team/join` (the one-use invitation
// token authenticates them; 10 tries a minute per address), `GET /api/v1/auth/oidc/providers`
// (enabled providers' ids and labels), `POST /api/v1/auth/oidc/start` (sign in, or join with the
// invitation; the answer is only the provider's address) and the public card
// `GET /api/v1/profiles/:handle`. Errors are ApiErrors like the app's client.
import type {
  JoinPreviewView,
  OidcStartRequest,
  OidcStartView,
  PublicProfileView,
} from '@nova/shared';
import { ApiError, type ApiErrorBody } from '../api.ts';

const V1 = '/api/v1';

export function memberClient(fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { accept: 'application/json', 'content-type': 'application/json' };
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
  return {
    /** What the join page shows first; `valid: false` for a used, withdrawn or expired link. */
    joinPreview: (token: string) =>
      call<JoinPreviewView>('POST', `${V1}/team/join/preview`, { token }),
    /** 201 and the session cookie; 401 `invitation_invalid`, 429 `address_rate_limited`. */
    join: (token: string, displayName: string) =>
      call<{ accountId: string; role: 'member' }>('POST', `${V1}/team/join`, {
        token,
        displayName,
      }),
    oidcProviders: () =>
      call<{ items: { id: string; label: string }[] }>('GET', `${V1}/auth/oidc/providers`),
    oidcStart: (body: OidcStartRequest) =>
      call<OidcStartView>('POST', `${V1}/auth/oidc/start`, body),
    publicProfile: (handle: string) =>
      call<PublicProfileView>('GET', `${V1}/profiles/${encodeURIComponent(handle)}`),
  };
}

export type MemberClient = ReturnType<typeof memberClient>;
