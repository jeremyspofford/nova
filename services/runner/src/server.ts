// The runner's HTTP API (contracts/rest-api.md §5 as amended by ADR-095 decision 4; FR-108,
// FR-071). Every route needs a Hub's bearer token (tokens.ts); a token sees only what it created.
// Bodies are validated; requests are rate limited per token (and failed sign-ins per address).
// Errors use the shape of contracts/rest-api.md §6. Live progress is a server-sent event stream
// per run, resumable with Last-Event-ID.
import { createReadStream } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RunnerError, isRunnerError } from './errors.ts';
import { streamLog, type RunnerLog } from './log.ts';
import { Runner, type RunnerLimits } from './runner.ts';
import { detectSubstrate, type Substrate } from './sandbox.ts';
import { findToken, type RunnerToken } from './tokens.ts';
import type { RunEvent } from './types.ts';

export const RUNNER_VERSION = '0.7.0';

export interface RateLimits {
  /** Requests per token per minute. */
  perMinute: number;
  /** Commands started per token per minute. */
  execPerMinute: number;
  /** Environments created or rebuilt per token per hour. */
  environmentsPerHour: number;
  /** Snapshots taken per token per hour. */
  snapshotsPerHour: number;
  /** Failed sign-ins per address per minute. */
  authFailuresPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  perMinute: 1_200,
  execPerMinute: 240,
  environmentsPerHour: 30,
  snapshotsPerHour: 60,
  authFailuresPerMinute: 30,
};

export interface RunnerServerOptions {
  dataDir: string;
  /** The Hubs' token hashes; a function is read on every request (a reloaded token file). */
  tokens: RunnerToken[] | (() => RunnerToken[]);
  /** The sandbox substrate; detected when left out, refused (null) when none works. */
  substrate?: Substrate | null;
  /** `auto`, `bwrap`, `docker`, `podman` or `none` (detection). */
  substrateMode?: string;
  /** The container substrate's default image. */
  image?: string;
  limits?: Partial<RunnerLimits>;
  rateLimits?: Partial<RateLimits>;
  localRepoRoots?: string[];
  log?: RunnerLog;
  now?: () => number;
  version?: string;
}

export interface RunnerServer {
  app: FastifyInstance;
  runner: Runner;
  close(): Promise<void>;
}

/** A sliding-window counter per key. */
class Limiter {
  readonly #hits = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }
  take(key: string, now: number): boolean {
    const list = (this.#hits.get(key) ?? []).filter((t) => t > now - this.#windowMs);
    if (list.length >= this.#limit) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(now);
    this.#hits.set(key, list);
    if (this.#hits.size > 10_000) this.sweep(now);
    return true;
  }
  sweep(now: number): void {
    for (const [k, list] of this.#hits) {
      const kept = list.filter((t) => t > now - this.#windowMs);
      if (kept.length) this.#hits.set(k, kept);
      else this.#hits.delete(k);
    }
  }
}

const id = z.uuid();
const idParams = z.object({ id });
const procParams = z.object({ id, processId: id });
const artifactParams = z.object({ id, artifactId: id });
const imageRef = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._/:@-]*$/, 'a container image reference');
const cacheName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'a cache name');
const envVars = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(32_768))
  .refine((v) => Object.keys(v).length <= 64, 'at most 64 variables');
const budget = z
  .object({
    cpuSeconds: z.number().int().min(1).optional(),
    wallSeconds: z.number().int().min(1).optional(),
  })
  .strict();

const environmentBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    repoUrls: z.array(z.string().trim().min(1).max(2_000)).max(10).default([]),
    setupScript: z.string().max(20_000).nullable().optional(),
    baseImage: imageRef.nullable().optional(),
    caches: z.array(cacheName).max(8).optional(),
    network: z.enum(['off', 'setup', 'on']).optional(),
    diskMb: z.number().int().min(16).optional(),
    reuse: z.boolean().optional(),
  })
  .strict();
const runBody = z
  .object({
    environmentId: id,
    label: z.string().trim().min(1).max(200).optional(),
    budget: budget.optional(),
    /** contracts/rest-api.md §5 named an encrypted task payload; the Hub keeps the task (ADR-095). */
    taskCiphertext: z.never().optional(),
  })
  .strict();
const runPatch = z.object({ budget }).strict();
const execBody = z
  .object({
    cmd: z.string().min(1).max(100_000),
    cwd: z.string().min(1).max(4_096).optional(),
    env: envVars.optional(),
    tag: z.string().min(1).max(200).optional(),
    network: z.enum(['off', 'on']).optional(),
    readOnly: z.boolean().optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(7 * 86_400_000)
      .optional(),
    stdin: z.boolean().optional(),
  })
  .strict();
const programBody = z
  .object({
    argv: z.array(z.string().max(100_000)).min(1).max(512),
    cwd: z.string().min(1).max(4_096).optional(),
    env: envVars.optional(),
    /** Base64 of stdin. */
    stdin: z
      .string()
      .max(12 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64')
      .optional(),
    timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024)
      .optional(),
  })
  .strict();
const outputQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  waitMs: z.coerce.number().int().min(0).max(30_000).default(0),
});
const inputBody = z
  .object({
    text: z.string().max(1_000_000).optional(),
    closeStdin: z.boolean().optional(),
    signal: z.enum(['interrupt', 'terminate']).optional(),
  })
  .strict();
const killBody = z.object({ tag: z.string().min(1).max(200) }).strict();
const artifactBody = z
  .object({
    path: z.string().min(1).max(4_096),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const snapshotBody = z
  .object({ environmentId: id, label: z.string().trim().min(1).max(200).optional() })
  .strict();
const listQuery = z.object({ environmentId: id.optional() });
const fileQuery = z.object({
  path: z.string().min(1).max(4_096),
  stat: z.enum(['0', '1', 'true', 'false']).optional(),
});
const fileBody = z
  .object({
    /** Base64 of the bytes. */
    content: z
      .string()
      .max(12 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64'),
  })
  .strict();
const streamQuery = z.object({
  since: z.coerce.number().int().min(0).optional(),
  output: z.enum(['0', '1']).optional(),
});

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

export async function buildRunnerServer(opts: RunnerServerOptions): Promise<RunnerServer> {
  const log = opts.log ?? streamLog();
  const now = opts.now ?? (() => Date.now());
  const rates = { ...DEFAULT_RATE_LIMITS, ...opts.rateLimits };
  let substrate = opts.substrate;
  let substrateDetail = 'configured';
  if (substrate === undefined) {
    const d = await detectSubstrate({
      ...(opts.substrateMode ? { mode: opts.substrateMode } : {}),
      ...(opts.image ? { image: opts.image } : {}),
    });
    substrate = d.substrate;
    substrateDetail = d.detail;
  } else if (substrate === null) substrateDetail = 'no sandbox is configured on this runner';
  if (!substrate) log.warn('no sandbox: environments will be refused', { detail: substrateDetail });
  const runner = new Runner({
    dataDir: opts.dataDir,
    substrate,
    substrateDetail,
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.localRepoRoots ? { localRepoRoots: opts.localRepoRoots } : {}),
    log,
    ...(opts.now ? { now: opts.now } : {}),
  });
  await runner.start();

  const tokenMap = () => {
    const list = typeof opts.tokens === 'function' ? opts.tokens() : opts.tokens;
    return new Map(list.map((t) => [t.hash, t]));
  };
  let cached = { at: 0, map: tokenMap() };
  const tokens = () => {
    if (typeof opts.tokens === 'function' && now() - cached.at > 1_000)
      cached = { at: now(), map: tokenMap() };
    return cached.map;
  };
  const general = new Limiter(rates.perMinute, 60_000);
  const execs = new Limiter(rates.execPerMinute, 60_000);
  const envs = new Limiter(rates.environmentsPerHour, 60 * 60_000);
  const snaps = new Limiter(rates.snapshotsPerHour, 60 * 60_000);
  const failures = new Limiter(rates.authFailuresPerMinute, 60_000);
  const owners = new WeakMap<FastifyRequest, string>();
  const streams = new Set<() => void>();

  // Closing cuts open long polls and event streams too (clients reattach by offset and event id).
  const app = Fastify({ logger: false, bodyLimit: 13 * 1024 * 1024, forceCloseConnections: true });

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (isRunnerError(err))
      return reply.status(err.status).send({
        error: {
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          ...(err.details ? { details: err.details } : {}),
        },
        requestId,
      });
    if (err instanceof z.ZodError)
      return reply.status(400).send({
        error: {
          code: 'validation',
          message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
          retryable: false,
        },
        requestId,
      });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 413)
      return reply.status(413).send({
        error: { code: 'too_large', message: 'the request is too large', retryable: false },
        requestId,
      });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)
      return reply.status(e.statusCode).send({
        error: { code: 'validation', message: e.message ?? 'bad request', retryable: false },
        requestId,
      });
    log.error('request failed', { err, url: req.url.split('?')[0] });
    return reply.status(500).send({
      error: { code: 'server_error', message: 'the runner failed', retryable: true },
      requestId,
    });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: 'not_found', message: 'no such route', retryable: false },
      requestId: req.id,
    }),
  );

  // Every route needs a token (none is public); failed sign-ins are limited per address.
  app.addHook('onRequest', (req, _reply, done) => {
    const t = now();
    const presented = bearer(req);
    if (!presented) {
      if (!failures.take(req.ip, t))
        return done(new RunnerError('rate_limited', 'too many failed sign-ins'));
      return done(
        new RunnerError('auth_missing', 'a runner token is required (Authorization: Bearer)'),
      );
    }
    const token = findToken(tokens(), presented);
    if (!token) {
      if (!failures.take(req.ip, t))
        return done(new RunnerError('rate_limited', 'too many failed sign-ins'));
      return done(new RunnerError('auth_invalid', 'the runner does not know this token'));
    }
    if (!general.take(token.id, t))
      return done(new RunnerError('rate_limited', 'too many requests for this token'));
    owners.set(req, token.id);
    done();
  });
  const owner = (req: FastifyRequest): string => {
    const o = owners.get(req);
    if (!o) throw new RunnerError('auth_missing', 'a runner token is required');
    return o;
  };
  const limit = (lim: Limiter, req: FastifyRequest, what: string) => {
    if (!lim.take(owner(req), now()))
      throw new RunnerError('rate_limited', `too many ${what} for this token`);
  };

  const P = '/v1/runner';

  app.get(`${P}/health`, async () => {
    const a = substrate ? await substrate.available() : { ok: false, detail: substrateDetail };
    return {
      status: 'ok',
      version: opts.version ?? RUNNER_VERSION,
      substrate: { kind: substrate?.kind ?? null, ok: a.ok, detail: a.detail },
      limits: {
        maxDiskMb: runner.limits.maxDiskMb,
        maxCpuSeconds: runner.limits.maxCpuSeconds,
        maxWallSeconds: runner.limits.maxWallSeconds,
        defaultCpuSeconds: runner.limits.defaultCpuSeconds,
        defaultWallSeconds: runner.limits.defaultWallSeconds,
        defaultDiskMb: runner.limits.defaultDiskMb,
        baseImages: substrate?.supportsImage ?? false,
      },
    };
  });

  // ---- environments --------------------------------------------------------------------------

  app.post(`${P}/environments`, async (req, reply) => {
    const body = environmentBody.parse(req.body ?? {});
    limit(envs, req, 'environments');
    const { view, reused } = await runner.createEnvironment(owner(req), body);
    void reply.status(reused ? 200 : 201);
    return view;
  });
  app.get(`${P}/environments`, (req) => ({ items: runner.listEnvironments(owner(req)) }));
  app.get(`${P}/environments/:id`, (req) =>
    runner.getEnvironment(owner(req), idParams.parse(req.params).id),
  );
  app.post(`${P}/environments/:id/rebuild`, async (req, reply) => {
    const { id: envId } = idParams.parse(req.params);
    limit(envs, req, 'environments');
    const view = await runner.rebuildEnvironment(owner(req), envId);
    void reply.status(202);
    return view;
  });
  app.delete(`${P}/environments/:id`, async (req) => {
    await runner.deleteEnvironment(owner(req), idParams.parse(req.params).id);
    return { ok: true };
  });

  app.get(`${P}/environments/:id/files`, async (req) => {
    const { id: envId } = idParams.parse(req.params);
    const q = fileQuery.parse(req.query);
    const o = owner(req);
    const st = await runner.stat(o, envId, q.path);
    if (!st) throw new RunnerError('not_found', 'nothing at that path', { reason: 'missing' });
    if (q.stat === '1' || q.stat === 'true') return st;
    if (st.kind === 'dir') return { kind: 'dir', ...(await runner.list(o, envId, q.path)) };
    if (st.kind !== 'file')
      throw new RunnerError('validation', 'not a file or a folder', { reason: 'not_a_file' });
    const f = await runner.readFile(o, envId, q.path);
    return {
      kind: 'file',
      size: st.size,
      content: f.content.toString('base64'),
      truncated: f.truncated,
    };
  });
  app.put(`${P}/environments/:id/files`, async (req) => {
    const { id: envId } = idParams.parse(req.params);
    const q = fileQuery.parse(req.query);
    const body = fileBody.parse(req.body);
    return runner.writeFile(owner(req), envId, q.path, Buffer.from(body.content, 'base64'));
  });
  app.delete(`${P}/environments/:id/files`, async (req) => {
    const { id: envId } = idParams.parse(req.params);
    await runner.deleteFile(owner(req), envId, fileQuery.parse(req.query).path);
    return { ok: true };
  });

  // ---- runs ----------------------------------------------------------------------------------

  app.post(`${P}/runs`, (req, reply) => {
    const body = runBody.parse(req.body ?? {});
    const run = runner.createRun(owner(req), body);
    void reply.status(201);
    return run;
  });
  app.get(`${P}/runs`, (req) => {
    const q = listQuery.parse(req.query);
    return { items: runner.listRuns(owner(req), q.environmentId) };
  });
  app.get(`${P}/runs/:id`, (req) => runner.getRun(owner(req), idParams.parse(req.params).id));
  app.patch(`${P}/runs/:id`, (req) =>
    runner.updateRun(owner(req), idParams.parse(req.params).id, runPatch.parse(req.body).budget),
  );
  app.post(`${P}/runs/:id/cancel`, (req) =>
    runner.cancelRun(owner(req), idParams.parse(req.params).id),
  );
  app.post(`${P}/runs/:id/finish`, (req) =>
    runner.finishRun(owner(req), idParams.parse(req.params).id),
  );
  // Approvals are answered on the Hub, whose gate runs before any command reaches the runner.
  app.post(`${P}/runs/:id/approve`, () => {
    throw new RunnerError('not_implemented', 'approvals are answered on the Hub', {
      reason: 'approvals_on_hub',
    });
  });

  app.post(`${P}/runs/:id/exec`, (req, reply) => {
    const { id: runId } = idParams.parse(req.params);
    const body = execBody.parse(req.body);
    limit(execs, req, 'commands');
    const view = runner.exec(owner(req), runId, body);
    void reply.status(201);
    return view;
  });
  // One program to its end, bytes in and out (the Hub's environment transport).
  app.post(`${P}/runs/:id/run`, async (req) => {
    const { id: runId } = idParams.parse(req.params);
    const body = programBody.parse(req.body);
    const r = await runner.runProgram(owner(req), runId, {
      argv: body.argv,
      cwd: body.cwd,
      env: body.env,
      stdin: body.stdin ? Buffer.from(body.stdin, 'base64') : null,
      timeoutMs: body.timeoutMs,
      maxBytes: body.maxBytes,
    });
    return { code: r.code, stdout: r.stdout.toString('base64'), stderr: r.stderr };
  });
  app.get(`${P}/runs/:id/processes`, (req) => ({
    items: runner.processes(owner(req), idParams.parse(req.params).id),
  }));
  app.get(`${P}/runs/:id/processes/:processId/output`, (req) => {
    const p = procParams.parse(req.params);
    const q = outputQuery.parse(req.query);
    return runner.read(owner(req), p.id, p.processId, q.offset, q.waitMs);
  });
  app.post(`${P}/runs/:id/processes/:processId/input`, async (req) => {
    const p = procParams.parse(req.params);
    await runner.input(owner(req), p.id, p.processId, inputBody.parse(req.body ?? {}));
    return { ok: true };
  });
  app.post(`${P}/runs/:id/kill`, async (req) => {
    const { id: runId } = idParams.parse(req.params);
    return { killed: await runner.killTag(owner(req), runId, killBody.parse(req.body).tag) };
  });

  app.post(`${P}/runs/:id/artifacts`, async (req, reply) => {
    const { id: runId } = idParams.parse(req.params);
    const rec = await runner.collectArtifact(owner(req), runId, artifactBody.parse(req.body));
    void reply.status(201);
    return rec;
  });
  app.get(`${P}/runs/:id/artifacts/:artifactId`, (req, reply) => {
    const p = artifactParams.parse(req.params);
    const { path, record } = runner.artifactFile(owner(req), p.id, p.artifactId);
    void reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(record.sizeBytes))
      .header('x-nova-sha256', record.sha256);
    return reply.send(createReadStream(path));
  });

  app.get(`${P}/runs/:id/stream`, (req, reply) => {
    const { id: runId } = idParams.parse(req.params);
    const q = streamQuery.parse(req.query);
    const last = Number(req.headers['last-event-id']);
    const since = q.since ?? (Number.isInteger(last) && last >= 0 ? last : 0);
    const withOutput = q.output !== '0';
    stream(reply, owner(req), runId, since, withOutput);
  });

  function stream(
    reply: FastifyReply,
    who: string,
    runId: string,
    since: number,
    withOutput: boolean,
  ): void {
    let send: (e: RunEvent) => void = () => undefined;
    const sub = runner.subscribe(who, runId, since, (e) => send(e));
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let open = true;
    const end = () => {
      if (!open) return;
      open = false;
      clearInterval(ping);
      sub.unsubscribe();
      streams.delete(end);
      raw.end();
    };
    streams.add(end);
    send = (e) => {
      if (!open || (!withOutput && e.type === 'output')) return;
      raw.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
      if (e.type === 'run.ended') end();
    };
    const ping = setInterval(() => {
      if (open) raw.write(': ping\n\n');
    }, 15_000);
    ping.unref();
    raw.on('close', end);
    for (const e of sub.backlog) send(e);
    if (sub.ended && !sub.backlog.some((e) => e.type === 'run.ended')) end();
  }

  // ---- snapshots -----------------------------------------------------------------------------

  app.post(`${P}/snapshots`, async (req, reply) => {
    const body = snapshotBody.parse(req.body ?? {});
    limit(snaps, req, 'snapshots');
    const snap = await runner.createSnapshot(owner(req), body.environmentId, body.label ?? null);
    void reply.status(201);
    return snap;
  });
  app.get(`${P}/snapshots`, (req) => ({
    items: runner.listSnapshots(owner(req), listQuery.parse(req.query).environmentId),
  }));
  app.get(`${P}/snapshots/:id`, (req) =>
    runner.getSnapshot(owner(req), idParams.parse(req.params).id),
  );
  app.post(`${P}/snapshots/:id/restore`, async (req) => ({
    ok: true,
    snapshot: await runner.restoreSnapshot(owner(req), idParams.parse(req.params).id),
  }));
  app.delete(`${P}/snapshots/:id`, async (req) => {
    await runner.deleteSnapshot(owner(req), idParams.parse(req.params).id);
    return { ok: true };
  });

  await app.ready();
  return {
    app,
    runner,
    close: async () => {
      for (const end of [...streams]) end();
      await app.close();
      await runner.close();
    },
  };
}
