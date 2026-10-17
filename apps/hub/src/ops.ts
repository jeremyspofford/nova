// Audit log, notifications, activity, logs and diagnostics (FR-013, FR-104, FR-118, FR-119,
// FR-149 baseline). Builds the AuditSink and Notifier the other areas use, registers the blob
// data key so attachments, sources and artifacts are encrypted at rest, subscribes to the event
// bus for security-relevant events, and serves the Ops routes (contracts/hub-api.md).
//
// M5: POST /diagnostics/test runs one component's test for Settings → Diagnostics (FR-119): a
// tiny request to each provider account, an MCP server's connection and tool list, a command in
// the sandbox, a write/read/delete in the data folder with a database integrity check, and the
// update channel. The MCP manager and the sandbox come from later areas (`useDiagnosticTests`).
import { randomBytes } from 'node:crypto';
import { readFileSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  NovaError,
  idSchema,
  isNovaError,
  modelRef,
  uuidv7,
  type EventEnvelope,
  type McpStatus,
} from '@nova/shared';
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
  type SandboxClient,
  type VolumeEncryption,
} from '@nova/core';
import { defaultRedactor, realpathLenient } from '@nova/security';
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

/** What Settings → Diagnostics can test (FR-119). */
export const DIAGNOSTIC_COMPONENTS = ['provider', 'mcp', 'sandbox', 'storage', 'update'] as const;
export type DiagnosticComponent = (typeof DIAGNOSTIC_COMPONENTS)[number];
const testBody = z.object({
  component: z.enum(DIAGNOSTIC_COMPONENTS),
  /** A provider account or MCP server id; every one of them when omitted. */
  ref: z.string().min(1).max(200).optional(),
});

export type DiagnosticStatus = 'ok' | 'warning' | 'error' | 'unavailable';

export interface DiagnosticCheck {
  name: string;
  /** The provider account or MCP server the check is about, when it is about one. */
  ref: string | null;
  status: DiagnosticStatus;
  detail: string;
}

/** The answer of POST /diagnostics/test (proposed for packages/shared as DiagnosticTestResult). */
export interface DiagnosticTestResult {
  component: DiagnosticComponent;
  ref: string | null;
  status: DiagnosticStatus;
  detail: string;
  checks: DiagnosticCheck[];
  durationMs: number;
  testedAt: string;
}

/** The parts of the MCP manager a test reads (McpManager satisfies it). */
export interface McpDiagnosticsSource {
  states(accountId: string): {
    id: string;
    name: string;
    status: McpStatus;
    lastError: string | null;
  }[];
  tools(id: string): { descriptor: { name: string } }[];
}

/** Parts of later areas the tests reach, wired by app.ts once those areas exist. */
export interface DiagnosticTestDeps {
  mcp?: McpDiagnosticsSource;
  sandbox?: () => SandboxClient;
}

export interface HubOpsArea extends OpsArea {
  /** Give the diagnostics tests the MCP manager and the sandbox (FR-119). */
  useDiagnosticTests(deps: DiagnosticTestDeps): void;
}

/** How long one test may take before it reports a timeout. */
export const DIAGNOSTIC_TIMEOUT_MS = 30_000;
const LOW_DISK_BYTES = 1024 ** 3;
const RANK: Record<DiagnosticStatus, number> = { ok: 0, unavailable: 1, warning: 2, error: 3 };

/** How long a volume-encryption probe result is reused (it can spawn commands on macOS). */
const VOLUME_TTL_MS = 5 * 60_000;
const MAX_ACTIVITY_EVENTS = 5000;

export async function setupOps(
  ctx: HubContext,
  opts: { diagnosticTimeoutMs?: number } = {},
): Promise<HubOpsArea> {
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

  let testDeps: DiagnosticTestDeps = {};
  const tests = diagnosticTests(
    ctx,
    () => testDeps,
    opts.diagnosticTimeoutMs ?? DIAGNOSTIC_TIMEOUT_MS,
  );

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
        const page = await ctx.events.since(after, 500, { threadId: ref, accountId });
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

    // One component's test (FR-119). Tests never throw for a failing component: the failure is
    // the result. Only an unknown ref is an error.
    app.post('/api/v1/diagnostics/test', async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = testBody.parse(req.body ?? {});
      const result = await tests(accountId, body.component, body.ref ?? null);
      log.info('diagnostics test', {
        component: result.component,
        status: result.status,
        ms: result.durationMs,
      });
      return result;
    });
  }

  return {
    audit,
    notifier: notifications,
    register,
    useDiagnosticTests: (deps) => {
      testDeps = { ...testDeps, ...deps };
    },
    close: async () => {
      for (const s of subscriptions) s.stop();
      await Promise.all(subscriptions.map((s) => s.idle()));
      if (!existing) ctx.log.removeSink(ring);
    },
  };
}

// ---- diagnostics tests (FR-119) ----------------------------------------------------------------

function worst(checks: DiagnosticCheck[]): DiagnosticStatus {
  let s: DiagnosticStatus = 'ok';
  for (const c of checks) if (RANK[c.status] > RANK[s]) s = c.status;
  return s;
}

const safe = (err: unknown) =>
  defaultRedactor.redactString(err instanceof Error ? err.message : String(err)).slice(0, 500);

/** Run `fn` with an abort signal that fires after `ms`; a timeout becomes an error result. */
async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(ctl.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(
            new NovaError(
              'timeout',
              `no answer within ${ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`}`,
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The test runner behind POST /diagnostics/test. */
export function diagnosticTests(
  ctx: HubContext,
  deps: () => DiagnosticTestDeps,
  timeoutMs: number,
): (
  accountId: string,
  component: DiagnosticComponent,
  ref: string | null,
) => Promise<DiagnosticTestResult> {
  async function provider(
    accountId: string,
    p: { id: string; label: string },
  ): Promise<DiagnosticCheck> {
    const check = (status: DiagnosticStatus, detail: string): DiagnosticCheck => ({
      name: p.label,
      ref: p.id,
      status,
      detail,
    });
    try {
      // Connect and list models (this also refreshes the account's status), then send a tiny
      // request to its first model through the router, held to this account so a fallback
      // cannot answer for it.
      const listed = await withTimeout(timeoutMs, () => ctx.registry.test(accountId, p.id));
      if (!listed.ok) return check('error', listed.detail ?? 'Could not connect.');
      // The account's own list (test() just fetched it): the merged model list shows an
      // inactive account's models under its kind's active account (FR-115).
      const info = ctx.registry.cachedModels(p.id)?.[0];
      if (!info) return check('warning', 'Connected, but it offers no models.');
      const route = await ctx.router.route(accountId, modelRef(p.id, info.id));
      const targets = route.targets.filter((t) => t.providerAccountId === p.id).slice(0, 1);
      if (!targets.length) return check('warning', `Connected, but ${info.label} is not routable.`);
      const started = Date.now();
      const answer = await withTimeout(timeoutMs, async (signal) => {
        let text = '';
        let error: string | null = null;
        for await (const ev of ctx.router.stream(
          { ...route, targets },
          {
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'Reply with the word OK.' }] },
            ],
            maxTokens: 16,
            signal,
          },
          { requestId: `diagnostics:${uuidv7()}` },
        )) {
          if (ev.type === 'text_delta') text += ev.text;
          if (ev.type === 'stop' && ev.reason === 'error')
            error = ev.error?.message ?? 'the request failed';
        }
        return { text, error };
      });
      if (answer.error) return check('error', defaultRedactor.redactString(answer.error));
      return check('ok', `${info.label} answered in ${Date.now() - started} ms.`);
    } catch (err) {
      return check('error', safe(err));
    }
  }

  async function providers(accountId: string, ref: string | null) {
    const all = (await ctx.registry.list(accountId)).filter((p) => p.status !== 'revoked');
    const picked = ref ? all.filter((p) => p.id === ref) : all;
    if (ref && !picked.length) throw new NovaError('not_found', 'provider account not found');
    if (!picked.length)
      return { status: 'unavailable' as const, detail: 'No providers are connected.', checks: [] };
    const checks = await Promise.all(picked.map((p) => provider(accountId, p)));
    const failed = checks.filter((c) => c.status !== 'ok').length;
    const detail =
      checks.length === 1
        ? checks[0]!.detail
        : failed
          ? `${failed} of ${checks.length} providers need attention.`
          : `All ${checks.length} providers answered.`;
    return { status: worst(checks), detail, checks };
  }

  function mcp(accountId: string, ref: string | null) {
    const source = deps().mcp;
    if (!source)
      return {
        status: 'unavailable' as const,
        detail: 'MCP is not set up on this Hub.',
        checks: [],
      };
    const all = source.states(accountId);
    const picked = ref ? all.filter((s) => s.id === ref) : all;
    if (ref && !picked.length) throw new NovaError('not_found', 'MCP server not found');
    if (!picked.length)
      return { status: 'unavailable' as const, detail: 'No MCP servers are set up.', checks: [] };
    const checks = picked.map((s): DiagnosticCheck => {
      const base = { name: s.name, ref: s.id };
      switch (s.status) {
        case 'connected': {
          const names = source.tools(s.id).map((t) => t.descriptor.name);
          const shown = names.slice(0, 8).join(', ');
          const more = names.length > 8 ? ` and ${names.length - 8} more` : '';
          return {
            ...base,
            status: names.length ? 'ok' : 'warning',
            detail: names.length
              ? `Connected; lists ${plural(names.length, 'tool')}: ${shown}${more}.`
              : 'Connected, but it lists no tools.',
          };
        }
        case 'disabled':
          return { ...base, status: 'unavailable', detail: 'Turned off.' };
        case 'starting':
          return { ...base, status: 'warning', detail: 'Still starting; test again in a moment.' };
        default:
          return { ...base, status: 'error', detail: s.lastError ?? 'Not connected.' };
      }
    });
    const failed = checks.filter((c) => c.status !== 'ok').length;
    const detail =
      checks.length === 1
        ? checks[0]!.detail
        : failed
          ? `${failed} of ${checks.length} servers need attention.`
          : `All ${checks.length} servers are connected.`;
    return { status: worst(checks), detail, checks };
  }

  async function sandbox() {
    const sb = deps().sandbox?.();
    if (!sb)
      return {
        status: 'unavailable' as const,
        detail: 'No sandbox is set up on this Hub.',
        checks: [],
      };
    const available = await sb.available();
    if (!available.ok)
      return { status: 'unavailable' as const, detail: available.detail, checks: [] };
    const turnId = `diagnostics-${uuidv7()}`;
    const started = Date.now();
    try {
      const r = await withTimeout(timeoutMs, (signal) =>
        sb.exec({
          cmd: 'true',
          cwd: '/',
          roots: [],
          network: 'off',
          yieldMs: timeoutMs,
          signal,
          turnId,
        }),
      );
      if (r.status === 'running') {
        await sb.killTurn(turnId);
        return { status: 'error' as const, detail: 'The test command did not finish.', checks: [] };
      }
      if (r.exitCode !== 0)
        return {
          status: 'error' as const,
          detail: `The test command exited with code ${r.exitCode}: ${defaultRedactor.redactString(r.output).slice(0, 300).trim()}`,
          checks: [],
        };
      const where = sb.substrate ? ` (${sb.substrate.replace('_', ' ')})` : '';
      return {
        status: 'ok' as const,
        detail: `Ran a command in the sandbox${where} in ${Date.now() - started} ms.`,
        checks: [],
      };
    } catch (err) {
      await sb.killTurn(turnId).catch(() => undefined);
      return { status: 'error' as const, detail: safe(err), checks: [] };
    }
  }

  function storage() {
    const checks: DiagnosticCheck[] = [];
    const file = join(ctx.dataDir, `.diagnostics-${uuidv7()}`);
    try {
      const payload = randomBytes(64);
      writeFileSync(file, payload, { mode: 0o600 });
      const back = readFileSync(file);
      unlinkSync(file);
      checks.push({
        name: 'Data folder',
        ref: null,
        status: back.equals(payload) ? 'ok' : 'error',
        detail: back.equals(payload)
          ? 'Wrote, read back and deleted a test file.'
          : 'A test file read back differently from what was written.',
      });
    } catch (err) {
      try {
        unlinkSync(file);
      } catch {
        // nothing was written
      }
      checks.push({ name: 'Data folder', ref: null, status: 'error', detail: safe(err) });
    }
    try {
      const rows = ctx.db.raw.prepare('PRAGMA integrity_check(10)').all() as Record<
        string,
        unknown
      >[];
      const lines = rows.map((r) => String(Object.values(r)[0]));
      const okDb = lines.length === 1 && lines[0] === 'ok';
      checks.push({
        name: 'Database',
        ref: null,
        status: okDb ? 'ok' : 'error',
        detail: okDb
          ? 'Passed its integrity check.'
          : `Integrity check: ${lines.join('; ').slice(0, 400)}`,
      });
    } catch (err) {
      checks.push({ name: 'Database', ref: null, status: 'error', detail: safe(err) });
    }
    try {
      const fs = statfsSync(ctx.dataDir);
      const free = Number(fs.bavail) * Number(fs.bsize);
      const gb = (free / 1024 ** 3).toFixed(1);
      checks.push({
        name: 'Free space',
        ref: null,
        status: free < LOW_DISK_BYTES ? 'warning' : 'ok',
        detail: free < LOW_DISK_BYTES ? `Only ${gb} GB free.` : `${gb} GB free.`,
      });
    } catch (err) {
      checks.push({ name: 'Free space', ref: null, status: 'warning', detail: safe(err) });
    }
    const status = worst(checks);
    const detail =
      status === 'ok'
        ? 'The data folder and the database are working.'
        : checks
            .filter((c) => c.status !== 'ok')
            .map((c) => `${c.name}: ${c.detail}`)
            .join(' ');
    return { status, detail, checks };
  }

  return async (accountId, component, ref) => {
    const started = Date.now();
    let r: { status: DiagnosticStatus; detail: string; checks: DiagnosticCheck[] };
    try {
      switch (component) {
        case 'provider':
          r = await providers(accountId, ref);
          break;
        case 'mcp':
          r = mcp(accountId, ref);
          break;
        case 'sandbox':
          r = await sandbox();
          break;
        case 'storage':
          r = storage();
          break;
        case 'update':
          // No update channel exists before M10; say so rather than pretend to check.
          r = {
            status: 'unavailable',
            detail: `No update channel is configured. This Hub runs version ${ctx.config.version}.`,
            checks: [],
          };
          break;
      }
    } catch (err) {
      if (isNovaError(err) && err.code === 'not_found') throw err;
      r = { status: 'error', detail: safe(err), checks: [] };
    }
    return {
      component,
      ref,
      ...r,
      durationMs: Date.now() - started,
      testedAt: new Date().toISOString(),
    };
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
