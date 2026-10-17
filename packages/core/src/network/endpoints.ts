// The Hub's endpoints (FR-135, docs/22 §2, §9.7): candidates per transport — LAN from the Hub's
// own interfaces and its mDNS name, Mesh and Relay from their areas' sources, Direct public from
// settings — each tested with a real reachability probe on a schedule and on demand. Only healthy
// candidates of enabled transports are advertised, best first (LAN → Mesh → Relay → Direct). Every
// probe is kept for 7 days (`network_endpoint_check`), and every change to what is advertised is
// logged (`network_transport_event`) and announced (`network.endpoints.changed`,
// `network.transport.changed`): a LAN outage that leaves Mesh or Relay as the preferred path is
// the logged fallback of docs/17 §M6.5.
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import {
  NETWORK_TRANSPORTS,
  TRANSPORT_PRIORITY,
  endpointCandidateSchema,
  uuidv7,
  type EndpointCandidate,
  type EndpointProbeOutcome,
  type NetworkListenerView,
  type NetworkTestResult,
  type NetworkTransport,
  type NetworkTransportView,
  type TransportEventView,
  type TransportStatus,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import { probeHello, type HubProbe } from './probe.ts';
import {
  isLinkLocalIp,
  isLoopbackIp,
  isMeshIp,
  isVirtualInterface,
  normalizeIp,
  ipFamily,
  urlIp,
} from './subnet.ts';

/** Where the Hub listens (main.ts reports it once it is bound). */
export type ListenerInfo = NetworkListenerView;

/** Mesh and Relay candidates come from their areas (`useEndpointSource`). */
export interface EndpointSource {
  transport: 'mesh' | 'relay';
  list(): Promise<EndpointCandidate[]>;
  /**
   * Test one of its candidates. Without it, http(s) URLs get the Hub's hello probe and other URLs
   * (a Relay's wss://) keep the health the source reports.
   */
  check?(candidate: EndpointCandidate): Promise<EndpointProbeOutcome>;
}

export interface EndpointConfig {
  enabled: Record<NetworkTransport, boolean>;
  includeLoopback: boolean;
  includeLinkLocal: boolean;
  /** `<name>.local` while the mDNS advertiser runs, else null. */
  mdnsHost: string | null;
  directPublicUrl: string | null;
}

function isWildcard(host: string): 4 | 6 | null {
  if (host === '0.0.0.0' || host === '') return 4;
  if (host === '::' || host === '[::]') return 6;
  return null;
}

/** Whether the listener accepts only this computer's own connections. */
export function listensOnLoopbackOnly(listener: ListenerInfo): boolean {
  const host = listener.host.toLowerCase();
  return host === 'localhost' || isLoopbackIp(host);
}

function hostUrl(protocol: string, address: string, port: number): string {
  return `${protocol}://${ipFamily(address) === 6 ? `[${address}]` : address}:${port}`;
}

/**
 * LAN candidates from the Hub's interfaces: the addresses its listener accepts, without loopback
 * and IPv4 link-local unless asked, never IPv6 link-local (a URL cannot carry its zone), container
 * bridges, or mesh addresses. IPv4 first (priority 10), then IPv6 (12); the mDNS name is 11.
 */
export function lanCandidates(input: {
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
  listener: ListenerInfo;
  includeLoopback: boolean;
  includeLinkLocal: boolean;
}): EndpointCandidate[] {
  const { listener } = input;
  const listenHost = listener.host.toLowerCase();
  const wildcard = isWildcard(listenHost);
  const bound = normalizeIp(listenHost);
  const out: EndpointCandidate[] = [];
  const seen = new Set<string>();
  for (const [name, entries] of Object.entries(input.interfaces)) {
    for (const e of entries ?? []) {
      const address = normalizeIp(e.address);
      if (!address) continue;
      const family = ipFamily(address);
      if (wildcard === 4 && family !== 4) continue;
      if (wildcard === null) {
        if (listenHost === 'localhost') {
          if (!e.internal) continue;
        } else if (address !== bound) continue;
      }
      const loopback = e.internal || isLoopbackIp(address);
      if (loopback && !input.includeLoopback) continue;
      if (!loopback && isVirtualInterface(name)) continue;
      if (isMeshIp(address)) continue;
      if (family === 6 && isLinkLocalIp(address)) continue;
      if (family === 4 && isLinkLocalIp(address) && !input.includeLinkLocal) continue;
      const url = hostUrl(listener.protocol, address, listener.port);
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        transport: 'lan',
        url,
        priority: TRANSPORT_PRIORITY.lan + (family === 4 ? 0 : 2),
        health: 'unknown',
        latencyMs: null,
        checkedAt: null,
        detail: name,
      });
    }
  }
  return out.sort((a, b) => a.priority - b.priority);
}

interface Target {
  candidate: EndpointCandidate;
  /** For the mDNS name: probe this address with the name as Host. */
  connectAddress?: string;
  source?: EndpointSource;
}

export interface EndpointRegistryOptions {
  db: NovaDatabase;
  config: () => Promise<EndpointConfig>;
  events?: EventSink;
  log?: Logger;
  now?: () => Date;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  probe?: HubProbe;
  /** Per probe (default 300 ms, docs/22 §2). */
  probeTimeoutMs?: number;
  /** The Hub's own fingerprint, so another Hub answering is not taken for this one. */
  fingerprint?: () => Promise<string | null>;
  /** An extra CA (PEM) to verify the Hub's own https endpoints (the local CA). */
  ca?: () => Promise<string | null>;
  timers?: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  /** How long probe history is kept (default 7 days). */
  historyDays?: number;
}

export type EndpointsListener = (advertised: EndpointCandidate[]) => void;

interface EventRow {
  id: string;
  kind: TransportEventView['kind'];
  transport: NetworkTransport | null;
  from_transport: NetworkTransport | null;
  url: string | null;
  detail: string | null;
  created_at: string;
}

const SOURCE_TIMEOUT_MS = 2_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class EndpointRegistry {
  readonly #db: NovaDatabase;
  readonly #config: () => Promise<EndpointConfig>;
  readonly #events: EventSink | null;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly #probe: HubProbe;
  readonly #probeTimeoutMs: number;
  readonly #fingerprint: () => Promise<string | null>;
  readonly #ca: () => Promise<string | null>;
  readonly #timers: NonNullable<EndpointRegistryOptions['timers']>;
  readonly #historyDays: number;
  readonly #sources = new Set<EndpointSource>();
  readonly #listeners = new Set<EndpointsListener>();
  #listener: ListenerInfo | null = null;
  #timer: unknown = null;
  #running: Promise<NetworkTestResult> | null = null;
  #transports: NetworkTransportView[] = [];
  #advertised: EndpointCandidate[] = [];
  #primary: NetworkTransport | null = null;
  #checkedAt: string | null = null;

  constructor(opts: EndpointRegistryOptions) {
    this.#db = opts.db;
    this.#config = opts.config;
    this.#events = opts.events ?? null;
    this.#log = opts.log ?? new Logger({ module: 'core.network', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#interfaces = opts.interfaces ?? networkInterfaces;
    this.#probe = opts.probe ?? probeHello;
    this.#probeTimeoutMs = opts.probeTimeoutMs ?? 300;
    this.#fingerprint = opts.fingerprint ?? (() => Promise.resolve(null));
    this.#ca = opts.ca ?? (() => Promise.resolve(null));
    this.#timers = opts.timers ?? {
      setInterval: (fn, ms) => {
        const t = setInterval(fn, ms);
        t.unref();
        return t;
      },
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
    this.#historyDays = opts.historyDays ?? 7;
  }

  get listener(): ListenerInfo | null {
    return this.#listener;
  }

  setListener(listener: ListenerInfo | null): void {
    this.#listener = listener;
  }

  /** A Mesh or Relay source; returns its removal. */
  useSource(source: EndpointSource): () => void {
    this.#sources.add(source);
    return () => this.#sources.delete(source);
  }

  /** Called with the advertised set whenever it changes. */
  onChange(listener: EndpointsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Check on a schedule (and once now); a second call changes the interval. */
  start(intervalMs: number): void {
    this.stop();
    this.#timer = this.#timers.setInterval(() => {
      if (this.#running) return;
      this.check().catch((err: unknown) => this.#log.warn('endpoint check failed', { err }));
    }, intervalMs);
  }

  stop(): void {
    if (this.#timer !== null) this.#timers.clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Healthy candidates of enabled transports, best first: what clients are told. */
  advertised(): EndpointCandidate[] {
    return this.#advertised.map((c) => ({ ...c }));
  }

  transports(): NetworkTransportView[] {
    return this.#transports.map((t) => ({ ...t, endpoints: t.endpoints.map((c) => ({ ...c })) }));
  }

  primary(): NetworkTransport | null {
    return this.#primary;
  }

  checkedAt(): string | null {
    return this.#checkedAt;
  }

  /**
   * The transport a request arrived on, from its Host header: null when unknown, and for this
   * computer's own names (no transport change can cut those off).
   */
  classify(host: string): NetworkTransport | null {
    let name: string;
    try {
      name = new URL(`http://${host}`).host.toLowerCase();
    } catch {
      return null;
    }
    for (const t of this.#transports) {
      for (const c of t.endpoints) {
        try {
          if (new URL(c.url).host.toLowerCase() === name) return c.transport;
        } catch {
          // a source URL that is not a URL never matches
        }
      }
    }
    return null;
  }

  /** Probe one URL now, as the scheduled checks do (for Network Setup's verify step). */
  async probe(url: string): Promise<EndpointProbeOutcome> {
    return this.#probe(url, {
      timeoutMs: this.#probeTimeoutMs,
      expectFingerprint: await this.#fingerprint(),
      ca: await this.#ca(),
    });
  }

  /**
   * The check already running or queued, else a new one: for on-demand tests, so concurrent
   * callers share one run instead of queueing a full check each.
   */
  checkShared(): Promise<NetworkTestResult> {
    return this.#running ?? this.check();
  }

  /** Run every reachability test now; runs one at a time (a call waits for the current one). */
  check(): Promise<NetworkTestResult> {
    const previous = this.#running ?? Promise.resolve(null);
    const run = previous
      .catch(() => null)
      .then(() => this.#check())
      .finally(() => {
        if (this.#running === run) this.#running = null;
      });
    this.#running = run;
    return run;
  }

  async #targets(cfg: EndpointConfig): Promise<{
    targets: Target[];
    details: Partial<Record<NetworkTransport, string>>;
  }> {
    const targets: Target[] = [];
    const details: Partial<Record<NetworkTransport, string>> = {};
    const listener = this.#listener;
    // LAN: the Hub's own addresses, then its mDNS name probed through the first of them.
    if (!listener) {
      details.lan = 'the Hub has not reported where it listens yet';
    } else {
      const lan = lanCandidates({
        interfaces: this.#interfaces(),
        listener,
        includeLoopback: cfg.includeLoopback,
        includeLinkLocal: cfg.includeLinkLocal,
      });
      for (const c of lan) targets.push({ candidate: c });
      const via = lan.map((c) => urlIp(c.url)).find((a): a is string => a !== null);
      if (cfg.mdnsHost && via) {
        targets.push({
          candidate: {
            transport: 'lan',
            url: `${listener.protocol}://${cfg.mdnsHost}:${listener.port}`,
            priority: TRANSPORT_PRIORITY.lan + 1,
            health: 'unknown',
            latencyMs: null,
            checkedAt: null,
            detail: 'mdns',
          },
          connectAddress: via,
        });
      }
      if (lan.length === 0) {
        details.lan = listensOnLoopbackOnly(listener)
          ? `the Hub listens on ${listener.host} only; start it with --host 0.0.0.0 (NOVA_HOST) to reach it from the LAN`
          : 'no LAN address of this computer accepts connections';
      }
    }
    // Mesh and Relay: their areas' sources, in their order within the transport.
    for (const transport of ['mesh', 'relay'] as const) {
      const sources = [...this.#sources].filter((s) => s.transport === transport);
      if (sources.length === 0) {
        details[transport] = transport === 'mesh' ? 'no mesh is set up' : 'no Relay is set up';
        continue;
      }
      let index = 0;
      for (const source of sources) {
        let listed: EndpointCandidate[];
        try {
          listed = await withTimeout(source.list(), SOURCE_TIMEOUT_MS, `the ${transport} source`);
        } catch (err) {
          details[transport] = err instanceof Error ? err.message : 'the source failed';
          continue;
        }
        for (const raw of listed) {
          const parsed = endpointCandidateSchema.safeParse(raw);
          if (!parsed.success) continue;
          targets.push({
            candidate: {
              ...parsed.data,
              transport,
              priority: TRANSPORT_PRIORITY[transport] + Math.min(index, 9),
            },
            source,
          });
          index += 1;
        }
      }
      if (index === 0 && !details[transport])
        details[transport] =
          `the ${transport === 'mesh' ? 'mesh' : 'Relay'} reports no address for the Hub`;
    }
    if (cfg.directPublicUrl) {
      targets.push({
        candidate: {
          transport: 'direct',
          url: cfg.directPublicUrl.replace(/\/+$/, ''),
          priority: TRANSPORT_PRIORITY.direct,
          health: 'unknown',
          latencyMs: null,
          checkedAt: null,
          detail: null,
        },
      });
    } else if (cfg.enabled.direct) {
      details.direct = 'no public URL is set';
    }
    return { targets, details };
  }

  async #test(t: Target, at: string): Promise<EndpointCandidate> {
    const c = t.candidate;
    let outcome: EndpointProbeOutcome;
    if (t.source?.check) {
      try {
        outcome = await withTimeout(t.source.check(c), SOURCE_TIMEOUT_MS * 2, 'the check');
      } catch (err) {
        outcome = { ok: false, detail: err instanceof Error ? err.message : 'check failed' };
      }
    } else if (/^https?:\/\//i.test(c.url)) {
      outcome = await this.#probe(c.url, {
        timeoutMs: this.#probeTimeoutMs,
        ...(t.connectAddress ? { connectAddress: t.connectAddress } : {}),
        expectFingerprint: await this.#fingerprint().catch(() => null),
        ca: await this.#ca().catch(() => null),
      });
    } else {
      // A Relay's own connection state is its reachability test.
      return { ...c, checkedAt: c.checkedAt ?? at };
    }
    return {
      ...c,
      health: outcome.ok ? 'ok' : 'failing',
      latencyMs: outcome.ok ? (outcome.latencyMs ?? null) : null,
      checkedAt: at,
      detail: outcome.ok ? c.detail : (outcome.detail ?? 'unreachable'),
    };
  }

  async #check(): Promise<NetworkTestResult> {
    const cfg = await this.#config();
    const at = this.#now().toISOString();
    const { targets, details } = await this.#targets(cfg);
    const enabled = (t: NetworkTransport) => cfg.enabled[t];
    const tested = await Promise.all(
      targets.map((t) =>
        enabled(t.candidate.transport) ? this.#test(t, at) : Promise.resolve(t.candidate),
      ),
    );
    const transports: NetworkTransportView[] = NETWORK_TRANSPORTS.map((transport) => {
      const endpoints = tested
        .filter((c) => c.transport === transport)
        .sort((a, b) => a.priority - b.priority);
      const on = enabled(transport);
      const status: TransportStatus = !on
        ? 'off'
        : endpoints.length === 0
          ? 'none'
          : endpoints.some((c) => c.health === 'ok')
            ? 'up'
            : 'down';
      return {
        transport,
        enabled: on,
        status,
        endpoints: on ? endpoints : [],
        detail: on ? (details[transport] ?? null) : `${transport} is not advertised`,
      };
    });
    const advertised = transports
      .filter((t) => t.enabled)
      .flatMap((t) => t.endpoints.filter((c) => c.health === 'ok'))
      .sort(
        (a, b) => a.priority - b.priority || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity),
      );
    await this.#record(tested, transports, advertised, at);
    const result: NetworkTestResult = {
      checkedAt: at,
      transports: transports.map((t) => ({ ...t, endpoints: t.endpoints.map((c) => ({ ...c })) })),
      advertised: advertised.map((c) => ({ ...c })),
      primary: advertised[0]?.transport ?? null,
    };
    return result;
  }

  async #record(
    tested: EndpointCandidate[],
    transports: NetworkTransportView[],
    advertised: EndpointCandidate[],
    at: string,
  ): Promise<void> {
    const before = new Map(this.#advertised.map((c) => [c.url, c]));
    const after = new Map(advertised.map((c) => [c.url, c]));
    const statusBefore = new Map(this.#transports.map((t) => [t.transport, t.status]));
    const primaryBefore = this.#primary;
    const primary = advertised[0]?.transport ?? null;
    const rows: EventRow[] = [];
    const ev = (r: Omit<EventRow, 'id' | 'created_at'>) =>
      rows.push({ ...r, id: uuidv7(), created_at: at });
    const removed: { url: string; transport: NetworkTransport; reason: string }[] = [];
    for (const [url, c] of after) {
      if (!before.has(url))
        ev({
          kind: 'advertised',
          transport: c.transport,
          from_transport: null,
          url,
          detail: null,
        });
    }
    for (const [url, c] of before) {
      if (after.has(url)) continue;
      const now = tested.find((x) => x.url === url);
      const reason = !now
        ? 'no longer a candidate'
        : !transports.find((t) => t.transport === c.transport)?.enabled
          ? 'transport disabled'
          : (now.detail ?? 'failing');
      removed.push({ url, transport: c.transport, reason });
      ev({ kind: 'withdrawn', transport: c.transport, from_transport: null, url, detail: reason });
    }
    const changedTransports: NetworkTransport[] = [];
    for (const t of transports) {
      const was = statusBefore.get(t.transport) ?? 'none';
      // Only a transport coming up or going down is a change clients care about.
      if (was === t.status || (t.status !== 'up' && was !== 'up')) continue;
      changedTransports.push(t.transport);
      const failing = t.endpoints.find((c) => c.health === 'failing')?.detail;
      // A transport the owner turned off is not a failure (docs/22 §10).
      ev({
        kind: t.status === 'up' ? 'up' : t.status === 'off' ? 'off' : 'down',
        transport: t.transport,
        from_transport: null,
        url: null,
        detail: t.status === 'up' || t.status === 'off' ? null : (failing ?? t.detail ?? t.status),
      });
    }
    const primaryChanged = primary !== primaryBefore;
    if (primaryChanged) {
      ev({
        kind: 'primary',
        transport: primary,
        from_transport: primaryBefore,
        url: advertised[0]?.url ?? null,
        detail: primary ? null : 'nothing passes its reachability test',
      });
    }
    const cutoff = new Date(Date.parse(at) - this.#historyDays * 86_400_000).toISOString();
    const eventCutoff = new Date(Date.parse(at) - 90 * 86_400_000).toISOString();
    await this.#db.transaction(() => {
      const insert = this.#db.raw.prepare(
        `INSERT INTO network_endpoint_check (id, transport, url, health, latency_ms, detail, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of tested) {
        if (c.health === 'unknown' || c.checkedAt !== at) continue;
        insert.run(
          uuidv7(),
          c.transport,
          c.url,
          c.health,
          c.latencyMs === null ? null : Math.round(c.latencyMs),
          c.health === 'ok' ? null : c.detail,
          at,
        );
      }
      const insertEvent = this.#db.raw.prepare(
        `INSERT INTO network_transport_event (id, kind, transport, from_transport, url, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows)
        insertEvent.run(r.id, r.kind, r.transport, r.from_transport, r.url, r.detail, r.created_at);
      this.#db.raw.prepare('DELETE FROM network_endpoint_check WHERE checked_at < ?').run(cutoff);
      this.#db.raw
        .prepare('DELETE FROM network_transport_event WHERE created_at < ?')
        .run(eventCutoff);
    });
    this.#transports = transports;
    this.#advertised = advertised;
    this.#primary = primary;
    this.#checkedAt = at;
    const setChanged = removed.length > 0 || [...after.keys()].some((u) => !before.has(u));
    if (setChanged) {
      await this.#emit('network.endpoints.changed', {
        advertised: advertised.map((c) => ({
          transport: c.transport,
          url: c.url,
          priority: c.priority,
        })),
        added: [...after.keys()].filter((u) => !before.has(u)),
        removed,
      });
      for (const l of this.#listeners) {
        try {
          l(this.advertised());
        } catch (err) {
          this.#log.warn('endpoints listener failed', { err });
        }
      }
    }
    if (changedTransports.length > 0 || primaryChanged) {
      await this.#emit('network.transport.changed', {
        primary,
        previousPrimary: primaryBefore,
        transports: Object.fromEntries(transports.map((t) => [t.transport, t.status])),
        changed: changedTransports,
      });
      if (primaryChanged)
        this.#log.info('preferred transport changed', { from: primaryBefore, to: primary });
    }
  }

  async #emit(name: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.#events) return;
    try {
      await this.#events.emit({ name, actor: 'system', payload });
    } catch (err) {
      this.#log.warn('network event not emitted', { err, name });
    }
  }

  /** The transport events log, newest first. */
  events(limit = 50): TransportEventView[] {
    const rows = this.#db.raw
      .prepare('SELECT * FROM network_transport_event ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit))) as unknown as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      transport: r.transport,
      fromTransport: r.from_transport,
      url: r.url,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  /** Checks and successes per URL over the last 24 hours. */
  uptime24h(): Map<string, { checks: number; ok: number }> {
    const since = new Date(this.#now().getTime() - 86_400_000).toISOString();
    const rows = this.#db.raw
      .prepare(
        `SELECT url, count(*) AS checks, sum(CASE WHEN health = 'ok' THEN 1 ELSE 0 END) AS ok
         FROM network_endpoint_check WHERE checked_at >= ? GROUP BY url`,
      )
      .all(since) as { url: string; checks: number; ok: number }[];
    return new Map(rows.map((r) => [r.url, { checks: Number(r.checks), ok: Number(r.ok) }]));
  }
}
