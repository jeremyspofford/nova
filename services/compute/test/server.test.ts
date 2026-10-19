// The node's job API (contracts/hub-api.md §2): job-token auth on every route, browsers refused,
// request validation, SSE streaming, cancel, health and the busy answer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SseParser, type ChatRequest, type StreamEvent } from '@nova/providers';
import { Logger, MemorySink } from '@nova/telemetry';
import { JobManager, buildJobServer } from '../src/index.ts';

const TOKEN = `nvj_${'a'.repeat(43)}`;
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JOB = {
  kind: 'chat',
  request: {
    model: 'llama3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  },
};

let app: FastifyInstance;
let jobs: JobManager;
let token: string | null;
let release: (() => void)[];
let seen: ChatRequest[];

beforeEach(() => {
  release = [];
  seen = [];
  token = TOKEN;
  jobs = new JobManager({
    maxConcurrentJobs: 1,
    maxQueue: 0,
    run: async function* (req): AsyncIterable<StreamEvent> {
      seen.push(req);
      yield { type: 'start', messageId: 'm1', model: req.model };
      await new Promise<void>((resolve) => {
        release.push(resolve);
        req.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (req.signal.aborted) {
        yield { type: 'stop', reason: 'cancelled' };
        return;
      }
      yield { type: 'text_delta', text: 'hi there' };
      yield { type: 'stop', reason: 'end' };
    },
  });
  app = buildJobServer({
    jobs,
    jobToken: () => token,
    log: new Logger({ module: 'test', sinks: [new MemorySink()] }),
    keepAliveMs: 20,
  });
});

afterEach(async () => {
  jobs.close();
  await app.close();
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('authentication', () => {
  it('refuses calls without the job token or with a wrong one', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: TOKEN }]) {
      const res = await app.inject({ method: 'GET', url: '/node/v1/health', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('token_required');
    }
    // Unknown paths do not reveal themselves before authentication.
    expect((await app.inject({ url: '/nope' })).statusCode).toBe(401);
  });

  it('refuses everything once the node holds no token (revoked)', async () => {
    token = null;
    const res = await app.inject({ url: '/node/v1/health', headers: AUTH });
    expect(res.statusCode).toBe(401);
  });

  it('refuses browser requests even with the token', async () => {
    const res = await app.inject({
      url: '/node/v1/health',
      headers: { ...AUTH, origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('origin_rejected');
  });
});

describe('jobs', () => {
  it('reports health and load', async () => {
    const res = await app.inject({ url: '/node/v1/health', headers: AUTH });
    expect(res.json()).toMatchObject({
      status: 'ok',
      load: { running: 0, queued: 0 },
      maxConcurrentJobs: 1,
      maxQueue: 0,
    });
  });

  it('validates the job body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/node/v1/jobs',
      headers: AUTH,
      payload: { kind: 'chat', request: { model: '', messages: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
    const other = await app.inject({
      method: 'POST',
      url: '/node/v1/jobs',
      headers: AUTH,
      payload: { kind: 'embedding', request: JOB.request },
    });
    expect(other.statusCode).toBe(400);
  });

  it('accepts a job, streams its events as SSE, and answers busy beyond the limit', async () => {
    const submit = await app.inject({
      method: 'POST',
      url: '/node/v1/jobs',
      headers: AUTH,
      payload: JOB,
    });
    expect(submit.statusCode).toBe(201);
    const { jobId } = submit.json();
    expect(seen[0]?.messages[0]?.content[0]).toEqual({ type: 'text', text: 'hello' });

    const busy = await app.inject({
      method: 'POST',
      url: '/node/v1/jobs',
      headers: AUTH,
      payload: JOB,
    });
    expect(busy.statusCode).toBe(429);
    expect(busy.json().error).toMatchObject({ code: 'rate_limited', retryable: true });

    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${url}/node/v1/jobs/${jobId}/stream`, { headers: AUTH });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await tick(50); // long enough for keep-alive comments
    release[0]!();
    const text = await res.text();
    expect(text).toContain(': ping');
    const events = new SseParser().push(text).map((d) => JSON.parse(d) as StreamEvent);
    expect(events.map((e) => e.type)).toEqual(['start', 'text_delta', 'stop']);
    expect(jobs.load()).toEqual({ running: 0, queued: 0 });

    const again = await app.inject({ url: `/node/v1/jobs/${jobId}/stream`, headers: AUTH });
    expect(again.statusCode).toBe(404);
  });

  it('cancels a job on request and when the stream disconnects', async () => {
    const first = (
      await app.inject({ method: 'POST', url: '/node/v1/jobs', headers: AUTH, payload: JOB })
    ).json().jobId as string;
    const cancel = await app.inject({
      method: 'POST',
      url: `/node/v1/jobs/${first}/cancel`,
      headers: AUTH,
    });
    expect(cancel.json()).toEqual({ ok: true, cancelled: true });
    await tick();
    expect(jobs.load().running).toBe(0);
    const unknown = await app.inject({
      method: 'POST',
      url: '/node/v1/jobs/nope/cancel',
      headers: AUTH,
    });
    expect(unknown.statusCode).toBe(404);

    const second = (
      await app.inject({ method: 'POST', url: '/node/v1/jobs', headers: AUTH, payload: JOB })
    ).json().jobId as string;
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const ac = new AbortController();
    const res = await fetch(`${url}/node/v1/jobs/${second}/stream`, {
      headers: AUTH,
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    // The server sees the closed socket a moment later; on a loaded machine that can take a while.
    await vi.waitFor(() => expect(jobs.load().running).toBe(0), { timeout: 5_000 });
    expect(jobs.has(second)).toBe(false);
  });
});
