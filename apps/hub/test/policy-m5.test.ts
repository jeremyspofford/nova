/* eslint-disable @typescript-eslint/require-await */
// The policy area's M5 wiring (FR-063, FR-085): per-thread policy through `useThreadPolicy`, the
// default auto-reviewer on `review.model` through the router (deny without one), `useReviewer`,
// and the approvals flow the requests area mirrors.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NovaError, SETTINGS, type SettingKey, type ToolDescriptor } from '@nova/shared';
import type { AuditRecord, GateRequest, ModelRouter, NotificationInput } from '@nova/core';
import type { StreamEvent } from '@nova/providers';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import { setupPolicy, type PolicyAreaFull } from '../src/policy.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000a1';

const execTool: ToolDescriptor = {
  name: 'exec.run',
  title: 'Run command',
  description: 'Run a command in the sandbox',
  source: 'builtin',
  inputSchema: { type: 'object' },
  annotations: { destructive: true },
  effects: ['exec'],
};

let dir: string;
let db: NovaDatabase;
let events: EventStore;
let settings: Partial<Record<SettingKey, unknown>>;
let audit: AuditRecord[];
let routed: string[];
let reply: string;
let area: PolicyAreaFull;

const router = {
  route: (_accountId: string, ref: string) => {
    routed.push(ref);
    return Promise.resolve({ requested: ref, targets: [] });
  },
  stream: () =>
    (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', text: reply };
      yield { type: 'stop', reason: 'end' };
    })(),
} as unknown as ModelRouter;

async function makeArea() {
  const ctx = {
    config: {} as never,
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets: {} as never,
    dataDir: join(dir, 'data'),
    registry: {} as never,
    router,
    nodes: {} as never,
    threads: {} as never,
    setting: (key: SettingKey) =>
      Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) =>
      req.headers['x-account'] === ACCOUNT
        ? Promise.resolve(ACCOUNT)
        : Promise.reject(new NovaError('token_required', 'sign in')),
    diagnostics: new DiagnosticsRegistry(),
    audit: { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: (_n: NotificationInput) => Promise.resolve() },
  } as unknown as Parameters<typeof setupPolicy>[0];
  return setupPolicy(ctx, { home: join(dir, 'home'), approvalTimeoutMs: () => 60_000 });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-policy-m5-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'code', 'streaming', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  events = new EventStore(db);
  settings = {};
  audit = [];
  routed = [];
  reply = JSON.stringify({
    outcome: 'allow',
    risk: 'low',
    userAuthorization: 'high',
    rationale: 'The user asked for the tests.',
  });
  area = await makeArea();
});

afterEach(async () => {
  await area.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function req(over: Partial<GateRequest> = {}): GateRequest {
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: '',
    callId: 'call-1',
    projectId: null,
    mode: 'code',
    tool: execTool,
    args: { cmd: 'npm test' },
    argsPreview: '{"cmd":"npm test"}',
    provenance: { userInstruction: { messageId: 'm', accountId: ACCOUNT }, taint: [] },
    profile: { id: 'workspace', hash: 'h' },
    ...over,
  };
}

const check = (r = req()) => area.gate.check(r, new AbortController().signal);

describe('policy area M5 wiring', () => {
  it("applies a session's permission mode from useThreadPolicy", async () => {
    area.useThreadPolicy({
      forThread: (_a, threadId) =>
        Promise.resolve(
          threadId === THREAD
            ? {
                approvalPolicy: 'never_ask',
                profileId: 'workspace',
                roots: null,
                permissionMode: 'bypass',
                autoAcceptEdits: false,
              }
            : null,
        ),
    });
    expect(await check()).toMatchObject({
      effect: 'allow',
      reason: 'your approval policy does not ask for this',
    });
    expect(audit.at(-1)!.detail).toMatchObject({
      permissionMode: 'bypass',
      approvalPolicy: 'never_ask',
    });
  });

  it('reviews with the review.model through the router, and denies without one', async () => {
    settings['tools.approvalPolicy'] = 'review';
    const denied = await check();
    expect(denied).toMatchObject({ effect: 'deny' });
    expect(denied.reason).toContain('No auto-review model is set up');
    expect(routed).toEqual([]);
    settings['review.model'] = 'mock:reviewer';
    expect(await check()).toMatchObject({ effect: 'allow' });
    expect(routed).toEqual(['mock:reviewer']);
    const verdicts = (await events.since(null, 500)).filter((e) => e.name === 'review.completed');
    expect(verdicts.at(-1)!.payload).toMatchObject({
      verdict: { outcome: 'allow' },
      attempts: 1,
      failedClosed: false,
    });
    expect(
      audit.find((a) => a.action === 'review.verdict' && a.decision === 'allow'),
    ).toMatchObject({
      detail: { model: 'mock:reviewer' },
    });
  });

  it('lets useReviewer replace the default reviewer', async () => {
    settings['tools.approvalPolicy'] = 'review';
    area.useReviewer({
      review: () =>
        Promise.resolve({
          outcome: 'deny',
          risk: 'high',
          userAuthorization: 'low',
          rationale: 'Not what the user asked for.',
          attempts: 1,
          failed: false,
        }),
    });
    expect((await check()).reason).toContain('Not what the user asked for.');
  });

  it('exposes the approvals flow for the request mirror', async () => {
    const outcome = check();
    let id = '';
    await vi.waitFor(async () => {
      const pending = await area.approvals.pending(ACCOUNT, THREAD);
      expect(pending).toHaveLength(1);
      id = pending[0]!.id;
    });
    expect(await area.approvals.pending(ACCOUNT)).toHaveLength(1);
    expect((await area.approvals.get(ACCOUNT, id)).status).toBe('pending');
    await area.approvals.decide(ACCOUNT, { approvalId: id, decision: 'allow_once' }, 'user');
    expect(await outcome).toMatchObject({ effect: 'allow' });
    expect(await area.approvals.pending(ACCOUNT)).toEqual([]);
  });
});
