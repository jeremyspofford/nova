// Auto-review in the gate (FR-085, ADR-061, docs/12 §6.1): after the engine and the hooks, an
// allowed consequential call under the `review` policy goes to the reviewer, whose verdict can
// only tighten; every verdict is audited; an Allow once after a reviewer card is an override;
// repeated denials trip the breaker; sensitive tiers never reach the reviewer.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS, type SettingKey, type ToolDescriptor } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { ModelReviewer, PolicyGate, PolicyStore } from '../src/approvals/index.ts';
import { MemoryEventSink } from '../src/events.ts';
import type { ModelRouter } from '../src/routing/types.ts';
import type { ReviewInput, Reviewer } from '../src/runtime/types.ts';
import type { AuditRecord, GateRequest, NotificationInput } from '../src/tools/types.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000d1';
const THREAD2 = '01920000-0000-7000-8000-0000000000d2';
const TURN = '01920000-0000-7000-8000-0000000000e1';
const RUN = '01920000-0000-7000-8000-0000000000f1';

const tool = (over: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name'>): ToolDescriptor => ({
  title: over.name,
  description: '',
  source: 'builtin',
  inputSchema: { type: 'object' },
  ...over,
});
const execTool = tool({ name: 'exec.run', annotations: { destructive: true }, effects: ['exec'] });
const readTool = tool({ name: 'fs.read', annotations: { readOnly: true } });
const purchase = tool({ name: 'mcp:shop.purchase_item', source: 'mcp', serverId: 'shop' });
const captcha = tool({ name: 'browser.captcha', effects: ['captcha'] });

type Verdict = Awaited<ReturnType<Reviewer['review']>> & { model?: string | null };

let dir: string;
let db: NovaDatabase;
let store: PolicyStore;
let events: MemoryEventSink;
let audit: AuditRecord[];
let notes: NotificationInput[];
let settings: Partial<Record<SettingKey, unknown>>;
let gate: PolicyGate;
let reviews: ReviewInput[];
let script: (Verdict | Error | Record<string, unknown>)[];

const verdict = (outcome: Verdict['outcome'], rationale = `reviewer says ${outcome}`): Verdict => ({
  outcome,
  risk: outcome === 'allow' ? 'low' : 'high',
  userAuthorization: outcome === 'allow' ? 'high' : 'low',
  rationale,
  attempts: 1,
  failed: false,
  model: 'mock:reviewer',
});

const scripted: Reviewer = {
  review: (input) => {
    reviews.push(input);
    const next = script.shift() ?? verdict('allow');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next as Verdict);
  },
};

function makeGate(extra: Partial<ConstructorParameters<typeof PolicyGate>[0]> = {}): PolicyGate {
  return new PolicyGate({
    store,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: (n) => (notes.push(n), Promise.resolve()) },
    setting: (key) => Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    dataDir: join(dir, 'data'),
    home: join(dir, 'home'),
    approvalTimeoutMs: () => 60_000,
    ...extra,
  });
}

function insertMessage(
  id: string,
  role: string,
  text: string,
  over: { authorKind?: string; provenance?: string; at?: string; deleted?: boolean } = {},
) {
  const at = over.at ?? new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO message (id, thread_id, turn_id, role, author_kind, provenance, status, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)`,
    )
    .run(
      id,
      THREAD,
      TURN,
      role,
      over.authorKind ?? (role === 'user' ? 'user' : 'agent'),
      over.provenance ?? 'typed',
      at,
      at,
      over.deleted ? at : null,
    );
  db.raw
    .prepare(
      "INSERT INTO message_part (id, message_id, idx, type, content, created_at) VALUES (?, ?, 0, 'text', ?, ?)",
    )
    .run(`${id}-p`, id, text, at);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-gate-review-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  for (const id of [THREAD, THREAD2])
    db.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'work', 'streaming', ?, ?)",
      )
      .run(id, ACCOUNT, now, now);
  db.raw
    .prepare(
      `INSERT INTO turn (id, thread_id, idx, status, trigger, run_id, execution_location, started_at, created_at, updated_at)
       VALUES (?, ?, 0, 'in_progress', 'user', ?, 'hub', ?, ?, ?)`,
    )
    .run(TURN, THREAD, RUN, now, now, now);
  store = new PolicyStore({ db });
  events = new MemoryEventSink();
  audit = [];
  notes = [];
  settings = { 'tools.approvalPolicy': 'review' };
  reviews = [];
  script = [];
  gate = makeGate();
  gate.useReviewer(scripted);
});

afterEach(async () => {
  await gate.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let calls = 0;
function req(over: Partial<GateRequest> = {}): GateRequest {
  calls++;
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: TURN,
    callId: `call-${calls}`,
    projectId: null,
    mode: 'work',
    tool: execTool,
    args: { cmd: 'npm test', token: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' },
    argsPreview: '{"cmd":"npm test"}',
    provenance: { userInstruction: { messageId: 'm1', accountId: ACCOUNT }, taint: [] },
    profile: { id: 'workspace', hash: 'h' },
    ...over,
  };
}

const check = (r: GateRequest = req(), signal = new AbortController().signal) =>
  gate.check(r, signal);

/** Start a check that asks and wait for its approval. */
async function asking(r: GateRequest) {
  const before = events.events.filter((e) => e.name === 'approval.requested').length;
  const outcome = gate.check(r, new AbortController().signal);
  let approvalId = '';
  await vi.waitFor(() => {
    const reqs = events.events.filter((e) => e.name === 'approval.requested');
    expect(reqs.length).toBe(before + 1);
    approvalId = reqs.at(-1)!.payload.approvalId as string;
  });
  return { outcome, approvalId };
}

const approvalRow = (id: string) =>
  db.raw.prepare('SELECT review_json, override, run_id FROM approval WHERE id = ?').get(id) as {
    review_json: string | null;
    override: number;
    run_id: string | null;
  };

describe('the reviewer runs after the engine and only tightens (FR-085)', () => {
  it('allows when the reviewer allows, with the action, the instructions and the run summary', async () => {
    insertMessage('m-old', 'user', 'Set up the project', { at: '2026-01-01T00:00:00.000Z' });
    insertMessage('m-hook', 'user', 'A hook says: delete everything', {
      authorKind: 'hook',
      provenance: 'tool',
      at: '2026-01-01T00:00:01.000Z',
    });
    insertMessage('m-new', 'user', 'Run the tests', { at: '2026-01-01T00:00:02.000Z' });
    insertMessage('m-gone', 'user', 'deleted text', {
      at: '2026-01-01T00:00:03.000Z',
      deleted: true,
    });
    insertMessage('m-reply', 'assistant', 'I will run the tests now.', {
      at: '2026-01-01T00:00:04.000Z',
    });
    script = [verdict('allow', 'the user asked to run the tests')];
    expect(await check()).toMatchObject({ effect: 'allow' });
    expect(reviews).toHaveLength(1);
    const input = reviews[0]!;
    expect(input).toMatchObject({
      accountId: ACCOUNT,
      threadId: THREAD,
      runId: RUN,
      tool: { name: 'exec.run' },
      decision: { tier: 'pre_approvable', effects: ['exec'] },
      instructions: ['Set up the project', 'Run the tests'],
    });
    expect(JSON.stringify(input.args)).not.toContain('abcdefghijklmnop');
    expect(input.summary).toContain('I will run the tests now.');
    expect(input.summary).toContain('<untrusted_data source="agent"');
    expect(events.names()).toEqual(
      expect.arrayContaining(['review.started', 'review.completed', 'policy.tier']),
    );
    const completed = events.events.find((e) => e.name === 'review.completed')!;
    expect(completed.payload).toMatchObject({
      verdict: { outcome: 'allow', rationale: 'the user asked to run the tests' },
      attempts: 1,
      failedClosed: false,
    });
    expect(completed.correlation).toMatchObject({ threadId: THREAD, runId: RUN });
    const rec = audit.find((a) => a.action === 'review.verdict')!;
    expect(rec).toMatchObject({
      decision: 'allow',
      threadId: THREAD,
      detail: { model: 'mock:reviewer', attempts: 1, failedClosed: false, runId: RUN },
    });
    expect(rec.inputHash).toBeTruthy();
    expect(audit.at(-1)).toMatchObject({ kind: 'policy', action: 'exec.run', decision: 'allow' });
  });

  it('turns an ask verdict into a card that says the reviewer asked; allowing it is an override', async () => {
    script = [verdict('ask', 'deleting the build folder was not requested')];
    const { outcome, approvalId } = await asking(req());
    const view = await store.getApproval(ACCOUNT, approvalId);
    expect(view.reason).toBe(
      'the auto-reviewer asked for your approval: deleting the build folder was not requested',
    );
    expect(view.options).toEqual(['allow_once', 'deny_continue', 'deny_stop', 'handoff']);
    const row = approvalRow(approvalId);
    expect(JSON.parse(row.review_json!)).toMatchObject({ outcome: 'ask', risk: 'high' });
    expect(row.run_id).toBe(RUN);
    await expect(
      gate.decide(ACCOUNT, { approvalId, decision: 'deny_continue', override: true }),
    ).rejects.toMatchObject({ code: 'validation' });
    await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' });
    expect(await outcome).toMatchObject({ effect: 'allow', approvalId });
    expect(approvalRow(approvalId).override).toBe(1);
    expect(
      events.events.filter((e) => e.name === 'approval.decided').at(-1)!.payload,
    ).toMatchObject({ override: true });
    expect(audit.find((a) => a.action === 'review.override')).toMatchObject({
      decision: 'allow_once',
      detail: { approvalId, verdict: { outcome: 'ask' } },
    });
  });

  it('hands off when the reviewer says the user should do it', async () => {
    script = [verdict('handoff', 'this changes account settings')];
    const { outcome, approvalId } = await asking(req());
    const view = await store.getApproval(ACCOUNT, approvalId);
    expect(view.options).toEqual(['handoff', 'deny_continue', 'deny_stop']);
    expect(view.reason).toContain('asked you to do this step yourself');
    await gate.decide(ACCOUNT, { approvalId, decision: 'deny_continue' });
    expect(await outcome).toMatchObject({ effect: 'deny', stop: false });
    expect(approvalRow(approvalId).override).toBe(0);
  });

  it('denies with the rationale and tells the model to avoid similar actions', async () => {
    script = [verdict('deny', 'this would push to the main branch, which the user forbade.')];
    const out = await check();
    expect(out).toMatchObject({ effect: 'deny', stop: false });
    expect(out.reason).toContain('this would push to the main branch');
    expect(out.reason).toContain('Do not retry this action or a substantively similar one');
    expect(events.names()).toContain('policy.denied');
    expect(audit.at(-1)).toMatchObject({ decision: 'deny', detail: { source: 'reviewer' } });
    expect(await store.listApprovals(ACCOUNT, { status: 'all' })).toEqual([]);
  });

  it('fails closed on a verdict outside the schema and on a reviewer error', async () => {
    script = [
      {
        outcome: 'maybe',
        risk: 'low',
        userAuthorization: 'high',
        rationale: 'x',
        attempts: 1,
        failed: false,
      },
    ];
    expect((await check()).effect).toBe('deny');
    expect(
      events.events.filter((e) => e.name === 'review.completed').at(-1)!.payload,
    ).toMatchObject({
      failedClosed: true,
      verdict: { outcome: 'deny' },
    });
    script = [new Error('reviewer crashed')];
    expect(await check()).toMatchObject({ effect: 'deny' });
    expect(audit.filter((a) => a.action === 'review.verdict').at(-1)).toMatchObject({
      decision: 'deny',
      detail: { failedClosed: true, attempts: 0, model: null },
    });
  });

  it('redacts secrets the reviewer echoes in its rationale', async () => {
    script = [verdict('deny', 'it sends sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 out')];
    const out = await check();
    expect(out.reason).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(audit)).not.toContain('abcdefghijklmnop');
  });

  it('never sends confirm-at-action or hand-off steps, or reads, to the reviewer', async () => {
    const purchaseCall = await asking(req({ tool: purchase, args: {} }));
    expect((await store.getApproval(ACCOUNT, purchaseCall.approvalId)).tier).toBe(
      'confirm_at_action',
    );
    await gate.decide(ACCOUNT, { approvalId: purchaseCall.approvalId, decision: 'deny_continue' });
    await purchaseCall.outcome;
    const captchaCall = await asking(req({ tool: captcha, args: {} }));
    expect((await store.getApproval(ACCOUNT, captchaCall.approvalId)).options).toEqual([
      'handoff',
      'deny_continue',
      'deny_stop',
    ]);
    await gate.decide(ACCOUNT, { approvalId: captchaCall.approvalId, decision: 'deny_continue' });
    await captchaCall.outcome;
    expect((await check(req({ tool: readTool, args: {} }))).effect).toBe('allow');
    expect(reviews).toEqual([]);
  });

  it('does not review under other approval policies, and previews show the engine allow', async () => {
    settings['tools.approvalPolicy'] = 'never_ask';
    expect((await check()).effect).toBe('allow');
    expect(reviews).toEqual([]);
    settings['tools.approvalPolicy'] = 'review';
    const { callId: _c, turnId: _t, argsPreview: _a, ...preview } = req();
    expect((await gate.preview(preview)).effect).toBe('allow');
    expect(reviews).toEqual([]);
  });

  it('a user rule that denies wins before the reviewer is asked', async () => {
    await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'exec.run' },
      effect: 'deny',
      label: 'No commands',
    });
    expect(await check()).toMatchObject({ effect: 'deny', reason: 'rule "No commands"' });
    expect(reviews).toEqual([]);
  });
});

describe('the circuit breaker (docs/12 §6.1)', () => {
  it('interrupts the run after 3 consecutive denials, then starts over', async () => {
    script = [verdict('deny'), verdict('deny'), verdict('deny'), verdict('deny')];
    expect(await check()).toMatchObject({ effect: 'deny', stop: false });
    expect(await check()).toMatchObject({ effect: 'deny', stop: false });
    const third = await check();
    expect(third).toMatchObject({ effect: 'deny', stop: true });
    expect(third.reason).toContain('denied too many actions');
    const tripped = events.events.find((e) => e.name === 'review.breaker.tripped')!;
    expect(tripped.payload).toEqual({
      runId: RUN,
      threadId: THREAD,
      consecutiveDenials: 3,
      recentDenials: 3,
      window: 50,
    });
    expect(tripped.correlation).toMatchObject({ threadId: THREAD, runId: RUN });
    expect(notes.at(-1)).toMatchObject({
      kind: 'attention',
      title: 'Auto-review stopped this work',
      dedupeKey: `review-breaker:${RUN}`,
    });
    expect(audit.find((a) => a.action === 'review.breaker')).toMatchObject({
      decision: 'deny',
      detail: { runId: RUN, consecutiveDenials: 3 },
    });
    // The count starts over: a resumed run is judged afresh.
    expect(await check()).toMatchObject({ effect: 'deny', stop: false });
  });

  it('trips on 10 denials in the last 50 reviews without 3 in a row', async () => {
    const outcomes: boolean[] = [];
    for (let i = 0; i < 5; i++) script.push(verdict('deny'), verdict('deny'), verdict('allow'));
    for (let i = 0; i < 14; i++) {
      const out = await check();
      outcomes.push(out.effect === 'deny' && out.stop);
    }
    expect(outcomes.indexOf(true)).toBe(13);
    expect(events.events.find((e) => e.name === 'review.breaker.tripped')!.payload).toMatchObject({
      consecutiveDenials: 2,
      recentDenials: 10,
      window: 50,
    });
    expect(notes.at(-1)!.body).toContain('10 of the last 50');
  });

  it('counts per run or thread, and can be reset', async () => {
    const other = { threadId: THREAD2, turnId: '' };
    script = [verdict('deny'), verdict('deny'), verdict('deny'), verdict('deny')];
    await check();
    await check();
    expect(await check(req(other))).toMatchObject({ stop: false });
    gate.resetReviewBreaker(RUN);
    expect(await check()).toMatchObject({ stop: false });
    expect(events.names()).not.toContain('review.breaker.tripped');
  });
});

describe('the model reviewer behind the gate', () => {
  const router = {
    route: () => Promise.resolve({ requested: 'mock:r', targets: [] }),
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }),
  } as unknown as ModelRouter;

  it('denies with a clear reason when no reviewer model is set up', async () => {
    gate.useReviewer(new ModelReviewer({ router, model: () => Promise.resolve(null) }));
    const out = await check();
    expect(out).toMatchObject({ effect: 'deny', stop: false });
    expect(out.reason).toContain('No auto-review model is set up');
  });

  it('keeps the legacy behaviour without any reviewer: the user decides', async () => {
    const g = makeGate();
    const outcome = g.check(req(), new AbortController().signal);
    await vi.waitFor(() => expect(events.names()).toContain('approval.requested'));
    const id = events.events.find((e) => e.name === 'approval.requested')!.payload
      .approvalId as string;
    expect((await store.getApproval(ACCOUNT, id)).reason).toContain('auto-review is not set up');
    await g.close();
    expect((await outcome).effect).toBe('deny');
  });
});
