// OTLP export (FR-223, ADR-097 D6) against a fake collector on 127.0.0.1: off by default, the JSON
// encoding of traces, metrics and logs, redaction at the boundary, no content unless enabled,
// backoff on failure (and Retry-After), dropped batches on refusals, the bounded queue, refused
// endpoints and redirects, and the log sink.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redactor } from '@nova/security';
import {
  Logger,
  Meter,
  OtlpExporter,
  OtlpLogSink,
  Tracer,
  isAllowedOtlpEndpoint,
  isContentAttribute,
  nanos,
  type OtlpConfig,
} from '../src/index.ts';

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OTLP JSON read by tests
  body: any;
}

let server: Server;
let endpoint: string;
let received: Received[];
/** What the collector answers next (default 200 `{}`). */
let answers: { status: number; headers?: Record<string, string>; body?: string }[];
let clock: number;

beforeEach(async () => {
  received = [];
  answers = [];
  clock = Date.parse('2026-10-19T10:00:00.000Z');
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      });
      const a = answers.shift() ?? { status: 200 };
      res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers ?? {}) });
      res.end(a.body ?? '{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const config = (over: Partial<OtlpConfig> = {}): OtlpConfig => ({
  endpoint,
  headers: { authorization: 'Bearer collector-secret-123456' },
  signals: { traces: true, metrics: true, logs: true },
  includeContent: false,
  resource: { 'service.name': 'nova-hub', 'service.version': '0.8.0' },
  ...over,
});

const exporter = (over: ConstructorParameters<typeof OtlpExporter>[0] = {}) =>
  new OtlpExporter({
    now: () => clock,
    flushIntervalMs: 0,
    metricsIntervalMs: 0,
    random: () => 0.5,
    ...over,
  });

const record = (msg: string, fields: Record<string, unknown> = {}) => ({
  ts: new Date(clock).toISOString(),
  level: 'info' as const,
  module: 'hub.test',
  msg,
  ...fields,
});

describe('off by default', () => {
  it('queues and sends nothing until configured, and stops again when unconfigured', async () => {
    const ex = exporter();
    const tracer = new Tracer({ now: () => clock });
    tracer.addProcessor((s) => ex.span(s));
    tracer.startSpan('a').end();
    ex.log(record('hello'));
    ex.metrics(new Meter().collect());
    await ex.flush({ force: true });
    expect(received).toEqual([]);
    expect(ex.stats()).toMatchObject({ active: false, queued: { traces: 0, metrics: 0, logs: 0 } });

    ex.configure(config());
    ex.log(record('queued'));
    ex.configure(null);
    expect(ex.stats().queued.logs).toBe(0);
    await ex.flush({ force: true });
    expect(received).toEqual([]);
  });

  it('refuses an endpoint that is neither https nor loopback http, and one with no signal', () => {
    for (const bad of [
      'http://collector.example:4318',
      'ftp://127.0.0.1',
      'https://u:p@c.example',
      'x',
    ]) {
      expect(isAllowedOtlpEndpoint(bad), bad).toBe(false);
      const ex = exporter();
      ex.configure(config({ endpoint: bad }));
      expect(ex.active).toBe(false);
      expect(ex.stats().lastError).toMatch(/https/);
    }
    expect(isAllowedOtlpEndpoint('https://otel.example:4318')).toBe(true);
    expect(isAllowedOtlpEndpoint('http://[::1]:4318')).toBe(true);
    const ex = exporter();
    ex.configure(config({ signals: { traces: false, metrics: false, logs: false } }));
    expect(ex.active).toBe(false);
  });
});

describe('encoding', () => {
  it('sends spans, metrics and logs as OTLP/HTTP JSON with the configured headers', async () => {
    const ex = exporter({ scope: { name: 'nova', version: '0.8.0' } });
    ex.configure(config());
    const tracer = new Tracer({ now: () => clock });
    tracer.addProcessor((s) => ex.span(s));
    const parent = tracer.startSpan('HTTP GET', {
      kind: 'server',
      attributes: { 'http.route': '/api/v1/threads' },
    });
    const child = tracer.startSpan('db', { parent: parent.context });
    child.addEvent('rows', { count: 3 });
    child.setStatus('error', 'boom').end();
    parent.setAttribute('http.response.status_code', 200).end(clock + 12.5);

    const meter = new Meter({ now: () => clock });
    meter.counter('nova.events', { unit: '{event}' }).add(2, { 'event.name': 'x' });
    meter
      .histogram('http.server.request.duration', { unit: 's' })
      .record(0.02, { 'http.route': '/a' });
    meter.gauge('process.uptime', { unit: 's' }, () => 1.5);
    ex.metrics(meter.collect());
    ex.log(record('request', { status: 200, ms: 3, nested: { a: [1, 'b'] } }));

    await ex.flush();
    expect(received.map((r) => r.path)).toEqual(['/v1/traces', '/v1/metrics', '/v1/logs']);
    for (const r of received) {
      expect(r.headers['content-type']).toBe('application/json');
      expect(r.headers.authorization).toBe('Bearer collector-secret-123456');
    }
    const traces = received[0]!.body.resourceSpans[0];
    expect(traces.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'nova-hub' } },
      { key: 'service.version', value: { stringValue: '0.8.0' } },
    ]);
    expect(traces.scopeSpans[0].scope).toEqual({ name: 'nova', version: '0.8.0' });
    const [c, p] = traces.scopeSpans[0].spans;
    expect(p).toMatchObject({
      name: 'HTTP GET',
      kind: 2,
      startTimeUnixNano: nanos(clock),
      endTimeUnixNano: (BigInt(clock) * 1_000_000n + 12_500_000n).toString(),
      status: { code: 0 },
    });
    expect(p.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(p.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(p.parentSpanId).toBeUndefined();
    expect(c).toMatchObject({
      parentSpanId: p.spanId,
      traceId: p.traceId,
      kind: 1,
      status: { code: 2, message: 'boom' },
    });
    expect(c.events[0]).toMatchObject({
      name: 'rows',
      attributes: [{ key: 'count', value: { intValue: '3' } }],
    });

    const metrics = received[1]!.body.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics.find((m: { name: string }) => m.name === 'nova.events')).toMatchObject({
      unit: '{event}',
      sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ asInt: '2' }] },
    });
    expect(
      metrics.find((m: { name: string }) => m.name === 'http.server.request.duration').histogram
        .dataPoints[0],
    ).toMatchObject({
      count: '1',
      sum: 0.02,
      explicitBounds: expect.arrayContaining([0.025]),
    });
    expect(
      metrics.find((m: { name: string }) => m.name === 'process.uptime').gauge.dataPoints[0]
        .asDouble,
    ).toBe(1.5);

    const log = received[2]!.body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(log).toMatchObject({
      severityNumber: 9,
      severityText: 'INFO',
      body: { stringValue: 'request' },
    });
    expect(log.attributes).toEqual([
      { key: 'nova.module', value: { stringValue: 'hub.test' } },
      { key: 'status', value: { intValue: '200' } },
      { key: 'ms', value: { intValue: '3' } },
      {
        key: 'nested',
        value: {
          kvlistValue: {
            values: [
              {
                key: 'a',
                value: { arrayValue: { values: [{ intValue: '1' }, { stringValue: 'b' }] } },
              },
            ],
          },
        },
      },
    ]);
    expect(ex.stats()).toMatchObject({ sent: { traces: 2, metrics: 3, logs: 1 }, failures: 0 });
  });
});

describe('privacy', () => {
  it('redacts secrets at the boundary, in names, bodies, values and secret-named keys', async () => {
    const redactor = new Redactor();
    redactor.addLiteral('hunter2-very-secret');
    const ex = exporter({ redactor });
    ex.configure(config());
    ex.log(
      record('token nva_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG leaked', {
        apiKey: 'sk-abcdefghijklmnopqrstuvwx',
        note: 'the password is hunter2-very-secret',
        authorization: 'Basic abc',
      }),
    );
    await ex.flush();
    const text = JSON.stringify(received[0]!.body);
    expect(text).not.toContain('nva_abcdefghij');
    expect(text).not.toContain('sk-abcdefghij');
    expect(text).not.toContain('hunter2-very-secret');
    expect(text).not.toContain('Basic abc');
    expect(text).toContain('[REDACTED]');
  });

  it('leaves content out unless includeContent is on, and redacts it even then', async () => {
    const tracer = new Tracer({ now: () => clock });
    const span = () =>
      tracer
        .startSpan('chat', {
          attributes: {
            'content.prompt': 'my secret plans',
            'gen_ai.prompt.0.content': 'hello there',
            'gen_ai.completion': 'general kenobi',
            'tool.args': 'rm -rf /',
            'gen_ai.request.model': 'local/m',
            'nova.content.result': 'sk-abcdefghijklmnopqrstuvwx',
          },
        })
        .end();
    const off = exporter();
    off.configure(config({ signals: { traces: true, metrics: false, logs: false } }));
    tracer.addProcessor((s) => off.span(s));
    span();
    off.log(record('x', { query: 'what is my salary' }));
    await off.flush();
    const attrs = received[0]!.body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    expect(attrs).toEqual([{ key: 'gen_ai.request.model', value: { stringValue: 'local/m' } }]);
    expect(received).toHaveLength(1);

    received = [];
    const on = exporter();
    on.configure(config({ includeContent: true }));
    const t2 = new Tracer({ now: () => clock });
    t2.addProcessor((s) => on.span(s));
    t2.startSpan('chat', {
      attributes: {
        'content.prompt': 'my plans',
        'nova.content.result': 'sk-abcdefghijklmnopqrstuvwx',
      },
    }).end();
    on.log(record('x', { query: 'what is my salary' }));
    await on.flush();
    const text = JSON.stringify(received.map((r) => r.body));
    expect(text).toContain('my plans');
    expect(text).toContain('what is my salary');
    expect(text).not.toContain('sk-abcdefghij');
  });

  it('names content attributes by prefix, GenAI convention and last segment', () => {
    for (const k of [
      'content.x',
      'nova.content.y',
      'gen_ai.input.messages',
      'gen_ai.tool.call.arguments',
      'tool.result',
      'Prompt',
      'error.message',
      'message',
    ])
      expect(isContentAttribute(k), k).toBe(true);
    for (const k of ['http.route', 'gen_ai.request.model', 'status', 'contentType', 'ms'])
      expect(isContentAttribute(k), k).toBe(false);
  });
});

describe('failures', () => {
  it('backs off exponentially on a retryable failure, keeps the batch, and resumes', async () => {
    const ex = exporter({ backoff: { initialMs: 1000, maxMs: 4000 } });
    ex.configure(config({ signals: { traces: false, metrics: false, logs: true } }));
    ex.log(record('one'));
    answers.push({ status: 503 });
    await ex.flush();
    expect(ex.stats()).toMatchObject({
      failures: 1,
      queued: { logs: 1 },
      lastError: 'the collector answered 503',
    });
    expect(ex.stats().nextAttemptAt).toBe(new Date(clock + 1000).toISOString());
    // Within the backoff nothing is sent.
    await ex.flush();
    expect(received).toHaveLength(1);
    clock += 1000;
    answers.push({ status: 502 });
    await ex.flush();
    expect(ex.stats().failures).toBe(2);
    expect(ex.stats().nextAttemptAt).toBe(new Date(clock + 2000).toISOString());
    clock += 2000;
    answers.push({ status: 504 }, { status: 504 });
    await ex.flush();
    clock += 4000;
    await ex.flush();
    // Capped at the maximum.
    expect(ex.stats().nextAttemptAt).toBe(new Date(clock + 4000).toISOString());
    clock += 4000;
    await ex.flush();
    expect(ex.stats()).toMatchObject({
      failures: 0,
      queued: { logs: 0 },
      sent: { logs: 1 },
      dropped: { logs: 0 },
    });
    expect(ex.stats().lastSuccessAt).toBe(new Date(clock).toISOString());
    expect(received).toHaveLength(5);
  });

  it('honours Retry-After and treats an unreachable collector as retryable', async () => {
    const ex = exporter();
    ex.configure(config({ signals: { traces: false, metrics: false, logs: true } }));
    ex.log(record('one'));
    answers.push({ status: 429, headers: { 'retry-after': '30' } });
    await ex.flush();
    expect(ex.stats().nextAttemptAt).toBe(new Date(clock + 30_000).toISOString());

    const down = exporter({ fetch: () => Promise.reject(new TypeError('fetch failed')) });
    down.configure(config());
    down.log(record('x'));
    await down.flush();
    expect(down.stats()).toMatchObject({
      failures: 1,
      queued: { logs: 1 },
      lastError: 'the collector could not be reached',
    });
  });

  it('drops a batch the collector refuses outright, and counts partial rejections', async () => {
    const ex = exporter();
    ex.configure(config({ signals: { traces: false, metrics: false, logs: true } }));
    ex.log(record('bad'));
    answers.push({ status: 400 });
    await ex.flush();
    expect(ex.stats()).toMatchObject({ failures: 0, queued: { logs: 0 }, dropped: { logs: 1 } });
    ex.log(record('a'));
    ex.log(record('b'));
    answers.push({
      status: 200,
      body: JSON.stringify({ partialSuccess: { rejectedLogRecords: '1' } }),
    });
    await ex.flush();
    expect(ex.stats()).toMatchObject({ sent: { logs: 1 }, dropped: { logs: 2 } });
  });

  it('refuses to follow a redirect', async () => {
    const ex = exporter();
    ex.configure(config({ signals: { traces: false, metrics: false, logs: true } }));
    ex.log(record('a'));
    answers.push({ status: 307, headers: { location: 'http://127.0.0.1:1/elsewhere' } });
    await ex.flush();
    expect(received).toHaveLength(1);
    expect(ex.stats().failures).toBe(1);
  });

  it('keeps a bounded queue, dropping the oldest', async () => {
    const ex = exporter({ maxQueue: 3, maxBatch: 2 });
    ex.configure(config({ signals: { traces: false, metrics: false, logs: true } }));
    for (const m of ['1', '2', '3', '4', '5']) ex.log(record(m));
    expect(ex.stats()).toMatchObject({ queued: { logs: 3 }, dropped: { logs: 2 } });
    await ex.flush();
    expect(
      received.map((r) =>
        r.body.resourceLogs[0].scopeLogs[0].logRecords.map(
          (l: { body: { stringValue: string } }) => l.body.stringValue,
        ),
      ),
    ).toEqual([['3', '4'], ['5']]);
    // A failed batch put back still respects the bound.
    for (const m of ['6', '7', '8']) ex.log(record(m));
    answers.push({ status: 503 });
    ex.log(record('9'));
    await ex.flush();
    expect(ex.stats().queued.logs).toBe(3);
  });
});

describe('content in logs (M8 review)', () => {
  it("leaves out an extension's text and error messages unless content export is on", async () => {
    const ex = exporter();
    ex.configure(config({ signals: { traces: false, metrics: false, logs: true } }));
    const log = new Logger({ module: 'hub', sinks: [], now: () => new Date(clock) });
    log.addSink(new OtlpLogSink(ex));
    // As the extension host logs it: a fixed message, the text as a content attribute.
    log.warn('extension log', {
      extensionId: 'x',
      'content.text': 'the user asked about salaries',
    });
    log.warn('request failed', { err: new Error('could not summarize "my diagnosis"') });
    await ex.flush();
    const text = JSON.stringify(received[0]!.body);
    expect(text).not.toContain('salaries');
    expect(text).not.toContain('diagnosis');
    expect(text).toContain('extension log');
    // The error keeps its name.
    expect(text).toContain('"Error"');

    received = [];
    const on = exporter();
    on.configure(
      config({ includeContent: true, signals: { traces: false, metrics: false, logs: true } }),
    );
    const log2 = new Logger({ module: 'hub', sinks: [], now: () => new Date(clock) });
    log2.addSink(new OtlpLogSink(on));
    log2.warn('request failed', { err: new Error('could not summarize "my diagnosis"') });
    await on.flush();
    expect(JSON.stringify(received[0]!.body)).toContain('diagnosis');
  });
});

describe('closing', () => {
  it('gives up after its bound when the collector does not answer', async () => {
    const hung = createServer(() => {
      // never answers
    });
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}`;
    const ex = exporter({ timeoutMs: 60_000 });
    ex.configure(config({ endpoint: url, signals: { traces: false, metrics: false, logs: true } }));
    ex.log(record('pending'));
    const t0 = Date.now();
    await ex.close({ timeoutMs: 200 });
    expect(Date.now() - t0).toBeLessThan(2000);
    hung.closeAllConnections();
    await new Promise<void>((r) => hung.close(() => r()));
  });
});

describe('the rest', () => {
  it('sends a test record outside the queue', async () => {
    const ex = exporter();
    expect(await ex.sendTest(config())).toEqual({ ok: true, status: 200, error: null });
    expect(received[0]!.path).toBe('/v1/logs');
    answers.push({ status: 401 });
    expect(await ex.sendTest(config())).toEqual({
      ok: false,
      status: 401,
      error: 'the collector answered 401',
    });
    expect((await ex.sendTest(config({ endpoint: 'http://c.example' }))).ok).toBe(false);
  });

  it('collects metrics from its source and flushes on close', async () => {
    const meter = new Meter({ now: () => clock });
    meter.counter('c').add(1);
    const ex = exporter({ metrics: () => meter.collect() });
    ex.configure(config({ signals: { traces: false, metrics: true, logs: false } }));
    await ex.close();
    expect(received.map((r) => r.path)).toEqual(['/v1/metrics']);
  });

  it('feeds logs through the sink, skipping what it is told to', async () => {
    const ex = exporter();
    ex.configure(config({ signals: { traces: false, metrics: false, logs: true } }));
    const log = new Logger({ module: 'hub', sinks: [], now: () => new Date(clock) });
    log.addSink(new OtlpLogSink(ex, (r) => r.module.startsWith('hub.otlp')));
    log.info('kept');
    log.child('otlp').warn('skipped');
    await ex.flush();
    const bodies = received[0]!.body.resourceLogs[0].scopeLogs[0].logRecords.map(
      (l: { body: { stringValue: string } }) => l.body.stringValue,
    );
    expect(bodies).toEqual(['kept']);
  });
});

describe('meter and tracer', () => {
  it('caps attribute sets and ignores bad values', () => {
    const meter = new Meter();
    const c = meter.counter('c');
    for (let i = 0; i < 1005; i++) c.add(1, { i });
    expect(meter.overflow).toBe(5);
    c.add(-1);
    c.add(Number.NaN);
    const h = meter.histogram('h', { boundaries: [10, 1] });
    h.record(0.5);
    h.record(5);
    h.record(50);
    h.record(Number.POSITIVE_INFINITY);
    const data = meter.collect();
    const hist = data.find((m) => m.name === 'h');
    expect(hist).toMatchObject({
      kind: 'histogram',
      boundaries: [1, 10],
      points: [{ count: 3, bucketCounts: [1, 1, 1], min: 0.5, max: 50 }],
    });
    expect(() => meter.histogram('c')).toThrow(TypeError);
    meter.gauge('g', {}, () => {
      throw new Error('x');
    });
    expect(meter.collect().find((m) => m.name === 'g')).toBeUndefined();
  });

  it('ends a span once and survives a processor that throws', () => {
    const tracer = new Tracer({ now: () => clock });
    const seen: string[] = [];
    tracer.addProcessor(() => {
      throw new Error('bad');
    });
    const off = tracer.addProcessor((s) => seen.push(s.name));
    expect(tracer.recording).toBe(true);
    const s = tracer.startSpan('x');
    s.end();
    s.end();
    s.setAttribute('late', 1);
    expect(seen).toEqual(['x']);
    off();
  });
});
