// The Hub's calls to novad's browser and bridge routes (ADR-096 D7, D8; contracts/hub-api.md §3):
// JSON POSTs with the management token through the devices area's transport, and the raw
// management connection the DevTools relay needs. A device on plain HTTP is reached over TCP; a
// device that registered an https endpoint (D1) only through the `connect` the devices area
// gives (mutual TLS, novad's certificate checked by chain and device id), never over plain HTTP.
import { connect as tcpConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import { NovaError } from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import {
  callDevice,
  deviceError,
  httpDeviceTransport,
  type DeviceTransport,
} from '../devices/client.ts';
import { managementTokenRef, type ManagedDevice } from '../devices/service.ts';
import type {
  DeviceBrowserLaunch,
  DeviceBrowserLink,
  DeviceEgressCounts,
  DeviceManagementSocket,
} from './device-launcher.ts';

export interface DeviceLinkOptions {
  devices: { device(accountId: string, deviceId: string): Promise<ManagedDevice> };
  secrets: SecretStore;
  /** The devices area's `managementTransport` (mutual TLS under D1); plain fetch otherwise. */
  transport?: DeviceTransport;
  /**
   * Open the management connection to an https endpoint (D1; the devices area's
   * `connectManagementTls`). Without it an https device is refused: the Hub never falls back to
   * plain HTTP for it.
   */
  connectTls?: (endpoint: URL, deviceId: string) => Promise<Duplex>;
  timeoutMs?: number;
}

export interface DeviceBridgeCaller {
  /** `POST /agent/v1/bridge/call` (D8): `{result}` or `{error}`; 409 `bridge_offline` throws. */
  bridgeCall(input: {
    accountId: string;
    deviceId: string;
    method: string;
    params: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<{ result: unknown } | { error: { code: string; message: string } }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** novad's browser and bridge routes over the devices area's management channel. */
export function deviceBrowserLink(opts: DeviceLinkOptions): DeviceBrowserLink & DeviceBridgeCaller {
  const transport = opts.transport ?? httpDeviceTransport;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const target = async (accountId: string, deviceId: string) => {
    const d = await opts.devices.device(accountId, deviceId);
    if (d.row.status === 'revoked') throw new NovaError('not_found', 'device not found');
    if (d.row.status !== 'active' || !d.endpoint)
      throw new NovaError('node_unavailable', 'the device is not reachable', {
        details: { reason: 'unreachable', status: d.row.status },
      });
    const token = await opts.secrets.get(managementTokenRef(d.row.id));
    if (!token)
      throw new NovaError('auth_missing', 'the Hub has no management token for this device');
    // The device a mutual TLS call must reach (D1: its id and the key the Hub pinned).
    return {
      endpoint: d.endpoint,
      token,
      target: { deviceId: d.row.id, publicKey: d.row.publicKey },
    };
  };
  const post = async <T>(
    accountId: string,
    deviceId: string,
    path: string,
    body: unknown,
    ms = timeoutMs,
  ) => {
    const t = await target(accountId, deviceId);
    return callDevice<T>(transport, t.endpoint, t.token, path, body, ms, t.target);
  };
  return {
    async launch(input): Promise<DeviceBrowserLaunch> {
      const r = await post<{ sessionId?: unknown; cdpPath?: unknown }>(
        input.accountId,
        input.deviceId,
        '/agent/v1/browser/launch',
        {
          sessionId: input.sessionId,
          grantee: input.grantee,
          allowHosts: input.allowHosts,
          headless: input.headless,
        },
        90_000,
      );
      if (typeof r.sessionId !== 'string' || typeof r.cdpPath !== 'string')
        throw new NovaError('server_error', 'the device answered an unexpected browser launch');
      return { sessionId: r.sessionId, cdpPath: r.cdpPath };
    },
    async close(input): Promise<{ egress: DeviceEgressCounts | null }> {
      const r = await post<{ egress?: unknown }>(
        input.accountId,
        input.deviceId,
        '/agent/v1/browser/close',
        { sessionId: input.sessionId },
        30_000,
      );
      return {
        egress: isRecord(r.egress)
          ? { allowed: count(r.egress.allowed), refused: count(r.egress.refused) }
          : null,
      };
    },
    async open(input): Promise<DeviceManagementSocket> {
      const t = await target(input.accountId, input.deviceId);
      const url = new URL(t.endpoint);
      let socket: Duplex;
      if (url.protocol === 'https:') {
        if (!opts.connectTls)
          throw new NovaError('capability_missing', 'this device is reached over TLS only', {
            details: { reason: 'tls_not_wired' },
          });
        socket = await opts.connectTls(url, input.deviceId);
      } else if (url.protocol === 'http:') {
        socket = await new Promise<Duplex>((resolve, reject) => {
          const s = tcpConnect({ host: url.hostname, port: Number(url.port || 80) });
          s.once('connect', () => {
            s.off('error', reject);
            resolve(s);
          });
          s.once('error', reject);
          s.setTimeout(30_000, () => s.destroy(new Error('the device did not answer')));
        });
      } else throw new NovaError('server_error', 'the device endpoint is not http or https');
      return { socket, host: url.host, authorization: `Bearer ${t.token}` };
    },
    async list(input): Promise<{ sessionId: string }[]> {
      const r = await post<{ sessions?: unknown }>(
        input.accountId,
        input.deviceId,
        '/agent/v1/browser/list',
        {},
        30_000,
      );
      return (Array.isArray(r.sessions) ? r.sessions : []).flatMap((x) =>
        isRecord(x) && typeof x.sessionId === 'string' ? [{ sessionId: x.sessionId }] : [],
      );
    },
    async bridgeCall(input) {
      const t = await target(input.accountId, input.deviceId);
      let res;
      try {
        res = await transport.post(
          `${t.endpoint.replace(/\/+$/, '')}/agent/v1/bridge/call`,
          t.token,
          { method: input.method, params: input.params, timeoutMs: input.timeoutMs },
          input.timeoutMs + 5_000,
          t.target,
        );
      } catch (err) {
        if (err instanceof NovaError) throw err;
        throw new NovaError('node_unavailable', 'the device is not reachable', {
          details: { reason: 'unreachable' },
          cause: err,
        });
      }
      const body = isRecord(res.body) ? res.body : {};
      const err = isRecord(body.error) ? body.error : null;
      const details = err && isRecord(err.details) ? err.details : {};
      // No native host connected to novad (D8): 409 `bridge_offline`, however novad words it.
      if (
        res.status === 409 ||
        err?.code === 'bridge_offline' ||
        details.reason === 'bridge_offline'
      )
        throw new NovaError('conflict', 'the extension is not connected on that computer', {
          details: { reason: 'bridge_offline' },
        });
      if (res.status < 200 || res.status >= 300) throw deviceError(res.status, res.body);
      if (err)
        return {
          error: {
            code: typeof err.code === 'string' ? err.code.slice(0, 60) : 'bridge_error',
            message:
              typeof err.message === 'string'
                ? err.message.slice(0, 500)
                : 'the extension refused the call',
          },
        };
      return { result: body.result ?? null };
    },
  };
}
