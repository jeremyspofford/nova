// M5 requests area: server-to-client requests (FR-188, contracts/hub-api.md §5), the `ask_user`
// tool and the derived thread status (FR-215). Routes need a session and validate their input
// with zod: GET /api/v1/requests lists pending requests (with pending approvals as read-only
// `approval` items); POST /api/v1/requests/:id/respond answers one (first valid answer wins:
// later `conflict`, after expiry `request_expired`). WebSocket clients get `request` frames for
// the kinds they declared in the handshake (`hello`) and answer with `respond` frames; the lead
// wires both into /api/v1/hello and /api/v1/ws (`hello`, `attachClient`).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  REQUEST_KINDS,
  idSchema,
  respondRequestSchema,
  type ServerRequestKind,
} from '@nova/shared';
import {
  RequestService,
  ThreadStatusService,
  requestToolSource,
  userAskTool,
  type ApprovalRequests,
  type Notifier,
  type RequestConnection,
  type ThreadStatusSource,
  type ToolSourceProvider,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

/** The header a client sends its `clientSessionId` (from the handshake) in. */
export const CLIENT_SESSION_HEADER = 'x-nova-client-session';
const MAX_SESSIONS = 1000;

export interface ClientSession {
  accountId: string;
  deviceId: string | null;
  kinds: ServerRequestKind[];
}

export interface RequestsArea extends HubArea {
  /** The broker (RequestBroker) for the chat loop, MCP elicitations and client tools. */
  service: RequestService;
  /** The derived thread status: `statusOf` fills ThreadView.derived (FR-215). */
  status: ThreadStatusService;
  /** `ask_user` for the tool runtime (offered in Work and Code threads). */
  tools: ToolSourceProvider;
  /**
   * The server-request part of POST /api/v1/hello: the kinds the Hub agrees to send this client
   * and the `clientSessionId` its WebSocket and HTTP calls name.
   */
  hello(input: { accountId: string; deviceId: string | null; serverRequests: unknown }): {
    serverRequests: ServerRequestKind[];
    clientSessionId: string;
  };
  /** The client a handshake declared, if it is this account's. */
  clientSession(
    accountId: string,
    clientSessionId: string | null | undefined,
  ): ClientSession | null;
  /**
   * Attach a WebSocket client: `request` frames for its kinds (from its handshake session, or
   * `kinds`), and `handle(frame)` for inbound `respond` frames. Call `detach` on close.
   */
  attachClient(input: {
    accountId: string;
    deviceId: string | null;
    clientSessionId?: string | null;
    kinds?: readonly ServerRequestKind[];
    send: (frame: Record<string, unknown>) => void;
  }): RequestConnection;
  /** The notification fallback (FR-060), from the ops area. */
  useNotifier(notifier: Notifier): void;
  /** The approvals flow (policy area `approvals`), for the `approval` mirror. */
  useApprovals(approvals: ApprovalRequests): void;
  /** What the runs and Code areas know about blocked and child threads. */
  useStatusSources(...sources: ThreadStatusSource[]): void;
}

export interface RequestsOptions {
  notifier?: Notifier;
  approvals?: ApprovalRequests;
  /** Tests drive a simulated clock. */
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => () => void;
  notifyAfterMs?: number;
}

const listQuery = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  threadId: idSchema.optional(),
});
const params = z.object({ id: idSchema });

function tableExists(ctx: HubContext, name: string): boolean {
  try {
    return !!ctx.db.raw
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
  } catch {
    return false;
  }
}

export async function setupRequests(
  ctx: HubContext,
  opts: RequestsOptions = {},
): Promise<RequestsArea> {
  const log = ctx.log.child('requests');
  const service = new RequestService({
    db: ctx.db,
    events: ctx.events,
    log,
    ...(opts.notifier ? { notifier: opts.notifier } : {}),
    ...(opts.approvals ? { approvals: opts.approvals } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.setTimer ? { setTimer: opts.setTimer } : {}),
    ...(opts.notifyAfterMs !== undefined ? { notifyAfterMs: opts.notifyAfterMs } : {}),
  });
  if (tableExists(ctx, 'server_request')) {
    // Nobody waits for a request left pending by a restart (docs/06 invariant 11).
    const expired = await service.recover();
    if (expired) log.info('expired requests left pending by a restart', { count: expired });
  } else {
    log.warn('server_request table missing: requests are unavailable until migration 0019');
  }
  const status = new ThreadStatusService({ db: ctx.db, events: ctx.events, log });
  const stopStatus = status.start(ctx.events.bus);
  // New approvals also go to clients that declared the `approval` kind.
  const offApprovals = ctx.events.bus.subscribe('approval.requested', (e) => {
    const approvalId = e.payload.approvalId;
    if (!e.accountId || typeof approvalId !== 'string') return;
    service
      .announceApproval(e.accountId, approvalId)
      .catch((err: unknown) => log.warn('could not push an approval to clients', { err }));
  });

  const sessions = new Map<string, ClientSession>();
  const threadMode = (accountId: string, threadId: string) => {
    const row = ctx.db.raw
      .prepare('SELECT mode FROM thread WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
      .get(threadId, accountId) as { mode: string } | undefined;
    return Promise.resolve(row?.mode ?? null);
  };
  const runOf = (turnId: string): string | null => {
    const row = ctx.db.raw.prepare('SELECT run_id FROM turn WHERE id = ?').get(turnId) as
      { run_id: string | null } | undefined;
    return row?.run_id ?? null;
  };
  const tools = requestToolSource([
    userAskTool({
      broker: service,
      threadMode,
      runOf,
      // An unanswered question waits as long as an approval (docs/09 §12).
      timeoutMs: async (projectId) =>
        (await ctx.setting('policy.approvalTimeoutMinutes', projectId)) * 60_000,
    }),
  ]);

  ctx.diagnostics.add('requests', () =>
    Promise.resolve({ waiting: service.pending, clients: service.clients }),
  );

  function clientSession(accountId: string, id: string | null | undefined): ClientSession | null {
    if (!id) return null;
    const s = sessions.get(id);
    return s?.accountId === accountId ? s : null;
  }

  function hello(input: { accountId: string; deviceId: string | null; serverRequests: unknown }) {
    const asked = Array.isArray(input.serverRequests) ? input.serverRequests : [];
    const kinds = REQUEST_KINDS.filter((k) => asked.includes(k));
    const clientSessionId = randomUUID();
    sessions.set(clientSessionId, { accountId: input.accountId, deviceId: input.deviceId, kinds });
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    return { serverRequests: kinds, clientSessionId };
  }

  const sessionOf = (req: FastifyRequest, accountId: string) => {
    const header = req.headers[CLIENT_SESSION_HEADER];
    return clientSession(accountId, typeof header === 'string' ? header : null);
  };

  function register(app: FastifyInstance): void {
    app.get('/api/v1/requests', async (req) => {
      const accountId = await ctx.accountOf(req);
      const q = listQuery.parse(req.query);
      const session = sessionOf(req, accountId);
      return {
        items: await service.list(accountId, {
          status: q.status,
          ...(q.threadId ? { threadId: q.threadId } : {}),
          // A client named by its handshake sees no request aimed at another device.
          ...(session ? { deviceId: session.deviceId } : {}),
        }),
      };
    });

    app.get('/api/v1/requests/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      return service.get(accountId, params.parse(req.params).id);
    });

    app.post('/api/v1/requests/:id/respond', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      const body = respondRequestSchema.parse(req.body ?? {});
      const session = sessionOf(req, accountId);
      return service.respond(accountId, id, body.result, {
        by: 'user',
        deviceId: session?.deviceId ?? null,
      });
    });
  }

  return {
    service,
    status,
    tools,
    hello,
    clientSession,
    attachClient: (input) => {
      const session = clientSession(input.accountId, input.clientSessionId);
      return service.attachClient({
        accountId: input.accountId,
        deviceId: session?.deviceId ?? input.deviceId,
        kinds: session?.kinds ?? [...(input.kinds ?? [])],
        send: input.send,
      });
    },
    useNotifier: (n) => service.useNotifier(n),
    useApprovals: (a) => service.useApprovals(a),
    useStatusSources: (...s) => status.useSources(...s),
    register,
    close: async () => {
      stopStatus();
      offApprovals();
      await service.close();
    },
  };
}
