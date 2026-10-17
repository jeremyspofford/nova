// The derived thread status (FR-215, docs/09 §9): needs_input > blocked > running > ready, child
// threads count for needs_input and running, and `thread.status.changed` is emitted when an
// approval, request, turn, run or goal event changes a thread's status.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, makeEvent, type EventEnvelope, type NewEvent } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { ThreadStatusService } from '../src/requests/index.ts';
import type { EventSink } from '../src/events.ts';
import type { ThreadStatusSource } from '../src/runtime/types.ts';
import { openRequestsDb } from './requests-db.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const T = (n: number) => `01920000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;
const NOW = '2026-10-17T10:00:00.000Z';

let db: NovaDatabase;
let bus: EventBus;
let emitted: EventEnvelope[];
let svc: ThreadStatusService;
let blocked: Map<string, string>;
let children: Map<string, string[]>;

/** Publishes on the bus like the EventStore, and records what the service emits. */
const sink: EventSink = {
  emit: <P extends Record<string, unknown>>(e: NewEvent<P>) => {
    const env = makeEvent(e);
    emitted.push(env);
    bus.publish(env);
    return Promise.resolve(env);
  },
  emitEphemeral: () => undefined,
};

const source: ThreadStatusSource = {
  blocked: (_a, ids) => Promise.resolve(new Map([...blocked].filter(([id]) => ids.includes(id)))),
  children: (_a, id) => Promise.resolve(children.get(id) ?? []),
};

function thread(id: string, parent: string | null = null) {
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, parent_thread_id, created_at, updated_at) VALUES (?, ?, 'work', 'idle', ?, ?, ?)",
    )
    .run(id, ACCOUNT, parent, NOW, NOW);
}

let turns = 0;
function turn(threadId: string, status: 'in_progress' | 'completed' | 'failed') {
  turns++;
  const idx = (
    db.raw.prepare('SELECT COUNT(*) AS n FROM turn WHERE thread_id = ?').get(threadId) as {
      n: number;
    }
  ).n;
  const id = `turn-${turns}`;
  db.raw
    .prepare(
      `INSERT INTO turn (id, thread_id, idx, status, trigger, execution_location, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', 'hub', ?, ?, ?, ?)`,
    )
    .run(id, threadId, idx, status, NOW, status === 'in_progress' ? null : NOW, NOW, NOW);
  return id;
}

let approvals = 0;
function approval(threadId: string, decision: string | null = null) {
  approvals++;
  const id = `appr-${approvals}`;
  db.raw
    .prepare(
      `INSERT INTO approval (id, account_id, thread_id, requested_action, options_json, status, decision, created_at)
       VALUES (?, ?, ?, 'Run a command', '[]', 'pending', ?, ?)`,
    )
    .run(id, ACCOUNT, threadId, decision, NOW);
  return id;
}

function request(threadId: string, kind = 'user_input') {
  db.raw
    .prepare(
      `INSERT INTO server_request (id, account_id, kind, thread_id, payload_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, '{}', 'pending', ?, ?)`,
    )
    .run(`req-${threadId}-${kind}`, ACCOUNT, kind, threadId, NOW, '2026-10-18T10:00:00.000Z');
}

beforeEach(async () => {
  db = await openRequestsDb();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, NOW, NOW);
  bus = new EventBus();
  emitted = [];
  blocked = new Map();
  children = new Map();
  svc = new ThreadStatusService({ db, events: sink });
  svc.useSources(source);
});

afterEach(() => {
  svc.stop();
  db.close();
});

const status = async (...ids: string[]) => Object.fromEntries(await svc.statusOf(ACCOUNT, ids));

describe('statusOf (FR-215)', () => {
  it('derives each status in precedence order', async () => {
    for (let i = 1; i <= 7; i++) thread(T(i));
    // 1: a pending approval beats everything else.
    approval(T(1));
    turn(T(1), 'in_progress');
    blocked.set(T(1), 'Budget reached');
    // 2: a handed-off step; 3: a question.
    approval(T(2), 'handoff');
    request(T(3));
    // 4: blocked by a mode beats running; 5: the last turn failed.
    blocked.set(T(4), 'Goal blocked');
    turn(T(4), 'in_progress');
    turn(T(5), 'completed');
    turn(T(5), 'failed');
    // 6: running; 7: a failed turn followed by a good one is ready.
    turn(T(6), 'in_progress');
    turn(T(7), 'failed');
    turn(T(7), 'completed');
    expect(await status(T(1), T(2), T(3), T(4), T(5), T(6), T(7), 'unknown')).toEqual({
      [T(1)]: { status: 'needs_input', reason: 'Approval needed' },
      [T(2)]: { status: 'needs_input', reason: 'Your turn' },
      [T(3)]: { status: 'needs_input', reason: 'Question for you' },
      [T(4)]: { status: 'blocked', reason: 'Goal blocked' },
      [T(5)]: { status: 'blocked', reason: 'Last turn failed' },
      [T(6)]: { status: 'running', reason: null },
      [T(7)]: { status: 'ready', reason: null },
      unknown: { status: 'ready', reason: null },
    });
    expect(await svc.statusOf(ACCOUNT, [])).toEqual(new Map());
  });

  it('counts child threads for needs input and running, but not for blocked', async () => {
    for (let i = 1; i <= 6; i++) thread(T(i));
    children.set(T(1), [T(2)]);
    children.set(T(2), [T(3)]);
    request(T(3), 'elicitation');
    children.set(T(4), [T(5)]);
    turn(T(5), 'in_progress');
    children.set(T(6), [T(6), T(5)]);
    blocked.set(T(5), 'Budget reached');
    expect(await status(T(1), T(2), T(4), T(6))).toEqual({
      [T(1)]: { status: 'needs_input', reason: 'A sub-agent needs you' },
      [T(2)]: { status: 'needs_input', reason: 'A sub-agent needs you' },
      [T(4)]: { status: 'running', reason: null },
      [T(6)]: { status: 'running', reason: null },
    });
    expect((await status(T(3)))[T(3)]).toEqual({
      status: 'needs_input',
      reason: 'Waiting for you',
    });
  });

  it('ignores a failing source and works without any', async () => {
    thread(T(1));
    turn(T(1), 'in_progress');
    svc.useSources({
      blocked: () => Promise.reject(new Error('runs down')),
      children: () => Promise.reject(new Error('runs down')),
    });
    expect((await status(T(1)))[T(1)]!.status).toBe('running');
    const bare = new ThreadStatusService({ db, events: sink });
    expect((await bare.statusOf(ACCOUNT, [T(1)])).get(T(1))!.status).toBe('running');
  });
});

describe('thread.status.changed', () => {
  const publish = (
    name: string,
    correlation: Record<string, string> | undefined,
    payload: Record<string, unknown> = {},
  ) =>
    bus.publish(
      makeEvent({
        name,
        accountId: ACCOUNT,
        actor: 'system',
        ...(correlation ? { correlation } : {}),
        payload,
      }),
    );
  const changes = () =>
    emitted
      .filter((e) => e.name === 'thread.status.changed')
      .map((e) => [
        (e.payload.ref as { id: string }).id,
        e.payload.from,
        e.payload.status,
        e.payload.reason,
      ]);

  it('follows a thread through running, needs input and ready, and updates its parent', async () => {
    thread(T(1));
    thread(T(2), T(1));
    children.set(T(1), [T(2)]);
    svc.start(bus);
    const t = turn(T(2), 'in_progress');
    publish('turn.started', undefined, { threadId: T(2), turnId: t });
    await svc.idle();
    const id = approval(T(2));
    publish('approval.requested', { threadId: T(2) }, { approvalId: id });
    await svc.idle();
    db.raw
      .prepare("UPDATE approval SET status = 'decided', decision = 'allow_once' WHERE id = ?")
      .run(id);
    publish('approval.decided', { threadId: T(2) }, { approvalId: id });
    // Nothing changed for an unrelated event or one without a thread.
    publish('approval.decided', undefined, {});
    publish('request.created', { threadId: T(2) }, {});
    await svc.idle();
    db.raw.prepare("UPDATE turn SET status = 'completed', ended_at = ? WHERE id = ?").run(NOW, t);
    publish('turn.completed', { threadId: T(2) }, { threadId: T(2) });
    await svc.idle();
    expect(changes()).toEqual([
      [T(2), 'ready', 'running', null],
      [T(1), 'ready', 'running', null],
      [T(2), 'running', 'needs_input', 'Approval needed'],
      [T(1), 'running', 'needs_input', 'A sub-agent needs you'],
      [T(2), 'needs_input', 'running', null],
      [T(1), 'needs_input', 'running', null],
      [T(2), 'running', 'ready', null],
      [T(1), 'running', 'ready', null],
    ]);
    const first = emitted.find((e) => e.name === 'thread.status.changed')!;
    expect(first.correlation).toEqual({ threadId: T(2) });
  });

  it('maps run and goal events to their thread, and stops listening', async () => {
    thread(T(1));
    svc.start(bus);
    db.raw
      .prepare(
        `INSERT INTO run (id, account_id, thread_id, title, objective, status, pause_reason, created_at, updated_at)
         VALUES ('run-1', ?, ?, 'Run', 'Do it', 'paused', 'budget_time', ?, ?)`,
      )
      .run(ACCOUNT, T(1), NOW, NOW);
    blocked.set(T(1), 'Budget reached');
    publish('run.status.changed', undefined, { runId: 'run-1', from: 'running', to: 'paused' });
    publish('goal.status.changed', undefined, { goalId: 'missing' });
    publish('run.status.changed', undefined, { runId: 42 });
    bus.publish(makeEvent({ name: 'turn.started', actor: 'system', payload: { threadId: T(1) } }));
    await svc.idle();
    expect(changes()).toEqual([[T(1), 'ready', 'blocked', 'Budget reached']]);
    svc.stop();
    blocked.clear();
    publish('run.status.changed', undefined, { runId: 'run-1' });
    await svc.idle();
    expect(changes()).toHaveLength(1);
  });

  it('refreshes on demand without emitting when nothing changed', async () => {
    thread(T(1));
    await svc.refresh(ACCOUNT, [T(1)]);
    expect(changes()).toEqual([]);
    approval(T(1));
    await svc.refresh(ACCOUNT, [T(1)]);
    await svc.refresh(ACCOUNT, [T(1)]);
    expect(changes()).toEqual([[T(1), 'ready', 'needs_input', 'Approval needed']]);
  });
});
