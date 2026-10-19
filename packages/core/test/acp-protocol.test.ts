// The Agent Client Protocol client's framing and dispatch (FR-203): JSON-RPC 2.0 over lines, with
// everything from the agent untrusted (noise, oversized lines, bad ids, unknown methods, a broken
// handler, too many requests at once), the handshake's version check, prompts, cancellation and
// how a permission answer picks the agent's option. The sandbox launcher's command line, mounts
// and polling are checked with a fake sandbox.
import { describe, expect, it } from 'vitest';
import {
  AcpClient,
  AgentRefused,
  JsonRpcError,
  JsonRpcPeer,
  agentCommandLine,
  pickOption,
  sandboxAgentLauncher,
  type AcpHost,
  type ExecResult,
  type LineTransport,
  type PermissionRequest,
  type SandboxClient,
} from '../src/index.ts';

/** Two ends of an in-memory line transport. */
function pipe(): { a: LineTransport; b: LineTransport; closeB: (r: string) => void } {
  const aLines: ((l: string) => void)[] = [];
  const bLines: ((l: string) => void)[] = [];
  const aClose: ((r: string) => void)[] = [];
  const bClose: ((r: string) => void)[] = [];
  const mk = (
    mine: ((l: string) => void)[],
    theirs: ((l: string) => void)[],
    closers: ((r: string) => void)[],
    other: ((r: string) => void)[],
  ): LineTransport => ({
    send: (line) => queueMicrotask(() => theirs.forEach((cb) => cb(line))),
    onLine: (cb) => void mine.push(cb),
    onClose: (cb) => void closers.push(cb),
    close: () => {
      closers.forEach((cb) => cb('closed'));
      other.forEach((cb) => cb('peer closed'));
      return Promise.resolve();
    },
  });
  return {
    a: mk(aLines, bLines, aClose, bClose),
    b: mk(bLines, aLines, bClose, aClose),
    closeB: (r) => aClose.forEach((cb) => cb(r)),
  };
}

const noHost: AcpHost = {
  requestPermission: () => Promise.resolve('reject'),
  readTextFile: () => Promise.resolve('file text'),
  writeTextFile: () => Promise.resolve(),
  createTerminal: () => Promise.resolve('t1'),
  terminalOutput: () => Promise.resolve({ output: 'o', truncated: false, exitStatus: null }),
  waitForExit: () => Promise.resolve({ exitCode: 0, signal: null }),
  killTerminal: () => Promise.resolve(),
  releaseTerminal: () => Promise.resolve(),
};

/** A scripted agent on the other end: answers Nova's requests and can send its own. */
function agent(
  t: LineTransport,
  answer: (method: string, params: unknown, id: number) => unknown = () => ({}),
) {
  const sent: Record<string, unknown>[] = [];
  const replies = new Map<number, (m: Record<string, unknown>) => void>();
  t.onLine((line) => {
    const m = JSON.parse(line) as Record<string, unknown>;
    sent.push(m);
    if (typeof m.method === 'string' && m.id !== undefined) {
      const result = answer(m.method, m.params, m.id as number);
      if (result instanceof Error)
        t.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: m.id,
            error: { code: -1, message: result.message },
          }),
        );
      else if (result !== undefined) t.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    } else if (typeof m.id === 'number') replies.get(m.id)?.(m);
  });
  let n = 500;
  return {
    sent,
    raw: (line: string) => t.send(line),
    request: (method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = n++;
        replies.set(id, resolve);
        t.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      }),
  };
}

const init = {
  protocolVersion: 1,
  agentCapabilities: {},
  authMethods: [],
  agentInfo: { name: 'x' },
};

describe('JSON-RPC peer', () => {
  it('ignores noise and answers unknown methods, bad params and failing handlers with errors', async () => {
    const { a, b } = pipe();
    const peer = new JsonRpcPeer({
      transport: a,
      onRequest: (method) => {
        if (method === 'boom') return Promise.reject(new Error('handler failed'));
        if (method === 'coded') return Promise.reject(new JsonRpcError(-32099, 'coded', { x: 1 }));
        return Promise.resolve({ ok: method });
      },
      onNotification: () => {
        throw new Error('notification handlers may throw');
      },
      maxLineChars: 1000,
    });
    const other = agent(b);
    for (const noise of [
      'plain text',
      '[1,2]',
      '{"not":"rpc"}',
      '{broken',
      `{"jsonrpc":"2.0","method":"x","id":{"bad":1},"params":{}}`,
      `{"jsonrpc":"2.0","id":"str","result":1}`,
      `{"jsonrpc":"2.0","id":1,"result":{"pad":"${'x'.repeat(2000)}"}}`,
      '',
    ])
      other.raw(noise);
    other.raw('{"jsonrpc":"2.0","method":"note","params":{}}');
    expect(await other.request('ping', {})).toMatchObject({ result: { ok: 'ping' } });
    expect(await other.request('boom', {})).toMatchObject({
      error: { code: -32603, message: 'handler failed' },
    });
    expect(await other.request('coded', {})).toMatchObject({
      error: { code: -32099, message: 'coded', data: { x: 1 } },
    });
    expect(peer.ignored).toBe(7);
    await peer.close();
    await expect(peer.request('late', {})).rejects.toThrow(/gone/);
  });

  it('times out, can be cancelled, rejects pending requests when the agent goes, and caps inbound', async () => {
    const { a, b, closeB } = pipe();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const peer = new JsonRpcPeer({
      transport: a,
      onRequest: async () => {
        await held;
        return 1;
      },
      onNotification: () => undefined,
      maxInbound: 2,
    });
    const other = agent(b, () => undefined);
    await expect(peer.request('slow', {}, { timeoutMs: 20 })).rejects.toThrow(/in time/);
    const ac = new AbortController();
    const cancelled = peer.request('slow', {}, { signal: ac.signal });
    ac.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/);
    const r1 = other.request('a', {});
    const r2 = other.request('b', {});
    expect(await other.request('c', {})).toMatchObject({
      error: { message: 'too many requests at once' },
    });
    release();
    expect(await r1).toMatchObject({ result: 1 });
    expect(await r2).toMatchObject({ result: 1 });
    const pending = peer.request('never', {});
    closeB('the agent exited with code 1');
    await expect(pending).rejects.toThrow(/exited with code 1/);
    expect(peer.closed).toBe(true);
  });
});

describe('ACP client', () => {
  it('advertises Nova’s file system and terminal, refuses another protocol version', async () => {
    const { a, b } = pipe();
    const other = agent(b, (m) => (m === 'initialize' ? { ...init, protocolVersion: 2 } : {}));
    const client = new AcpClient({ transport: a, host: noHost });
    await expect(client.initialize()).rejects.toBeInstanceOf(AgentRefused);
    expect(other.sent[0]).toMatchObject({
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      },
    });
    const p2 = pipe();
    agent(p2.b, () => ({ nonsense: true }));
    await expect(new AcpClient({ transport: p2.a, host: noHost }).initialize()).rejects.toThrow(
      /handshake/,
    );
  });

  it('starts a session, prompts, relays updates of its own session only, and dispatches requests', async () => {
    const { a, b } = pipe();
    const updates: unknown[] = [];
    const other: ReturnType<typeof agent> = agent(b, (m, _params, promptId) => {
      if (m === 'initialize') return init;
      if (m === 'session/new') return { sessionId: 's1' };
      if (m === 'session/prompt') {
        void (async () => {
          other.raw(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk' } },
            }),
          );
          other.raw(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 's1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'hi' },
                },
              },
            }),
          );
          const read = await other.request('fs/read_text_file', { sessionId: 's1', path: '/w/a' });
          const wrong = await other.request('fs/read_text_file', {
            sessionId: 'nope',
            path: '/w/a',
          });
          const bad = await other.request('fs/write_text_file', { sessionId: 's1' });
          const unknown = await other.request('agent/do_anything', { sessionId: 's1' });
          const term = await other.request('terminal/create', { sessionId: 's1', command: 'ls' });
          const out = await other.request('terminal/output', { sessionId: 's1', terminalId: 't1' });
          const wait = await other.request('terminal/wait_for_exit', {
            sessionId: 's1',
            terminalId: 't1',
          });
          const kill = await other.request('terminal/kill', { sessionId: 's1', terminalId: 't1' });
          const rel = await other.request('terminal/release', {
            sessionId: 's1',
            terminalId: 't1',
          });
          const write = await other.request('fs/write_text_file', {
            sessionId: 's1',
            path: '/w/a',
            content: 'x',
          });
          other.raw(
            JSON.stringify({
              jsonrpc: '2.0',
              id: promptId,
              result: {
                stopReason: 'end_turn',
                log: [read, wrong, bad, unknown, term, out, wait, kill, rel, write],
              },
            }),
          );
        })();
        return undefined;
      }
      return {};
    });
    const client = new AcpClient({ transport: a, host: noHost, onUpdate: (u) => updates.push(u) });
    await client.initialize();
    expect(await client.newSession('/w')).toBe('s1');
    expect(client.sessionId).toBe('s1');
    const stop = await client.prompt('do it', new AbortController().signal);
    expect(stop).toBe('end_turn');
    const promptMsg = other.sent.find((m) => m.method === 'session/prompt')!;
    expect(promptMsg.params).toEqual({
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'do it' }],
    });
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    ]);
    expect(client.counts).toEqual({ permission: 0, operations: 4 });
    await client.close();
  });

  it('sends session/cancel on abort and treats silence after it as cancelled', async () => {
    const { a, b } = pipe();
    const other = agent(b, (m) => {
      if (m === 'initialize') return init;
      if (m === 'session/new') return { sessionId: 's1' };
      return undefined;
    });
    const client = new AcpClient({ transport: a, host: noHost, cancelGraceMs: 20 });
    await client.initialize();
    await client.newSession('/w');
    const ac = new AbortController();
    const p = client.prompt('hang', ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect(await p).toBe('cancelled');
    expect(other.sent.some((m) => m.method === 'session/cancel')).toBe(true);
    await expect(client.prompt('x', ac.signal)).resolves.toBe('cancelled');
  });

  it('answers a permission request through the host and refuses a bad stop reason', async () => {
    const { a, b } = pipe();
    let answer: unknown;
    const other: ReturnType<typeof agent> = agent(b, (m, _p, promptId) => {
      if (m === 'initialize') return init;
      if (m === 'session/new') return { sessionId: 's1' };
      if (m === 'session/prompt') {
        void other
          .request('session/request_permission', {
            sessionId: 's1',
            toolCall: { toolCallId: 'x', kind: 'edit' },
            options: [
              { optionId: 'y', kind: 'allow_once' },
              { optionId: 'n', kind: 'reject_once' },
            ],
          })
          .then((r) => {
            answer = r.result;
            other.raw(
              JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'weird' } }),
            );
          });
        return undefined;
      }
      return {};
    });
    const client = new AcpClient({
      transport: a,
      host: { ...noHost, requestPermission: () => Promise.resolve('allow') },
    });
    await client.initialize();
    await client.newSession('/w');
    // The fake answers the prompt with an unknown stop reason.
    await expect(client.prompt('go', new AbortController().signal)).rejects.toThrow(
      /ended the turn/,
    );
    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'y' } });
    expect(client.counts.permission).toBe(1);
  });
});

describe('permission options', () => {
  const req = (kinds: string[]): PermissionRequest => ({
    sessionId: 's',
    toolCall: { toolCallId: 't' },
    options: kinds.map((kind, i) => ({ optionId: `o${i}`, kind })),
  });
  it('never picks allow_always, and rejects when only that would allow', () => {
    expect(pickOption(req(['allow_always', 'allow_once', 'reject_once']), 'allow')).toEqual({
      outcome: 'selected',
      optionId: 'o1',
    });
    expect(pickOption(req(['allow_always', 'reject_always']), 'allow')).toEqual({
      outcome: 'selected',
      optionId: 'o1',
    });
    expect(pickOption(req(['allow_always']), 'allow')).toEqual({ outcome: 'cancelled' });
    expect(pickOption(req(['allow_once', 'reject_once']), 'reject')).toEqual({
      outcome: 'selected',
      optionId: 'o1',
    });
    expect(pickOption(req(['allow_once']), 'cancelled')).toEqual({ outcome: 'cancelled' });
  });
});

describe('sandbox agent launcher', () => {
  it('runs the agent in the session sandbox, folder read-only, stderr discarded, and polls it', async () => {
    const execs: Record<string, unknown>[] = [];
    const writes: unknown[] = [];
    const outputs = ['{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc"', ':"2.0","method":"b"}\n'];
    let polls = 0;
    const sandbox: SandboxClient = {
      substrate: 'container',
      available: () => Promise.resolve({ ok: true, detail: '' }),
      exec: (req) => {
        execs.push(req as unknown as Record<string, unknown>);
        return Promise.resolve({ status: 'running', sessionId: 'S', output: 'note: no network\n' });
      },
      poll: async (): Promise<ExecResult> => {
        await new Promise((r) => setTimeout(r, 1));
        const out = outputs[polls++];
        if (out === undefined) return { status: 'exited', exitCode: 0, output: '' };
        return { status: 'running', sessionId: 'S', output: out };
      },
      write: (id, input) => {
        writes.push([id, input]);
        return Promise.resolve();
      },
      killTurn: () => Promise.resolve(),
    };
    const t = await sandboxAgentLauncher(() => sandbox)({
      accountId: 'acc',
      threadId: 'th',
      delegationId: 'd1',
      command: '/opt/agent/bin/agent',
      args: ['--acp', "it's"],
      env: { KEY: 'v' },
      folder: '/work/repo',
      hosts: [],
      signal: new AbortController().signal,
    });
    const lines: string[] = [];
    const closed = new Promise<string>((r) => t.onClose(r));
    t.onLine((l) => lines.push(l));
    t.send('{"x":1}');
    expect(await closed).toMatch(/exited with code 0/);
    expect(lines).toEqual([
      'note: no network',
      '{"jsonrpc":"2.0","method":"a"}',
      '{"jsonrpc":"2.0","method":"b"}',
    ]);
    expect(execs[0]).toMatchObject({
      cmd: `exec /opt/agent/bin/agent --acp 'it'\\''s' 2>/dev/null`,
      cwd: '/work/repo',
      roots: [{ path: '/work/repo', access: 'read' }],
      network: 'off',
      env: { KEY: 'v' },
      egress: {
        accountId: 'acc',
        threadId: 'th',
        scope: { kind: 'sandbox', id: 'agent-d1' },
        policy: { allow: [] },
      },
    });
    expect(writes).toEqual([['S', { text: '{"x":1}\n' }]]);
    await t.close();
  });

  it('fails closed without a sandbox and reports an agent that exits at once', async () => {
    const launch = {
      accountId: 'a',
      threadId: 't',
      delegationId: 'd',
      command: 'agent',
      args: [],
      env: {},
      folder: '/w',
      hosts: [],
      signal: new AbortController().signal,
    };
    await expect(sandboxAgentLauncher(() => null)(launch)).rejects.toMatchObject({
      code: 'sandbox_unavailable',
    });
    const down: SandboxClient = {
      substrate: null,
      available: () => Promise.resolve({ ok: false, detail: 'no container runtime' }),
      exec: () => Promise.reject(new Error('never')),
      poll: () => Promise.reject(new Error('never')),
      write: () => Promise.resolve(),
      killTurn: () => Promise.resolve(),
    };
    await expect(sandboxAgentLauncher(() => down)(launch)).rejects.toMatchObject({
      code: 'sandbox_unavailable',
    });
    const quick: SandboxClient = {
      ...down,
      substrate: 'container',
      available: () => Promise.resolve({ ok: true, detail: '' }),
      exec: () => Promise.resolve({ status: 'exited', exitCode: 127, output: 'not found\n' }),
    };
    const t = await sandboxAgentLauncher(() => quick)(launch);
    const closed = new Promise<string>((r) => t.onClose(r));
    expect(await closed).toMatch(/code 127/);
    t.send('ignored');
    await t.close();
    expect(agentCommandLine('a b', [])).toBe("exec 'a b' 2>/dev/null");
  });
});
