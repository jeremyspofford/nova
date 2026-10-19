// script.run (FR-202) through the real tool runtime and policy gate: every nested call reaches
// the gate as a call of its own (an ask pauses the script until the user answers, a deny fails
// that call), each is recorded with the script's call as its parent and audited naming the
// script, taint from nested results carries to later calls, and with the flag off the tool is
// absent and refuses.
import { afterEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import {
  runtimeNestedCaller,
  scriptTool,
  scriptToolSource,
  type NestedToolCaller,
  type Provenance,
  type ToolContext,
} from '../src/index.ts';
import { ACCOUNT, THREAD, TURN, demoTool, flaggedEnv, type FlaggedEnv } from './flagged-env.ts';

let env: FlaggedEnv;
afterEach(() => env.close());

const read = demoTool('demo.read', {
  descriptor: { annotations: { readOnly: true, action: 'read' } },
  origin: 'file',
  run: (args) => ({
    ok: true,
    content: [{ type: 'text', text: `contents of ${(args as { path: string }).path}` }],
  }),
});
let writes: unknown[] = [];
const write = demoTool('demo.write', {
  descriptor: { annotations: { destructive: true, action: 'write' }, effects: ['file_write'] },
  run: (args) => {
    writes.push(args);
    return { ok: true, content: [{ type: 'text', text: 'written' }] };
  },
});

async function setup(enabled = true) {
  writes = [];
  env = await flaggedEnv({
    tools: [read, write],
    sources: ({ db }) => [
      scriptToolSource({
        enabled: () => env.setting('scripts.enabled'),
        limits: async () => {
          const l = await env.setting('scripts.limits');
          return { cpuMs: l.cpuMs, maxCalls: l.maxCalls };
        },
        caller: runtimeNestedCaller({ runtime: () => env.runtime, db }),
        db,
        audit: { append: (r) => Promise.resolve(void env.audit.push(r)) },
      }),
    ],
  });
  env.settings['scripts.enabled'] = enabled;
}

/** Run script.run as the model would, in a turn the user typed. */
async function modelCall(code: string, input?: unknown) {
  const msg = uuidv7();
  const now = new Date().toISOString();
  env.db.raw
    .prepare(
      "INSERT INTO message (id, thread_id, turn_id, role, created_at, updated_at) VALUES (?, ?, ?, 'assistant', ?, ?)",
    )
    .run(msg, THREAD, TURN, now, now);
  const turn = await env.runtime.beginTurn({
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: TURN,
    projectId: null,
    mode: 'chat',
    signal: new AbortController().signal,
  });
  const args: Record<string, unknown> = { code };
  if (input !== undefined) args.input = input;
  const out = await turn.call({
    call: { id: 'm-1', name: 'script.run', args },
    messageId: msg,
    partIdx: 0,
    provenance: { userInstruction: { messageId: 'u1', accountId: ACCOUNT }, taint: [] },
  });
  const row = env.db.raw
    .prepare('SELECT status, result_json AS result FROM tool_call WHERE id = ?')
    .get(out.callId) as { status: string; result: string };
  const result = JSON.parse(row.result) as {
    content: { text: string }[];
    meta: { calls: { callId: string; tool: string; status: string }[] } | null;
  };
  return { ...out, text: result.content[0]!.text, meta: result.meta };
}

const nested = (parent: string) =>
  env.db.raw
    .prepare(
      'SELECT id, tool_name AS tool, status, origin, decision, message_id AS messageId FROM tool_call WHERE parent_call_id = ? ORDER BY created_at',
    )
    .all(parent) as {
    id: string;
    tool: string;
    status: string;
    origin: string;
    decision: string;
    messageId: string | null;
  }[];

describe('script.run behind its flag', () => {
  it('is absent and refuses while scripts.enabled is off', async () => {
    await setup(false);
    expect((await env.runtime.registry.list(ACCOUNT)).map((t) => t.descriptor.name)).not.toContain(
      'script.run',
    );
    const tool = scriptTool({
      enabled: () => Promise.resolve(false),
      caller: { open: () => Promise.reject(new Error('never opened')) },
    });
    const r = await tool.handler({ code: 'return 1' }, {} as ToolContext);
    expect(r).toMatchObject({ ok: false, error: { code: 'disabled' } });
  });

  it('is listed while on, as a read-only built-in whose nested calls are judged on their own', async () => {
    await setup(true);
    const def = await env.runtime.registry.find(ACCOUNT, 'script.run');
    expect(def?.descriptor).toMatchObject({
      source: 'builtin',
      annotations: { readOnly: true },
      timeoutMs: 600_000,
    });
  });
});

describe('nested calls pass the gate', () => {
  it('allows a read, records it under the script and audits both', async () => {
    await setup();
    const out = await modelCall(
      'const a = await tools["demo.read"]({path: input.file}); return a.toUpperCase()',
      { file: 'notes.md' },
    );
    expect(out.status).toBe('ok');
    expect(out.text).toContain('Result: "CONTENTS OF NOTES.MD"');
    const rows = nested(out.callId);
    expect(rows).toEqual([
      expect.objectContaining({
        tool: 'demo.read',
        status: 'ok',
        // The script origin (docs/08 §1.5), judged like the model's own call.
        origin: 'script',
        decision: 'allow',
      }),
    ]);
    // Nested calls are not parts of the reply message.
    expect(rows[0]!.messageId).toBeNull();
    // The gate decided the nested call itself, and the audit names the script.
    expect(env.audit.some((a) => a.kind === 'policy' && a.action === 'demo.read')).toBe(true);
    expect(env.audit.find((a) => a.action === 'script.call')).toMatchObject({
      kind: 'tool_call',
      resource: 'demo.read',
      result: 'ok',
      detail: { scriptCallId: out.callId, callId: rows[0]!.id, tool: 'demo.read' },
    });
    expect(env.audit.find((a) => a.kind === 'tool_call' && a.action === 'demo.read')).toMatchObject(
      { detail: { callId: rows[0]!.id } },
    );
    expect(out.meta?.calls).toEqual([{ callId: rows[0]!.id, tool: 'demo.read', status: 'ok' }]);
    const run = env.db.raw.prepare('SELECT * FROM script_run WHERE id = ?').get(out.callId) as {
      status: string;
      calls: number;
      code_sha256: string;
    };
    expect(run).toMatchObject({ status: 'ok', calls: 1 });
    expect(run.code_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the script origin for a script the user started from the UI (M8)', async () => {
    await setup();
    const { callId, done } = await env.runtime.invoke({
      accountId: ACCOUNT,
      name: 'script.run',
      args: { code: 'return await tools.call("demo.read", {path: "x"})' },
      threadId: THREAD,
      initiator: 'user',
    });
    expect((await done).ok).toBe(true);
    const row = env.db.raw.prepare('SELECT origin FROM tool_call WHERE id = ?').get(callId) as {
      origin: string;
    };
    // The script call is the user's; its nested call is the script's, never the user's own.
    expect(row.origin).toBe('ui');
    expect(nested(callId)).toEqual([expect.objectContaining({ origin: 'script', status: 'ok' })]);
    const policy = env.audit.filter((a) => a.kind === 'policy' && a.action === 'demo.read');
    expect(policy.length).toBeGreaterThan(0);
    expect(policy.every((a) => a.actor !== 'user')).toBe(true);
  });

  it('pauses the script on an ask and continues once the user allows it', async () => {
    await setup();
    const before = env.approvals();
    const pending = modelCall(
      'const r = await tools.call("demo.write", {path: "a.txt"}); return r',
    );
    const approvalId = await env.nextApproval(before);
    // The script waits: nothing was written while the approval is open.
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toEqual([]);
    const approval = env.db.raw
      .prepare('SELECT tool_call_id AS callId, thread_id AS threadId FROM approval WHERE id = ?')
      .get(approvalId) as { callId: string; threadId: string };
    expect(approval.threadId).toBe(THREAD);
    await env.gate.decide(ACCOUNT, { approvalId, decision: 'allow_once' });
    const out = await pending;
    expect(out.status).toBe('ok');
    expect(out.text).toContain('Result: "written"');
    expect(writes).toEqual([{ path: 'a.txt' }]);
    expect(nested(out.callId)).toEqual([
      expect.objectContaining({ id: approval.callId, tool: 'demo.write', status: 'ok' }),
    ]);
  });

  it('fails the nested call when the user denies, and the script sees why', async () => {
    await setup();
    const before = env.approvals();
    const pending = modelCall(
      'try { await tools.call("demo.write", {path: "a.txt"}) } catch (e) { return e.code }',
    );
    const approvalId = await env.nextApproval(before);
    await env.gate.decide(ACCOUNT, { approvalId, decision: 'deny_continue' });
    const out = await pending;
    expect(out.text).toContain('Result: "denied"');
    expect(writes).toEqual([]);
    expect(nested(out.callId)[0]).toMatchObject({ status: 'denied', decision: 'deny' });
  });

  it('fails a call a rule denies without asking', async () => {
    await setup();
    await env.store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'demo.write' },
      effect: 'deny',
      label: 'No writes',
    });
    const before = env.approvals();
    const out = await modelCall(
      'const r = []; for (const p of ["a", "b"]) { try { await tools.call("demo.write", {path: p}) } catch (e) { r.push(e.message) } } return r',
    );
    expect(env.approvals()).toBe(before);
    expect(out.text).toContain('Denied: rule');
    expect(nested(out.callId).map((r) => r.status)).toEqual(['denied', 'denied']);
    expect(writes).toEqual([]);
  });

  it('carries taint from a nested result to the next call', async () => {
    await setup();
    await env.store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'demo.write' },
      effect: 'allow',
      label: 'Writes ok',
    });
    const out = await modelCall(
      'await tools.call("demo.read", {path: "x"}); return await tools.call("demo.write", {path: "y"})',
    );
    expect(out.status).toBe('ok');
    const audits = env.audit.filter((a) => a.kind === 'tool_call' && a.action.startsWith('demo.'));
    expect(audits.map((a) => [a.action, a.detail?.taint, a.detail?.userAsked])).toEqual([
      ['demo.read', ['tool'], false],
      ['demo.write', ['tool', 'file'], false],
    ]);
  });

  it('refuses tools that belong to the loop, and unknown tools fail like direct calls', async () => {
    await setup();
    const out = await modelCall(
      `const r = [];
       for (const n of ["script.run", "tool.search", "nope.tool"]) {
         try { await tools.call(n, {}) } catch (e) { r.push(n + ":" + e.code) }
       }
       return [r, tools.names]`,
    );
    expect(out.text).toContain('script.run:not_allowed');
    expect(out.text).toContain('tool.search:not_allowed');
    expect(out.text).toContain('nope.tool:unknown_tool');
    expect(out.text).toContain('["demo.read","demo.write"]');
  });

  it('reports a script that runs out of CPU as a failed call with its output so far', async () => {
    await setup();
    env.settings['scripts.limits'] = { cpuMs: 200, memoryMb: 32, maxCalls: 2, logChars: 20_000 };
    const out = await modelCall('console.log("before"); while (true) {}');
    expect(out.status).toBe('error');
    expect(out.text).toContain('cpu_limit');
    expect(out.text).toContain('before');
    const run = env.db.raw
      .prepare('SELECT status, error_code AS code FROM script_run WHERE id = ?')
      .get(out.callId);
    expect(run).toEqual({ status: 'error', code: 'cpu_limit' });
  });

  it('applies the call limit from the settings', async () => {
    await setup();
    env.settings['scripts.limits'] = { cpuMs: 10_000, memoryMb: 32, maxCalls: 2, logChars: 20_000 };
    const out = await modelCall(
      'const r = []; for (let i = 0; i < 4; i++) { r.push(await tools.call("demo.read", {path: String(i)}).then(() => "ok", (e) => e.code)) } return r',
    );
    expect(out.text).toContain('["ok","ok","call_limit","call_limit"]');
    expect(nested(out.callId)).toHaveLength(2);
  });
});

describe('provenance of nested calls', () => {
  it('inherits the provenance when the context carries it, and never adds an instruction', async () => {
    const seen: Provenance[] = [];
    const caller: NestedToolCaller = {
      open: () =>
        Promise.resolve({
          names: ['demo.read'],
          call: (_name, _args, p) => {
            seen.push(p);
            return Promise.resolve({
              callId: uuidv7(),
              status: 'ok',
              ok: true,
              text: 't',
              error: null,
              origin: 'page',
            });
          },
        }),
    };
    const tool = scriptTool({ enabled: () => Promise.resolve(true), caller });
    const ctx = {
      accountId: ACCOUNT,
      threadId: '',
      turnId: '',
      callId: 'c1',
      projectId: null,
      origin: 'model',
      signal: new AbortController().signal,
      provenance: { userInstruction: { messageId: 'u1', accountId: ACCOUNT }, taint: [] },
    } as unknown as ToolContext;
    const r = await tool.handler(
      { code: 'await tools.call("demo.read"); await tools.call("demo.read")' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual([
      { userInstruction: { messageId: 'u1', accountId: ACCOUNT }, taint: [] },
      { userInstruction: { messageId: 'u1', accountId: ACCOUNT }, taint: ['page'] },
    ]);
    const bare = { ...ctx, provenance: undefined } as unknown as ToolContext;
    seen.length = 0;
    await tool.handler({ code: 'await tools.call("demo.read")' }, bare);
    expect(seen).toEqual([{ taint: ['tool'] }]);
  });

  it('refuses an empty script and works without a runtime', async () => {
    const caller = runtimeNestedCaller({ runtime: () => null, db: {} as never });
    const tool = scriptTool({ enabled: () => Promise.resolve(true), caller });
    const ctx = {
      accountId: ACCOUNT,
      threadId: '',
      turnId: '',
      callId: 'c2',
      projectId: null,
      signal: new AbortController().signal,
    } as unknown as ToolContext;
    expect(await tool.handler({ code: '  ' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
    const r = await tool.handler(
      { code: 'try { await tools.call("demo.read") } catch (e) { return e.code }' },
      ctx,
    );
    expect(r).toMatchObject({ ok: true });
    expect((r as { content: { text: string }[] }).content[0]!.text).toContain('"unavailable"');
  });
});
