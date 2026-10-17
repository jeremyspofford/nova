// The Hub calls the joining device makes without a session (contracts/hub-api.md §1; Add Device
// protocol v2): `GET /api/v1/hello` (the Hub's fingerprint and public key, checked against the pin
// in the QR payload), the public `POST /api/v1/devices/add/complete` (the code authenticates it;
// it carries a commitment and answers with the Hub's nonce), the public, signed
// `POST /api/v1/devices/add/reveal` (the device's nonce; answers with the confirmation and the
// Hub's signature) and the public, signed `GET /api/v1/devices/add/status/:requestId`. Errors are
// ApiErrors like the app's client; each answer also carries the Hub's clock from its Date header,
// so signed calls use the Hub's time.
import {
  ADD_DEVICE_SIGNATURE_HEADER,
  ADD_DEVICE_TIME_HEADER,
  type AddDeviceKind,
  type AddDeviceStatusView,
} from '@nova/shared';
import { ApiError, type ApiErrorBody } from '../api.ts';
import { TimedApiError } from './poll.ts';

export interface JoinHello {
  name?: string;
  setupRequired?: boolean;
  /** base64url SHA-256 of the Hub identity key; null until the Hub has one. */
  hubFingerprint?: string | null;
  /** The Hub identity key, raw Ed25519, base64url; null until the Hub has one. */
  hubPublicKey?: string | null;
}

/** `add/complete` v2 (the shapes of the protocol document, until @nova/shared has them). */
export interface JoinCompleteRequest {
  pairingId?: string;
  code: string;
  publicKey: string;
  name: string;
  platform: string;
  kind: AddDeviceKind;
  /** base64url SHA-256 of `nova-add-device-commit-v1|<publicKey>|<deviceNonce>`. */
  commitment: string;
}

export interface JoinCommitted {
  requestId: string;
  pairingId: string;
  expiresAt: string;
  /** 32 random bytes from the Hub, base64url. */
  hubNonce: string;
  status: 'committed';
}

export interface JoinRevealed {
  requestId: string;
  confirmation: string;
  status: 'pending';
  /** The Hub identity's signature over the reveal statement; null without an identity. */
  hubSignature: string | null;
}

export interface Answer<T> {
  body: T;
  /** The Hub's clock (ms) from the Date header, or null. */
  hubTime: number | null;
}

const V1 = '/api/v1';

/** The signed headers of `reveal` and `status`. */
export function signedHeaders(time: number, signature: string): Record<string, string> {
  return { [ADD_DEVICE_TIME_HEADER]: String(time), [ADD_DEVICE_SIGNATURE_HEADER]: signature };
}

export function joinClient(fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  async function call<T>(path: string, init: RequestInit): Promise<Answer<T>> {
    const res = await fetchImpl(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers: { accept: 'application/json', ...(init.headers as Record<string, string>) },
    });
    const data = (await res.json().catch(() => ({}))) as { error?: ApiErrorBody } & T;
    const date = Date.parse(res.headers.get('date') ?? '');
    const hubTime = Number.isNaN(date) ? null : date;
    if (!res.ok) {
      throw new TimedApiError(
        new ApiError(
          res.status,
          data.error ?? { code: 'server_error', message: res.statusText, retryable: true },
        ),
        hubTime,
      );
    }
    return { body: data, hubTime };
  }
  const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
  return {
    hello: () => call<JoinHello>(`${V1}/hello`, { method: 'GET' }),
    complete: (body: JoinCompleteRequest) =>
      call<JoinCommitted>(`${V1}/devices/add/complete`, json(body)),
    reveal: (requestId: string, nonce: string, time: number, signature: string) =>
      call<JoinRevealed>(
        `${V1}/devices/add/reveal`,
        json({ requestId, nonce }, signedHeaders(time, signature)),
      ),
    status: (requestId: string, time: number, signature: string) =>
      call<AddDeviceStatusView>(`${V1}/devices/add/status/${encodeURIComponent(requestId)}`, {
        method: 'GET',
        headers: signedHeaders(time, signature),
      }),
  };
}

export type JoinClient = ReturnType<typeof joinClient>;
