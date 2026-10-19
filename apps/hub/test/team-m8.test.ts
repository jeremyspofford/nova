// M8 team carry-ins through the fully wired Hub (decision 5, ADR-097): a removed member's data is
// kept, exportable and then purged (after the grace period or at once on the owner's request),
// only by the owner; a removed member's channel pollers stop at once; a person learns what they
// may reach for the web UI's member mode.
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startMockTelegram,
  type MockTelegram,
} from '../../../packages/core/test/fixtures/channels/mock-telegram.ts';
import { makeTeamHub, type TeamHub, type WireJson } from './team-env.ts';

let h: TeamHub | null = null;
let tg: MockTelegram | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  await tg?.close();
  tg = null;
  delete process.env.NOVA_TELEGRAM_API_BASE;
});

async function call(
  headers: Record<string, string>,
  method: string,
  url: string,
  payload?: unknown,
) {
  const res = await h!.hub.app.inject({
    method: method as 'GET',
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let json: WireJson;
  try {
    json = res.json<WireJson>();
  } catch {
    json = {};
  }
  return { status: res.statusCode, json, res };
}

const threadsOf = (accountId: string) =>
  (
    h!.db.raw.prepare('SELECT count(*) AS n FROM thread WHERE account_id = ?').get(accountId) as {
      n: number;
    }
  ).n;

describe("a removed member's data", () => {
  it('is kept and listed for the owner, exported on request, then purged at once', async () => {
    let clock = new Date('2026-10-01T00:00:00.000Z');
    h = await makeTeamHub({ now: () => clock });
    const owner = h.owner.headers;
    const bea = await h.join('Bea');
    const cy = await h.join('Cy');
    expect((await call(bea.headers, 'POST', '/api/v1/threads', {})).status).toBe(201);
    expect(threadsOf(bea.accountId)).toBe(1);

    expect((await call(owner, 'DELETE', `/api/v1/team/members/${bea.accountId}`)).status).toBe(200);
    // Kept (the default grace period is 30 days), and only the owner sees the list.
    expect(threadsOf(bea.accountId)).toBe(1);
    const list = await call(owner, 'GET', '/api/v1/team/removed');
    expect(list.json.items).toEqual([
      expect.objectContaining({
        accountId: bea.accountId,
        displayName: 'Bea',
        status: 'scheduled',
        purgeAfter: '2026-10-31T00:00:00.000Z',
        // Nothing to export with until the data controls hand the area their export.
        exportable: false,
      }),
    ]);
    for (const [method, url, body] of [
      ['GET', '/api/v1/team/removed', undefined],
      ['POST', `/api/v1/team/removed/${bea.accountId}/purge`, { confirm: true }],
      ['GET', `/api/v1/team/removed/${bea.accountId}/export`, undefined],
    ] as const) {
      const r = await call(cy.headers, method, url, body);
      expect(r.status, url).toBe(403);
      expect(r.json.error.details.reason, url).toBe('owner_only');
    }
    // Her own session ended with the removal.
    expect((await call(bea.headers, 'GET', '/api/v1/threads')).status).toBe(401);

    // Export: refused until wired, then streamed and audited.
    const missing = await call(owner, 'GET', `/api/v1/team/removed/${bea.accountId}/export`);
    expect(missing.json.error).toMatchObject({
      code: 'capability_missing',
      details: { reason: 'export_unavailable' },
    });
    const asked: string[] = [];
    h.area.useExporter((accountId) => {
      asked.push(accountId);
      return Promise.resolve({
        fileName: 'bea "data".novaexport',
        body: Readable.from([Buffer.from('PK'), Buffer.from('data')]),
      });
    });
    expect((await call(owner, 'GET', '/api/v1/team/removed')).json.items[0].exportable).toBe(true);
    const exp = await call(owner, 'GET', `/api/v1/team/removed/${bea.accountId}/export`);
    expect(exp.status).toBe(200);
    expect(exp.res.body).toBe('PKdata');
    expect(exp.res.headers['content-disposition']).toBe(
      'attachment; filename="bea__data_.novaexport"',
    );
    expect(asked).toEqual([bea.accountId]);
    const audit = h.db.raw
      .prepare("SELECT action, resource FROM audit_event WHERE action LIKE 'team.member.%'")
      .all();
    expect(audit).toContainEqual({
      action: 'team.member.export',
      resource: `account:${bea.accountId}`,
    });

    // Purge at once: the confirmation is explicit.
    const unconfirmed = await call(
      owner,
      'POST',
      `/api/v1/team/removed/${bea.accountId}/purge`,
      {},
    );
    expect(unconfirmed.status).toBe(400);
    clock = new Date('2026-10-02T00:00:00.000Z');
    const purged = await call(owner, 'POST', `/api/v1/team/removed/${bea.accountId}/purge`, {
      confirm: true,
    });
    expect(purged.status).toBe(200);
    expect(purged.json).toMatchObject({
      status: 'purged',
      cause: 'request',
      purgedAt: '2026-10-02T00:00:00.000Z',
      displayName: null,
      exportable: false,
    });
    expect(threadsOf(bea.accountId)).toBe(0);
    expect(
      h.db.raw.prepare("SELECT 1 AS x FROM audit_event WHERE action = 'team.member.purge'").get(),
    ).toBeDefined();
    const again = await call(owner, 'GET', `/api/v1/team/removed/${bea.accountId}/export`);
    expect(again.status).toBe(409);
    expect(
      (await call(owner, 'POST', `/api/v1/team/removed/${bea.accountId}/purge`, { confirm: true }))
        .status,
    ).toBe(409);
    // An active member is not a removed one.
    expect(
      (await call(owner, 'POST', `/api/v1/team/removed/${cy.accountId}/purge`, { confirm: true }))
        .status,
    ).toBe(404);
  });

  it('is purged by the sweep once the grace period the owner set has passed', async () => {
    let clock = new Date('2026-10-01T00:00:00.000Z');
    h = await makeTeamHub({ now: () => clock });
    const bea = await h.join('Bea');
    await call(bea.headers, 'POST', '/api/v1/threads', {});
    h.put('team.removedMemberPurgeDays', 7);
    await call(h.owner.headers, 'DELETE', `/api/v1/team/members/${bea.accountId}`);
    clock = new Date('2026-10-07T00:00:00.000Z');
    expect(await h.area.purges.sweep()).toEqual({ purged: [], failed: [] });
    clock = new Date('2026-10-08T00:00:00.000Z');
    expect(await h.area.purges.sweep()).toEqual({ purged: [bea.accountId], failed: [] });
    expect(threadsOf(bea.accountId)).toBe(0);
    const [view] = (await call(h.owner.headers, 'GET', '/api/v1/team/removed')).json.items;
    expect(view).toMatchObject({ status: 'purged', cause: 'grace' });
  });
});

describe("a removed member's channel pollers (decision 5)", () => {
  it('stop at once, not at the next restart', async () => {
    tg = await startMockTelegram();
    process.env.NOVA_TELEGRAM_API_BASE = tg.api;
    h = await makeTeamHub();
    const bea = await h.join('Bea');
    const created = await call(bea.headers, 'POST', '/api/v1/channels', {
      kind: 'telegram',
      externalRef: '42',
      audience: 'private',
      credentials: { botToken: tg.botToken },
    });
    expect(created.status).toBe(201);
    expect(
      (await call(bea.headers, 'POST', `/api/v1/channels/${created.json.id as string}/connect`))
        .status,
    ).toBe(200);
    // Her bot is being polled.
    await vi.waitFor(() => expect(tg!.of('getUpdates').length).toBeGreaterThan(2));
    await call(h.owner.headers, 'DELETE', `/api/v1/team/members/${bea.accountId}`);
    // The loop ends with the removal: a round already in flight may finish, then nothing more.
    await new Promise((r) => setTimeout(r, 100));
    const after = tg.of('getUpdates').length;
    await new Promise((r) => setTimeout(r, 300));
    expect(tg.of('getUpdates').length).toBe(after);
  });
});

describe('what a person may reach (member mode)', () => {
  it('is nothing refused for the owner, and the owner-only routes for a member', async () => {
    h = await makeTeamHub();
    const owner = await call(h.owner.headers, 'GET', '/api/v1/team/me/access');
    expect(owner.json).toEqual({
      role: 'owner',
      refused: [],
      limits: {
        stdioMcpServers: true,
        privateAddresses: true,
        narrowingOnlyAllowLists: false,
        hubSettings: true,
      },
    });
    const bea = await h.join('Bea');
    const mine = await call(bea.headers, 'GET', '/api/v1/team/me/access');
    expect(mine.json.role).toBe('member');
    expect(mine.json.limits).toEqual({
      stdioMcpServers: false,
      privateAddresses: false,
      narrowingOnlyAllowLists: true,
      hubSettings: false,
    });
    const refused = mine.json.refused as { method: string; route: string; why: string }[];
    expect(refused).toContainEqual({
      method: 'PATCH',
      route: '/api/v1/settings',
      why: "the Hub's settings",
    });
    expect(refused).toContainEqual({
      method: 'POST',
      route: '/api/v1/plugins',
      why: 'plugins installed for everyone',
    });
    expect(refused.some((r) => r.route === '/api/v1/threads')).toBe(false);
    expect(refused.some((r) => r.route === '/api/v1/mcp/servers')).toBe(false);
  });
});
