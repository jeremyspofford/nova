// Wake Helper routing (FR-138, docs/22 §7). Magic packets only cross one LAN segment, so a wake
// goes through a Wake Helper on the target's subnet: an active `novad` device with the
// `wake-helper` role (optionally only those named in `network.wakeHelpers`, in that order) on the
// same LAN as the target. A device's LAN is what it last reported: the physical subnets novad
// sends with its power status (`power.lan`, exact), and the hosts of its registered endpoints
// (with the prefix of the Hub's own interface on that network, else /24 or /64). The Hub calls the
// helper's management endpoint (`POST /agent/v1/power/wake-other`, Hub-authenticated like every
// management call). When no helper can send it, the Hub broadcasts itself if it has an interface
// on that subnet; else the wake is refused (409 `no_wake_helper`). Rate limits, the wake log and
// audit stay with the devices service, which calls `route`.
import { lookup as dnsLookup } from 'node:dns/promises';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { NovaError, type WakeHelperView } from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { callDevice, httpDeviceTransport, type DeviceTransport } from '../devices/client.ts';
import { deviceLanSubnetSchema } from '../devices/protocol.ts';
import { managementTokenRef, type DeviceWakeRouter } from '../devices/service.ts';
import {
  directedBroadcast,
  inSubnet,
  interfaceAddresses,
  ipFamily,
  isLoopbackIp,
  isMeshIp,
  isVirtualInterface,
  normalizeIp,
  type InterfaceAddress,
} from './subnet.ts';

/** The management call a Wake Helper answers (services/novad, agent-dist area). */
export const WAKE_OTHER_PATH = '/agent/v1/power/wake-other';

/** How the devices service sends a wake (DeviceService.useWakeRouter). */
export type WakeRoute = Awaited<ReturnType<DeviceWakeRouter['route']>>;

export interface WakeRouteInput {
  accountId: string;
  deviceId: string;
  mac: string;
}

export interface WakeHelperRouterOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  transport?: DeviceTransport;
  /** `network.wakeHelpers`: when non-empty, only these devices, in this order. */
  preferred?: () => Promise<string[]>;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Resolves a host name in a device endpoint to addresses. */
  lookup?: (host: string) => Promise<string[]>;
  /** UDP port of the magic packet (default 9). */
  port?: number;
  timeoutMs?: number;
  log?: Logger;
}

interface HelperRow {
  id: string;
  name: string;
  status: string;
  roles: string;
  last_seen_at: string | null;
}

/** A subnet a device reported (`192.168.1.0/24`) with its broadcast address. */
interface Subnet {
  network: string;
  prefix: number;
  broadcast: string | null;
}

/** What the Hub knows of a device's LAN. */
interface DeviceLan {
  /** Hosts of its endpoints, without loopback and mesh addresses (WoL never crosses a tunnel). */
  addresses: string[];
  subnets: Subnet[];
}

function lanAddress(address: string): boolean {
  return !isLoopbackIp(address) && !isMeshIp(address);
}

function parseRoles(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * `power.lan` of a device's last power report, each entry checked like a heartbeat's. The
 * broadcast address is computed from the network; a reported one is never used (review 17).
 */
function parseSubnets(powerJson: string | null): Subnet[] {
  if (!powerJson) return [];
  let power: unknown;
  try {
    power = JSON.parse(powerJson) as unknown;
  } catch {
    return [];
  }
  const lan = (power as { lan?: unknown } | null)?.lan;
  if (!Array.isArray(lan)) return [];
  const out: Subnet[] = [];
  for (const entry of lan.slice(0, 32) as unknown[]) {
    const parsed = deviceLanSubnetSchema.safeParse(entry);
    if (!parsed.success) continue;
    const [network = '', bits] = parsed.data.network.split('/');
    const prefix = Number(bits);
    if (isMeshIp(network) || isLoopbackIp(network)) continue;
    out.push({ network, prefix, broadcast: directedBroadcast(network, prefix) });
  }
  return out;
}

/** The Hub's interfaces a magic packet may leave by: physical LAN ones only. */
function lanInterfaces(hub: InterfaceAddress[]): InterfaceAddress[] {
  return hub.filter((i) => !i.internal && !isMeshIp(i.address) && !isVirtualInterface(i.name));
}

/** The system resolver, given up on after `ms` (a dead name never stalls the panel or a wake). */
function lookupWithin(ms: number): (host: string) => Promise<string[]> {
  return async (host) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        dnsLookup(host, { all: true }).then(
          (list) => list.map((a) => a.address),
          () => [],
        ),
        new Promise<string[]>((resolve) => {
          timer = setTimeout(() => resolve([]), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export class WakeHelperRouter implements DeviceWakeRouter {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #transport: DeviceTransport;
  readonly #preferred: () => Promise<string[]>;
  readonly #interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly #lookup: (host: string) => Promise<string[]>;
  readonly #port: number;
  readonly #timeoutMs: number;
  readonly #log: Logger;

  constructor(opts: WakeHelperRouterOptions) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#transport = opts.transport ?? httpDeviceTransport;
    this.#preferred = opts.preferred ?? (() => Promise.resolve([]));
    this.#interfaces = opts.interfaces ?? networkInterfaces;
    this.#lookup = opts.lookup ?? lookupWithin(1_000);
    this.#port = opts.port ?? 9;
    this.#timeoutMs = opts.timeoutMs ?? 5_000;
    this.#log = opts.log ?? new Logger({ module: 'core.network.wake', sinks: [] });
  }

  /** A device's last reported addresses: the hosts of its registered endpoints. */
  async addresses(deviceId: string): Promise<string[]> {
    const rows = this.#db.raw
      .prepare('SELECT url FROM transport_endpoint WHERE device_id = ? ORDER BY created_at')
      .all(deviceId) as { url: string }[];
    const out: string[] = [];
    for (const { url } of rows) {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      const ip = normalizeIp(host);
      if (ip) {
        if (!out.includes(ip)) out.push(ip);
        continue;
      }
      try {
        for (const a of await this.#lookup(host)) {
          const n = normalizeIp(a);
          if (n && !out.includes(n)) out.push(n);
        }
      } catch {
        // a name that no longer resolves gives no address
      }
    }
    return out;
  }

  async #lan(deviceId: string): Promise<DeviceLan> {
    const row = this.#db.raw
      .prepare('SELECT power FROM device_management WHERE device_id = ?')
      .get(deviceId) as { power: string | null } | undefined;
    return {
      addresses: (await this.addresses(deviceId)).filter(lanAddress),
      subnets: parseSubnets(row?.power ?? null),
    };
  }

  #rows(accountId: string): HelperRow[] {
    return (
      this.#db.raw
        .prepare(
          `SELECT d.id, d.name, d.status, d.roles, d.last_seen_at FROM device d
           JOIN device_management m ON m.device_id = d.id
           WHERE d.account_id = ? AND d.status != 'revoked'
           ORDER BY d.last_seen_at DESC, d.id`,
        )
        .all(accountId) as unknown as HelperRow[]
    ).filter((r) => parseRoles(r.roles).includes('wake-helper'));
  }

  /** Active devices with the wake-helper role, most recently seen first; only the preferred ones, in their order, when set. */
  async helpers(accountId: string, exclude: string | null = null): Promise<string[]> {
    const ids = this.#rows(accountId)
      .filter((r) => r.status === 'active' && r.id !== exclude)
      .map((r) => r.id);
    const preferred = await this.#preferred();
    if (preferred.length === 0) return ids;
    return preferred.filter((id) => ids.includes(id));
  }

  /** Every device with the wake-helper role that is not revoked, for the network panel. */
  async available(accountId: string): Promise<WakeHelperView[]> {
    const rows = this.#rows(accountId).sort((a, b) => a.id.localeCompare(b.id));
    const out: WakeHelperView[] = [];
    for (const r of rows) {
      const lan = await this.#lan(r.id);
      out.push({
        deviceId: r.id,
        name: r.name,
        status: r.status,
        addresses: await this.addresses(r.id),
        subnets: lan.subnets.map((s) => `${s.network}/${s.prefix}`),
        lastSeenAt: r.last_seen_at,
      });
    }
    return out;
  }

  /** The Hub's own interface on `address`'s network, when it has one. */
  #hubOn(address: string, hub: InterfaceAddress[]): InterfaceAddress | undefined {
    return lanInterfaces(hub).find(
      (i) => i.prefix < (i.family === 4 ? 32 : 128) && inSubnet(address, i.address, i.prefix),
    );
  }

  /**
   * Whether a helper shares the target's LAN, and the broadcast address to use when it is known
   * exactly (else the helper broadcasts on all its subnets).
   */
  #share(
    helper: DeviceLan,
    target: DeviceLan,
    hub: InterfaceAddress[],
  ): { broadcast: string | null } | null {
    // Both reported their subnets: the same network.
    for (const t of target.subnets) {
      if (helper.subnets.some((h) => h.network === t.network && h.prefix === t.prefix))
        return { broadcast: t.broadcast };
    }
    // The target's address is on a subnet the helper reported.
    for (const a of target.addresses) {
      const s = helper.subnets.find((h) => inSubnet(a, h.network, h.prefix));
      if (s) return { broadcast: s.broadcast };
    }
    // Addresses only: the prefix of the Hub's own interface there, else /24 or /64.
    for (const a of target.addresses) {
      const own = this.#hubOn(a, hub);
      const prefix = own?.prefix ?? (ipFamily(a) === 6 ? 64 : 24);
      if (helper.addresses.some((h) => inSubnet(h, a, prefix)))
        return { broadcast: own ? directedBroadcast(a, prefix) : null };
    }
    return null;
  }

  /**
   * Send the wake through a helper, or say the Hub should broadcast it (with the directed
   * broadcast address of its interface on the target's subnet). `conflict` with reason
   * `no_wake_helper` when neither can reach the target's LAN.
   */
  async route(input: WakeRouteInput): Promise<WakeRoute> {
    const target = await this.#lan(input.deviceId);
    const hub = interfaceAddresses(this.#interfaces());
    const tried: { deviceId: string; error: string }[] = [];
    for (const helperId of await this.helpers(input.accountId, input.deviceId)) {
      const shared = this.#share(await this.#lan(helperId), target, hub);
      if (!shared) continue;
      const endpoint = this.#db.raw
        .prepare(
          "SELECT url FROM transport_endpoint WHERE device_id = ? AND net = 'lan' ORDER BY created_at LIMIT 1",
        )
        .get(helperId) as { url: string } | undefined;
      const token = await this.#secrets.get(managementTokenRef(helperId));
      if (!endpoint || !token) {
        tried.push({ deviceId: helperId, error: 'no management endpoint' });
        continue;
      }
      try {
        await callDevice(
          this.#transport,
          endpoint.url,
          token,
          WAKE_OTHER_PATH,
          {
            mac: input.mac,
            port: this.#port,
            ...(shared.broadcast ? { broadcast: shared.broadcast } : {}),
          },
          this.#timeoutMs,
        );
        return { via: 'helper', helperDeviceId: helperId };
      } catch (err) {
        const error = err instanceof Error ? err.message.slice(0, 200) : 'failed';
        tried.push({ deviceId: helperId, error });
        this.#log.warn('wake helper failed', { helperId, error });
      }
    }
    // The Hub's own broadcast reaches the target when one of its physical LAN interfaces is on
    // the target's subnet; loopback, mesh and tunnel addresses never count (review 18).
    const own = lanInterfaces(hub).filter((i) => i.family === 4);
    for (const s of target.subnets) {
      if (own.some((i) => i.prefix === s.prefix && inSubnet(i.address, s.network, s.prefix)))
        return { via: 'hub', address: s.broadcast };
    }
    for (const a of target.addresses) {
      const i = own.find((x) => x.prefix <= 30 && inSubnet(a, x.address, x.prefix));
      if (i) return { via: 'hub', address: directedBroadcast(i.address, i.prefix) };
    }
    throw new NovaError('conflict', 'no Wake Helper or Hub interface is on the device’s LAN', {
      details: { reason: 'no_wake_helper', tried },
      action: 'Add a device on that LAN as a Wake Helper',
    });
  }
}
