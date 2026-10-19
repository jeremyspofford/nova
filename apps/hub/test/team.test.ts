// The team area on a real Hub (decision 5, FR-217, FR-091, FR-113): invitations and joining,
// member sessions and removal, the member guard on Hub administration, isolation of a member's
// data through the ordinary routes, shared threads over HTTP, team agents, plugins per agent and
// the public profile card.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST, cookieOf, makeTeamHub, type TeamHub, type WireJson } from './team-env.ts';

let t: TeamHub;

beforeEach(async () => {
  t = await makeTeamHub({ limits: { join: { limit: 1000, windowMs: 60_000 } } });
});

afterEach(async () => {
  await t.close();
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  t.hub.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const body = (r: { json(): unknown }) => r.json() as WireJson;

describe('invitations and joining', () => {
  it('lets the owner invite, the member join once and sign in with their own session', async () => {
    const inv = await call('POST', '/api/v1/team/invitations', t.owner.headers, { label: 'Bea' });
    expect(inv.statusCode).toBe(201);
    expect(inv.headers['cache-control']).toBe('no-store');
    const { token, url } = body(inv) as { token: string; url: string };
    expect(url).toBe(`http://127.0.0.1:7419/join#invite=${encodeURIComponent(token)}`);
    const preview = await call('POST', '/api/v1/team/join/preview', HOST, { token });
    expect(body(preview)).toMatchObject({
      valid: true,
      invitedBy: 'Owner',
      label: 'Bea',
      providers: [],
    });
    const joined = await call('POST', '/api/v1/team/join', HOST, { token, displayName: 'Bea' });
    expect(joined.statusCode).toBe(201);
    const session = cookieOf(joined)!;
    const bea = { ...HOST, authorization: `Bearer ${session}` };
    expect(body(await call('GET', '/api/v1/session', bea)).accountId).toBe(body(joined).accountId);
    expect(body(await call('GET', '/api/v1/team/me', bea))).toMatchObject({
      role: 'member',
      displayName: 'Bea',
      identities: [],
    });
    // The member can chat offline at once with the mock provider.
    expect((body(await call('GET', '/api/v1/providers', bea)).items as unknown[]).length).toBe(1);
    // Once only.
    const again = await call('POST', '/api/v1/team/join', HOST, { token, displayName: 'Eve' });
    expect(again.statusCode).toBe(401);
    expect(body(await call('POST', '/api/v1/team/join/preview', HOST, { token })).valid).toBe(
      false,
    );
    // A member cannot invite or list invitations.
    expect((await call('POST', '/api/v1/team/invitations', bea, {})).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/team/invitations', bea)).statusCode).toBe(403);
    expect(
      (body(await call('GET', '/api/v1/team/members', bea)).items as WireJson[]).map(
        (m) => m.displayName,
      ),
    ).toEqual(['Owner', 'Bea']);
  });

  it('validates the public routes and rate-limits them per address', async () => {
    const strict = await makeTeamHub({ limits: { join: { limit: 2, windowMs: 60_000 } } });
    try {
      const bad = { token: 'nvi_' + 'x'.repeat(40), displayName: 'Eve' };
      const r1 = await strict.hub.app.inject({
        method: 'POST',
        url: '/api/v1/team/join',
        headers: HOST,
        payload: bad,
      });
      expect(r1.statusCode).toBe(401);
      const r2 = await strict.hub.app.inject({
        method: 'POST',
        url: '/api/v1/team/join',
        headers: HOST,
        payload: { token: 'x' },
      });
      expect(r2.statusCode).toBe(400);
      const r3 = await strict.hub.app.inject({
        method: 'POST',
        url: '/api/v1/team/join',
        headers: HOST,
        payload: bad,
      });
      expect(r3.statusCode).toBe(429);
    } finally {
      await strict.close();
    }
  });

  it('ends every session of a removed member at once', async () => {
    const bea = await t.join('Bea');
    expect((await call('GET', '/api/v1/threads', bea.headers)).statusCode).toBe(200);
    const removed = await call('DELETE', `/api/v1/team/members/${bea.accountId}`, t.owner.headers);
    expect(body(removed)).toEqual({ sessionsEnded: 1 });
    const after = await call('GET', '/api/v1/threads', bea.headers);
    expect(after.statusCode).toBe(401);
    // The owner's own session is untouched; a member cannot remove anyone.
    const cy = await t.join('Cy');
    expect(
      (await call('DELETE', `/api/v1/team/members/${t.owner.accountId}`, cy.headers)).statusCode,
    ).toBe(403);
    expect((await call('GET', '/api/v1/threads', t.owner.headers)).statusCode).toBe(200);
    // The owner still gets a setup code at start only when the owner has no session.
    expect(await t.hub.auth.hasActiveSessions()).toBe(true);
  });
});

describe('the member guard', () => {
  it('refuses Hub administration and the Hub machine to members, not to the owner', async () => {
    const bea = await t.join('Bea');
    const refused: [Method, string, unknown?][] = [
      ['GET', '/api/v1/settings'],
      ['PATCH', '/api/v1/settings', { key: 'appearance.theme', value: 'dark' }],
      ['GET', '/api/v1/files/roots'],
      ['POST', '/api/v1/terminals', {}],
      ['GET', '/api/v1/diagnostics'],
      ['GET', '/api/v1/network'],
      ['GET', '/api/v1/devices/all'],
      ['POST', '/api/v1/import/preview', {}],
      ['GET', '/api/v1/code/sessions'],
      ['POST', '/api/v1/mcp/servers', { name: 'sh', transport: 'stdio', command: 'sh' }],
    ];
    for (const [m, url, payload] of refused) {
      const r = await call(m, url, bea.headers, payload);
      expect([url, r.statusCode, body(r).error?.details?.reason]).toEqual([url, 403, 'owner_only']);
    }
    // Their own areas work.
    for (const url of [
      '/api/v1/threads',
      '/api/v1/memory/items',
      '/api/v1/agents',
      '/api/v1/team/me/settings',
    ])
      expect([url, (await call('GET', url, bea.headers)).statusCode]).toEqual([url, 200]);
    // A remote MCP server is not a program on the Hub: not refused by the guard.
    const remote = await call('POST', '/api/v1/mcp/servers', bea.headers, {
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      enabled: false,
    });
    expect(remote.statusCode).not.toBe(403);
    // The owner is never refused by it.
    expect((await call('GET', '/api/v1/settings', t.owner.headers)).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/files/roots', t.owner.headers)).statusCode).toBe(200);
  });

  it("keeps a member's own preferences apart from the Hub's settings", async () => {
    const bea = await t.join('Bea');
    const r = await call('PATCH', '/api/v1/team/me/settings', bea.headers, {
      key: 'appearance.theme',
      value: 'dark',
    });
    expect(body(r).settings['appearance.theme']).toEqual({ value: 'dark', source: 'member' });
    const hub = body(await call('GET', '/api/v1/settings', t.owner.headers)).settings as WireJson[];
    expect(hub.find((s) => s.key === 'appearance.theme')?.value).toBe('system');
    const refused = await call('PATCH', '/api/v1/team/me/settings', bea.headers, {
      key: 'tools.roots',
      value: [],
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe('isolation through the ordinary routes', () => {
  it("never shows a member the owner's memory, threads or events", async () => {
    const bea = await t.join('Bea');
    await call('POST', '/api/v1/memory/items', t.owner.headers, {
      content: 'The owner paints with teal',
    });
    const thread = body(
      await call('POST', '/api/v1/threads', t.owner.headers, { title: 'Private' }),
    );
    const items = body(await call('GET', '/api/v1/memory/items', bea.headers)).items as WireJson[];
    const mine = body(await call('GET', '/api/v1/memory/items', t.owner.headers))
      .items as WireJson[];
    expect(mine.map((i) => i.content)).toEqual(['The owner paints with teal']);
    expect(items.map((i) => i.content)).toEqual([]);
    expect(body(await call('GET', '/api/v1/threads', bea.headers)).items).toEqual([]);
    expect((await call('GET', `/api/v1/threads/${thread.id}`, bea.headers)).statusCode).toBe(404);
    expect(
      (await call('POST', `/api/v1/threads/${thread.id}/messages`, bea.headers, { text: 'hi' }))
        .statusCode,
    ).toBe(404);
    const events = body(await call('GET', '/api/v1/events', bea.headers)).events as WireJson[];
    expect(events.filter((e) => e.accountId === t.owner.accountId)).toEqual([]);
    expect((await call('GET', '/api/v1/team/threads/' + thread.id, bea.headers)).statusCode).toBe(
      404,
    );
  });
});

describe('shared threads over HTTP (FR-217)', () => {
  it('lets the owner share, the member read and write under their own account, and shows who said what', async () => {
    const bea = await t.join('Bea');
    const thread = body(await call('POST', '/api/v1/threads', t.owner.headers, {}));
    await call('POST', `/api/v1/threads/${thread.id}/messages`, t.owner.headers, {
      text: 'plan the trip',
    });
    await t.hub.chat.idle();
    expect(
      (
        await call('POST', `/api/v1/team/threads/${thread.id}/share`, bea.headers, {
          accountIds: [t.owner.accountId],
        })
      ).statusCode,
    ).toBe(404);
    const shared = await call('POST', `/api/v1/team/threads/${thread.id}/share`, t.owner.headers, {
      accountIds: [bea.accountId],
    });
    expect(body(shared)).toMatchObject({ you: 'owner', participants: [{ displayName: 'Bea' }] });
    expect(
      (body(await call('GET', '/api/v1/team/threads', bea.headers)).items as WireJson[]).map(
        (s) => s.thread.id,
      ),
    ).toEqual([thread.id]);
    const sent = await call('POST', `/api/v1/team/threads/${thread.id}/messages`, bea.headers, {
      text: 'I will book the train',
    });
    expect(sent.statusCode).toBe(202);
    await t.hub.chat.idle();
    const d = body(await call('GET', `/api/v1/team/threads/${thread.id}`, bea.headers));
    const said = (d.messages as WireJson[]).map((m) => [m.role, d.authors[m.id].displayName]);
    expect(said).toEqual([
      ['user', 'Owner'],
      ['assistant', 'Owner'],
      ['user', 'Bea'],
      ['assistant', 'Bea'],
    ]);
    // The owner sees Bea's message in the ordinary thread view too.
    const own = body(await call('GET', `/api/v1/threads/${thread.id}`, t.owner.headers));
    expect((own.messages as WireJson[]).length).toBe(4);
    // Bea leaves; the thread is hers no longer.
    expect(
      (
        await call(
          'DELETE',
          `/api/v1/team/threads/${thread.id}/share/${bea.accountId}`,
          bea.headers,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await call('POST', `/api/v1/team/threads/${thread.id}/messages`, bea.headers, { text: 'x' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('POST', `/api/v1/team/threads/${thread.id}/cancel`, bea.headers)).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/api/v1/team/threads/${thread.id}/stream`, bea.headers)).statusCode,
    ).toBe(404);
  });

  it('streams the shared conversation to a participant', async () => {
    const bea = await t.join('Bea');
    const thread = body(await call('POST', '/api/v1/threads', t.owner.headers, {}));
    await call('POST', `/api/v1/team/threads/${thread.id}/share`, t.owner.headers, {
      accountIds: [bea.accountId],
    });
    const address = await t.hub.app.listen({ host: '127.0.0.1', port: 0 });
    const ctrl = new AbortController();
    const res = await fetch(`${address}/api/v1/team/threads/${thread.id}/stream`, {
      headers: { authorization: bea.headers.authorization!, host: '127.0.0.1:7419' },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await call('POST', `/api/v1/team/threads/${thread.id}/messages`, t.owner.headers, {
      text: 'hello Bea',
    });
    let text = '';
    const t0 = Date.now();
    while (!text.includes('chat.message.created') && Date.now() - t0 < 5000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += Buffer.from(chunk.value).toString('utf8');
    }
    ctrl.abort();
    expect(text).toContain('event: chat.message.created');
    await t.hub.chat.idle();
  });
});

describe("a team agent's events (FR-091)", () => {
  it("reach the owner, naming the agent; a task's progress reaches who asked", async () => {
    const bea = await t.join('Bea');
    const agent = body(await call('POST', '/api/v1/team/agents', t.owner.headers, { name: 'Ops' }));
    const task = body(
      await call('POST', `/api/v1/team/agents/${agent.agentId}/tasks`, bea.headers, {
        text: 'tidy the wiki',
      }),
    );
    await t.hub.chat.idle();
    await t.area.agents()!.idle();
    // An approval the agent waits for (as the gate would announce it) reaches the owner too.
    await t.hub.events.emit({
      name: 'approval.requested',
      actor: 'system',
      accountId: agent.identityAccountId as string,
      payload: { approvalId: 'ap-1', tool: 'exec.run' },
    });
    const owner = body(await call('GET', '/api/v1/events?limit=500', t.owner.headers))
      .events as WireJson[];
    const mirrored = owner.filter((e) => e.payload.teamAgent?.agentId === agent.agentId);
    expect(mirrored.map((e) => e.name)).toEqual(
      expect.arrayContaining(['turn.started', 'chat.message.created', 'approval.requested']),
    );
    expect(mirrored.every((e) => e.accountId === t.owner.accountId)).toBe(true);
    expect(
      mirrored.find((e) => e.name === 'approval.requested')?.payload.teamAgent.identityAccountId,
    ).toBe(agent.identityAccountId);
    // Bea hears about her task, running then done; she gets none of the agent's own events.
    const hers = body(await call('GET', '/api/v1/events?limit=500', bea.headers))
      .events as WireJson[];
    expect(
      hers
        .filter((e) => e.name === 'team.task.updated' && e.payload.taskId === task.id)
        .map((e) => e.payload.status),
    ).toEqual(['running', 'done']);
    expect(hers.some((e) => e.payload.teamAgent)).toBe(false);
  });
});

describe('team agents over HTTP (FR-091)', () => {
  it('provisions an agent with its own identity, binds credentials and runs a member task', async () => {
    const bea = await t.join('Bea');
    expect(
      (await call('POST', '/api/v1/team/agents', bea.headers, { name: 'Ops' })).statusCode,
    ).toBe(403);
    const made = await call('POST', '/api/v1/team/agents', t.owner.headers, { name: 'Ops' });
    expect(made.statusCode).toBe(201);
    const agent = body(made);
    expect(agent.identityAccountId).not.toBe(t.owner.accountId);
    const cred = await call(
      'POST',
      `/api/v1/team/agents/${agent.agentId}/credentials`,
      t.owner.headers,
      {
        kind: 'egress',
        label: 'Wiki',
        hosts: ['wiki.example.com'],
        scheme: 'bearer',
        value: 'wiki-secret',
      },
    );
    expect(cred.statusCode).toBe(201);
    expect(cred.body).not.toContain('wiki-secret');
    expect(
      body(await call('GET', '/api/v1/team/agents', bea.headers)).items[0].credentials,
    ).toEqual([]);
    const task = await call('POST', `/api/v1/team/agents/${agent.agentId}/tasks`, bea.headers, {
      text: 'tidy the wiki',
    });
    expect(task.statusCode).toBe(202);
    await t.hub.chat.idle();
    await t.area.agents()!.idle();
    const done = body(await call('GET', `/api/v1/team/tasks/${body(task).id}`, bea.headers));
    expect(done.status).toBe('done');
    const audit = body(
      await call('GET', `/api/v1/team/agents/${agent.agentId}/audit`, t.owner.headers),
    );
    expect((audit.items as WireJson[]).some((e) => e.actor === `agent:${agent.agentId}`)).toBe(
      true,
    );
    expect(
      (await call('GET', `/api/v1/team/agents/${agent.agentId}/audit`, bea.headers)).statusCode,
    ).toBe(403);
    expect(
      body(await call('GET', `/api/v1/team/agents/${agent.agentId}/approvals`, t.owner.headers))
        .items,
    ).toEqual([]);
    expect(
      (await call('DELETE', `/api/v1/team/agents/${agent.agentId}`, t.owner.headers)).statusCode,
    ).toBe(200);
  });
});

describe('plugins per agent (FR-045)', () => {
  it('reads and sets the plugins connected to an agent', async () => {
    const agent = body(await call('POST', '/api/v1/agents', t.owner.headers, { name: 'Scout' }));
    expect(body(await call('GET', `/api/v1/agents/${agent.id}/plugins`, t.owner.headers))).toEqual({
      agentId: agent.id,
      pluginIds: null,
    });
    const set = await call('PUT', `/api/v1/agents/${agent.id}/plugins`, t.owner.headers, {
      pluginIds: [],
    });
    expect(body(set)).toEqual({ agentId: agent.id, pluginIds: [] });
    const bad = await call('PUT', `/api/v1/agents/${agent.id}/plugins`, t.owner.headers, {
      pluginIds: ['ghost'],
    });
    expect(bad.statusCode).toBe(400);
    const bea = await t.join('Bea');
    expect((await call('GET', `/api/v1/agents/${agent.id}/plugins`, bea.headers)).statusCode).toBe(
      404,
    );
  });
});

describe('the public profile card (FR-113)', () => {
  it('is published only when the Hub allows it and the person chose to', async () => {
    // Everyone can tell whether the owner's switch is off.
    const bea = await t.join('Bea');
    expect(body(await call('GET', '/api/v1/team/me/card', bea.headers))).toMatchObject({
      allowed: false,
      enabled: false,
    });
    const off = await call('PUT', '/api/v1/team/me/card', t.owner.headers, {
      enabled: true,
      handle: 'owner',
    });
    expect(off.statusCode).toBe(403);
    t.put('team.publicProfiles', true);
    expect(body(await call('GET', '/api/v1/team/me/card', bea.headers)).allowed).toBe(true);
    const on = await call('PUT', '/api/v1/team/me/card', t.owner.headers, {
      enabled: true,
      handle: 'owner',
    });
    expect(body(on)).toMatchObject({ enabled: true, path: '/api/v1/profiles/owner' });
    const pub = await call('GET', '/api/v1/profiles/owner', HOST);
    expect(body(pub)).toEqual({ handle: 'owner', displayName: 'Owner', avatarPath: null });
    expect(Object.keys(body(pub))).toEqual(['handle', 'displayName', 'avatarPath']);
    expect((await call('GET', '/api/v1/profiles/owner/avatar', HOST)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/profiles/nobody', HOST)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/profiles/NO!', HOST)).statusCode).toBe(400);
    t.put('team.publicProfiles', false);
    expect((await call('GET', '/api/v1/profiles/owner', HOST)).statusCode).toBe(404);
  });
});
