// Calls from the node to its Hub (contracts/hub-api.md §2): register, heartbeat, model sync. The
// node never contacts anything else but its backend (FR-126); redirects are refused.
import type { HeartbeatBody, RegisterBody, RegisterResult, SyncBody } from './protocol.ts';

/** A failed Hub call; `status` 401 means the credential no longer works (revoked). */
export class HubError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
  }
}

export interface HubClientOptions {
  hubUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HubClient {
  readonly hubUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: HubClientOptions) {
    const url = new URL(opts.hubUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new TypeError('the Hub URL must use http or https');
    if (url.username || url.password || url.search || url.hash)
      throw new TypeError('the Hub URL must be a plain http(s) URL');
    this.hubUrl = url.href.replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  register(body: RegisterBody): Promise<RegisterResult> {
    return this.#post<RegisterResult>('/node/v1/register', body, null);
  }

  async heartbeat(credential: string, body: HeartbeatBody): Promise<void> {
    await this.#post('/node/v1/heartbeat', body, credential);
  }

  async syncModels(credential: string, body: SyncBody): Promise<void> {
    await this.#post('/node/v1/models/sync', body, credential);
  }

  async #post<T>(path: string, body: unknown, credential: string | null): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (credential) headers.authorization = `Bearer ${credential}`;
    let res: Response;
    try {
      res = await this.#fetch(`${this.hubUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new HubError(0, 'network', `could not reach the Hub at ${this.hubUrl}`);
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // handled below
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw new HubError(
        res.status,
        typeof e?.code === 'string' ? e.code : 'server_error',
        typeof e?.message === 'string' ? e.message : `the Hub answered ${res.status}`,
      );
    }
    return parsed as T;
  }
}
