// Opt-in OTLP export (FR-223; docs/16 §1; ADR-097 D6), the Hub area. Off by default: nothing is
// sent until the owner turns `telemetry.otlp.enabled` on with an endpoint (https, or http to this
// machine). The settings `telemetry.otlp.*` drive one OtlpExporter; header values live in the vault
// (`secret://telemetry/otlp/header/<name>`) and are read when the export is (re)configured. What
// is exported: HTTP request spans and metrics (method, route pattern and status only, never the
// URL), event counts by name, process gauges, and the Hub's logs (already redacted by the logger,
// redacted again at the boundary). Content attributes go only with
// `telemetry.otlp.includeContent`. Managed policy (`managed.restrict`, D4 `restrict.telemetryExport`)
// can forbid it; its refusals say `{reason: managed}`.
//   GET  /api/v1/telemetry/otlp        settings (header names only) and the exporter's stats
//   PUT  /api/v1/telemetry/otlp        change them in one call; header values go to the vault
//   POST /api/v1/telemetry/otlp/test   send one log record now
// All three are the owner's.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  NovaError,
  OTLP_SIGNALS,
  otlpHeaderRef,
  putOtlpSchema,
  type OtlpStatusView,
  type OtlpTestResultView,
  type SettingKey,
  type SettingValue,
} from '@nova/shared';
import { isHubOwner, managedRestrictions, ownerOnlyError, type AuditSink } from '@nova/core';
import {
  Meter,
  OtlpExporter,
  OtlpLogSink,
  Tracer,
  type OtlpConfig,
  type OtlpExporterOptions,
  type Span,
} from '@nova/telemetry';
import type { HubArea, HubContext } from './hub-context.ts';

export interface OtlpArea extends HubArea {
  exporter: OtlpExporter;
  /** For other areas' spans (exported only while traces are). */
  tracer: Tracer;
  /** For other areas' counters and histograms. */
  meter: Meter;
  useAudit(audit: AuditSink): void;
  /** Read the settings and secrets again and reconfigure (settings.changed does it too). */
  reload(): Promise<void>;
}

type OtlpKey =
  | 'telemetry.otlp.enabled'
  | 'telemetry.otlp.endpoint'
  | 'telemetry.otlp.headers'
  | 'telemetry.otlp.signals'
  | 'telemetry.otlp.includeContent';

export interface OtlpDeps {
  /**
   * Write a global setting the way PATCH /api/v1/settings does (a managed lock refuses it): its
   * `settings.changed` is the change's audit entry and makes this area reload.
   */
  writeSetting: <K extends OtlpKey>(
    accountId: string,
    key: K,
    value: SettingValue<K>,
  ) => Promise<void>;
  audit?: AuditSink;
  /** The Hub's version, for the `service.version` resource attribute. */
  version?: string;
  /** Tests: the exporter's fetch, clock, intervals and limits. */
  exporter?: Pick<
    OtlpExporterOptions,
    | 'fetch'
    | 'now'
    | 'flushIntervalMs'
    | 'metricsIntervalMs'
    | 'maxQueue'
    | 'backoff'
    | 'random'
    | 'timeoutMs'
  >;
}

/** Records the export never carries: its own (a failing collector must not feed itself). */
const OWN_MODULE = 'hub.otlp';

export function setupOtlp(ctx: HubContext, deps: OtlpDeps): Promise<OtlpArea> {
  const log = ctx.log.child('otlp');
  let audit: AuditSink | null = deps.audit ?? null;

  const meter = new Meter();
  const tracer = new Tracer();
  const exporter = new OtlpExporter({
    ...deps.exporter,
    metrics: () => meter.collect(),
    scope: { name: 'nova-hub', ...(deps.version ? { version: deps.version } : {}) },
  });
  const sink = new OtlpLogSink(
    exporter,
    (r) => r.module === OWN_MODULE || r.module.startsWith(`${OWN_MODULE}.`),
  );
  let sinkAttached = false;
  let offSpans: (() => void) | null = null;

  // Content-free instruments (docs/16 §2).
  const requests = meter.histogram('http.server.request.duration', {
    unit: 's',
    description: 'Hub API requests by method, route pattern and status',
  });
  const eventCount = meter.counter('nova.events', {
    unit: '{event}',
    description: 'Hub events by name',
  });
  meter.gauge('process.memory.usage', { unit: 'By', description: 'Resident memory' }, () =>
    process.memoryUsage.rss(),
  );
  meter.gauge('process.uptime', { unit: 's', description: 'Time since the Hub started' }, () =>
    Math.round(process.uptime()),
  );
  const offEvents = ctx.events.bus.subscribe('*', (e) => {
    eventCount.add(1, { 'event.name': e.name });
  });

  /** Why managed policy forbids export, or null; a policy that cannot be read forbids it. */
  const managedWhy = async (): Promise<string | null> => {
    try {
      return managedRestrictions(await ctx.setting('managed.restrict')).telemetryExport();
    } catch (err) {
      log.warn('managed export policy unreadable; export is off', { err });
      return 'Telemetry export is off: the managed policy could not be read';
    }
  };
  const managedRefusal = (why: string) =>
    new NovaError('policy_denied', why, { details: { reason: 'managed' } });

  const get = <K extends SettingKey>(key: K) => ctx.setting(key);

  /** The settings now; `null` when the export should be off. */
  async function desired(): Promise<OtlpConfig | null> {
    if ((await managedWhy()) || !(await get('telemetry.otlp.enabled'))) return null;
    const endpoint = await get('telemetry.otlp.endpoint');
    if (!endpoint) return null;
    return {
      endpoint,
      headers: await headers(),
      signals: await get('telemetry.otlp.signals'),
      includeContent: await get('telemetry.otlp.includeContent'),
      resource: {
        'service.name': 'nova-hub',
        ...(deps.version ? { 'service.version': deps.version } : {}),
      },
    };
  }

  /** Header values from the vault; a reference without a value is left out. */
  async function headers(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, ref] of Object.entries(await get('telemetry.otlp.headers'))) {
      const v = await ctx.secrets.get(ref);
      if (v) out[name] = v;
    }
    return out;
  }

  // Reconfigurations run one after another and never reject.
  let reloading: Promise<void> = Promise.resolve();
  function reload(): Promise<void> {
    reloading = reloading
      .then(apply)
      .catch((err: unknown) => log.warn('OTLP export not reconfigured', { err }));
    return reloading;
  }
  async function apply(): Promise<void> {
    const wasActive = exporter.active;
    const config = await desired().catch((err: unknown) => {
      log.warn('OTLP settings unreadable; export is off', { err });
      return null;
    });
    exporter.configure(config);
    const traces = exporter.signalOn('traces');
    if (traces && !offSpans) offSpans = tracer.addProcessor((s) => exporter.span(s));
    if (!traces && offSpans) {
      offSpans();
      offSpans = null;
    }
    const logs = exporter.signalOn('logs');
    if (logs && !sinkAttached) ctx.log.addSink(sink);
    if (!logs && sinkAttached) ctx.log.removeSink(sink);
    sinkAttached = logs;
    if (exporter.active !== wasActive)
      log.info(exporter.active ? 'OTLP export on' : 'OTLP export off', {
        signals: exporter.active ? OTLP_SIGNALS.filter((s) => exporter.signalOn(s)) : [],
      });
  }

  const offSettings = ctx.events.bus.subscribe('settings.changed', (e) => {
    const key = typeof e.payload.key === 'string' ? e.payload.key : '';
    if (key.startsWith('telemetry.otlp.') || key === 'managed.restrict') void reload();
  });
  const offPolicy = ctx.events.bus.subscribe('managed.policy.changed', () => void reload());

  async function status(): Promise<OtlpStatusView> {
    const refs = await get('telemetry.otlp.headers');
    const stats = exporter.stats();
    return {
      enabled: await get('telemetry.otlp.enabled'),
      endpoint: await get('telemetry.otlp.endpoint'),
      headers: await Promise.all(
        Object.entries(refs).map(async ([name, ref]) => ({
          name,
          set: await ctx.secrets.has(ref),
        })),
      ),
      signals: await get('telemetry.otlp.signals'),
      includeContent: await get('telemetry.otlp.includeContent'),
      managedOff: (await managedWhy()) !== null,
      active: stats.active,
      queued: stats.queued,
      dropped: stats.dropped,
      sent: stats.sent,
      failures: stats.failures,
      lastError: stats.lastError,
      lastSuccessAt: stats.lastSuccessAt,
      nextAttemptAt: stats.nextAttemptAt,
    };
  }

  async function owner(req: FastifyRequest): Promise<string> {
    const accountId = await ctx.accountOf(req);
    if (!isHubOwner(ctx.db, accountId)) throw ownerOnlyError("the Hub's telemetry export");
    return accountId;
  }

  ctx.diagnostics.add('otlp', () => {
    const s = exporter.stats();
    return Promise.resolve({
      active: s.active,
      queued: s.queued,
      dropped: s.dropped,
      failures: s.failures,
      lastError: s.lastError,
    });
  });

  /** Spans of requests in flight (only while traces are exported). */
  const spans = new WeakMap<FastifyRequest, Span>();

  function register(app: FastifyInstance): void {
    // Spans and metrics name the route pattern, never the URL (paths can carry tokens).
    app.addHook('onRequest', (req, _reply, done) => {
      if (tracer.recording)
        spans.set(
          req,
          tracer.startSpan(`${req.method} ${req.routeOptions.url ?? 'unmatched'}`, {
            kind: 'server',
          }),
        );
      done();
    });
    app.addHook('onResponse', (req, reply, done) => {
      const route = req.routeOptions.url ?? 'unmatched';
      const attrs = {
        'http.request.method': req.method,
        'http.route': route,
        'http.response.status_code': reply.statusCode,
      };
      requests.record(reply.elapsedTime / 1000, attrs);
      const span = spans.get(req);
      if (span) {
        span.setAttributes({ ...attrs, 'url.scheme': req.protocol });
        if (reply.statusCode >= 500) span.setStatus('error');
        span.end();
      }
      done();
    });

    app.get('/api/v1/telemetry/otlp', async (req) => {
      await owner(req);
      return status();
    });

    app.put('/api/v1/telemetry/otlp', async (req) => {
      const accountId = await owner(req);
      const body = putOtlpSchema.parse(req.body);
      // Managed policy first: it also locks `telemetry.otlp.enabled`, and the refusal names it.
      const why = body.enabled === true ? await managedWhy() : null;
      if (why) throw managedRefusal(why);
      if (body.headers) {
        const refs = { ...(await get('telemetry.otlp.headers')) };
        const values: [ref: string, value: string | null][] = [];
        for (const [name, value] of Object.entries(body.headers)) {
          const existing = Object.keys(refs).find((k) => k.toLowerCase() === name.toLowerCase());
          if (existing) delete refs[existing];
          const ref = otlpHeaderRef(name);
          if (value !== null) refs[name] = ref;
          values.push([ref, value]);
        }
        if (Object.keys(refs).length > 20)
          throw new NovaError('validation', 'at most 20 headers', {
            details: { field: 'headers' },
          });
        // The setting first: a managed lock refuses before the vault changes.
        await deps.writeSetting(accountId, 'telemetry.otlp.headers', refs);
        for (const [ref, value] of values) {
          if (value === null) await ctx.secrets.delete(ref);
          else await ctx.secrets.put(ref, value);
        }
        if (audit)
          await audit.append({
            accountId,
            actor: 'user',
            kind: 'secret',
            action: 'telemetry.otlp.headers',
            resource: 'setting:telemetry.otlp.headers',
            // Names only: values stay in the vault.
            detail: { headers: Object.keys(body.headers), set: Object.keys(refs) },
          });
      }
      if (body.endpoint !== undefined)
        await deps.writeSetting(accountId, 'telemetry.otlp.endpoint', body.endpoint);
      if (body.signals)
        await deps.writeSetting(accountId, 'telemetry.otlp.signals', {
          ...(await get('telemetry.otlp.signals')),
          ...body.signals,
        });
      if (body.includeContent !== undefined)
        await deps.writeSetting(accountId, 'telemetry.otlp.includeContent', body.includeContent);
      if (body.enabled !== undefined)
        await deps.writeSetting(accountId, 'telemetry.otlp.enabled', body.enabled);
      await reload();
      return status();
    });

    app.post('/api/v1/telemetry/otlp/test', async (req) => {
      await owner(req);
      const why = await managedWhy();
      if (why) throw managedRefusal(why);
      const endpoint = await get('telemetry.otlp.endpoint');
      if (!endpoint)
        throw new NovaError('validation', 'name a collector endpoint first', {
          details: { field: 'endpoint', reason: 'no_endpoint' },
        });
      const result: OtlpTestResultView = await exporter.sendTest({
        endpoint,
        headers: await headers(),
        signals: { traces: false, metrics: false, logs: true },
        includeContent: false,
        resource: { 'service.name': 'nova-hub' },
      });
      return result;
    });
  }

  // The first configuration (off unless the owner turned it on).
  return reload().then(() => ({
    exporter,
    tracer,
    meter,
    register,
    reload,
    useAudit: (a: AuditSink) => {
      audit = a;
    },
    close: async () => {
      offSettings();
      offPolicy();
      offEvents();
      offSpans?.();
      if (sinkAttached) ctx.log.removeSink(sink);
      sinkAttached = false;
      await exporter.close();
    },
  }));
}
