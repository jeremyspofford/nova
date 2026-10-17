// Per-device reachability for the network diagnostics panel (FR-139, docs/22 §6): every device of
// the account that is not revoked (novad devices and compute nodes), its status and last contact,
// and the endpoints it last reported with their health (`transport_endpoint`).
import {
  NETWORK_TRANSPORTS,
  type DeviceReachabilityView,
  type NetworkTransport,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';

interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  roles: string;
  status: string;
  last_seen_at: string | null;
  relay_client_id: string | null;
}

interface EndpointRow {
  device_id: string;
  net: string;
  url: string;
  healthy: number;
  latency_ms: number | null;
  last_checked_at: string | null;
}

function roles(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

export function deviceReachability(db: NovaDatabase, accountId: string): DeviceReachabilityView[] {
  const devices = db.raw
    .prepare(
      `SELECT id, name, kind, roles, status, last_seen_at, relay_client_id FROM device
       WHERE account_id = ? AND status != 'revoked' AND kind != 'hub'
       ORDER BY created_at, id`,
    )
    .all(accountId) as unknown as DeviceRow[];
  if (devices.length === 0) return [];
  const endpoints = db.raw
    .prepare(
      `SELECT e.device_id, e.net, e.url, e.healthy, e.latency_ms, e.last_checked_at
       FROM transport_endpoint e JOIN device d ON d.id = e.device_id
       WHERE d.account_id = ? ORDER BY e.created_at, e.id`,
    )
    .all(accountId) as unknown as EndpointRow[];
  return devices.map((d) => ({
    deviceId: d.id,
    name: d.name,
    kind: d.kind,
    roles: roles(d.roles),
    status: d.status,
    lastSeenAt: d.last_seen_at,
    reachable: d.status === 'active',
    relayPaired: d.relay_client_id !== null,
    endpoints: endpoints
      .filter((e) => e.device_id === d.id)
      .filter((e) => (NETWORK_TRANSPORTS as readonly string[]).includes(e.net))
      .map((e) => ({
        transport: e.net as NetworkTransport,
        url: e.url,
        healthy: e.healthy === 1,
        latencyMs: e.latency_ms,
        checkedAt: e.last_checked_at,
      })),
  }));
}
