// Shared setup for the network tests: a migrated in-memory database with the network tables, fake
// interfaces in the shape of os.networkInterfaces(), and a fake probe that answers per URL.
import type { NetworkInterfaceInfo } from 'node:os';
import type { EndpointProbeOutcome } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import type { HelloProbeOptions, HelloProbeResult } from '../src/index.ts';

export const ACCOUNT = '01920000-0000-7000-8000-000000000001';

export async function networkDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, iso, iso);
  return db;
}

/** One interface address as os.networkInterfaces() reports it. */
export function iface(address: string, prefix: number, internal = false): NetworkInterfaceInfo {
  const v6 = address.includes(':');
  return {
    address,
    netmask: v6 ? 'ffff:ffff:ffff:ffff::' : '255.255.255.0',
    family: v6 ? 'IPv6' : 'IPv4',
    mac: '02:00:00:00:00:01',
    internal,
    cidr: `${address}/${prefix}`,
    ...(v6 ? { scopeid: 0 } : {}),
  } as NetworkInterfaceInfo;
}

/** A probe whose answer per URL the test sets; unknown URLs are refused. */
export class FakeProbe {
  readonly answers = new Map<string, EndpointProbeOutcome>();
  readonly calls: { url: string; opts: HelloProbeOptions }[] = [];

  set(url: string, ok: boolean, latencyMs = 5, detail: string | null = null): void {
    this.answers.set(url, { ok, latencyMs: ok ? latencyMs : null, detail });
  }

  readonly probe = (url: string, opts: HelloProbeOptions): Promise<HelloProbeResult> => {
    this.calls.push({ url, opts });
    const a = this.answers.get(url);
    if (!a) return Promise.resolve({ ok: false, latencyMs: null, detail: 'connection refused' });
    return Promise.resolve({
      ok: a.ok,
      latencyMs: a.latencyMs ?? null,
      detail: a.ok ? null : (a.detail ?? 'connection refused'),
    });
  };
}
