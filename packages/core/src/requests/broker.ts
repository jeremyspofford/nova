// Server-to-client requests (FR-188, ADR-072; docs/09 §9, contracts/hub-api.md §5,
// contracts/schemas/server-request.json). The Hub asks connected clients a question over the
// stream they hold: a `request.created` event for every stream (SSE clients answer with
// POST /requests/:id/respond) and a `request` frame for each WebSocket client that declared the
// kind in its handshake (a `client_tool` request with a target goes to that device only). Each
// request has one id, a timeout and exactly one resolution: the first valid answer wins, a later
// one is `conflict` with the winning resolution, and an answer after `expiresAt` is
// `request_expired`. A request nobody can answer, or nobody answers soon, falls back to a
// notification (FR-060, deduplicated per request). Cancelling the turn expires its requests.
// Approvals keep their own flow (FR-100): they are listed here as `approval` requests, pushed to
// clients that declared that kind, and answered through the approvals service.
import { z } from 'zod';
import {
  NovaError,
  decideApprovalSchema,
  uuidv7,
  type ApprovalView,
  type DecideApprovalRequest,
  type ServerRequestKind,
  type ServerRequestView,
} from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AskInput, AskResult, RequestBroker } from '../runtime/types.ts';
import type { NotificationInput, Notifier } from '../tools/types.ts';
import { requestPayload, requestResult } from './validate.ts';

/** With a capable client connected, an unanswered request is notified after this long. */
export const REQUEST_NOTIFY_AFTER_MS = 2 * 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 7 * 86_400_000;

export type ExpiredReason = 'timeout' | 'cancelled' | 'restart';

interface RequestRow {
  id: string;
  account_id: string;
  kind: ServerRequestKind;
  thread_id: string | null;
  turn_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  call_id: string | null;
  approval_id: string | null;
  target_device_id: string | null;
  payload_json: string;
  status: 'pending' | 'resolved' | 'expired';
  resolved_by: string | null;
  resolved_by_device: string | null;
  resolution_json: string | null;
  expired_reason: ExpiredReason | null;
  notified_at: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

/** A connected WebSocket client (contracts/hub-api.md §5 "WebSocket frames"). */
export interface RequestClient {
  accountId: string;
  /** The device or client session; a `client_tool` request may name it as its target. */
  deviceId: string | null;
  /** The request kinds the client declared in its handshake (`serverRequests`). */
  kinds: readonly ServerRequestKind[];
  /** Send one JSON frame; a throw counts as not delivered. */
  send(frame: Record<string, unknown>): void;
}

export interface RequestConnection {
  detach(): void;
  /**
   * Handle an inbound frame. Returns true when it was a `respond` frame (answered with a
   * `respond.ack`, or an `error` frame when the answer is invalid), false for any other frame.
   */
  handle(frame: unknown): Promise<boolean>;
}

/** The approvals flow, for the `approval` mirror and answers sent as requests. */
export interface ApprovalRequests {
  /** Pending approvals, newest first (a handed-off one stays pending until marked done). */
  pending(accountId: string, threadId?: string): Promise<ApprovalView[]>;
  get(accountId: string, approvalId: string): Promise<ApprovalView>;
  decide(accountId: string, body: DecideApprovalRequest, decidedBy: string): Promise<ApprovalView>;
}

export interface RequestServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  notifier?: Notifier;
  approvals?: ApprovalRequests;
  log?: Logger;
  now?: () => Date;
  /** Start a timer; returns its cancel (tests drive a simulated clock). */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** How long a delivered request may wait before it is also notified. */
  notifyAfterMs?: number;
}

interface Waiter {
  threadId: string | null;
  settle(r: AskResult): void;
}

const respondFrame = z
  .object({
    type: z.literal('respond'),
    requestId: z.string().min(1).max(100),
    result: z.unknown(),
  })
  .strict();

function defaultTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function parse(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function correlationOf(r: RequestRow): ServerRequestView['correlation'] {
  const c: ServerRequestView['correlation'] = {};
  if (r.thread_id) c.threadId = r.thread_id;
  if (r.turn_id) c.turnId = r.turn_id;
  if (r.run_id) c.runId = r.run_id;
  if (r.call_id) c.callId = r.call_id;
  if (r.approval_id) c.approvalId = r.approval_id;
  return c;
}

export function requestView(r: RequestRow): ServerRequestView {
  return {
    id: r.id,
    kind: r.kind,
    correlation: correlationOf(r),
    targetDeviceId: r.target_device_id,
    status: r.status,
    payload: (parse(r.payload_json) ?? {}) as Record<string, unknown>,
    resolution:
      r.status === 'resolved' && r.resolved_at
        ? { by: r.resolved_by ?? 'user', at: r.resolved_at, result: parse(r.resolution_json) }
        : null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** A pending approval as a read-only `approval` request (contracts/schemas/server-request.json). */
export function approvalRequestView(a: ApprovalView): ServerRequestView {
  const correlation: ServerRequestView['correlation'] = { approvalId: a.id };
  if (a.threadId) correlation.threadId = a.threadId;
  if (a.turnId) correlation.turnId = a.turnId;
  if (a.callId) correlation.callId = a.callId;
  const payload: Record<string, unknown> = {
    approvalId: a.id,
    action: clip(a.action, 500),
    reason: clip(a.reason, 2000),
    tier: a.tier,
    options: a.options,
    alwaysScopes: [...new Set(a.alwaysScopes.map((s) => s.kind))],
    // Confirm-at-action and hand-off steps are answered only in a Nova client (FR-189).
    nativeClientOnly: a.tier !== 'pre_approvable',
  };
  if (a.risk) payload.risk = a.risk;
  return {
    id: a.id,
    kind: 'approval',
    correlation,
    targetDeviceId: null,
    status: 'pending',
    payload,
    resolution: null,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  };
}

/** `request.created`: the request without resolution (contracts/events.md). */
function createdPayload(v: ServerRequestView): Record<string, unknown> {
  const p: Record<string, unknown> = {
    requestId: v.id,
    kind: v.kind,
    correlation: v.correlation,
    payload: v.payload,
    expiresAt: v.expiresAt,
  };
  if (v.targetDeviceId) p.targetDeviceId = v.targetDeviceId;
  return p;
}

function conflict(v: ServerRequestView): NovaError {
  return new NovaError('conflict', 'this request was already answered', {
    details: { status: v.status, resolution: v.resolution },
  });
}

function expired(r: RequestRow): NovaError {
  return new NovaError('request_expired', 'this request has expired', {
    details: { status: 'expired', reason: r.expired_reason ?? 'timeout' },
  });
}

export class RequestService implements RequestBroker {
  readonly #o: RequestServiceOptions;
  readonly #db: NovaDatabase;
  readonly #waiters = new Map<string, Waiter>();
  readonly #waitingThreads = new Map<string, number>();
  readonly #clients = new Set<RequestClient>();
  #notifier: Notifier | undefined;
  #approvals: ApprovalRequests | undefined;

  constructor(opts: RequestServiceOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#notifier = opts.notifier;
    this.#approvals = opts.approvals;
  }

  /** Wire the notifications fallback (FR-060). */
  useNotifier(notifier: Notifier): void {
    this.#notifier = notifier;
  }

  /** Wire the approvals flow for the `approval` mirror (FR-100). */
  useApprovals(approvals: ApprovalRequests): void {
    this.#approvals = approvals;
  }

  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  #timer(fn: () => void, ms: number): () => void {
    return (this.#o.setTimer ?? defaultTimer)(fn, ms);
  }

  /** Requests waiting in this process. */
  get pending(): number {
    return this.#waiters.size;
  }

  /** Connected clients (diagnostics). */
  get clients(): number {
    return this.#clients.size;
  }

  /**
   * Nobody waits for a request left pending by a restart: record it as expired and put threads
   * left waiting for input back to idle. Returns how many requests expired.
   */
  async recover(): Promise<number> {
    const now = this.#now().toISOString();
    return this.#db.transaction(() => {
      const res = this.#db.raw
        .prepare(
          `UPDATE server_request SET status = 'expired', expired_reason = 'restart', resolved_at = ?
           WHERE status = 'pending'`,
        )
        .run(now);
      this.#db.raw.prepare("UPDATE thread SET state = 'idle' WHERE state = 'waiting_input'").run();
      return Number(res.changes);
    });
  }

  // ---- asking ---------------------------------------------------------------------------------

  async ask(input: AskInput, signal: AbortSignal): Promise<AskResult> {
    if (signal.aborted) return { status: 'cancelled' };
    const payload = requestPayload(input.kind, input.payload);
    const now = this.#now();
    const timeoutMs = Math.min(
      Math.max(Math.floor(input.timeoutMs), MIN_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );
    const c = input.correlation;
    const row: RequestRow = {
      id: uuidv7(),
      account_id: input.accountId,
      kind: input.kind,
      thread_id: c.threadId ?? null,
      turn_id: c.turnId ?? null,
      run_id: c.runId ?? null,
      agent_id: null,
      call_id: c.callId ?? null,
      approval_id: null,
      target_device_id: input.targetDeviceId ?? null,
      payload_json: JSON.stringify(payload),
      status: 'pending',
      resolved_by: null,
      resolved_by_device: null,
      resolution_json: null,
      expired_reason: null,
      notified_at: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
      resolved_at: null,
    };
    let settled = false;
    let resolveDone!: (r: AskResult) => void;
    const done = new Promise<AskResult>((resolve) => {
      resolveDone = resolve;
    });
    this.#waiters.set(row.id, {
      threadId: row.thread_id,
      settle: (r) => {
        if (settled) return;
        settled = true;
        resolveDone(r);
      },
    });
    const cancels: (() => void)[] = [];
    const onAbort = () => void this.#expire(row.id, 'cancelled');
    let waiting = false;
    try {
      await this.#insert(row);
      if (row.thread_id) {
        await this.#enterWaiting(row.thread_id);
        waiting = true;
      }
      const view = requestView(row);
      await this.#o.events.emit({
        name: 'request.created',
        accountId: row.account_id,
        actor: 'system',
        correlation: this.#eventCorrelation(row),
        payload: createdPayload(view),
      });
      if (this.#deliver(view, row.account_id) === 0) await this.#fallback(row.id);
      else
        cancels.push(
          this.#timer(
            () => void this.#fallback(row.id),
            this.#o.notifyAfterMs ?? REQUEST_NOTIFY_AFTER_MS,
          ),
        );
      cancels.push(this.#timer(() => void this.#expire(row.id, 'timeout'), timeoutMs));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      return await done;
    } catch (err) {
      // Whatever went wrong, the request must not stay pending with nobody waiting.
      await this.#expire(row.id, 'cancelled').catch(() => undefined);
      throw err;
    } finally {
      for (const cancel of cancels) cancel();
      signal.removeEventListener('abort', onAbort);
      this.#waiters.delete(row.id);
      if (waiting && row.thread_id) await this.#leaveWaiting(row.thread_id);
    }
  }

  async #insert(r: RequestRow): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO server_request (id, account_id, kind, thread_id, turn_id, run_id, agent_id,
             call_id, approval_id, target_device_id, payload_json, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          r.id,
          r.account_id,
          r.kind,
          r.thread_id,
          r.turn_id,
          r.run_id,
          r.agent_id,
          r.call_id,
          r.approval_id,
          r.target_device_id,
          r.payload_json,
          r.created_at,
          r.expires_at,
        );
    });
  }

  #eventCorrelation(r: RequestRow): Record<string, string> {
    const c: Record<string, string> = {};
    if (r.thread_id) c.threadId = r.thread_id;
    if (r.turn_id) c.turnId = r.turn_id;
    if (r.run_id) c.runId = r.run_id;
    if (r.call_id) c.callId = r.call_id;
    return c;
  }

  /** The thread waits for input while a request of its turn is pending (docs/06 thread.state). */
  async #enterWaiting(threadId: string): Promise<void> {
    const n = (this.#waitingThreads.get(threadId) ?? 0) + 1;
    this.#waitingThreads.set(threadId, n);
    if (n === 1)
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare("UPDATE thread SET state = 'waiting_input' WHERE id = ? AND state = 'streaming'")
          .run(threadId);
      });
  }

  async #leaveWaiting(threadId: string): Promise<void> {
    const n = (this.#waitingThreads.get(threadId) ?? 1) - 1;
    if (n > 0) {
      this.#waitingThreads.set(threadId, n);
      return;
    }
    this.#waitingThreads.delete(threadId);
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare("UPDATE thread SET state = 'streaming' WHERE id = ? AND state = 'waiting_input'")
        .run(threadId);
    });
  }

  // ---- clients --------------------------------------------------------------------------------

  /**
   * Attach a WebSocket client. Every request still pending that it may answer is sent again at
   * once (a reconnect resumes, contracts/hub-api.md §5); new ones follow as they are created.
   */
  attachClient(client: RequestClient): RequestConnection {
    this.#clients.add(client);
    void this.#resend(client).catch((err: unknown) =>
      this.#o.log?.warn('could not re-send pending requests', { err }),
    );
    return {
      detach: () => {
        this.#clients.delete(client);
      },
      handle: (frame) => this.#handleFrame(client, frame),
    };
  }

  async #resend(client: RequestClient): Promise<void> {
    const views = await this.list(client.accountId, {
      status: 'pending',
      deviceId: client.deviceId,
    });
    // Oldest first, as they were asked.
    for (const v of views.reverse()) if (this.#accepts(client, v)) this.#send(client, v);
  }

  #accepts(client: RequestClient, v: ServerRequestView): boolean {
    if (!client.kinds.includes(v.kind)) return false;
    return v.targetDeviceId === null || v.targetDeviceId === client.deviceId;
  }

  #send(client: RequestClient, v: ServerRequestView): boolean {
    try {
      client.send({ type: 'request', request: v });
      return true;
    } catch (err) {
      this.#o.log?.warn('could not send a request to a client', { err, requestId: v.id });
      return false;
    }
  }

  /** Push a request to every capable client of its account; returns how many got it. */
  #deliver(v: ServerRequestView, accountId: string): number {
    let n = 0;
    for (const client of this.#clients)
      if (client.accountId === accountId && this.#accepts(client, v) && this.#send(client, v)) n++;
    return n;
  }

  /** An approval was requested: push it to clients that declared `approval` (FR-188). */
  async announceApproval(accountId: string, approvalId: string): Promise<number> {
    if (!this.#approvals) return 0;
    const a = await this.#approvals.get(accountId, approvalId);
    if (a.status !== 'pending') return 0;
    return this.#deliver(approvalRequestView(a), accountId);
  }

  async #handleFrame(client: RequestClient, frame: unknown): Promise<boolean> {
    if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== 'respond')
      return false;
    const f = respondFrame.safeParse(frame);
    const requestId =
      typeof (frame as { requestId?: unknown }).requestId === 'string'
        ? (frame as { requestId: string }).requestId
        : null;
    if (!f.success) {
      this.#reply(client, {
        type: 'error',
        requestId,
        error: { code: 'validation', message: 'a respond frame needs requestId and result' },
      });
      return true;
    }
    try {
      await this.respond(client.accountId, f.data.requestId, f.data.result, {
        deviceId: client.deviceId,
      });
      this.#reply(client, { type: 'respond.ack', requestId: f.data.requestId, status: 'resolved' });
    } catch (err) {
      if (err instanceof NovaError && err.code === 'conflict')
        this.#reply(client, {
          type: 'respond.ack',
          requestId: f.data.requestId,
          status: 'conflict',
          resolution: err.details?.resolution ?? null,
        });
      else if (err instanceof NovaError && err.code === 'request_expired')
        this.#reply(client, {
          type: 'respond.ack',
          requestId: f.data.requestId,
          status: 'expired',
        });
      else {
        const body =
          err instanceof NovaError
            ? err.toJSON()
            : { code: 'server_error', message: 'the answer could not be recorded' };
        if (!(err instanceof NovaError))
          this.#o.log?.error('answering a request failed', { err, requestId });
        this.#reply(client, { type: 'error', requestId: f.data.requestId, error: body });
      }
    }
    return true;
  }

  #reply(client: RequestClient, frame: Record<string, unknown>): void {
    try {
      client.send(frame);
    } catch {
      // The socket is gone; the answer (if any) is already recorded.
    }
  }

  // ---- answering ------------------------------------------------------------------------------

  #row(accountId: string, id: string): RequestRow | null {
    const r = this.#db.raw
      .prepare('SELECT * FROM server_request WHERE id = ? AND account_id = ?')
      .get(id, accountId) as RequestRow | undefined;
    return r ?? null;
  }

  #rowAny(id: string): RequestRow | null {
    const r = this.#db.raw.prepare('SELECT * FROM server_request WHERE id = ?').get(id) as
      RequestRow | undefined;
    return r ?? null;
  }

  async get(accountId: string, id: string): Promise<ServerRequestView> {
    const row = this.#row(accountId, id);
    if (row) return requestView(row);
    if (this.#approvals) {
      const a = await this.#approvals.get(accountId, id).catch(() => null);
      if (a?.status === 'pending') return approvalRequestView(a);
    }
    throw new NovaError('not_found', 'request not found');
  }

  /**
   * Answer a request (POST /requests/:id/respond, a WebSocket `respond` frame). The first valid
   * answer wins; a later one is `conflict` with the winning resolution, one after `expiresAt` is
   * `request_expired`, an invalid one is `validation`.
   */
  async respond(
    accountId: string,
    id: string,
    result: unknown,
    who: { by?: string; deviceId?: string | null } = {},
  ): Promise<ServerRequestView> {
    const by = who.by ?? 'user';
    const deviceId = who.deviceId ?? null;
    const row = this.#row(accountId, id);
    if (!row) return this.#respondApproval(accountId, id, result, by);
    if (row.status === 'resolved') throw conflict(requestView(row));
    if (row.status === 'expired') throw expired(row);
    if (Date.parse(row.expires_at) <= this.#now().getTime()) {
      await this.#expire(row.id, 'timeout');
      const now = this.#row(accountId, id);
      if (now?.status === 'resolved') throw conflict(requestView(now));
      throw expired(now ?? row);
    }
    if (row.target_device_id && row.target_device_id !== deviceId)
      throw new NovaError('policy_denied', 'this request is for another device');
    if (row.kind === 'approval')
      throw new NovaError('validation', 'answer approvals through the approvals flow');
    const payload = (parse(row.payload_json) ?? {}) as Record<string, unknown>;
    const value = requestResult(row.kind, payload, result);
    // Stored and broadcast redacted; the waiting turn gets the answer itself.
    const stored = defaultRedactor.redact(value);
    const at = this.#now().toISOString();
    const changed = await this.#db.transaction(() => {
      const res = this.#db.raw
        .prepare(
          `UPDATE server_request SET status = 'resolved', resolved_by = ?, resolved_by_device = ?,
             resolution_json = ?, resolved_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(by, deviceId, JSON.stringify(stored), at, row.id);
      return Number(res.changes) > 0;
    });
    const after = this.#row(accountId, id) ?? row;
    if (!changed) {
      if (after.status === 'resolved') throw conflict(requestView(after));
      throw expired(after);
    }
    await this.#o.events.emit({
      name: 'request.resolved',
      accountId,
      actor: by === 'user' ? 'user' : 'system',
      correlation: this.#eventCorrelation(row),
      payload: { requestId: row.id, kind: row.kind, resolvedBy: by, deviceId, result: stored },
    });
    this.#waiters.get(row.id)?.settle({ status: 'resolved', result: value, by });
    return requestView(after);
  }

  /** An approval answered as a request: validated and decided by the approvals flow. */
  async #respondApproval(
    accountId: string,
    id: string,
    result: unknown,
    by: string,
  ): Promise<ServerRequestView> {
    const approvals = this.#approvals;
    if (!approvals) throw new NovaError('not_found', 'request not found');
    const before = await approvals.get(accountId, id).catch(() => null);
    if (!before) throw new NovaError('not_found', 'request not found');
    const body = decideApprovalSchema.safeParse({
      ...(result && typeof result === 'object' ? result : {}),
      approvalId: id,
    });
    if (!body.success)
      throw new NovaError('validation', 'the answer is not a valid approval decision', {
        details: { issues: body.error.issues.map((i) => i.message) },
      });
    if (before.status === 'expired')
      throw new NovaError('request_expired', 'this approval expired');
    const decided = await approvals.decide(accountId, body.data, by);
    return {
      ...approvalRequestView(before),
      status: decided.status === 'expired' ? 'expired' : 'resolved',
      resolution: {
        by: decided.decidedBy ?? by,
        at: decided.decidedAt ?? this.#now().toISOString(),
        result: { approvalId: id, decision: decided.decision },
      },
    };
  }

  /** Expire a pending request (timeout, the turn was cancelled); settles its waiter. */
  async #expire(id: string, reason: ExpiredReason): Promise<void> {
    const at = this.#now().toISOString();
    const changed = await this.#db.transaction(() => {
      const res = this.#db.raw
        .prepare(
          `UPDATE server_request SET status = 'expired', expired_reason = ?, resolved_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(reason, at, id);
      return Number(res.changes) > 0;
    });
    const row = this.#rowAny(id);
    if (changed && row) {
      try {
        await this.#o.events.emit({
          name: 'request.expired',
          accountId: row.account_id,
          actor: 'system',
          correlation: this.#eventCorrelation(row),
          payload: {
            requestId: id,
            kind: row.kind,
            fallback: row.notified_at ? 'notification' : 'none',
            reason,
          },
        });
      } catch (err) {
        this.#o.log?.error('recording a request expiry failed', { err, requestId: id });
      }
    }
    // A request answered at the same moment keeps its answer.
    if (row?.status === 'resolved') return;
    this.#waiters.get(id)?.settle({ status: reason === 'cancelled' ? 'cancelled' : 'expired' });
  }

  /** The notification fallback (FR-060): once per request, while it is still pending. */
  async #fallback(id: string): Promise<void> {
    const notifier = this.#notifier;
    if (!notifier) return;
    const at = this.#now().toISOString();
    const claimed = await this.#db.transaction(() => {
      const res = this.#db.raw
        .prepare(
          `UPDATE server_request SET notified_at = ?
           WHERE id = ? AND status = 'pending' AND notified_at IS NULL`,
        )
        .run(at, id);
      return Number(res.changes) > 0;
    });
    const row = claimed ? this.#rowAny(id) : null;
    if (!row) return;
    await notifier
      .notify({ accountId: row.account_id, ...notificationFor(row) })
      .catch((err: unknown) => this.#o.log?.warn('request notification failed', { err }));
  }

  // ---- listing --------------------------------------------------------------------------------

  /**
   * Requests of an account, newest first: pending ones (or all, last 200), without those aimed
   * at another device, plus pending approvals as read-only `approval` items.
   */
  async list(
    accountId: string,
    q: { status?: 'pending' | 'all'; threadId?: string; deviceId?: string | null } = {},
  ): Promise<ServerRequestView[]> {
    const where = ['account_id = ?'];
    const args: string[] = [accountId];
    if ((q.status ?? 'pending') === 'pending') where.push("status = 'pending'");
    if (q.threadId) {
      where.push('thread_id = ?');
      args.push(q.threadId);
    }
    if (q.deviceId !== undefined) {
      where.push('(target_device_id IS NULL OR target_device_id = ?)');
      args.push(q.deviceId ?? '');
    }
    const rows = this.#db.raw
      .prepare(
        `SELECT * FROM server_request WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT 200`,
      )
      .all(...args) as unknown as RequestRow[];
    const out = rows.map(requestView);
    if (this.#approvals) {
      try {
        const approvals = await this.#approvals.pending(accountId, q.threadId);
        out.push(...approvals.map(approvalRequestView));
      } catch (err) {
        this.#o.log?.warn('pending approvals unavailable for the request list', { err });
      }
      out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    }
    return out;
  }

  /** Expire every request still waiting in this process (Hub shutdown). */
  async close(): Promise<void> {
    await Promise.all([...this.#waiters.keys()].map((id) => this.#expire(id, 'cancelled')));
    this.#clients.clear();
  }
}

/** What the fallback notification says for each kind. */
function notificationFor(r: RequestRow): Omit<NotificationInput, 'accountId'> {
  const p = (parse(r.payload_json) ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? clip(v, 200) : undefined);
  const href = r.thread_id ? `/chat/${r.thread_id}?request=${r.id}` : `/requests/${r.id}`;
  const base = { href, dedupeKey: `request:${r.id}` };
  switch (r.kind) {
    case 'user_input': {
      const body = text(p.question);
      return {
        kind: 'attention',
        title: 'Nova has a question for you',
        ...base,
        ...(body ? { body } : {}),
      };
    }
    case 'elicitation': {
      const body = text(p.message);
      return {
        kind: 'attention',
        title: 'A connected server needs information',
        ...base,
        ...(body ? { body } : {}),
      };
    }
    case 'client_tool':
      return { kind: 'attention', title: 'A device action is waiting', ...base };
    case 'credential_refresh': {
      const body = text(p.reason);
      return {
        kind: 'attention',
        title: 'Sign in again to keep things working',
        ...base,
        ...(body ? { body } : {}),
      };
    }
    default:
      return { kind: 'attention', title: 'Nova is waiting for you', ...base };
  }
}
