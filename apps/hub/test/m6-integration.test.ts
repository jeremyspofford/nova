// M6 through the fully wired Hub (app.ts): an agent's turns run on the chat loop in its own
// thread; its rules reach the policy gate (FR-084); its computer is made for it and goes with it
// (FR-080, FR-090); the kill key pauses the agent using the computer and resuming restores it
// (FR-207); its self-set wake shows in the Scheduled list as the agent's (FR-206).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@nova/providers';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let headers: Record<string, string>;

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

type Json = Record<string, unknown>;
const api = async (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) => {
  const res = await hub.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Json }),
  });
  return { status: res.statusCode, json: res.json<Json>() };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-m6-'));
  const config = loadConfig(
    { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
    [],
  );
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const mock = new MockProvider({ id: 'mock', timing: 'instant' });
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    providerFactory: ({ row }) => (row.provider === 'mock' ? mock : undefined),
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
  });
  const code = await hub.auth.issueSetupCode();
  const setup = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { host: '127.0.0.1:7419' },
    payload: { code, displayName: 'Owner' },
  });
  const session = setup.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  headers = { host: '127.0.0.1:7419', authorization: `Bearer ${session}` };
});

afterEach(async () => {
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function newAgent(name = 'Ada') {
  const r = await api('POST', '/api/v1/agents', { name, proactive: false });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string; primaryThreadId: string };
}

async function agentComputer(agentId: string): Promise<string> {
  return until(async () => {
    const list = (await api('GET', '/api/v1/computers')).json.items as {
      id: string;
      agentId: string | null;
    }[];
    return list.find((c) => c.agentId === agentId)?.id ?? null;
  });
}

describe('M6 through the wired Hub', () => {
  it("runs an agent's turn in its thread, and its rules reach the gate (FR-084)", async () => {
    const agent = await newAgent();
    const reply = await api('POST', `/api/v1/threads/${agent.primaryThreadId}/messages`, {
      text: 'hello agent',
    });
    expect(reply.status, JSON.stringify(reply.json)).toBe(202);
    await until(async () => {
      const t = (await api('GET', `/api/v1/threads/${agent.primaryThreadId}`)).json;
      return JSON.stringify(t).includes('You said: hello agent');
    });
    // An "ask" rule on a tool the defaults allow: the call now waits for an approval card.
    const rule = await api('POST', `/api/v1/agents/${agent.id}/rules`, {
      description: 'Ask before listing files',
      effect: 'ask',
      match: { tools: ['fs.list'] },
    });
    expect(rule.status, JSON.stringify(rule.json)).toBe(201);
    await api('POST', `/api/v1/threads/${agent.primaryThreadId}/messages`, {
      text: '/tool fs.list {}',
    });
    const pending = await until(async () => {
      const items = (await api('GET', '/api/v1/approvals?status=pending')).json.items as {
        id: string;
        threadId: string | null;
      }[];
      return items.find((a) => a.threadId === agent.primaryThreadId) ?? null;
    });
    expect(pending.id).toBeTruthy();
  }, 30_000);

  it("works in the agent computer's folder, never elsewhere in the data folder (FR-080)", async () => {
    const agent = await newAgent();
    await agentComputer(agent.id);
    await api('POST', `/api/v1/threads/${agent.primaryThreadId}/messages`, {
      text: '/tool fs.list {}',
    });
    const card = await until(async () => {
      const t = JSON.stringify((await api('GET', `/api/v1/threads/${agent.primaryThreadId}`)).json);
      const m = /"tool":"fs\.list"[^}]*"status":"(\w+)"/.exec(t);
      return m && m[1] !== 'running' && m[1] !== 'pending' ? m[1] : null;
    });
    expect(card).toBe('ok');
    await api('POST', `/api/v1/threads/${agent.primaryThreadId}/messages`, {
      text: `/tool fs.list {"path":${JSON.stringify(join(dir, 'data'))}}`,
    });
    const outside = await until(async () => {
      const t = JSON.stringify((await api('GET', `/api/v1/threads/${agent.primaryThreadId}`)).json);
      const all = [...t.matchAll(/"tool":"fs\.list"[^}]*"status":"(\w+)"/g)].map((m) => m[1]);
      return all.length >= 2 && all[1] !== 'running' && all[1] !== 'pending' ? all[1] : null;
    });
    expect(outside).toBe('denied');
  }, 30_000);

  it("makes the agent's computer, and the kill key pauses the agent until control returns (FR-207)", async () => {
    const agent = await newAgent();
    const computerId = await agentComputer(agent.id);
    expect(
      (await api('PUT', `/api/v1/computers/${computerId}/screen/control`, { enabled: true }))
        .status,
    ).toBe(200);
    const kill = await api('POST', `/api/v1/computers/${computerId}/screen/kill`);
    expect(kill.status, JSON.stringify(kill.json)).toBe(200);
    const paused = (await api('GET', `/api/v1/agents/${agent.id}`)).json;
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'user' });
    expect(String(paused.statusDetail)).toContain('kill key');
    const resume = await api('POST', `/api/v1/computers/${computerId}/screen/resume`);
    expect(resume.status, JSON.stringify(resume.json)).toBe(200);
    expect((await api('GET', `/api/v1/agents/${agent.id}`)).json.status).toBe('active');
  });

  it('a kill key never resumes an agent the user paused themselves', async () => {
    const agent = await newAgent();
    const computerId = await agentComputer(agent.id);
    await api('PUT', `/api/v1/computers/${computerId}/screen/control`, { enabled: true });
    expect((await api('POST', `/api/v1/agents/${agent.id}/pause`)).status).toBe(200);
    await api('POST', `/api/v1/computers/${computerId}/screen/kill`);
    await api('POST', `/api/v1/computers/${computerId}/screen/resume`);
    expect((await api('GET', `/api/v1/agents/${agent.id}`)).json.status).toBe('paused');
  });

  it("removes the agent's computer when the agent is deleted (FR-090)", async () => {
    const agent = await newAgent();
    const computerId = await agentComputer(agent.id);
    const del = await api('DELETE', `/api/v1/agents/${agent.id}`, { confirm: true });
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    const list = (await api('GET', '/api/v1/computers')).json.items as { id: string }[];
    expect(list.map((c) => c.id)).not.toContain(computerId);
  });

  it('answers on the configured public address once it is set (channels.publicUrl)', async () => {
    const hello = () =>
      hub.app.inject({
        method: 'GET',
        url: '/api/v1/hello',
        headers: { host: 'nova.tunnel.test' },
      });
    expect((await hello()).statusCode).toBe(403);
    const set = await api('PATCH', '/api/v1/settings', {
      key: 'channels.publicUrl',
      value: 'https://nova.tunnel.test',
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    await until(async () => (await hello()).statusCode === 200);
  });

  it("lists an agent's wake in the Scheduled list as set by the agent (FR-206)", async () => {
    const agent = await newAgent();
    const wake = await api('POST', `/api/v1/agents/${agent.id}/schedules`, {
      title: 'Check the inbox',
      when: { at: new Date(Date.now() + 3 * 3600_000).toISOString() },
      timezone: 'UTC',
      instructions: 'Look for anything new.',
    });
    expect(wake.status, JSON.stringify(wake.json)).toBe(201);
    const items = (await api('GET', '/api/v1/schedules')).json.items as {
      id: string;
      agentId: string | null;
    }[];
    expect(items.find((s) => s.id === wake.json.id)).toMatchObject({ agentId: agent.id });
  });
});
