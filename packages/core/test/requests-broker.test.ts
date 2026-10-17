// Server-to-client requests (FR-188, contracts/hub-api.md §5): one resolution per request (the
// first valid answer wins, a later one is conflict, after expiry request_expired), kind
// filtering and device targets, the notification fallback, cancellation, restart recovery,
// WebSocket frames and the read-only approval mirror.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NovaError, type ApprovalView, type DecideApprovalRequest } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { MemoryEventSink } from '../src/events.ts';
import {
  RequestService,
  requestPayload,
  requestResult,
  type ApprovalRequests,
  type RequestClient,
} from '../src/requests/index.ts';
import type { AskInput } from '../src/runtime/types.ts';
import type { NotificationInput } from '../src/tools/types.ts';
import { openRequestsDb } from './requests-db.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const OTHER = '01920000-0000-7000-8000-000000000002';
const THREAD = '01920000-0000-7000-8000-0000000000a1';

let db: NovaDatabase;
let events: MemoryEventSink;
let notes: NotificationInput[];
let clock: { now: number };
let timers: { fn: () => void; ms: number; live: boolean }[];
let svc: RequestService;

function setTimer(fn: () => void, ms: number) {
  const t = { fn, ms, live: true };
  timers.push(t);
  return () => {
    t.live = false;
  };
}

/** Fire the live timers set for exactly `ms`. */
function fire(ms: number) {
  for (const t of timers.filter((x) => x.live && x.ms === ms)) {
    t.live = false;
    t.fn();
  }
}

function make(extra: Partial<ConstructorParameters<typeof RequestService>[0]> = {}) {
  return new RequestService({
    db,
    events,
    notifier: { notify: (n) => (notes.push(n), Promise.resolve()) },
    now: () => new Date(clock.now),
    setTimer,
    notifyAfterMs: 120_000,
    ...extra,
  });
}

beforeEach(async () => {
  db = await openRequestsDb();
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'work', 'streaming', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  events = new MemoryEventSink();
  notes = [];
  clock = { now: Date.parse('2026-10-17T10:00:00.000Z') };
  timers = [];
  svc = make();
});

afterEach(async () => {
  await svc.close();
  db.close();
});

function client(over: Partial<RequestClient> = {}) {
  const frames: Record<string, unknown>[] = [];
  const c: RequestClient = {
    accountId: ACCOUNT,
    deviceId: 'web-1',
    kinds: ['user_input', 'approval'],
    send: (f) => frames.push(f),
    ...over,
  };
  return { c, frames };
}

const question = (over: Partial<AskInput> = {}): AskInput => ({
  accountId: ACCOUNT,
  kind: 'user_input',
  correlation: { threadId: THREAD, turnId: 'turn-1', callId: 'call-1' },
  payload: { question: 'Which branch?', choices: ['main', 'dev'] },
  timeoutMs: 3_600_000,
  ...over,
});

/** Ask and wait until the request exists. */
async function asking(input = question(), signal = new AbortController().signal) {
  const before = events.events.filter((e) => e.name === 'request.created').length;
  const result = svc.ask(input, signal);
  let id = '';
  await vi.waitFor(() => {
    const created = events.events.filter((e) => e.name === 'request.created');
    expect(created.length).toBe(before + 1);
    id = created.at(-1)!.payload.requestId as string;
  });
  return { result, id };
}

const threadState = () =>
  (db.raw.prepare('SELECT state FROM thread WHERE id = ?').get(THREAD) as { state: string }).state;

describe('asking and answering', () => {
  it('pushes to capable clients, waits for input and resolves with the first valid answer', async () => {
    const web = client();
    const cli = client({ kinds: ['approval'] });
    const stranger = client({ accountId: OTHER });
    svc.attachClient(web.c);
    svc.attachClient(cli.c);
    svc.attachClient(stranger.c);
    const { result, id } = await asking();
    const created = events.events.find((e) => e.name === 'request.created')!;
    expect(created.payload).toMatchObject({
      requestId: id,
      kind: 'user_input',
      correlation: { threadId: THREAD, turnId: 'turn-1', callId: 'call-1' },
      payload: { question: 'Which branch?', choices: ['main', 'dev'] },
      expiresAt: '2026-10-17T11:00:00.000Z',
    });
    expect(created.payload).not.toHaveProperty('targetDeviceId');
    expect(created.correlation).toMatchObject({ threadId: THREAD });
    expect(web.frames).toEqual([
      { type: 'request', request: expect.objectContaining({ id, status: 'pending' }) },
    ]);
    expect(cli.frames).toEqual([]);
    expect(stranger.frames).toEqual([]);
    expect(threadState()).toBe('waiting_input');
    expect(svc.pending).toBe(1);
    // Delivered: the notification waits for the fallback delay.
    expect(notes).toEqual([]);

    const view = await svc.respond(ACCOUNT, id, { choice: 'dev' }, { deviceId: 'web-1' });
    expect(view).toMatchObject({
      status: 'resolved',
      resolution: { by: 'user', result: { choice: 'dev' } },
    });
    expect(await result).toEqual({ status: 'resolved', result: { choice: 'dev' }, by: 'user' });
    expect(events.events.find((e) => e.name === 'request.resolved')!.payload).toEqual({
      requestId: id,
      kind: 'user_input',
      resolvedBy: 'user',
      deviceId: 'web-1',
      result: { choice: 'dev' },
    });
    expect(threadState()).toBe('streaming');
    // A later answer gets the winning resolution.
    const late = await svc
      .respond(ACCOUNT, id, { choice: 'main' })
      .catch((e: unknown) => e as NovaError);
    expect(late).toMatchObject({
      code: 'conflict',
      details: { resolution: { by: 'user', result: { choice: 'dev' } } },
    });
    fire(120_000);
    expect(notes).toEqual([]);
  });

  it('rejects invalid answers and keeps the request open', async () => {
    const { result, id } = await asking();
    await expect(svc.respond(ACCOUNT, id, { choice: 'staging' })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(svc.respond(ACCOUNT, id, { text: '   ' })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(svc.respond(ACCOUNT, id, 'dev')).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.respond(OTHER, id, { choice: 'dev' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await svc.get(ACCOUNT, id)).status).toBe('pending');
    await svc.respond(ACCOUNT, id, { text: '  feature/x  ' });
    expect(await result).toMatchObject({ status: 'resolved', result: { text: 'feature/x' } });
  });

  it('refuses a payload its kind does not allow, before anything is stored', async () => {
    await expect(
      svc.ask(question({ payload: { question: '' } }), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      svc.ask(question({ payload: { question: 'x', extra: 1 } }), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(await svc.list(ACCOUNT, { status: 'all' })).toEqual([]);
  });

  it('returns at once when the turn is already cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await svc.ask(question(), ac.signal)).toEqual({ status: 'cancelled' });
  });
});

describe('expiry, cancellation and fallback', () => {
  it('expires at the timeout: request.expired, and a late answer gets request_expired', async () => {
    const { result, id } = await asking(question({ timeoutMs: 60_000 }));
    // No capable client: notified at once, once.
    expect(notes).toEqual([
      expect.objectContaining({
        kind: 'attention',
        title: 'Nova has a question for you',
        body: 'Which branch?',
        href: `/chat/${THREAD}?request=${id}`,
        dedupeKey: `request:${id}`,
      }),
    ]);
    fire(60_000);
    expect(await result).toEqual({ status: 'expired' });
    expect(events.events.find((e) => e.name === 'request.expired')!.payload).toEqual({
      requestId: id,
      kind: 'user_input',
      fallback: 'notification',
      reason: 'timeout',
    });
    await expect(svc.respond(ACCOUNT, id, { choice: 'dev' })).rejects.toMatchObject({
      code: 'request_expired',
    });
    expect(threadState()).toBe('streaming');
    expect(notes).toHaveLength(1);
  });

  it('treats an answer after expiresAt as expired even before the timer runs', async () => {
    const { result, id } = await asking(question({ timeoutMs: 60_000 }));
    clock.now += 61_000;
    await expect(svc.respond(ACCOUNT, id, { choice: 'dev' })).rejects.toMatchObject({
      code: 'request_expired',
    });
    expect(await result).toEqual({ status: 'expired' });
  });

  it('notifies after the delay when a capable client got it but nobody answered', async () => {
    svc.attachClient(client().c);
    const { result, id } = await asking();
    expect(notes).toEqual([]);
    fire(120_000);
    await vi.waitFor(() => expect(notes).toHaveLength(1));
    fire(120_000);
    await svc.respond(ACCOUNT, id, { choice: 'main' });
    await result;
    expect(notes).toHaveLength(1);
  });

  it('expires the request when the turn is cancelled', async () => {
    const ac = new AbortController();
    const { result, id } = await asking(question(), ac.signal);
    ac.abort();
    expect(await result).toEqual({ status: 'cancelled' });
    expect(events.events.find((e) => e.name === 'request.expired')!.payload).toMatchObject({
      requestId: id,
      reason: 'cancelled',
    });
    await expect(svc.respond(ACCOUNT, id, { choice: 'dev' })).rejects.toMatchObject({
      code: 'request_expired',
      details: { reason: 'cancelled' },
    });
  });

  it('expires waiting requests on close and recovers rows left pending by a restart', async () => {
    const first = await asking();
    await svc.close();
    expect(await first.result).toEqual({ status: 'cancelled' });
    // A crash: the row stays pending with nobody waiting.
    db.raw
      .prepare(
        `INSERT INTO server_request (id, account_id, kind, thread_id, payload_json, status, created_at, expires_at)
         VALUES ('stale', ?, 'user_input', ?, '{"question":"q"}', 'pending', ?, ?)`,
      )
      .run(ACCOUNT, THREAD, '2026-10-17T09:00:00.000Z', '2026-10-18T09:00:00.000Z');
    db.raw.prepare("UPDATE thread SET state = 'waiting_input' WHERE id = ?").run(THREAD);
    const next = make();
    expect(await next.recover()).toBe(1);
    expect(await next.get(ACCOUNT, 'stale')).toMatchObject({ status: 'expired' });
    // Clients still showing the question learn it is gone.
    expect(
      events.events.find((e) => e.name === 'request.expired' && e.payload.requestId === 'stale')
        ?.payload,
    ).toMatchObject({
      requestId: 'stale',
      reason: 'restart',
    });
    expect(threadState()).toBe('idle');
    await next.close();
  });

  it('works without a notifier', async () => {
    svc = make({ notifier: undefined });
    const { result, id } = await asking();
    await svc.respond(ACCOUNT, id, { choice: 'dev' });
    expect((await result).status).toBe('resolved');
    svc.useNotifier({ notify: (n) => (notes.push(n), Promise.resolve()) });
    await asking();
    expect(notes).toHaveLength(1);
  });
});

describe('kinds and devices', () => {
  it('sends a client tool to its target device only, and only that device may answer', async () => {
    const target = client({ deviceId: 'mac-1', kinds: ['client_tool'] });
    const other = client({ deviceId: 'web-1', kinds: ['client_tool'] });
    svc.attachClient(target.c);
    svc.attachClient(other.c);
    const { result, id } = await asking(
      question({
        kind: 'client_tool',
        payload: { tool: 'clipboard.read', args: {} },
        targetDeviceId: 'mac-1',
      }),
    );
    expect(target.frames).toHaveLength(1);
    expect(other.frames).toEqual([]);
    expect(await svc.list(ACCOUNT, { deviceId: 'web-1' })).toEqual([]);
    expect(await svc.list(ACCOUNT, { deviceId: 'mac-1' })).toHaveLength(1);
    await expect(
      svc.respond(ACCOUNT, id, { ok: true, output: 'x' }, { deviceId: 'web-1' }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await svc.respond(ACCOUNT, id, { ok: true, output: { text: 'copied' } }, { deviceId: 'mac-1' });
    expect(await result).toMatchObject({ status: 'resolved', result: { ok: true } });
  });

  it('validates elicitation, client tool and credential refresh answers', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        size: { type: 'number' },
        ok: { type: 'boolean' },
        tier: { type: 'string', enum: ['free', 'pro'] },
        any: {},
      },
      required: ['name'],
    };
    const payload = requestPayload('elicitation', {
      serverId: 'linear',
      message: 'Your team?',
      requestedSchema: schema,
    });
    expect(
      requestResult('elicitation', payload, {
        action: 'accept',
        content: { name: 'A', age: 3, size: 1.5, ok: true, tier: 'pro', any: 'x' },
      }),
    ).toMatchObject({ action: 'accept' });
    expect(requestResult('elicitation', payload, { action: 'decline' })).toEqual({
      action: 'decline',
    });
    for (const bad of [
      { action: 'accept', content: {} },
      { action: 'accept', content: { name: 'A', age: 1.5 } },
      { action: 'accept', content: { name: 1 } },
      { action: 'accept', content: { name: 'A', size: 'big' } },
      { action: 'accept', content: { name: 'A', ok: 'yes' } },
      { action: 'accept', content: { name: 'A', tier: 'gold' } },
      { action: 'accept', content: { name: 'A', unknown: 1 } },
      { action: 'cancel', content: { name: 'A' } },
      { action: 'maybe' },
    ])
      expect(() => requestResult('elicitation', payload, bad)).toThrow(NovaError);
    expect(() =>
      requestResult(
        'elicitation',
        { requestedSchema: null },
        { action: 'accept', content: { x: 1 } },
      ),
    ).toThrow(/does not ask for x/);
    expect(
      requestResult('client_tool', {}, { ok: false, error: { message: 'denied by the user' } }),
    ).toMatchObject({ ok: false });
    expect(() => requestResult('client_tool', {}, { ok: true, output: null })).not.toThrow();
    expect(() => requestResult('client_tool', {}, { ok: 'yes' })).toThrow(NovaError);
    expect(requestResult('credential_refresh', {}, { refreshed: true })).toEqual({
      refreshed: true,
    });
    expect(() => requestResult('credential_refresh', {}, {})).toThrow(NovaError);
    expect(requestResult('user_input', { question: 'q' }, { text: 'free text' })).toEqual({
      text: 'free text',
    });
    expect(() =>
      requestResult('user_input', { choices: ['a'], allowFreeText: false }, { text: 'b' }),
    ).toThrow(/pick one/);
    expect(() =>
      requestPayload('credential_refresh', { targetKind: 'provider_account', targetId: 'p1' }),
    ).not.toThrow();
  });

  it('names each kind in its notification', async () => {
    for (const [kind, payload, title] of [
      [
        'elicitation',
        { serverId: 's', message: 'Pick a team', requestedSchema: {} },
        'A connected server needs information',
      ],
      ['client_tool', { tool: 't', args: {} }, 'A device action is waiting'],
      [
        'credential_refresh',
        { targetKind: 'connector', targetId: 'c', reason: 'Token expired' },
        'Sign in again to keep things working',
      ],
    ] as const) {
      await asking(question({ kind, payload, correlation: {} }));
      expect(notes.at(-1)).toMatchObject({ title, href: expect.stringMatching(/^\/requests\//) });
    }
  });
});

describe('WebSocket frames', () => {
  it('re-sends pending requests on attach and answers respond frames with an ack', async () => {
    const first = await asking();
    const web = client();
    const conn = svc.attachClient(web.c);
    await vi.waitFor(() => expect(web.frames).toHaveLength(1));
    expect(web.frames[0]).toMatchObject({ type: 'request', request: { id: first.id } });
    expect(await conn.handle({ type: 'ping' })).toBe(false);
    expect(await conn.handle('nope')).toBe(false);
    expect(await conn.handle({ type: 'respond', requestId: first.id })).toBe(true);
    expect(web.frames.at(-1)).toMatchObject({ type: 'error', error: { code: 'validation' } });
    await conn.handle({ type: 'respond', requestId: first.id, result: { choice: 'nope' } });
    expect(web.frames.at(-1)).toMatchObject({
      type: 'error',
      requestId: first.id,
      error: { code: 'validation' },
    });
    await conn.handle({ type: 'respond', requestId: first.id, result: { choice: 'main' } });
    expect(web.frames.at(-1)).toEqual({
      type: 'respond.ack',
      requestId: first.id,
      status: 'resolved',
    });
    expect(await first.result).toMatchObject({ status: 'resolved', by: 'user' });
    expect(events.events.find((e) => e.name === 'request.resolved')!.payload.deviceId).toBe(
      'web-1',
    );
    await conn.handle({ type: 'respond', requestId: first.id, result: { choice: 'dev' } });
    expect(web.frames.at(-1)).toMatchObject({
      type: 'respond.ack',
      status: 'conflict',
      resolution: { result: { choice: 'main' } },
    });
    const second = await asking(question({ timeoutMs: 1_000 }));
    fire(1_000);
    await second.result;
    await conn.handle({ type: 'respond', requestId: second.id, result: { choice: 'dev' } });
    expect(web.frames.at(-1)).toMatchObject({ type: 'respond.ack', status: 'expired' });
    conn.detach();
    expect(svc.clients).toBe(0);
  });

  it('survives a client whose socket is gone', async () => {
    svc.attachClient(
      client({
        send: () => {
          throw new Error('closed');
        },
      }).c,
    );
    const { result, id } = await asking();
    // Not delivered anywhere: notified at once.
    expect(notes).toHaveLength(1);
    await svc.respond(ACCOUNT, id, { choice: 'dev' });
    await result;
  });
});

describe('the approval mirror', () => {
  const approval: ApprovalView = {
    id: 'appr-1',
    threadId: THREAD,
    turnId: 'turn-1',
    callId: 'call-9',
    action: 'Run `npm publish`',
    tool: 'exec.run',
    argsPreview: '{}',
    reason: 'the default for exec.run is to ask',
    tier: 'pre_approvable',
    risk: 'medium',
    userAsked: true,
    ruleId: null,
    options: ['allow_once', 'allow_session', 'deny_continue', 'deny_stop', 'handoff'],
    alwaysScopes: [{ kind: 'tool', label: 'x', tool: 'exec.run' }],
    status: 'pending',
    decision: null,
    decidedBy: null,
    createdAt: '2026-10-17T09:59:00.000Z',
    expiresAt: '2026-10-18T09:59:00.000Z',
    decidedAt: null,
  };

  function approvals(): ApprovalRequests & { decided: DecideApprovalRequest[] } {
    const decided: DecideApprovalRequest[] = [];
    let current: ApprovalView = { ...approval };
    return {
      decided,
      pending: () => Promise.resolve(current.status === 'pending' ? [current] : []),
      get: (_a, id) =>
        id === current.id
          ? Promise.resolve(current)
          : Promise.reject(new NovaError('not_found', 'approval not found')),
      decide: (_a, body, by) => {
        if (current.decision) return Promise.reject(new NovaError('conflict', 'answered'));
        decided.push(body);
        current = {
          ...current,
          status: 'decided',
          decision: body.decision,
          decidedBy: by,
          decidedAt: '2026-10-17T10:00:00.000Z',
        };
        return Promise.resolve(current);
      },
    };
  }

  it('lists pending approvals as read-only approval requests and answers them through the approvals flow', async () => {
    const src = approvals();
    svc.useApprovals(src);
    const { id } = await asking();
    const list = await svc.list(ACCOUNT);
    expect(list.map((r) => r.kind)).toEqual(['user_input', 'approval']);
    expect(list[1]).toMatchObject({
      id: 'appr-1',
      kind: 'approval',
      correlation: { approvalId: 'appr-1', threadId: THREAD, callId: 'call-9' },
      payload: {
        approvalId: 'appr-1',
        tier: 'pre_approvable',
        risk: 'medium',
        alwaysScopes: ['tool'],
        nativeClientOnly: false,
      },
    });
    expect((await svc.get(ACCOUNT, 'appr-1')).kind).toBe('approval');
    await expect(svc.respond(ACCOUNT, 'appr-1', { decision: 'maybe' })).rejects.toMatchObject({
      code: 'validation',
    });
    const view = await svc.respond(ACCOUNT, 'appr-1', { decision: 'allow_once' });
    expect(view).toMatchObject({
      status: 'resolved',
      resolution: { by: 'user', result: { approvalId: 'appr-1', decision: 'allow_once' } },
    });
    expect(src.decided).toEqual([{ approvalId: 'appr-1', decision: 'allow_once' }]);
    await expect(
      svc.respond(ACCOUNT, 'appr-1', { decision: 'deny_continue' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(svc.respond(ACCOUNT, 'nothing', {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.get(ACCOUNT, 'nothing')).rejects.toMatchObject({ code: 'not_found' });
    await svc.respond(ACCOUNT, id, { choice: 'dev' });
  });

  it('pushes a new approval to clients that declared the approval kind', async () => {
    svc.useApprovals(approvals());
    const web = client();
    const cli = client({ kinds: ['user_input'] });
    svc.attachClient(web.c);
    svc.attachClient(cli.c);
    await vi.waitFor(() => expect(web.frames).toHaveLength(1));
    web.frames.length = 0;
    expect(await svc.announceApproval(ACCOUNT, 'appr-1')).toBe(1);
    expect(web.frames).toEqual([
      { type: 'request', request: expect.objectContaining({ id: 'appr-1', kind: 'approval' }) },
    ]);
    expect(cli.frames).toEqual([]);
    expect(await make().announceApproval(ACCOUNT, 'appr-1')).toBe(0);
  });

  it('keeps listing requests when the approvals flow fails', async () => {
    svc.useApprovals({
      pending: () => Promise.reject(new Error('locked')),
      get: () => Promise.reject(new Error('locked')),
      decide: () => Promise.reject(new Error('locked')),
    });
    await asking();
    expect(await svc.list(ACCOUNT, { status: 'all', threadId: THREAD })).toHaveLength(1);
    await expect(svc.respond(ACCOUNT, 'appr-x', {})).rejects.toMatchObject({ code: 'not_found' });
  });
});
