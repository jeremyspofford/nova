// Security regressions for external agent adapters (FR-203; M7 review findings 2, 3, 8, 9, 17,
// 18, 19), ported from the review's probes: an adapter holds and resolves only its own vault
// entries and what an agent says about itself is cleaned; agents are refused where the routed
// sandbox is no sandbox, or cannot hold them to their hosts; the agent's egress policy is its
// own hosts only; turning the feature off stops running delegations and cancel and get still
// work; the agent's commands end with the delegation; terminals are capped; progress events are
// coalesced.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import {
  EnvHelperSandbox,
  ExternalAgentService,
  MAX_AGENT_TERMINALS,
  MAX_TERMINAL_OUTPUT,
  egressContext,
  execTools,
  fsTools,
  policyAcpHost,
  sandboxAgentLauncher,
  threadSandboxRouter,
  type AgentLaunch,
  type AgentLauncher,
  type ExecRequest,
  type ExecResult,
  type LineTransport,
  type SandboxClient,
  type ToolRuntime,
} from '../src/index.ts';
import { ACCOUNT, THREAD, flaggedEnv, type FlaggedEnv } from './flagged-env.ts';

type Msg = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

/** A scripted in-memory agent: `script` answers Nova's messages and may send its own. */
function scriptedLauncher(
  script: (
    l: AgentLaunch,
    io: { send: (m: Msg) => void; onMsg: (cb: (m: Msg) => void) => void },
  ) => void,
): AgentLauncher & { launches: AgentLaunch[]; state: { closed: number } } {
  const launches: AgentLaunch[] = [];
  const state = { closed: 0 };
  const launcher = (l: AgentLaunch): Promise<LineTransport> => {
    launches.push(l);
    const lineCbs: ((line: string) => void)[] = [];
    const msgCbs: ((m: Msg) => void)[] = [];
    const closers: ((r: string) => void)[] = [];
    const send = (m: Msg) =>
      queueMicrotask(() => lineCbs.forEach((cb) => cb(JSON.stringify({ jsonrpc: '2.0', ...m }))));
    script(l, { send, onMsg: (cb) => msgCbs.push(cb) });
    return Promise.resolve({
      send: (line) => {
        const m = JSON.parse(line) as Msg;
        queueMicrotask(() => msgCbs.forEach((cb) => cb(m)));
      },
      onLine: (cb) => void lineCbs.push(cb),
      onClose: (cb) => void closers.push(cb),
      close: () => {
        state.closed++;
        closers.forEach((cb) => cb('closed'));
        return Promise.resolve();
      },
    });
  };
  return Object.assign(launcher, { launches, state });
}

/** An agent that handshakes, starts a session and runs `onPrompt` for the prompt. */
function agent(
  onPrompt: (io: {
    send: (m: Msg) => void;
    request: (method: string, params: Record<string, unknown>) => Promise<Msg>;
    end: () => void;
  }) => void,
  info: (l: AgentLaunch) => { name?: string; version?: string } = () => ({
    name: 'agent',
    version: '1',
  }),
) {
  return scriptedLauncher((l, io) => {
    let next = 5000;
    const waiting = new Map<number, (m: Msg) => void>();
    io.onMsg((m) => {
      if (m.method === undefined && typeof m.id === 'number' && waiting.has(m.id)) {
        waiting.get(m.id)!(m);
        waiting.delete(m.id);
        return;
      }
      if (m.method === 'initialize')
        io.send({ id: m.id!, result: { protocolVersion: 1, agentInfo: info(l) } });
      else if (m.method === 'session/new') io.send({ id: m.id!, result: { sessionId: 's1' } });
      else if (m.method === 'session/prompt') {
        const promptId = m.id!;
        onPrompt({
          send: io.send,
          request: (method, params) =>
            new Promise((resolve) => {
              const id = next++;
              waiting.set(id, resolve);
              io.send({ id, method, params: { sessionId: 's1', ...params } });
            }),
          end: () => io.send({ id: promptId, result: { stopReason: 'end_turn' } }),
        });
      } else if (m.method === 'session/cancel') {
        // a well-behaved agent stops; the Hub stops it anyway
      }
    });
  });
}

const running = (id: string): ExecResult => ({ status: 'running', sessionId: id, output: '' });

/** A sandbox whose commands keep running until terminated; it records what it was told. */
function recordingSandbox() {
  const terminated: string[] = [];
  const execs: ExecRequest[] = [];
  let n = 0;
  const sb: SandboxClient = {
    substrate: 'container',
    available: () => Promise.resolve({ ok: true, detail: '' }),
    exec: (req) => {
      execs.push(req);
      return Promise.resolve(running(`S${++n}`));
    },
    poll: (id) => Promise.resolve(running(id)),
    write: (id, input) => {
      if (input.signal === 'terminate') terminated.push(id);
      return Promise.resolve();
    },
    killTurn: () => Promise.resolve(),
  };
  return { sb, terminated, execs };
}

let env: FlaggedEnv | undefined;
let service: ExternalAgentService | undefined;

async function setup(
  launcher: AgentLauncher,
  opts: { secrets?: MemorySecretStore; sandbox?: SandboxClient } = {},
) {
  env = await flaggedEnv({
    mode: 'code',
    tools: ({ dir, workspace }) => {
      const paths = { denied: [join(dir, 'data')], allowed: [workspace] };
      return [...fsTools({ paths }), ...execTools({ paths })];
    },
    sandbox: opts.sandbox ?? recordingSandbox().sb,
  });
  const now = new Date().toISOString();
  env.db.raw
    .prepare(
      'INSERT INTO code_session (id, account_id, thread_id, folder_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(uuidv7(), ACCOUNT, THREAD, env.workspace, now, now);
  service = new ExternalAgentService({
    db: env.db,
    events: env.events,
    audit: { append: (r) => Promise.resolve(void env!.audit.push(r)) },
    secrets: opts.secrets ?? new MemorySecretStore(),
    enabled: () => env!.setting('externalAgents.enabled'),
    launcher,
    runtime: () => env!.runtime,
    gate: () => env!.gate,
    startTimeoutMs: 5_000,
    cancelGraceMs: 100,
  });
  env.settings['externalAgents.enabled'] = true;
  return { env, service };
}

afterEach(async () => {
  await service?.close();
  await env?.close();
  env = undefined;
  service = undefined;
});

describe('finding 2: an adapter holds and resolves only its own secrets', () => {
  it('refuses a reference to another secret, and never resolves one in a row', async () => {
    const secrets = new MemorySecretStore();
    await secrets.put('secret://hub/identity', 'HUB-IDENTITY-PRIVATE-KEY');
    const launcher = agent(
      (io) => io.end(),
      (l) => ({ name: l.env.X ?? 'x' }),
    );
    const { service: s, env: e } = await setup(launcher, { secrets });
    await expect(
      s.createAdapter(ACCOUNT, {
        name: 'exfil',
        command: 'sh',
        env: { X: 'secret://hub/identity' },
        permissionRouting: 'client',
      }),
    ).rejects.toMatchObject({ code: 'validation', details: { reason: 'foreign_secret' } });
    // A row that holds one anyway (written before this check) is never resolved.
    const a = await s.createAdapter(ACCOUNT, {
      name: 'ok',
      command: 'agent',
      permissionRouting: 'client',
    });
    e.db.raw
      .prepare('UPDATE agent_adapter SET env_json = ? WHERE id = ?')
      .run(JSON.stringify({ X: 'secret://hub/identity' }), a.id);
    const check = await s.checkAdapter(ACCOUNT, a.id, THREAD);
    expect(check).toMatchObject({ ok: false });
    expect(launcher.launches).toHaveLength(0);
    expect(JSON.stringify(await s.getAdapter(ACCOUNT, a.id))).not.toContain('HUB-IDENTITY');
  });

  it('removes the agent’s own secrets from what it says about itself, redacted and clipped', async () => {
    const launcher = agent(
      (io) => io.end(),
      (l) => ({
        name: `agent ${l.env.TOKEN ?? ''} ${'n'.repeat(150)}`,
        version: `v-${l.env.TOKEN ?? ''}`,
      }),
    );
    const { service: s } = await setup(launcher);
    const a = await s.createAdapter(ACCOUNT, {
      name: 'echoer',
      command: 'agent',
      env: { TOKEN: 'own-secret-value-123' },
      permissionRouting: 'client',
    });
    const check = await s.checkAdapter(ACCOUNT, a.id, THREAD);
    expect(launcher.launches[0]!.env.TOKEN).toBe('own-secret-value-123');
    expect(JSON.stringify(check)).not.toContain('own-secret-value-123');
    expect(check.agent!.name!.length).toBeLessThanOrEqual(100);
    expect(check.agent!.version).toBe('v-[REDACTED]');
    const d = await s.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'go' });
    await s.whenDone(d.id);
    expect(JSON.stringify(await s.getDelegation(ACCOUNT, d.id))).not.toContain(
      'own-secret-value-123',
    );
  });
});

describe('finding 8: the flag stops running delegations; get and cancel always work', () => {
  it('stops the agent when the flag goes off, refuses its next request, and still reads and cancels', async () => {
    const hooks: { trigger: (() => Promise<Msg>) | null; finish: (() => void) | null } = {
      trigger: null,
      finish: null,
    };
    const launcher = agent((io) => {
      hooks.trigger = () =>
        io.request('fs/read_text_file', { path: join(env!.workspace, 'secret.txt') });
      hooks.finish = io.end;
    });
    const { service: s, env: e } = await setup(launcher);
    const a = await s.createAdapter(ACCOUNT, {
      name: 'a',
      command: 'agent',
      permissionRouting: 'client',
    });
    const d = await s.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 100));
    e.settings['externalAgents.enabled'] = false;
    // The agent's next request is refused and its delegation stopped.
    const reply = await hooks.trigger!();
    expect(reply.error).toMatchObject({ message: 'external agents were turned off' });
    await s.whenDone(d.id);
    hooks.finish?.();
    const view = await s.getDelegation(ACCOUNT, d.id);
    expect(view).toMatchObject({ status: 'cancelled', error: 'external agents were turned off' });
    await expect(s.cancel(ACCOUNT, d.id)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('stopAll ends every running delegation at once, audited as the system', async () => {
    const launcher = agent(() => undefined);
    const { env: e, service: s } = await setup(launcher);
    const a = await s.createAdapter(ACCOUNT, {
      name: 'a',
      command: 'agent',
      permissionRouting: 'client',
    });
    const d = await s.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.running).toBe(1);
    expect(await s.stopAll()).toBe(1);
    expect(s.running).toBe(0);
    expect(await s.getDelegation(ACCOUNT, d.id)).toMatchObject({ status: 'cancelled' });
    expect(launcher.state.closed).toBe(1);
    // Turning the feature off stopped it, not the user.
    expect(e.audit.filter((r) => r.action === 'delegation.cancel')).toEqual([
      expect.objectContaining({
        actor: 'system',
        resource: d.id,
        detail: { reason: 'external agents were turned off' },
      }),
    ]);
  });

  it('audits a cancel the user asked for as the user', async () => {
    const launcher = agent(() => undefined);
    const { env: e, service: s } = await setup(launcher);
    const a = await s.createAdapter(ACCOUNT, {
      name: 'a',
      command: 'agent',
      permissionRouting: 'client',
    });
    const d = await s.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'go' });
    await new Promise((r) => setTimeout(r, 50));
    await expect(s.cancel(ACCOUNT, d.id)).resolves.toMatchObject({ status: 'cancelled' });
    expect(e.audit.filter((r) => r.action === 'delegation.cancel')).toEqual([
      expect.objectContaining({ actor: 'user', resource: d.id }),
    ]);
  });
});

describe('findings 17 and 18: the agent’s commands', () => {
  it('caps terminals at once and stops every command when the delegation ends', async () => {
    const results: Msg[] = [];
    const rec = recordingSandbox();
    const launcher = agent((io) => {
      void (async () => {
        for (let i = 0; i <= MAX_AGENT_TERMINALS; i++)
          results.push(await io.request('terminal/create', { command: 'sleep', args: ['100'] }));
        io.end();
      })();
    });
    const { service: s, env: e } = await setup(launcher, { sandbox: rec.sb });
    await e.store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'exec.run' },
      effect: 'allow',
      label: 'commands ok',
    });
    const a = await s.createAdapter(ACCOUNT, {
      name: 'a',
      command: 'agent',
      permissionRouting: 'client',
    });
    const d = await s.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'go' });
    await s.whenDone(d.id);
    expect(results.filter((r) => r.result).length).toBe(MAX_AGENT_TERMINALS);
    expect(results.at(-1)!.error).toMatchObject({
      message: expect.stringMatching(/at most 8 terminals/),
    });
    // Every command still running was terminated when the delegation ended.
    expect(rec.terminated.sort()).toEqual(
      Array.from({ length: MAX_AGENT_TERMINALS }, (_, i) => `S${i + 1}`).sort(),
    );
  });

  it('keeps at most the cap of a terminal’s output, whatever the agent asks for', async () => {
    const big = 'b'.repeat(700_000);
    const terminated: string[] = [];
    const runtime = {
      registry: { find: () => Promise.resolve(null) },
      scopeFor: () =>
        Promise.resolve({ roots: [], profile: { id: 'p', hash: 'h' }, network: 'off' }),
      sandbox: {
        write: (id: string) => Promise.resolve(void terminated.push(id)),
      },
      execute: (x: { name: string }) =>
        Promise.resolve({
          callId: 'c',
          status: 'ok',
          ok: true,
          text: x.name === 'exec.run' ? `Still running (session T1). More\n${big}` : big,
          error: null,
          origin: null,
          stop: null,
          userAnswer: false,
        }),
    } as unknown as ToolRuntime;
    const host = policyAcpHost({
      runtime,
      gate: {
        check: () => Promise.reject(new Error('unused')),
        preview: () => Promise.reject(new Error('unused')),
      },
      accountId: ACCOUNT,
      threadId: THREAD,
      projectId: null,
      delegationId: 'd',
      adapterName: 'a',
      folder: '/w',
      signal: new AbortController().signal,
    });
    const big1 = await host.createTerminal({
      sessionId: 's',
      command: 'yes',
      outputByteLimit: 50_000_000,
    });
    const out = await host.terminalOutput(big1);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.output)).toBe(MAX_TERMINAL_OUTPUT);
    const small = await host.createTerminal({
      sessionId: 's',
      command: 'yes',
      outputByteLimit: 10,
    });
    expect((await host.terminalOutput(small)).output).toBe('bbbbbbbbbb');
    await host.closeAll();
    expect(terminated).toEqual(['T1', 'T1']);
    expect(host.terminals.size).toBe(0);
  });
});

describe('finding 19: progress events are coalesced', () => {
  it('turns a flood of chunks into a few events with the text joined', async () => {
    const launcher = agent((io) => {
      for (let i = 0; i < 500; i++)
        io.send({
          method: 'session/update',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
          },
        });
      for (let i = 0; i < 50; i++)
        io.send({
          method: 'session/update',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'tool_call', toolCallId: `t${i}`, title: 'T' },
          },
        });
      setTimeout(() => io.end(), 50);
    });
    const { service: s, env: e } = await setup(launcher);
    const a = await s.createAdapter(ACCOUNT, {
      name: 'a',
      command: 'agent',
      permissionRouting: 'client',
    });
    const d = await s.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'go' });
    await s.whenDone(d.id);
    const updates = e.events.events.filter((x) => x.name === 'delegation.updated');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.length).toBeLessThanOrEqual(3);
    expect(
      updates.map((u) => (typeof u.payload.message === 'string' ? u.payload.message : '')).join(''),
    ).toBe('x'.repeat(500));
    const tools = updates.flatMap((u) => (u.payload.toolCalls as unknown[] | undefined) ?? []);
    const dropped = updates.reduce((n, u) => n + Number(u.payload.droppedToolCalls ?? 0), 0);
    expect(tools.length + dropped).toBe(50);
    expect((await s.getDelegation(ACCOUNT, d.id)).output).toBe('x'.repeat(500));
  });
});

describe('findings 3 and 9: where an agent runs and what it may reach', () => {
  const launch = (over: Partial<AgentLaunch> = {}): AgentLaunch => ({
    accountId: ACCOUNT,
    threadId: THREAD,
    delegationId: 'd1',
    command: 'agent',
    args: [],
    env: {},
    folder: '/home/me/project',
    hosts: [],
    signal: new AbortController().signal,
    ...over,
  });

  it('refuses a routed sandbox that is no sandbox (SSH, WSL, a device), checking that client', async () => {
    const spawns: unknown[] = [];
    const conn = {
      hello: () =>
        Promise.resolve({
          version: '1',
          platform: 'linux',
          arch: null,
          verified: true,
          home: null,
        }),
      spawn: (spec: unknown) => {
        spawns.push(spec);
        return Promise.resolve({ id: 'p1' });
      },
    };
    const remote = new EnvHelperSandbox(() => Promise.resolve(conn as never));
    const base = recordingSandbox();
    const router = threadSandboxRouter(base.sb, () => remote);
    // Routed through the thread's environment: the remote helper has no substrate.
    await expect(
      sandboxAgentLauncher((a, t) => (t === THREAD ? remote : router))(launch()),
    ).rejects.toMatchObject({ code: 'sandbox_unavailable', details: { reason: 'no_substrate' } });
    expect(spawns).toEqual([]);
    expect(base.execs).toEqual([]);
    // The routed client's own availability decides, not the base's.
    const down: SandboxClient = {
      ...base.sb,
      available: () => Promise.resolve({ ok: false, detail: 'image missing' }),
    };
    await expect(sandboxAgentLauncher(() => down)(launch())).rejects.toThrow(/image missing/);
  });

  it('gives the agent its own hosts only, and no network where they cannot be enforced', async () => {
    const rec = recordingSandbox();
    const t = await sandboxAgentLauncher(() => rec.sb)(
      launch({ hosts: ['api.model.example', '*'] }),
    );
    await t.close();
    expect(rec.execs[0]).toMatchObject({
      network: 'allowlist',
      roots: [{ path: '/home/me/project', access: 'read' }],
      egress: {
        policy: { allow: ['api.model.example'] },
        scope: { kind: 'sandbox', id: 'agent-d1' },
      },
    });
    // The egress context carries the policy, which replaces the scopes' grants and credentials.
    expect(egressContext(rec.execs[0] as never)).toMatchObject({
      policy: { allow: ['api.model.example'] },
    });
    const t2 = await sandboxAgentLauncher(() => rec.sb)(launch());
    await t2.close();
    expect(rec.execs[1]).toMatchObject({ network: 'off' });
    const cloud: SandboxClient = { ...rec.sb, substrate: 'cloud' };
    await expect(
      sandboxAgentLauncher(() => cloud)(launch({ hosts: ['api.model.example'] })),
    ).rejects.toMatchObject({ details: { reason: 'no_egress_proxy' } });
    const t3 = await sandboxAgentLauncher(() => cloud)(launch());
    await t3.close();
  });
});
