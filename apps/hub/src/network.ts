// Network area (FR-135, FR-138, FR-139; docs/22 §2, §6, §7, §9; contracts/hub-api.md "Settings,
// network, diagnostics"). The Hub's endpoints per transport with real reachability checks on a
// schedule and on demand, only healthy ones advertised (to POST /api/v1/hello and the Add Device
// QR through `endpoints()`), mDNS on the LAN, the network panel with its change log and one-click
// rollback, diagnostics, and Wake Helper routing for the devices area's wake route. Every route
// needs a session; none is public.
//   GET/PATCH /api/v1/network          the panel; PATCH is audited (`network.change`) and recorded
//   POST      /api/v1/network/test     run every reachability test now
//   POST      /api/v1/network/rollback revert the last change (or `changeId`); `network.rollback`
//   GET       /api/v1/network/diagnostics
// What it needs from other areas is bound late: the settings writer (app.ts), Mesh and Relay
// endpoint sources, the Hub identity and trust summary (trust area), the mesh ACL summary and the
// Relay status. main.ts reports where the Hub listens (`listening`), which starts the checks.
import type { NetworkInterfaceInfo } from 'node:os';
import { hostname as osHostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import {
  ACTOR,
  NETWORK_TRANSPORTS,
  NovaError,
  networkRollbackSchema,
  updateNetworkSchema,
  type EndpointCandidate,
  type EndpointProbeOutcome,
  type NetworkChangeView,
  type NetworkDiagnosticsView,
  type NetworkTestResult,
  type NetworkTransport,
  type NetworkTransportView,
  type NetworkTrustSummary,
  type NetworkView,
  type WakeLogView,
  type SettingKey,
} from '@nova/shared';
import {
  EndpointRegistry,
  MdnsAdvertiser,
  NetworkChangeLog,
  WakeHelperRouter,
  deviceReachability,
  hubMdnsName,
  listensOnLoopbackOnly,
  urlIp,
  type AuditSink,
  type DeviceTransport,
  type EndpointRegistryOptions,
  type EndpointSource,
  type HubProbe,
  type ListenerInfo,
  type MdnsResponder,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

/** Stores one setting the way PATCH /api/v1/settings does (validation, managed lock, event). */
export type NetworkSettingsWriter = (
  accountId: string | null,
  key: SettingKey,
  value: unknown,
) => Promise<void>;

/** The Hub identity's public part (trust area). */
export type HubIdentityLike = { fingerprint: string } | null;

/** The settings this area owns; only these can be written or rolled back here. */
export const NETWORK_SETTING_KEYS = [
  'network.transports',
  'network.lan.mdns',
  'network.lan.mdnsName',
  'network.lan.includeLoopback',
  'network.lan.includeLinkLocal',
  'network.directPublic.url',
  'network.healthCheckSeconds',
  'network.wakeHelpers',
] as const satisfies readonly SettingKey[];
type NetworkSettingKey = (typeof NETWORK_SETTING_KEYS)[number];

/** The change kind of the panel's own edits. */
export const NETWORK_SETTINGS_CHANGE = 'network.settings';

export interface NetworkArea extends HubArea {
  registry: EndpointRegistry;
  changes: NetworkChangeLog;
  /** For the devices area: `devices.service.useWakeRouter(network.wakeRouter)` (FR-138). */
  wakeRouter: WakeHelperRouter;
  mdns: MdnsAdvertiser;
  /** Healthy endpoints, best first: POST /api/v1/hello's `endpoints`, the Add Device QR. */
  endpoints(): EndpointCandidate[];
  /** Where the Hub listens once bound (main.ts); starts the checks and mDNS. */
  listening(listener: ListenerInfo): Promise<void>;
  /** Run every reachability test now (Network Setup's verify step). */
  test(): Promise<NetworkTestResult>;
  /** Probe one URL as the checks do. */
  probe(url: string): Promise<EndpointProbeOutcome>;
  /** The transport a request came in on, from its Host header (null: unknown or this computer). */
  classify(host: string): NetworkTransport | null;
  /**
   * Names the Hub must answer to for its endpoints to pass their own test: `<name>.local` while
   * mDNS runs and the host of the direct public URL (app.ts adds them to the Host allowlist).
   */
  hostNames(): Promise<string[]>;
  useAudit(audit: AuditSink): void;
  useSettingsWriter(write: NetworkSettingsWriter): void;
  /** Mesh (network setup area) and Relay (relay area) endpoints; returns the removal. */
  useEndpointSource(source: EndpointSource): () => void;
  useHubIdentity(identity: () => HubIdentityLike | Promise<HubIdentityLike>): void;
  useTrustSummary(summary: () => Promise<NetworkTrustSummary | null>): void;
  /** The Hub's local CA (PEM), so the checks verify its own https endpoints. */
  useProbeCa(ca: () => Promise<string | null>): void;
  useMeshSummary(summary: () => Promise<Record<string, unknown> | null>): void;
  useRelayStatus(status: () => Promise<Record<string, unknown> | null>): void;
  /**
   * Called when `hostNames()` may have changed (mDNS started or stopped), before the checks run:
   * app.ts refreshes its Host allowlist so the new name passes its own test at once.
   */
  useHostNamesChanged(refresh: () => Promise<void>): void;
}

export interface NetworkDeps {
  audit?: AuditSink;
  writeSetting?: NetworkSettingsWriter;
  /** Tests: a clock, fake interfaces and host name, a fake probe, mDNS responder and timers. */
  now?: () => Date;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  hostname?: () => string;
  probe?: HubProbe;
  probeTimeoutMs?: number;
  mdns?: () => MdnsResponder;
  timers?: EndpointRegistryOptions['timers'];
  /** How Wake Helpers are reached (the devices' management channel). */
  transport?: DeviceTransport;
  lookup?: (host: string) => Promise<string[]>;
}

const TRANSPORT_NAMES: Record<NetworkTransport, string> = {
  lan: 'LAN',
  mesh: 'Mesh',
  relay: 'Relay',
  direct: 'Direct public',
};

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function setupNetwork(ctx: HubContext, deps: NetworkDeps = {}): Promise<NetworkArea> {
  const log = ctx.log.child('network');
  const now = deps.now ?? (() => new Date());
  let audit: AuditSink | null = deps.audit ?? null;
  let writer: NetworkSettingsWriter | null = deps.writeSetting ?? null;
  let identity: (() => HubIdentityLike | Promise<HubIdentityLike>) | null = null;
  let trust: (() => Promise<NetworkTrustSummary | null>) | null = null;
  let probeCa: (() => Promise<string | null>) | null = null;
  let meshSummary: (() => Promise<Record<string, unknown> | null>) | null = null;
  let relayStatus: (() => Promise<Record<string, unknown> | null>) | null = null;

  const fingerprint = async (): Promise<string | null> => {
    try {
      return (await identity?.())?.fingerprint ?? null;
    } catch {
      return null;
    }
  };

  const mdns = new MdnsAdvertiser({
    ...(deps.mdns ? { create: deps.mdns } : {}),
    log: log.child('mdns'),
  });
  const changes = new NetworkChangeLog({ db: ctx.db, now });
  const registry = new EndpointRegistry({
    db: ctx.db,
    events: ctx.events,
    log,
    now,
    ...(deps.interfaces ? { interfaces: deps.interfaces } : {}),
    ...(deps.probe ? { probe: deps.probe } : {}),
    ...(deps.probeTimeoutMs ? { probeTimeoutMs: deps.probeTimeoutMs } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
    fingerprint,
    ca: async () => (probeCa ? await probeCa().catch(() => null) : null),
    config: async () => {
      const t = await ctx.setting('network.transports');
      return {
        enabled: { lan: t.lan, mesh: t.mesh, relay: t.relay, direct: t.directPublic },
        includeLoopback: await ctx.setting('network.lan.includeLoopback'),
        includeLinkLocal: await ctx.setting('network.lan.includeLinkLocal'),
        mdnsHost: mdns.running && mdns.name ? `${mdns.name}.local` : null,
        directPublicUrl: await ctx.setting('network.directPublic.url'),
      };
    },
  });
  const wakeRouter = new WakeHelperRouter({
    db: ctx.db,
    secrets: ctx.secrets,
    log: log.child('wake'),
    preferred: () => ctx.setting('network.wakeHelpers'),
    ...(deps.transport ? { transport: deps.transport } : {}),
    ...(deps.interfaces ? { interfaces: deps.interfaces } : {}),
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
  });

  const mdnsName = async () =>
    (await ctx.setting('network.lan.mdnsName')) ?? hubMdnsName((deps.hostname ?? osHostname)());

  /** mDNS answers with the healthy LAN addresses only (docs/22 §9.7). */
  const advertiseMdns = async (): Promise<void> => {
    const listener = registry.listener;
    if (!listener || !mdns.running) return;
    const addresses = registry
      .advertised()
      .filter((c) => c.transport === 'lan')
      .map((c) => urlIp(c.url))
      .filter((a): a is string => a !== null && a !== '127.0.0.1' && a !== '::1');
    mdns.advertise({
      name: await mdnsName(),
      port: listener.port,
      addresses,
      fingerprint: await fingerprint(),
    });
  };
  registry.onChange(() => {
    advertiseMdns().catch((err: unknown) => log.warn('mDNS update failed', { err }));
  });

  // Settings changes, checks and mDNS are applied one at a time; calls made while one waits to
  // start share it (it reads the settings when it starts).
  let applying: Promise<void> = Promise.resolve();
  let waiting: Promise<void> | null = null;
  let namesChanged: () => Promise<void> = () => Promise.resolve();
  const reconfigure = (): Promise<void> => {
    if (waiting) return waiting;
    const run = applying
      .catch(() => undefined)
      .then(async () => {
        waiting = null;
        const listener = registry.listener;
        if (!listener) return;
        const t = await ctx.setting('network.transports');
        // mDNS only makes sense while the LAN is advertised and reachable from it.
        const wantMdns =
          t.lan && (await ctx.setting('network.lan.mdns')) && !listensOnLoopbackOnly(listener);
        const name = await mdnsName();
        if (mdns.running && (!wantMdns || mdns.name !== name)) await mdns.stop();
        if (wantMdns && !mdns.running) {
          // Start answering nothing; the healthy addresses follow the first check.
          mdns.advertise({
            name,
            port: listener.port,
            addresses: [],
            fingerprint: await fingerprint(),
          });
        }
        await namesChanged().catch((err: unknown) => log.warn('host names not refreshed', { err }));
        registry.start((await ctx.setting('network.healthCheckSeconds')) * 1000);
        await registry.check();
        await advertiseMdns();
      });
    waiting = run;
    applying = run;
    return run;
  };

  const offSettings = ctx.events.bus.subscribe('settings.changed', (e) => {
    const key = typeof e.payload.key === 'string' ? e.payload.key : '';
    if (!(NETWORK_SETTING_KEYS as readonly string[]).includes(key) || key === 'network.wakeHelpers')
      return;
    reconfigure().catch((err: unknown) => log.warn('network reconfigure failed', { err }));
  });

  const offChanges = changes.onChange((c) => {
    ctx.events
      .emit({
        name: 'network.changed',
        actor: ACTOR.test(c.actor) ? c.actor : 'system',
        payload: { changeId: c.id, kind: c.kind, summary: c.summary, status: c.status },
      })
      .catch((err: unknown) => log.warn('network.changed not emitted', { err }));
  });

  const write = async (accountId: string | null, key: NetworkSettingKey, value: unknown) => {
    if (!writer)
      throw new NovaError('capability_missing', 'network settings cannot be changed yet', {
        details: { reason: 'settings_writer_missing' },
      });
    await writer(accountId, key, value);
  };

  // The panel's own edits: write the previous values back, then apply them.
  changes.registerUndo(NETWORK_SETTINGS_CHANGE, async (undo) => {
    const settings = (undo.settings ?? {}) as Record<string, unknown>;
    const accountId = typeof undo.accountId === 'string' ? undo.accountId : null;
    for (const [key, value] of Object.entries(settings)) {
      if (!(NETWORK_SETTING_KEYS as readonly string[]).includes(key)) continue;
      await write(accountId, key as NetworkSettingKey, value);
    }
    await reconfigure();
  });

  const appendAudit = async (
    accountId: string,
    action: string,
    resource: string | null,
    detail: Record<string, unknown>,
    result = 'ok',
  ) => {
    if (!audit) return;
    try {
      await audit.append({
        accountId,
        actor: 'user',
        kind: 'network',
        action,
        resource,
        result,
        detail,
      });
    } catch (err) {
      log.warn('audit failed', { err, action });
    }
  };

  /** Transports before the first check: what the settings say, nothing tested yet. */
  const transportViews = async (): Promise<NetworkTransportView[]> => {
    const checked = registry.transports();
    if (checked.length > 0) return checked;
    const t = await ctx.setting('network.transports');
    const on = { lan: t.lan, mesh: t.mesh, relay: t.relay, direct: t.directPublic };
    return NETWORK_TRANSPORTS.map((transport) => ({
      transport,
      enabled: on[transport],
      status: on[transport] ? 'none' : 'off',
      endpoints: [],
      detail: registry.listener
        ? 'not tested yet'
        : 'the Hub has not reported where it listens yet',
    }));
  };

  const safe = async <T>(fn: (() => Promise<T>) | null): Promise<T | { error: string } | null> => {
    if (!fn) return null;
    try {
      return await fn();
    } catch (err) {
      return { error: err instanceof Error ? err.message.slice(0, 300) : 'failed' };
    }
  };

  /** The account's newest wakes, with the device and helper names (FR-138). */
  function recentWakes(accountId: string): WakeLogView[] {
    const rows = ctx.db.raw
      .prepare(
        `SELECT w.id, w.target_device_id, t.name AS target_name, w.helper_device_id,
                h.name AS helper_name, w.mac, w.status, w.error, w.created_at
         FROM wake_request w
         LEFT JOIN device t ON t.id = w.target_device_id
         LEFT JOIN device h ON h.id = w.helper_device_id
         WHERE w.account_id = ?
         ORDER BY w.created_at DESC, w.id DESC LIMIT 20`,
      )
      .all(accountId) as {
      id: string;
      target_device_id: string;
      target_name: string | null;
      helper_device_id: string | null;
      helper_name: string | null;
      mac: string;
      status: WakeLogView['status'];
      error: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.target_device_id,
      deviceName: r.target_name,
      mac: r.mac,
      status: r.status,
      // No helper and sent: the Hub broadcast it on its own LAN.
      via: r.helper_device_id ?? (r.status === 'sent' ? 'hub' : null),
      viaName: r.helper_name,
      error: r.error,
      createdAt: r.created_at,
    }));
  }

  async function view(accountId: string): Promise<NetworkView> {
    const trustView = await safe(trust);
    return {
      transports: await transportViews(),
      advertised: registry.advertised(),
      primary: registry.primary(),
      listener: registry.listener,
      lan: {
        mdns: {
          enabled: await ctx.setting('network.lan.mdns'),
          running: mdns.running,
          name: mdns.name ?? (await mdnsName()),
        },
        includeLoopback: await ctx.setting('network.lan.includeLoopback'),
        includeLinkLocal: await ctx.setting('network.lan.includeLinkLocal'),
      },
      directPublic: { url: await ctx.setting('network.directPublic.url') },
      healthCheckSeconds: await ctx.setting('network.healthCheckSeconds'),
      trust: trustView && !('error' in trustView) ? trustView : null,
      egress: { mode: await ctx.setting('network.egressMode'), href: '/api/v1/egress' },
      wakeHelpers: {
        configured: await ctx.setting('network.wakeHelpers'),
        available: await wakeRouter.available(accountId),
        recent: recentWakes(accountId),
      },
      lastChange: await changes.last(),
    };
  }

  async function update(accountId: string, body: unknown): Promise<NetworkChangeView | null> {
    const req = updateNetworkSchema.parse(body);
    const next = new Map<NetworkSettingKey, unknown>();
    const transports = { ...(await ctx.setting('network.transports')), ...req.transports };
    if (req.transports) {
      // Never leave the Hub with nothing to advertise (never lock the owner out, docs/22 §6).
      if (!Object.values(transports).some(Boolean))
        throw new NovaError('validation', 'keep at least one transport on', {
          details: { field: 'transports', reason: 'no_transport' },
        });
      next.set('network.transports', transports);
    }
    const url =
      req.directPublic !== undefined
        ? req.directPublic.url
        : await ctx.setting('network.directPublic.url');
    if (transports.directPublic && !url)
      throw new NovaError('validation', 'set the public URL to advertise Direct public', {
        details: { field: 'directPublic.url', reason: 'url_required' },
      });
    if (req.directPublic !== undefined)
      next.set('network.directPublic.url', url === null ? null : url.replace(/\/+$/, ''));
    if (req.lan?.mdns !== undefined) next.set('network.lan.mdns', req.lan.mdns);
    if (req.lan?.mdnsName !== undefined) next.set('network.lan.mdnsName', req.lan.mdnsName);
    if (req.lan?.includeLoopback !== undefined)
      next.set('network.lan.includeLoopback', req.lan.includeLoopback);
    if (req.lan?.includeLinkLocal !== undefined)
      next.set('network.lan.includeLinkLocal', req.lan.includeLinkLocal);
    if (req.healthCheckSeconds !== undefined)
      next.set('network.healthCheckSeconds', req.healthCheckSeconds);
    if (req.wakeHelpers !== undefined) {
      const known = new Set((await wakeRouter.available(accountId)).map((h) => h.deviceId));
      const unknown = req.wakeHelpers.filter((id) => !known.has(id));
      if (unknown.length > 0)
        throw new NovaError('validation', 'not a Wake Helper of this account', {
          details: { field: 'wakeHelpers', reason: 'unknown_device', ids: unknown },
        });
      next.set('network.wakeHelpers', [...new Set(req.wakeHelpers)]);
    }
    const previous: Record<string, unknown> = {};
    const values: Record<string, unknown> = {};
    for (const [key, value] of next) {
      const before = await ctx.setting(key);
      if (same(before, value)) continue;
      previous[key] = before;
      values[key] = value;
    }
    const keys = Object.keys(values) as NetworkSettingKey[];
    if (keys.length === 0) return null;
    const written: NetworkSettingKey[] = [];
    try {
      for (const key of keys) {
        await write(accountId, key, values[key]);
        written.push(key);
      }
    } catch (err) {
      // All or nothing: put back what was already written.
      for (const key of written.reverse())
        await write(accountId, key, previous[key]).catch(() => undefined);
      throw err;
    }
    const change = await changes.record({
      kind: NETWORK_SETTINGS_CHANGE,
      summary: `Changed ${keys.map((k) => k.replace(/^network\./, '')).join(', ')}`,
      undo: { settings: previous, accountId },
      accountId,
      actor: 'user',
    });
    await appendAudit(accountId, 'network.change', change.id, { keys, values });
    await reconfigure();
    return change;
  }

  async function diagnostics(accountId: string): Promise<NetworkDiagnosticsView> {
    if (!registry.checkedAt() && registry.listener) await reconfigure();
    const transports = await transportViews();
    const uptime = registry.uptime24h();
    const trustView = await safe(trust);
    const problems: string[] = [];
    if (!registry.listener)
      problems.push('The Hub has not reported where it listens; nothing is advertised yet.');
    for (const t of transports) {
      if (!t.enabled) continue;
      if (t.status === 'down') {
        const failing = t.endpoints.find((c) => c.health === 'failing');
        problems.push(
          `${TRANSPORT_NAMES[t.transport]}: ${failing?.url ?? ''} ${failing?.detail ?? 'failing'}`.replace(
            /\s+/g,
            ' ',
          ),
        );
      } else if (t.status === 'none' && t.transport === 'lan' && t.detail) {
        problems.push(`LAN: ${t.detail}`);
      }
    }
    if (registry.checkedAt() && registry.advertised().length === 0)
      problems.push('No endpoint passes its reachability test, so none is advertised.');
    if (trustView && 'problems' in trustView)
      for (const p of trustView.problems) problems.push(`Trust: ${p}`);
    return {
      checkedAt: registry.checkedAt(),
      primary: registry.primary(),
      transports,
      endpoints: transports.flatMap((t) =>
        t.endpoints.map((c) => ({ ...c, uptime24h: uptime.get(c.url) ?? { checks: 0, ok: 0 } })),
      ),
      trust: trustView && !('error' in trustView) ? trustView : null,
      mesh: await safe(meshSummary),
      relay: await safe(relayStatus),
      devices: deviceReachability(ctx.db, accountId),
      events: registry.events(50),
      changes: await changes.list(20),
      problems,
    };
  }

  ctx.diagnostics.add('network', () =>
    Promise.resolve({
      primary: registry.primary(),
      advertised: registry.advertised().length,
      transports: Object.fromEntries(registry.transports().map((t) => [t.transport, t.status])),
      mdns: mdns.running,
      checkedAt: registry.checkedAt(),
    }),
  );

  function register(app: FastifyInstance): void {
    app.get('/api/v1/network', async (req) => view(await ctx.accountOf(req)));

    app.patch('/api/v1/network', async (req) => {
      const accountId = await ctx.accountOf(req);
      const change = await update(accountId, req.body ?? {});
      return { ...(await view(accountId)), change };
    });

    app.post('/api/v1/network/test', async (req) => {
      await ctx.accountOf(req);
      if (!registry.listener)
        throw new NovaError('capability_missing', 'the Hub has not reported where it listens', {
          details: { reason: 'no_listener' },
        });
      // Concurrent callers share the running check rather than queueing one each.
      return registry.checkShared();
    });

    app.post('/api/v1/network/rollback', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { changeId } = networkRollbackSchema.parse(req.body ?? {});
      const target = changeId ? await changes.get(changeId) : await changes.last();
      if (!target) {
        if (changeId) throw new NovaError('not_found', 'network change not found');
        throw new NovaError('conflict', 'there is no network change to roll back', {
          details: { reason: 'nothing_to_roll_back' },
        });
      }
      try {
        const change = await changes.rollback(target.id);
        await appendAudit(accountId, 'network.rollback', change.id, {
          kind: change.kind,
          summary: change.summary,
        });
        return { change, network: await view(accountId) };
      } catch (err) {
        await appendAudit(
          accountId,
          'network.rollback',
          target.id,
          { kind: target.kind, error: err instanceof Error ? err.message.slice(0, 300) : 'failed' },
          'failed',
        );
        throw err;
      }
    });

    app.get('/api/v1/network/diagnostics', async (req) => diagnostics(await ctx.accountOf(req)));
  }

  return Promise.resolve({
    registry,
    changes,
    wakeRouter,
    mdns,
    endpoints: () => registry.advertised(),
    listening: async (listener) => {
      registry.setListener(listener);
      await reconfigure();
    },
    test: () => registry.check(),
    probe: (url) => registry.probe(url),
    classify: (host) => registry.classify(host),
    hostNames: async () => {
      const out: string[] = [];
      if (mdns.running && mdns.name) out.push(`${mdns.name}.local`);
      // The public host is one of the Hub's names only while Direct public is on.
      const direct = (await ctx.setting('network.transports')).directPublic
        ? await ctx.setting('network.directPublic.url')
        : null;
      if (direct) {
        try {
          out.push(new URL(direct).hostname.toLowerCase());
        } catch {
          // the setting is validated as a URL; nothing to add otherwise
        }
      }
      return out;
    },
    useAudit: (a) => {
      audit = a;
    },
    useSettingsWriter: (w) => {
      writer = w;
    },
    useEndpointSource: (source) => {
      const off = registry.useSource(source);
      if (registry.listener)
        reconfigure().catch((err: unknown) => log.warn('network reconfigure failed', { err }));
      return off;
    },
    useHubIdentity: (fn) => {
      identity = fn;
    },
    useTrustSummary: (fn) => {
      trust = fn;
    },
    useProbeCa: (fn) => {
      probeCa = fn;
    },
    useMeshSummary: (fn) => {
      meshSummary = fn;
    },
    useHostNamesChanged: (fn) => {
      namesChanged = fn;
    },
    useRelayStatus: (fn) => {
      relayStatus = fn;
    },
    register,
    close: async () => {
      offSettings();
      offChanges();
      registry.stop();
      await applying.catch(() => undefined);
      await mdns.stop();
    },
  });
}
