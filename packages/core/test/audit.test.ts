import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, makeEvent, type NewEvent } from '@nova/shared';
import { REDACTED } from '@nova/security';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  AuditLog,
  MemoryEventSink,
  auditInputHash,
  auditRecordFor,
  auditRowHash,
  auditSecurityEvents,
  isSecuritySetting,
  type AuditRow,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000a1';
const OTHER = '01920000-0000-7000-8000-0000000000a2';

let db: NovaDatabase;
let events: MemoryEventSink;
let audit: AuditLog;

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER]) {
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
      )
      .run(id, now, now);
  }
  events = new MemoryEventSink();
  audit = new AuditLog({ db, events });
});
afterEach(() => db.close());

const rows = () =>
  db.raw.prepare('SELECT * FROM audit_event ORDER BY seq').all() as unknown as AuditRow[];

/** Tampering needs direct file access: drop the append-only triggers first, as an attacker would. */
function tamper(sql: string, ...args: (string | number)[]): void {
  db.raw.exec('DROP TRIGGER audit_event_no_update; DROP TRIGGER audit_event_no_delete;');
  db.raw.prepare(sql).run(...args);
}

describe('AuditLog chain', () => {
  it('appends hash-chained entries and verifies them', async () => {
    const a = await audit.record({
      accountId: ACCOUNT,
      actor: 'user',
      kind: 'tool_call',
      action: 'fs.write',
      resource: 'notes/plan.md',
      inputHash: auditInputHash({ path: 'notes/plan.md', text: 'x' }),
      decision: 'allow',
      result: 'ok',
      threadId: 't1',
      turnId: 'u1',
      detail: { tier: 'pre_approvable', profileHash: 'abc' },
    });
    await audit.append({ accountId: ACCOUNT, actor: 'system', kind: 'policy', action: 'deny' });
    const [first, second] = rows();
    expect(first).toMatchObject({ seq: 1, prev_hash: null, hash: a.hash, thread_id: 't1' });
    expect(second).toMatchObject({ seq: 2, prev_hash: a.hash });
    expect(auditRowHash(second!)).toBe(second!.hash);
    expect(JSON.parse(first!.detail_json!)).toEqual({ tier: 'pre_approvable', profileHash: 'abc' });
    expect(second!.detail_json).toBeNull();
    expect(await audit.verify()).toEqual({ ok: true, checked: 2, brokenAt: null });
    expect(events.names()).toEqual(['audit.appended', 'audit.appended']);
    expect(events.events[0]!.payload).toEqual({ auditId: a.id, kind: 'tool_call', hash: a.hash });
  });

  it('stores only an input hash and redacts every text field', async () => {
    // secret-scan: fake
    const key = 'sk-proj-Zq7Lm2Vx9Rt4Wp8Ks3Hd6Jf1';
    await audit.append({
      accountId: ACCOUNT,
      actor: 'user',
      kind: 'secret',
      action: `used ${key}`,
      resource: `https://u:${key}@example.com/`,
      result: `Bearer ${key}`,
      inputHash: auditInputHash({ apiKey: key }),
      detail: { apiKey: key, note: `token ${key}` },
    });
    const text = JSON.stringify(rows());
    expect(text).not.toContain(key);
    expect(text).toContain(REDACTED);
    expect(rows()[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses edits and deletes at the database level', async () => {
    await audit.append({ accountId: ACCOUNT, actor: 'user', kind: 'auth', action: 'x' });
    expect(() => db.raw.prepare("UPDATE audit_event SET result = 'x'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.raw.prepare('DELETE FROM audit_event').run()).toThrow(/append-only/);
  });

  it('reports the first broken entry when a row is edited, removed or re-hashed', async () => {
    for (let i = 0; i < 5; i++)
      await audit.append({ accountId: ACCOUNT, actor: 'user', kind: 'auth', action: `a${i}` });
    const ids = rows().map((r) => r.id);
    tamper("UPDATE audit_event SET result = 'forged' WHERE seq = 3");
    expect(await audit.verify()).toEqual({ ok: false, checked: 3, brokenAt: ids[2] });
  });

  it('detects a deleted entry and a recomputed hash that no longer chains', async () => {
    for (let i = 0; i < 4; i++)
      await audit.append({ accountId: ACCOUNT, actor: 'user', kind: 'auth', action: `a${i}` });
    const ids = rows().map((r) => r.id);
    tamper('DELETE FROM audit_event WHERE seq = 2');
    expect(await audit.verify()).toMatchObject({ ok: false, brokenAt: ids[2] });
    // Re-hash row 3 so it is self-consistent: the next row's prev_hash still exposes it.
    const r3 = rows().find((r) => r.seq === 3)!;
    const forged = { ...r3, seq: 2, prev_hash: rows()[0]!.hash };
    db.raw
      .prepare('UPDATE audit_event SET seq = 2, prev_hash = ?, hash = ? WHERE id = ?')
      .run(forged.prev_hash, auditRowHash(forged), r3.id);
    expect(await audit.verify()).toMatchObject({ ok: false, brokenAt: ids[3] });
  });

  it('never forks under concurrent appends', async () => {
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        audit.append({ accountId: ACCOUNT, actor: 'user', kind: 'tool_call', action: `c${i}` }),
      ),
    );
    const all = rows();
    expect(all.map((r) => r.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(await audit.verify()).toEqual({ ok: true, checked: 60, brokenAt: null });
  });

  it('verifies an empty log, and a chain longer than one page', async () => {
    expect(await audit.verify()).toEqual({ ok: true, checked: 0, brokenAt: null });
    const quiet = new AuditLog({ db });
    for (let i = 0; i < 1005; i++)
      await quiet.append({ accountId: ACCOUNT, actor: 'system', kind: 'fs', action: 'r' });
    expect(await quiet.verify()).toEqual({ ok: true, checked: 1005, brokenAt: null });
  });

  it('clips long fields and oversized detail', async () => {
    await audit.append({
      accountId: ACCOUNT,
      actor: 'a'.repeat(300),
      kind: 'fs',
      action: 'b'.repeat(500),
      detail: { blob: 'c'.repeat(20_000) },
    });
    const [r] = rows();
    expect(r!.actor).toHaveLength(200);
    expect(r!.action).toHaveLength(200);
    expect(JSON.parse(r!.detail_json!)).toEqual({ truncated: true, chars: expect.any(Number) });
    expect(await audit.verify()).toMatchObject({ ok: true });
  });
});

describe('AuditLog queries', () => {
  beforeEach(async () => {
    await audit.append({ accountId: ACCOUNT, actor: 'user', kind: 'auth', action: 'signin' });
    for (let i = 0; i < 4; i++)
      await audit.append({
        accountId: ACCOUNT,
        actor: 'agent:a1',
        kind: 'tool_call',
        action: `call ${i}`,
        threadId: i % 2 ? 't1' : 't2',
      });
    await audit.append({ accountId: OTHER, actor: 'user', kind: 'auth', action: 'other' });
  });

  it('lists one account newest first with kind and thread filters and a cursor', async () => {
    const all = await audit.list(ACCOUNT);
    expect(all.items.map((e) => e.action)).toEqual([
      'call 3',
      'call 2',
      'call 1',
      'call 0',
      'signin',
    ]);
    expect(all.nextCursor).toBeNull();
    expect((await audit.list(ACCOUNT, { kind: 'auth' })).items.map((e) => e.action)).toEqual([
      'signin',
    ]);
    expect((await audit.list(ACCOUNT, { threadId: 't1' })).items.map((e) => e.action)).toEqual([
      'call 3',
      'call 1',
    ]);
    const p1 = await audit.list(ACCOUNT, { limit: 2 });
    expect(p1.items.map((e) => e.action)).toEqual(['call 3', 'call 2']);
    const p2 = await audit.list(ACCOUNT, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((e) => e.action)).toEqual(['call 1', 'call 0']);
    const p3 = await audit.list(ACCOUNT, { limit: 2, cursor: p2.nextCursor! });
    expect(p3).toEqual({
      items: [expect.objectContaining({ action: 'signin' })],
      nextCursor: null,
    });
    expect((await audit.list(ACCOUNT, { cursor: 'junk' })).items).toHaveLength(5);
    expect(p1.items[0]).toEqual({
      id: expect.any(String),
      actor: 'agent:a1',
      kind: 'tool_call',
      action: 'call 3',
      resource: null,
      decision: null,
      result: null,
      threadId: 't1',
      turnId: null,
      createdAt: expect.any(String),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      detail: null,
    });
  });

  it('lists each entry with its detail, redacted again and capped (M7.5)', async () => {
    await audit.append({
      accountId: ACCOUNT,
      actor: 'user',
      kind: 'settings',
      action: 'setting.changed',
      resource: 'devices.firmware.allowChanges',
      detail: { scope: 'global', before: false, after: true, confirmed: true },
    });
    await audit.append({ accountId: ACCOUNT, actor: 'system', kind: 'policy', action: 'none' });
    // A row written before a redaction rule existed (or by hand) is masked on the way out.
    await audit.append({
      accountId: ACCOUNT,
      actor: 'user',
      kind: 'device',
      action: 'device.bridge',
      resource: null,
      detail: { note: 'x' },
    });
    db.raw.exec('DROP TRIGGER audit_event_no_update;');
    db.raw.prepare('UPDATE audit_event SET detail_json = ? WHERE action = ?').run(
      // secret-scan: fake
      JSON.stringify({ token: 'plain', note: 'nvbr_Q2xhdWRlIHdhcyBoZXJlIDIwMjYtMTAtMTkK' }),
      'device.bridge',
    );
    await audit.append({
      accountId: ACCOUNT,
      actor: 'user',
      kind: 'device',
      action: 'device.big',
      detail: { values: 'v'.repeat(5_000) },
    });
    const items = (await audit.list(ACCOUNT)).items;
    const by = (action: string) => items.find((e) => e.action === action)?.detail;
    expect(by('setting.changed')).toEqual({
      scope: 'global',
      before: false,
      after: true,
      confirmed: true,
    });
    expect(by('none')).toBeNull();
    expect(by('device.bridge')).toEqual({ token: REDACTED, note: REDACTED });
    expect(by('device.big')).toEqual({ truncated: true, chars: expect.any(Number) as number });
    // The entry `record` returns carries it too.
    const rec = await audit.record({
      accountId: ACCOUNT,
      actor: 'user',
      kind: 'settings',
      action: 'setting.changed',
      detail: { before: 1, after: 2 },
    });
    expect(rec.detail).toEqual({ before: 1, after: 2 });
  });

  it('exports one account as JSON lines with the chain fields', async () => {
    const lines: string[] = [];
    for await (const l of audit.exportLines(ACCOUNT)) lines.push(l);
    expect(lines).toHaveLength(5);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ seq: 1, action: 'signin', prevHash: null, detail: null });
    expect(JSON.parse(lines[1]!).prevHash).toBe(first.hash);
    const other: string[] = [];
    for await (const l of audit.exportLines(OTHER)) other.push(l);
    expect(other).toHaveLength(1);
  });

  it('exports detail and spans several pages', async () => {
    const quiet = new AuditLog({ db });
    for (let i = 0; i < 510; i++)
      await quiet.append({
        accountId: OTHER,
        actor: 'system',
        kind: 'fs',
        action: 'r',
        detail: { i },
      });
    let n = 0;
    let last: { detail: { i: number } } | null = null;
    for await (const l of quiet.exportLines(OTHER)) {
      n++;
      last = JSON.parse(l);
    }
    expect(n).toBe(511);
    expect(last?.detail).toEqual({ i: 509 });
  });

  it('logs and survives a failing event sink', async () => {
    const warnings: string[] = [];
    const failing = new AuditLog({
      db,
      events: { emit: () => Promise.reject(new Error('bus down')), emitEphemeral: () => undefined },
      log: { warn: (msg: string) => warnings.push(msg) } as never,
    });
    await failing.append({ accountId: ACCOUNT, actor: 'user', kind: 'auth', action: 'x' });
    expect(warnings).toEqual(['audit.appended event failed']);
  });
});

describe('auditInputHash', () => {
  it('is stable across key order and drops undefined like JSON', () => {
    expect(auditInputHash({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(
      auditInputHash({ b: [1, { c: 2 }], a: 1 }),
    );
    expect(auditInputHash(undefined)).toBe(auditInputHash(null));
    expect(auditInputHash('x')).not.toBe(auditInputHash('y'));
  });
});

describe('event-driven audit', () => {
  const ev = (e: NewEvent<Record<string, unknown>>) => makeEvent(e);

  it('audits who answered a request, or why none did, never the answer (FR-188)', () => {
    expect(
      auditRecordFor(
        ev({
          name: 'request.resolved',
          actor: 'user',
          payload: {
            requestId: 'r1',
            kind: 'user_input',
            resolvedBy: 'user',
            deviceId: 'd1',
            result: { text: 'secret plans' },
          },
        }),
      ),
    ).toEqual({
      actor: 'user',
      kind: 'request',
      action: 'request.resolved',
      resource: 'r1',
      detail: { kind: 'user_input', resolvedBy: 'user', deviceId: 'd1' },
    });
    expect(
      auditRecordFor(
        ev({
          name: 'request.expired',
          actor: 'system',
          payload: { requestId: 'r2', kind: 'user_input', reason: 'timeout' },
        }),
      ),
    ).toMatchObject({ kind: 'request', resource: 'r2', detail: { reason: 'timeout' } });
  });

  it('maps security-relevant events and ignores the rest', () => {
    expect(
      auditRecordFor(
        ev({ name: 'auth.session.created', actor: 'user', payload: { accountId: 'a' } }),
      ),
    ).toEqual({ actor: 'user', kind: 'auth', action: 'session.created', resource: 'a' });
    expect(
      auditRecordFor(
        ev({
          name: 'provider.account.created',
          actor: 'user',
          payload: {
            providerAccountId: 'p1',
            provider: 'openai',
            secretRef: 'secret://provider/p1/api_key',
            apiKey: 'never',
          },
        }),
      ),
    ).toEqual({
      actor: 'user',
      kind: 'secret',
      action: 'account.created',
      resource: 'p1',
      detail: { provider: 'openai', secretRef: 'secret://provider/p1/api_key' },
    });
    expect(
      auditRecordFor(
        ev({
          name: 'settings.changed',
          actor: 'user',
          payload: { key: 'routing.allowCloud', scope: 'global' },
        }),
      ),
    ).toMatchObject({
      kind: 'settings',
      resource: 'routing.allowCloud',
      detail: { scope: 'global' },
    });
    // M7.5: the settings writer's values and confirmation are the entry's (ADR-096 D3).
    for (const confirmed of [true, false])
      expect(
        auditRecordFor(
          ev({
            name: 'settings.changed',
            actor: 'user',
            payload: {
              key: 'devices.firmware.allowChanges',
              scope: 'global',
              before: !confirmed,
              after: confirmed,
              confirmed,
            },
          }),
        ),
      ).toEqual({
        actor: 'user',
        kind: 'settings',
        action: 'setting.changed',
        resource: 'devices.firmware.allowChanges',
        detail: { scope: 'global', before: !confirmed, after: confirmed, confirmed },
      });
    expect(
      auditRecordFor(
        ev({ name: 'settings.changed', payload: { key: 'appearance.theme', scope: 'global' } }),
      ),
    ).toBeNull();
    expect(auditRecordFor(ev({ name: 'settings.changed', payload: {} }))).toBeNull();
    expect(
      auditRecordFor(ev({ name: 'node.registered', payload: { nodeId: 'n1', name: 'gpu' } })),
    ).toMatchObject({ kind: 'node', action: 'node.registered', resource: 'n1' });
    expect(
      auditRecordFor(
        ev({ name: 'node.status.changed', payload: { nodeId: 'n1', status: 'revoked' } }),
      ),
    ).toMatchObject({ action: 'node.revoked' });
    expect(
      auditRecordFor(
        ev({ name: 'node.status.changed', payload: { nodeId: 'n1', status: 'unreachable' } }),
      ),
    ).toBeNull();
    expect(auditRecordFor(ev({ name: 'chat.message.created', payload: {} }))).toBeNull();
    expect(isSecuritySetting('tools.approvalPolicy')).toBe(true);
    expect(isSecuritySetting('chat.defaultModel')).toBe(false);
    expect(isSecuritySetting('nope')).toBe(false);
  });

  it('appends from the bus in arrival order and files events without an account under the owner', async () => {
    const bus = new EventBus();
    let owner: string | null = ACCOUNT;
    const warned: string[] = [];
    const sub = auditSecurityEvents({
      bus,
      audit,
      ownerAccount: () => Promise.resolve(owner),
      log: { warn: (m: string) => warned.push(m) } as never,
    });
    bus.publish(
      ev({
        name: 'auth.session.created',
        actor: 'user',
        accountId: ACCOUNT,
        payload: { accountId: ACCOUNT },
      }),
    );
    bus.publish(
      ev({
        name: 'settings.changed',
        actor: 'user',
        payload: { key: 'network.egressAllow', scope: 'global' },
      }),
    );
    bus.publish(
      ev({
        name: 'node.status.changed',
        accountId: ACCOUNT,
        payload: { nodeId: 'n1', status: 'active' },
      }),
    );
    bus.publish(
      ev({
        name: 'auth.session.revoked',
        actor: 'user',
        accountId: ACCOUNT,
        payload: { accountId: ACCOUNT },
      }),
    );
    await sub.idle();
    expect(rows().map((r) => [r.kind, r.action, r.account_id])).toEqual([
      ['auth', 'session.created', ACCOUNT],
      ['settings', 'setting.changed', ACCOUNT],
      ['auth', 'session.revoked', ACCOUNT],
    ]);
    owner = null;
    bus.publish(ev({ name: 'settings.changed', payload: { key: 'network.egressAllow' } }));
    await sub.idle();
    expect(warned).toEqual(['security event not audited: no account yet']);
    sub.stop();
    bus.publish(ev({ name: 'auth.session.created', accountId: ACCOUNT, payload: {} }));
    await sub.idle();
    expect(rows()).toHaveLength(3);
  });

  it('keeps going after a failing append', async () => {
    const bus = new EventBus();
    const warned: string[] = [];
    let calls = 0;
    const sub = auditSecurityEvents({
      bus,
      audit: {
        append: () => (++calls === 1 ? Promise.reject(new Error('disk full')) : Promise.resolve()),
      },
      ownerAccount: () => Promise.resolve(ACCOUNT),
      log: { warn: (m: string) => warned.push(m) } as never,
    });
    bus.publish(ev({ name: 'auth.session.created', accountId: ACCOUNT, payload: {} }));
    bus.publish(ev({ name: 'auth.session.created', accountId: ACCOUNT, payload: {} }));
    await sub.idle();
    expect(calls).toBe(2);
    expect(warned).toEqual(['event handler failed']);
    sub.stop();
  });
});
