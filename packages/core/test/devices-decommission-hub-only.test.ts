// The decommission card is Hub-only (ADR-096 D9, docs/23 §6.3, like firmware and boot cards):
// `answerIn: 'hub'`, so a channel button, a signed email link, a hook or the system can never
// answer it (`hub_only`); only the signed-in owner in Nova does, and then the decommission runs.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, SETTINGS, uuidv7 } from '@nova/shared';
import {
  ApprovalLinks,
  DeviceService,
  MemoryEventSink,
  PolicyGate,
  PolicyStore,
  type ApprovalRequests,
} from '../src/index.ts';
import { ACCOUNT, serviceEnv, type ServiceEnv } from './fixtures/channels/env.ts';
import { startMockTelegram, type MockTelegram } from './fixtures/channels/mock-telegram.ts';

const OWNER = 42;

let env: ServiceEnv;
let tg: MockTelegram;
let gate: PolicyGate;
let devices: DeviceService;
let deviceId: string;

beforeEach(async () => {
  tg = await startMockTelegram();
  env = await serviceEnv({ telegramApi: tg.api, publicBase: 'https://hub.example.com' });
  const store = new PolicyStore({ db: env.db });
  gate = new PolicyGate({
    store,
    events: env.events,
    audit: { append: (r) => (env.audit.push(r), Promise.resolve()) },
    notifier: { notify: () => Promise.resolve() },
    setting: (key) => Promise.resolve(SETTINGS[key].default as never),
    dataDir: join('/nonexistent', 'data'),
    home: join('/nonexistent', 'home'),
  });
  // What app.ts hands the channels area (`policy.approvals`): the real store and gate.
  const approvals: ApprovalRequests = {
    pending: () => Promise.resolve([]),
    get: (accountId, id) => store.getApproval(accountId, id),
    decide: (accountId, body, by) => gate.decide(accountId, body, by),
  };
  env.service.useApprovals(approvals);
  devices = new DeviceService({ db: env.db, secrets: env.secrets, events: new MemoryEventSink() });
  // An offline novad device (decommission revokes it at once once approved).
  deviceId = uuidv7();
  const iso = new Date().toISOString();
  env.db.raw
    .prepare(
      `INSERT INTO device (id, account_id, name, kind, cert_fingerprint, public_key, roles, status,
         created_at, updated_at) VALUES (?, ?, 'desk', 'client', ?, 'key', '["client"]',
         'unreachable', ?, ?)`,
    )
    .run(deviceId, ACCOUNT, `fp-${deviceId}`, iso, iso);
  env.db.raw
    .prepare(
      `INSERT INTO device_management (device_id, protocol_version, update_channel, updated_at)
       VALUES (?, 1, 'stable', ?)`,
    )
    .run(deviceId, iso);
});

afterEach(async () => {
  devices.stop();
  await env.service.close();
  env.db.close();
  await tg.close();
});

async function telegramBinding() {
  await env.service.addIdentity(ACCOUNT, {
    kind: 'telegram',
    externalId: String(OWNER),
    role: 'owner',
  });
  const b = await env.service.create(ACCOUNT, {
    kind: 'telegram',
    externalRef: String(OWNER),
    label: 'Owner on Telegram',
    agentId: 'agent-1',
    audience: 'private',
    credentials: { botToken: tg.botToken },
  } as never);
  await env.service.setEnabled(ACCOUNT, b.id, true);
  const secret = (await env.secrets.get(`secret://channel/${b.id}/webhookSecret`))!;
  return {
    b,
    deliver: (update: Record<string, unknown>) =>
      env.service.receive(b.id, tg.webhook(update, secret)),
  };
}

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return { code: err.code, details: err.details };
    throw err;
  }
  return null;
}

describe('the decommission card is Hub-only', () => {
  it('refuses a channel button and a signed link with hub_only', async () => {
    const req = await devices.requestDecommission(ACCOUNT, deviceId, { purge: false });
    const approvalId = req.approvalId!;
    expect(
      env.db.raw.prepare('SELECT answer_in FROM approval WHERE id = ?').get(approvalId),
    ).toEqual({ answer_in: 'hub' });
    const { b, deliver } = await telegramBinding();
    const press = tg.callback({
      chat: OWNER,
      from: OWNER,
      data: `nova:a:${approvalId}:o`,
      messageId: 5,
    });
    expect(await deliver(press)).toMatchObject({ reason: 'refused:hub_only' });
    const links = new ApprovalLinks({ db: env.db, secrets: env.secrets });
    const token = await links.create({
      accountId: ACCOUNT,
      bindingId: b.id,
      approvalId,
      expiresAt: new Date(Date.now() + 600_000),
    });
    await expect(env.service.answerByLink(token, 'allow_once')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(
      env.audit
        .filter((x) => x.action === 'channel.approval.refused')
        .map((x) => (x.detail as { reason: string; via?: string }).reason),
    ).toEqual(['hub_only', 'hub_only']);
    // Nothing was decided and the device is untouched.
    expect(
      env.db.raw.prepare('SELECT status, decision FROM approval WHERE id = ?').get(approvalId),
    ).toEqual({ status: 'pending', decision: null });
    expect((await devices.decommission(ACCOUNT, deviceId))!.status).toBe('awaiting_approval');
    expect((await devices.get(ACCOUNT, deviceId)).status).toBe('unreachable');
  });

  it('is answered by the signed-in owner only; then the device is revoked', async () => {
    const req = await devices.requestDecommission(ACCOUNT, deviceId, { purge: false });
    const approvalId = req.approvalId!;
    for (const by of ['channel:b1', 'hook:h1', 'system'])
      expect(await code(gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' }, by))).toEqual({
        code: 'policy_denied',
        details: { reason: 'hub_only' },
      });
    expect((await devices.decommission(ACCOUNT, deviceId))!.status).toBe('awaiting_approval');
    const view = await gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' }, 'user');
    expect(view).toMatchObject({ decidedBy: 'user', answerIn: 'hub' });
    await devices.onApprovalDecided(ACCOUNT, approvalId, 'allow_once');
    expect(await devices.decommission(ACCOUNT, deviceId)).toMatchObject({
      status: 'done',
      deviceResult: 'unreachable',
    });
    expect((await devices.get(ACCOUNT, deviceId)).status).toBe('revoked');
  });
});
