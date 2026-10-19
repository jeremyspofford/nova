// The Hub's side of the management channel (contracts/hub-api.md §3): JSON POSTs to a device's
// `/agent/v1/*` with the management token. novad answers errors in the Hub's own error shape, so
// known codes pass through; anything else becomes `server_error`. An unreachable device is
// `node_unavailable` (retryable). M7.5 (ADR-096 D1): an https endpoint is called over mutual TLS
// (tls.ts); a refused channel is `policy_denied` `{reason: device_tls_failed, tls}` and passes
// through unchanged.
import { HUB_ERROR_CODES, NovaError, type HubErrorCode } from '@nova/shared';
import type { DeviceTarget } from './tls.ts';

export interface DeviceTransportResponse {
  status: number;
  body: unknown;
}

/** How the Hub reaches a device (tests substitute it). */
export interface DeviceTransport {
  /** `target` names the device a mutual TLS call must reach (its id and pinned key). */
  post(
    url: string,
    token: string,
    body: unknown,
    timeoutMs: number,
    target?: DeviceTarget,
  ): Promise<DeviceTransportResponse>;
}

export const httpDeviceTransport: DeviceTransport = {
  async post(url, token, body, timeoutMs) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, body: parsed };
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A device error body as a NovaError. */
export function deviceError(status: number, body: unknown): NovaError {
  const err = isRecord(body) && isRecord(body.error) ? body.error : {};
  const raw = typeof err.code === 'string' ? err.code : '';
  const message =
    typeof err.message === 'string' ? err.message.slice(0, 500) : `the device answered ${status}`;
  const details = isRecord(err.details) ? err.details : undefined;
  if (status === 401) {
    return new NovaError('auth_missing', 'the device refused the Hub’s management token', {
      details: { reason: 'device_token_rejected' },
      action: 'Enroll the device again',
    });
  }
  const code: HubErrorCode = (HUB_ERROR_CODES as readonly string[]).includes(raw)
    ? (raw as HubErrorCode)
    : status === 413
      ? 'validation'
      : 'server_error';
  return new NovaError(code, message, details ? { details } : {});
}

/** POST to a device and return its JSON answer. */
export async function callDevice<T = Record<string, unknown>>(
  transport: DeviceTransport,
  endpoint: string,
  token: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  target?: DeviceTarget,
): Promise<T> {
  let res: DeviceTransportResponse;
  try {
    res = await transport.post(
      `${endpoint.replace(/\/+$/, '')}${path}`,
      token,
      body,
      timeoutMs,
      target,
    );
  } catch (err) {
    // A refused TLS channel says why; it is never `node_unavailable` (nothing to retry).
    if (err instanceof NovaError) throw err;
    throw new NovaError('node_unavailable', 'the device is not reachable', {
      details: { reason: 'unreachable' },
      cause: err,
    });
  }
  if (res.status >= 200 && res.status < 300) return (res.body ?? {}) as T;
  throw deviceError(res.status, res.body);
}
