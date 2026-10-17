// Calls from the node to its Hub (contracts/hub-api.md §1, §2): Add Device v2 (hello, complete with
// a commitment, the signed reveal and status poll), register, heartbeat, model sync. The node never contacts anything else but
// its backend (FR-126); redirects are refused.
import type { HeartbeatBody, RegisterBody, RegisterResult, SyncBody } from './protocol.ts';

/** `POST /api/v1/devices/add/complete` as a compute node sends it (Add Device v2). */
export interface AddDeviceCompleteBody {
  pairingId?: string;
  code: string;
  publicKey: string;
  name: string;
  platform: string;
  kind: 'compute';
  /** base64url SHA-256 of `nova-add-device-commit-v1|<publicKey>|<deviceNonce>`. */
  commitment: string;
}

export interface AddDeviceCompleteResult {
  requestId: string;
  pairingId: string;
  expiresAt: string;
  hubNonce: string;
  status: 'committed';
}

export interface AddDeviceRevealResult {
  requestId: string;
  confirmation: string;
  status: 'pending';
  hubSignature: string | null;
}

export interface AddDeviceStatusResult {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  deviceId?: string;
  grant?: { type: string; enrollToken?: string; token?: string; certificatePem?: string };
}

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

  /** `GET /api/v1/hello` (public): once the Hub has an identity, its fingerprint and key. */
  hello(): Promise<{ hubFingerprint?: unknown; hubPublicKey?: unknown }> {
    return this.#call('GET', '/api/v1/hello', undefined, {});
  }

  /** `POST /api/v1/devices/add/complete`: the code, this node's key and its commitment (FR-132). */
  addDeviceComplete(body: AddDeviceCompleteBody): Promise<AddDeviceCompleteResult> {
    return this.#call('POST', '/api/v1/devices/add/complete', body, {});
  }

  /** `POST /api/v1/devices/add/reveal`: the nonce behind the commitment, signed by this node's key. */
  addDeviceReveal(
    body: { requestId: string; nonce: string },
    proof: { time: number; signature: string },
  ): Promise<AddDeviceRevealResult> {
    return this.#call('POST', '/api/v1/devices/add/reveal', body, {
      'x-nova-device-time': String(proof.time),
      'x-nova-device-signature': proof.signature,
    });
  }

  /** `GET /api/v1/devices/add/status/:id`, signed by this node's key. */
  addDeviceStatus(
    requestId: string,
    proof: { time: number; signature: string },
  ): Promise<AddDeviceStatusResult> {
    return this.#call(
      'GET',
      `/api/v1/devices/add/status/${encodeURIComponent(requestId)}`,
      undefined,
      {
        'x-nova-device-time': String(proof.time),
        'x-nova-device-signature': proof.signature,
      },
    );
  }

  async heartbeat(credential: string, body: HeartbeatBody): Promise<void> {
    await this.#post('/node/v1/heartbeat', body, credential);
  }

  async syncModels(credential: string, body: SyncBody): Promise<void> {
    await this.#post('/node/v1/models/sync', body, credential);
  }

  #post<T>(path: string, body: unknown, credential: string | null): Promise<T> {
    return this.#call(
      'POST',
      path,
      body,
      credential ? { authorization: `Bearer ${credential}` } : {},
    );
  }

  async #call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    extra: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.#fetch(`${this.hubUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
