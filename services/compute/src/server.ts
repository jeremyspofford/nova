// The node's job API (contracts/hub-api.md §2, FR-126): called only by the Hub, every request
// bearing the node's job token. Browsers are refused outright (any Origin header), so a web page
// on the LAN cannot drive the node even if it learned the address.
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NovaError, httpStatusFor, isNovaError } from '@nova/shared';
import type { StreamEvent } from '@nova/providers';
import type { Logger } from '@nova/telemetry';
import { tokenMatches } from './identity.ts';
import type { JobManager } from './jobs.ts';
import { parseJob } from './protocol.ts';

export const COMPUTE_NODE_VERSION = '0.0.0';

export interface JobServerOptions {
  jobs: JobManager;
  /** The token the Hub must present; null refuses everything (not enrolled or revoked). */
  jobToken: () => string | null;
  log: Logger;
  /** Keep-alive comment period on job streams (default 15 s). */
  keepAliveMs?: number;
  /** Largest job body; requests carry base64 images (default 64 MB). */
  bodyLimit?: number;
}

const params = z.object({ id: z.string().min(1).max(100) });

export function buildJobServer(opts: JobServerOptions): FastifyInstance {
  const { jobs, log } = opts;
  // Jobs are cancelled before close, so open connections are closed rather than awaited.
  const app = Fastify({
    logger: false,
    bodyLimit: opts.bodyLimit ?? 64 * 1024 * 1024,
    forceCloseConnections: true,
  });

  app.addHook('onRequest', (req: FastifyRequest, _reply, done) => {
    if (req.headers.origin !== undefined) {
      done(new NovaError('origin_rejected', 'browser requests are not accepted'));
      return;
    }
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const expected = opts.jobToken();
    if (!presented || !expected || !tokenMatches(presented, expected)) {
      done(new NovaError('token_required', 'a valid job token is required'));
      return;
    }
    done();
  });

  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err)) {
      void reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
      return;
    }
    if (err instanceof z.ZodError) {
      const body = new NovaError('validation', 'request failed validation', {
        details: {
          issues: err.issues
            .slice(0, 20)
            .map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      void reply.status(400).send({ error: body.toJSON(), requestId: req.id });
      return;
    }
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) log.error('job server error', { err });
    void reply.status(status).send({
      error: {
        code: status === 404 ? 'not_found' : status < 500 ? 'validation' : 'server_error',
        message: status < 500 && err instanceof Error ? err.message : 'internal error',
        retryable: status >= 500,
      },
      requestId: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: { code: 'not_found', message: 'not found', retryable: false },
      requestId: req.id,
    });
  });

  app.get('/node/v1/health', () => ({
    status: 'ok',
    version: COMPUTE_NODE_VERSION,
    load: jobs.load(),
    maxConcurrentJobs: jobs.maxConcurrentJobs,
    maxQueue: jobs.maxQueue,
  }));

  app.post('/node/v1/jobs', (req, reply) => {
    const request = parseJob(req.body);
    const jobId = jobs.submit(request);
    log.info('job accepted', { jobId, model: request.model, load: jobs.load() });
    void reply.status(201);
    return { jobId };
  });

  app.post('/node/v1/jobs/:id/cancel', (req) => {
    const { id } = params.parse(req.params);
    if (!jobs.has(id)) throw new NovaError('not_found', 'no such job');
    return { ok: true, cancelled: jobs.cancel(id) };
  });

  app.get('/node/v1/jobs/:id/stream', (req, reply) => {
    const { id } = params.parse(req.params);
    // Attach first so an unknown job is still a normal 404 reply; events wait in `pending`.
    const pending: StreamEvent[] = [];
    let deliver: ((e: StreamEvent) => void) | null = null;
    const detach = jobs.attach(id, (e) => {
      if (deliver) deliver(e);
      else pending.push(e);
    });
    if (!detach) throw new NovaError('not_found', 'no such job, or it is already being streamed');
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    raw.write(': connected\n\n');
    const ping = setInterval(() => raw.write(': ping\n\n'), opts.keepAliveMs ?? 15_000);
    let ended = false;
    const write = (e: StreamEvent) => {
      if (ended) return;
      raw.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type === 'stop') {
        ended = true;
        clearInterval(ping);
        raw.end();
      }
    };
    for (const e of pending.splice(0)) write(e);
    deliver = write;
    // The Hub disconnected before the job ended: detaching cancels the job.
    raw.on('close', () => {
      clearInterval(ping);
      if (!ended) log.info('job stream closed by the Hub; cancelling', { jobId: id });
      ended = true;
      detach();
    });
  });

  return app;
}
