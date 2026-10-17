// Audit log, notifications, activity, logs and diagnostics (FR-013, FR-104 partial, FR-118,
// FR-149 baseline). Builds the AuditSink and Notifier the other areas use, registers the blob
// data key so attachments, sources and artifacts are encrypted at rest, subscribes to the event
// bus for security-relevant events, and serves the Ops routes (contracts/hub-api.md).
import { Readable } from 'node:stream';
import { z } from 'zod';
import { idSchema, type EventEnvelope } from '@nova/shared';
import {
  AuditLog,
  NotificationService,
  auditSecurityEvents,
  blobEncryption,
  buildActivity,
  buildDiagnostics,
  detectVolumeEncryption,
  loadDataKey,
  notifyOnEvents,
  useBlobKey,
  type VolumeEncryption,
} from '@nova/core';
import { realpathLenient } from '@nova/security';
import { RingSink } from '@nova/telemetry';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { HubContext, OpsArea } from './hub-context.ts';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;

const notificationsQuery = z.object({
  unread: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});
const readBody = z
  .object({ ids: z.array(idSchema).max(500).optional(), all: z.boolean().optional() })
  .refine((v) => v.all === true || (v.ids?.length ?? 0) > 0, { message: 'give ids or all' });
const auditQuery = z.object({
  kind: z.string().max(50).optional(),
  threadId: idSchema.optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const activityQuery = z.object({ ref: idSchema });
const logsQuery = z.object({
  level: z.enum(LOG_LEVELS).optional(),
  module: z.string().max(200).optional(),
  since: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(200),
});
const params = z.object({ id: idSchema });

/** How long a volume-encryption probe result is reused (it can spawn commands on macOS). */
const VOLUME_TTL_MS = 5 * 60_000;
const MAX_ACTIVITY_EVENTS = 5000;

export async function setupOps(ctx: HubContext): Promise<OpsArea> {
  const startedAt = Date.now();
  const log = ctx.log.child('ops');
  const audit = new AuditLog({ db: ctx.db, events: ctx.events, log });
  const notifications = new NotificationService({
    db: ctx.db,
    events: ctx.events,
    enabled: async (kind) => (await ctx.setting('notifications.categories'))[kind],
  });

  // Blobs are encrypted with the Hub data key from the secret store (FR-149 baseline).
  useBlobKey(ctx.dataDir, await loadDataKey(ctx.secrets));

  // The diagnostics log ring: main.ts installs one; otherwise (tests, embedders) attach our own.
  const existing = ctx.log.findSink(RingSink);
  const ring = existing ?? new RingSink(5000);
  if (!existing) ctx.log.addSink(ring);

  // System events without an account are filed under the owner (single-owner Hub, docs/21).
  const ownerAccount = (): Promise<string | null> =>
    Promise.resolve(
      lookup(
        ctx,
        "SELECT id AS v FROM account WHERE kind = 'local' AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
      ),
    );
  const subscriptions = [
    auditSecurityEvents({ bus: ctx.events.bus, audit, ownerAccount, log }),
    notifyOnEvents({
      bus: ctx.events.bus,
      notifier: notifications,
      ownerAccount,
      nodeName: (id) =>
        Promise.resolve(lookup(ctx, 'SELECT name AS v FROM device WHERE id = ?', id)),
      threadTitle: (id) =>
        Promise.resolve(lookup(ctx, 'SELECT title AS v FROM thread WHERE id = ?', id)),
      mcpServerName: (id) =>
        Promise.resolve(lookup(ctx, 'SELECT name AS v FROM mcp_server WHERE id = ?', id)),
      log,
    }),
  ];

  let volume: { at: number; value: VolumeEncryption } | null = null;
  const volumeState = async (): Promise<VolumeEncryption> => {
    if (!volume || Date.now() - volume.at > VOLUME_TTL_MS) {
      volume = {
        at: Date.now(),
        value: await detectVolumeEncryption(realpathLenient(ctx.dataDir)),
      };
    }
    return volume.value;
  };

  function register(app: FastifyInstance): void {
    // ---- notifications (FR-013) ---------------------------------------------------------
    app.get('/api/v1/notifications', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = notificationsQuery.parse(req.query);
      return notifications.list(accountId, { unread: q.unread });
    });

    app.post('/api/v1/notifications/read', async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = readBody.parse(req.body);
      return { unread: await notifications.markRead(accountId, body) };
    });

    app.delete('/api/v1/notifications/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      await notifications.remove(accountId, params.parse(req.params).id);
      return { ok: true };
    });

    // ---- audit (FR-104 partial, docs/12 §11) ------------------------------------------------
    app.get('/api/v1/audit', async (req) => {
      const accountId = await ctx.accountOf(req);
      return audit.list(accountId, auditQuery.parse(req.query));
    });

    app.get('/api/v1/audit/verify', async (req) => {
      await ctx.accountOf(req);
      return audit.verify();
    });

    app.get('/api/v1/audit/export', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      return download(reply, 'nova-audit', Readable.from(audit.exportLines(accountId)));
    });

    // ---- activity -----------------------------------------------------------------------------
    app.get('/api/v1/activity', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { ref } = activityQuery.parse(req.query);
      await ctx.threads.row(accountId, ref); // not_found unless the thread is this account's
      const events: EventEnvelope[] = [];
      let after: string | null = null;
      while (events.length < MAX_ACTIVITY_EVENTS) {
        const page = await ctx.events.since(after, 500, { threadId: ref });
        events.push(...page);
        if (page.length < 500) break;
        after = page.at(-1)!.id;
      }
      return { items: buildActivity(events) };
    });

    // ---- diagnostics and logs (FR-043, FR-118) -------------------------------------------------
    app.get('/api/v1/diagnostics', async (req) => {
      const accountId = await ctx.accountOf(req);
      const [providers, nodes, probes, volumeValue] = await Promise.all([
        ctx.registry.list(accountId),
        ctx.nodes.list(accountId),
        ctx.diagnostics.collect(),
        volumeState(),
      ]);
      const info = ctx.secrets.info ?? {
        backend: ctx.secrets.kind === 'memory' ? ('memory' as const) : ('vault' as const),
        detail: ctx.secrets.kind,
        warning: null,
      };
      return buildDiagnostics({
        version: ctx.config.version,
        uptimeSeconds: (Date.now() - startedAt) / 1000,
        dataDir: ctx.dataDir,
        blobsEncrypted: blobEncryption(ctx.dataDir),
        volume: volumeValue,
        providers: providers.map((p) => ({ id: p.id, label: p.label, status: p.status })),
        nodes: nodes.map((n) => ({ id: n.id, name: n.name, status: n.status })),
        probes,
        secrets: info,
        tls: ctx.config.tls !== null,
        host: ctx.config.host,
      });
    });

    app.get('/api/v1/diagnostics/logs', async (req) => {
      await ctx.accountOf(req);
      const q = logsQuery.parse(req.query);
      return {
        items: ring.query(q).map((e) => ({
          ...e,
          // The API shape has no `trace`; it reads as debug detail.
          level: e.level === 'trace' ? ('debug' as const) : e.level,
        })),
      };
    });

    app.get('/api/v1/diagnostics/logs/export', async (req, reply) => {
      await ctx.accountOf(req);
      return download(reply, 'nova-logs', Readable.from(ring.exportLines()));
    });
  }

  return {
    audit,
    notifier: notifications,
    register,
    close: async () => {
      for (const s of subscriptions) s.stop();
      await Promise.all(subscriptions.map((s) => s.idle()));
      if (!existing) ctx.log.removeSink(ring);
    },
  };
}

/** One value from a read-only query, or null (a missing table or row never breaks a caller). */
function lookup(ctx: HubContext, sql: string, ...args: string[]): string | null {
  try {
    const row = ctx.db.raw.prepare(sql).get(...args) as { v: string | null } | undefined;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

function download(reply: FastifyReply, name: string, body: Readable): FastifyReply {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return reply
    .header('Content-Type', 'application/x-ndjson; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${name}-${stamp}.jsonl"`)
    .header('Cache-Control', 'no-store')
    .send(body);
}
