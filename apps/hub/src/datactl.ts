// Data controls area (FR-105, FR-116, FR-115, FR-121; ADR-097 D5): export, delete-all and import
// of the whole Hub, retention, crash reports, spend caps and provider limits.
//
// Under /api/v1/data everything is the Hub owner's (403 `policy_denied` `{reason: owner_only}` for
// anyone else, checked here as well as by the team guard): the export streams (`POST …/export`
// for programs, or a one-use ticket and `GET …/export/download?ticket=` for a browser download),
// delete-all needs the Hub's name typed, an import goes through an upload, a check and the import
// itself into an empty Hub. Delete-all and import replace everything, so the Hub restarts its
// services after answering (`restart`, given by main.ts). Under /api/v1/usage every account manages
// its own spend caps, sees its providers' limits and clears its usage records.
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  NovaError,
  clearUsageSchema,
  dataDeleteAllSchema,
  dataExportSchema,
  dataImportCheckSchema,
  dataImportSchema,
  spendCapSchema,
  spendProviderSchema,
  type CrashReportView,
  type RetentionItem,
} from '@nova/shared';
import {
  CrashReports,
  DataControls,
  RetentionService,
  SpendCaps,
  hubOwnerId,
  isHubOwner,
  ownerOnlyError,
  type AuditSink,
  type Notifier,
  type ScryptParams,
} from '@nova/core';
import type { Migration } from '@nova/storage';
import type { HubArea, HubContext } from './hub-context.ts';

export interface DatactlArea extends HubArea {
  data: DataControls;
  retention: RetentionService;
  crash: CrashReports;
  spend: SpendCaps;
}

export interface DatactlDeps {
  audit: AuditSink;
  notifier?: Notifier;
  /**
   * The spend caps the router enforces (app.ts makes them next to the router and wraps it with
   * `withSpendCaps`); without them the area makes its own (tests).
   */
  spend?: SpendCaps;
  /** Stop background work before delete-all or an import replaces every row. */
  quiesce?: () => Promise<void>;
  /** Restart the Hub's services after delete-all or an import (main.ts). */
  restart?: () => void;
  /** Tests: a clock, the crash endpoint's fetch, cheaper key derivation, migrations, timers. */
  now?: () => Date;
  fetch?: typeof fetch;
  scrypt?: ScryptParams;
  migrations?: Migration[];
  /** How often the daily retention sweep is checked for (default hourly; 0 turns it off). */
  sweepCheckMs?: number;
  hubName?: () => Promise<string>;
}

const TICKET_MS = 2 * 60_000;
const crashParams = z.object({ id: z.string().min(1).max(64) });
const providerParams = z.object({ provider: spendProviderSchema });
const ticketQuery = z.object({ ticket: z.string().min(20).max(100) });
const ticketBody = dataExportSchema;

export function setupDatactl(ctx: HubContext, deps: DatactlDeps): Promise<DatactlArea> {
  const log = ctx.log.child('datactl');
  const now = deps.now ?? (() => new Date());
  const hubName =
    deps.hubName ??
    (async () => {
      const set = await ctx.setting('network.lan.mdnsName');
      const label = hostname()
        .toLowerCase()
        .split('.')[0]!
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return set ?? (label || 'nova-hub');
    });

  const spend =
    deps.spend ?? new SpendCaps({ db: ctx.db, events: ctx.events, now, log: log.child('spend') });
  spend.useAudit(deps.audit);
  spend.useEvents(ctx.events);
  if (deps.notifier) spend.useNotifier(deps.notifier);

  const data = new DataControls({
    db: ctx.db,
    secrets: ctx.secrets,
    dataDir: ctx.dataDir,
    hubVersion: ctx.config.version,
    hubName,
    audit: deps.audit,
    events: ctx.events,
    log,
    now,
    ...(deps.quiesce ? { quiesce: deps.quiesce } : {}),
    ...(deps.scrypt ? { scrypt: deps.scrypt } : {}),
    ...(deps.migrations ? { migrations: deps.migrations } : {}),
  });

  const retention = new RetentionService({
    db: ctx.db,
    dataDir: ctx.dataDir,
    days: async (item: RetentionItem) => {
      switch (item) {
        case 'threads':
          return ctx.setting('retention.threadsDays');
        case 'runs':
          return ctx.setting('retention.runsDays');
        case 'audit':
          return ctx.setting('retention.auditDays');
        case 'artifacts':
          return ctx.setting('retention.artifactsDays');
        case 'traces':
          return ctx.setting('retention.tracesDays');
      }
    },
    audit: deps.audit,
    ownerAccountId: () => hubOwnerId(ctx.db),
    now,
    log: log.child('retention'),
  });

  const crash = new CrashReports({
    dataDir: ctx.dataDir,
    enabled: () => ctx.setting('privacy.crashReports'),
    endpoint: () => ctx.setting('privacy.crashReportEndpoint'),
    now,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  // A reply's usage may cross a cap's warning threshold: warn now, not at the next call.
  const offUsage = ctx.events.bus.subscribe('chat.message.completed', (e) => {
    const usage = e.payload.usage as { costUsd?: unknown } | null | undefined;
    if (!e.accountId || typeof usage?.costUsd !== 'number' || usage.costUsd <= 0) return;
    void spend
      .evaluate(e.accountId)
      .catch((err: unknown) => log.warn('spend caps not evaluated', { err }));
  });

  const sweepRetention = async (kind: 'schedule' | 'manual') => {
    const r = await retention.sweep(kind);
    const owner = hubOwnerId(ctx.db);
    await ctx.events.emit({
      name: 'data.retention.swept',
      actor: 'system',
      ...(owner ? { accountId: owner } : {}),
      payload: { sweepId: r.id, trigger: r.trigger, removed: r.removed, skipped: r.skipped },
    });
    return r;
  };
  const checkMs = deps.sweepCheckMs ?? 60 * 60_000;
  const timer =
    checkMs > 0
      ? setInterval(() => {
          data.sweepUploads();
          if (!retention.isDue()) return;
          void sweepRetention('schedule').catch((err: unknown) =>
            log.warn('retention sweep failed', { err }),
          );
        }, checkMs)
      : null;
  timer?.unref();
  // Reports a crash left behind go out now when the owner turned sending on (FR-121).
  void crash
    .sendPending()
    .then((n) => {
      if (n) log.info('sent crash reports', { count: n });
    })
    .catch((err: unknown) => log.warn('crash reports not sent', { err }));

  ctx.diagnostics.add('dataControls', async () => ({
    crashReports: crash.list().length,
    unsentCrashReports: crash.list().filter((r: CrashReportView) => !r.sentAt).length,
    crashReportsOn: await ctx.setting('privacy.crashReports'),
    lastRetentionSweep: retention.lastSweep()?.startedAt ?? null,
  }));

  /** The owner's account for an owner-only route (fail closed). */
  const owner = async (req: FastifyRequest): Promise<string> => {
    const accountId = await ctx.accountOf(req);
    if (!isHubOwner(ctx.db, accountId)) throw ownerOnlyError("the Hub's data");
    return accountId;
  };
  const sessionOf = (req: FastifyRequest): string | null => req.principal?.tokenId ?? null;
  /** Restart once the answer is on its way (the Hub's services start again on the new data). */
  const restartAfter = (reply: FastifyReply) => {
    if (!deps.restart) return;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      setImmediate(() => deps.restart?.());
    };
    reply.raw.once('finish', go);
    reply.raw.once('close', go);
  };

  const tickets = new Map<
    string,
    { accountId: string; passphrase?: string; confirm?: string; device: boolean; expires: number }
  >();
  /** A device session (Add Device) is never enough for a sealed export: it is Hub-only. */
  const deviceSession = (req: FastifyRequest) => !!req.principal?.deviceId;
  const sendExport = async (
    reply: FastifyReply,
    accountId: string,
    req: { passphrase?: string; confirm?: string },
    device: boolean,
  ) => {
    const passphrase = req.passphrase;
    const stream = Readable.from(
      await data.export(
        accountId,
        passphrase !== undefined
          ? { passphrase, ...(req.confirm ? { confirm: req.confirm } : {}) }
          : {},
        { deviceSession: device },
      ),
    );
    const day = now().toISOString().slice(0, 10);
    void reply
      .header(
        'Content-Type',
        passphrase !== undefined ? 'application/octet-stream' : 'application/zip',
      )
      .header('Content-Disposition', `attachment; filename="nova-${day}.novaexport"`)
      .header('Cache-Control', 'no-store');
    return reply.send(stream);
  };

  function register(app: FastifyInstance): void {
    // ---- overview and export --------------------------------------------------------------------
    app.get('/api/v1/data', async (req) => {
      await owner(req);
      return data.overview();
    });

    app.post('/api/v1/data/export', async (req, reply) => {
      const accountId = await owner(req);
      const body = dataExportSchema.parse(req.body ?? {});
      return sendExport(reply, accountId, body, deviceSession(req));
    });

    // A browser downloads with a plain GET: the ticket carries the choice (and passphrase), once.
    app.post('/api/v1/data/export/ticket', async (req) => {
      const accountId = await owner(req);
      const body = ticketBody.parse(req.body ?? {});
      // Checked now (the download re-checks): a sealed export is confirmed and Hub-only.
      if (body.passphrase !== undefined)
        await data.assertSealedExport(accountId, body.confirm, {
          deviceSession: deviceSession(req),
        });
      for (const [k, t] of tickets) if (t.expires < now().getTime()) tickets.delete(k);
      const ticket = randomBytes(32).toString('base64url');
      const expires = now().getTime() + TICKET_MS;
      tickets.set(ticket, {
        accountId,
        expires,
        device: deviceSession(req),
        ...(body.passphrase !== undefined ? { passphrase: body.passphrase } : {}),
        ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
      });
      return { ticket, expiresAt: new Date(expires).toISOString() };
    });

    app.get('/api/v1/data/export/download', async (req, reply) => {
      const accountId = await owner(req);
      const q = ticketQuery.parse(req.query);
      const t = tickets.get(q.ticket);
      tickets.delete(q.ticket);
      if (!t || t.accountId !== accountId || t.expires < now().getTime())
        throw new NovaError('not_found', 'the download link expired; start the export again', {
          details: { reason: 'ticket_expired' },
        });
      return sendExport(
        reply,
        accountId,
        {
          ...(t.passphrase !== undefined ? { passphrase: t.passphrase } : {}),
          ...(t.confirm !== undefined ? { confirm: t.confirm } : {}),
        },
        t.device || deviceSession(req),
      );
    });

    // ---- delete-all -----------------------------------------------------------------------------
    app.post('/api/v1/data/delete-all', async (req, reply) => {
      const accountId = await owner(req);
      const body = dataDeleteAllSchema.parse(req.body);
      const result = await data.deleteAll(accountId, sessionOf(req), body.confirm);
      tickets.clear();
      restartAfter(reply);
      return result;
    });

    // ---- import ---------------------------------------------------------------------------------
    // The archive arrives as the raw body; only this route takes binary bodies.
    void app.register((scoped, _opts, done) => {
      const raw = (
        _req: FastifyRequest,
        payload: NodeJS.ReadableStream,
        next: (e: Error | null, b?: unknown) => void,
      ) => next(null, payload);
      scoped.addContentTypeParser('application/octet-stream', raw);
      scoped.addContentTypeParser('application/zip', raw);
      scoped.post('/api/v1/data/import/upload', async (req, reply) => {
        const accountId = await owner(req);
        const body = req.body as AsyncIterable<Uint8Array> | undefined;
        if (
          !body ||
          typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function'
        )
          throw new NovaError('validation', 'send the archive as application/octet-stream', {
            details: { reason: 'content_type' },
          });
        const view = await data.upload(accountId, body);
        void reply.status(201);
        return view;
      });
      done();
    });

    app.delete('/api/v1/data/import/uploads/:id', async (req) => {
      const accountId = await owner(req);
      data.removeUpload(accountId, z.object({ id: z.string().max(64) }).parse(req.params).id);
      return { ok: true };
    });

    app.post('/api/v1/data/import/check', async (req) => {
      const accountId = await owner(req);
      const body = dataImportCheckSchema.parse(req.body);
      return data.check(accountId, body.uploadId, body.passphrase);
    });

    app.post('/api/v1/data/import', async (req, reply) => {
      const accountId = await owner(req);
      const body = dataImportSchema.parse(req.body);
      const result = await data.import(accountId, sessionOf(req), body.uploadId, body.passphrase);
      tickets.clear();
      restartAfter(reply);
      return result;
    });

    // ---- retention ------------------------------------------------------------------------------
    app.get('/api/v1/data/retention', async (req) => {
      await owner(req);
      return retention.view();
    });

    app.post('/api/v1/data/retention/sweep', async (req) => {
      const accountId = await owner(req);
      const r = await sweepRetention('manual');
      await deps.audit.append({
        accountId,
        actor: 'user',
        kind: 'settings',
        action: 'data.retention.sweep',
        resource: 'hub',
        result: r.error ? 'failed' : 'ok',
        detail: { removed: r.removed, skipped: r.skipped },
      });
      return r;
    });

    // ---- crash reports --------------------------------------------------------------------------
    app.get('/api/v1/data/crash-reports', async (req) => {
      await owner(req);
      return {
        items: crash.list(),
        enabled: await ctx.setting('privacy.crashReports'),
        endpoint: (await ctx.setting('privacy.crashReportEndpoint')) || null,
      };
    });

    app.get('/api/v1/data/crash-reports/:id/preview', async (req) => {
      await owner(req);
      return crash.preview(crashParams.parse(req.params).id);
    });

    app.post('/api/v1/data/crash-reports/:id/send', async (req) => {
      const accountId = await owner(req);
      const id = crashParams.parse(req.params).id;
      try {
        const sent = await crash.send(id);
        await deps.audit.append({
          accountId,
          actor: 'user',
          kind: 'settings',
          action: 'crash.report.send',
          resource: id,
          result: 'ok',
        });
        return sent;
      } catch (err) {
        await deps.audit
          .append({
            accountId,
            actor: 'user',
            kind: 'settings',
            action: 'crash.report.send',
            resource: id,
            result: 'failed',
            detail: {
              reason: err instanceof NovaError ? (err.details?.reason ?? err.code) : 'error',
            },
          })
          .catch(() => undefined);
        throw err;
      }
    });

    app.delete('/api/v1/data/crash-reports/:id', async (req) => {
      await owner(req);
      crash.delete(crashParams.parse(req.params).id);
      return { ok: true };
    });

    app.delete('/api/v1/data/crash-reports', async (req) => {
      await owner(req);
      return { deleted: crash.deleteAll() };
    });

    // ---- spend caps, provider limits and usage (every account its own) ---------------------------
    app.get('/api/v1/usage/caps', async (req) => ({
      items: spend.list(await ctx.accountOf(req)),
    }));

    app.put('/api/v1/usage/caps/:provider', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { provider } = providerParams.parse(req.params);
      return spend.set(accountId, provider, spendCapSchema.parse(req.body));
    });

    app.delete('/api/v1/usage/caps/:provider', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { provider } = providerParams.parse(req.params);
      if (!(await spend.remove(accountId, provider)))
        throw new NovaError('not_found', 'no spend cap for that provider');
      return { ok: true };
    });

    app.get('/api/v1/usage/limits', async (req) => ({
      items: spend.limits(await ctx.accountOf(req)),
    }));

    app.post('/api/v1/usage/clear', async (req) => {
      const accountId = await ctx.accountOf(req);
      clearUsageSchema.parse(req.body);
      return spend.clearUsage(accountId);
    });
  }

  return Promise.resolve({
    data,
    retention,
    crash,
    spend,
    register,
    close: () => {
      offUsage();
      if (timer) clearInterval(timer);
      tickets.clear();
      return Promise.resolve();
    },
  });
}
