// M5 through the fully wired Hub (app.ts): a Work run starts a turn on the chat loop and ends
// with its structured result; a Code session captures a file change in its folder; a schedule
// fired now starts a run and records the fire; threads carry their derived status (FR-215).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@nova/providers';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';

let dir: string;
let db: NovaDatabase;
let config: HubConfig;
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

const api = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
  const res = await hub.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, json: res.json<Record<string, unknown>>() };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-m5-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
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

describe('M5 through the wired Hub', () => {
  it('runs a Work run on the chat loop to its structured result, with a derived status', async () => {
    const created = await api('POST', '/api/v1/runs', {
      objective: '/tool run.complete {"summary":"Report ready"}',
      autonomy: 'standard',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const runId = created.json.id as string;
    const threadId = created.json.threadId as string;
    const done = await until(async () => {
      const r = (await api('GET', `/api/v1/runs/${runId}`)).json;
      return ['done', 'paused', 'failed', 'output_missing'].includes(r.status as string) ? r : null;
    });
    expect(done).toMatchObject({ status: 'done', result: { summary: 'Report ready' } });
    // The run's thread is a work thread with the objective labelled as the run's.
    const detail = (await api('GET', `/api/v1/threads/${threadId}`)).json as {
      thread: { mode: string; derived?: { status: string } };
      messages: { role: string; provenance?: string }[];
    };
    expect(detail.thread.mode).toBe('work');
    expect(detail.thread.derived?.status).toBe('ready');
    expect(detail.messages[0]).toMatchObject({ role: 'user', provenance: 'run' });
    const activity = await api('GET', `/api/v1/runs/${runId}/activity`);
    expect(activity.status).toBe(200);
  });

  it('captures a file change in a Code session folder as a diff', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
        cwd: repo,
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const created = await api('POST', '/api/v1/code/sessions', { folder: repo });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.id as string;
    expect(created.json).toMatchObject({ permissionMode: 'manual' });
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    const changes = (await api('GET', `/api/v1/code/sessions/${id}/changes`)).json as {
      items: { path: string; additions: number }[];
    };
    expect(changes.items).toEqual([expect.objectContaining({ path: 'a.txt', additions: 1 })]);
  });

  it("runs the agent's file tools in the session folder, never the Nova workspace (FR-063)", async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
        cwd: repo,
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const created = await api('POST', '/api/v1/code/sessions', {
      folder: repo,
      permissionMode: 'accept_edits',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.id as string;
    const threadId = created.json.threadId as string;
    // Relative paths, as an agent writes them: they resolve in the session's folder.
    const patch = '%%% patch\n%%% update a.txt\n@@\n one\n+two\n%%% end';
    const sent = await api('POST', `/api/v1/threads/${threadId}/messages`, {
      text: `/tool fs.edit ${JSON.stringify({ patch })}\n/tool fs.write {"path":"b.txt","content":"new"}`,
    });
    expect(sent.status, JSON.stringify(sent.json)).toBe(202);
    const detail = await until(async () => {
      const d = (await api('GET', `/api/v1/threads/${threadId}`)).json as {
        thread: { state: string };
        messages: { role: string; parts: { type: string; tool?: string; status?: string }[] }[];
      };
      const calls = d.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool_call'));
      return d.thread.state === 'idle' && calls.length === 2 ? calls : null;
    });
    expect(detail.map((c) => [c.tool, c.status])).toEqual([
      ['fs.edit', 'ok'],
      ['fs.write', 'ok'],
    ]);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('new');
    expect(existsSync(join(config.dataDir, 'workspace', 'b.txt'))).toBe(false);
    const changes = (await api('GET', `/api/v1/code/sessions/${id}/changes`)).json as {
      items: { path: string }[];
    };
    expect(changes.items.map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('fires a schedule now: a run starts and the fire is recorded', async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const created = await api('POST', '/api/v1/schedules', {
      when: { at },
      timezone: 'UTC',
      instructions: 'Say hello',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.id as string;
    const fired = await api('POST', `/api/v1/schedules/${id}/run`, {});
    expect(fired.status, JSON.stringify(fired.json)).toBe(201);
    const runId = fired.json.runId as string;
    const fires = await until(async () => {
      const f = (await api('GET', `/api/v1/schedules/${id}/fires`)).json as {
        items: { runId: string; outcome: string | null }[];
      };
      return f.items.find((x) => x.runId === runId && x.outcome) ?? null;
    });
    // Delivered in-app with a receipt: the run's reply counts as its message (FR-187).
    expect(fires.outcome).toBe('done');
  });
});
