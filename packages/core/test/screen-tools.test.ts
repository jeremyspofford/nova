// The computer-use tools (FR-093, FR-207, FR-075): canonical names from the `computer` source,
// offered in agent and Work threads, gated by the policy engine (a write needs the user's
// instruction or standing authority; a managed deny wins), the thread's own computer, tier
// refusals as clear tool errors, `screen.request_access` granting only on the user's own answer,
// and `appshot.capture`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluate, type PolicyContext } from '@nova/policy';
import { Logger } from '@nova/telemetry';
import type { AskInput, AskResult, RequestBroker } from '../src/runtime/types.ts';
import { screenToolSource, screenTools, type ScreenComputerRef } from '../src/screen/index.ts';
import { TOOL_NAME } from '../src/tools/registry.ts';
import type { BuiltinTool } from '../src/tools/builtin.ts';
import type { ToolContext, ToolResult } from '../src/tools/types.ts';
import { ACCOUNT, PC, THREAD, makeScreenEnv, type ScreenEnv } from './screen-env.ts';

let env: ScreenEnv;
let bound: ScreenComputerRef | null;
let answers: AskResult[];
let asked: AskInput[];
let tools: Map<string, BuiltinTool>;
let withBroker: boolean;

beforeEach(async () => {
  env = await makeScreenEnv();
  bound = { computerId: PC, agentId: 'agent-1' };
  answers = [];
  asked = [];
  withBroker = true;
  const broker: RequestBroker = {
    ask: (input) => {
      asked.push(input);
      return Promise.resolve(answers.shift() ?? { status: 'expired' });
    },
  };
  tools = new Map(
    screenTools({
      service: env.service,
      computerOf: () => () => Promise.resolve(bound),
      broker: () => (withBroker ? broker : null),
      grantMinutes: () => Promise.resolve(30),
      killKey: () => Promise.resolve('Escape'),
    }).map((t) => [t.descriptor.name, t]),
  );
});
afterEach(() => env.close());

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    callId: 'call-1',
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots: [],
    sandbox: {} as never,
    signal: new AbortController().signal,
    log: new Logger({ module: 'test', sinks: [] }),
    ...over,
  };
}

const call = (name: string, args: unknown = {}, over: Partial<ToolContext> = {}) =>
  tools.get(name)!.handler(args, ctx(over));
const text = (r: ToolResult) =>
  r.ok
    ? r.content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n')
    : r.error.message;
const errCode = (r: ToolResult) => (r.ok ? 'ok' : r.error.code);

describe('descriptors and listing', () => {
  it('names the tools canonically under the computer source and lists them in agent and work threads', async () => {
    expect([...tools.keys()]).toEqual([
      'screen.observe',
      'screen.click',
      'screen.type',
      'screen.key',
      'screen.scroll',
      'screen.drag',
      'screen.request_access',
      'appshot.capture',
    ]);
    for (const t of tools.values()) {
      expect(TOOL_NAME.test(t.descriptor.name)).toBe(true);
      expect(t.descriptor.source).toBe('computer');
    }
    expect(tools.get('screen.observe')!.origin).toBe('capture');
    expect(tools.get('screen.request_access')!.origin).toBeNull();
    const source = screenToolSource([...tools.values()]);
    expect(source.source).toBe('computer');
    expect(await source.list(ACCOUNT)).toHaveLength(8);
    expect(await source.list(ACCOUNT, { threadId: THREAD, mode: 'agent' })).toHaveLength(8);
    expect(await source.list(ACCOUNT, { threadId: THREAD, mode: 'work' })).toHaveLength(8);
    expect(await source.list(ACCOUNT, { threadId: THREAD, mode: 'chat' })).toEqual([]);
    expect(await source.list(ACCOUNT, { threadId: THREAD, mode: 'code' })).toEqual([]);
    // With the thread-to-computer mapping bound, only threads with a computer get them.
    const resolver = (_a: string, threadId: string) =>
      threadId === THREAD
        ? Promise.resolve({ computerId: PC })
        : threadId === 'broken'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(null);
    const mapped = screenToolSource([...tools.values()], { computerOf: () => resolver });
    expect(await mapped.list(ACCOUNT, { threadId: THREAD, mode: 'work' })).toHaveLength(8);
    expect(await mapped.list(ACCOUNT, { threadId: 'other', mode: 'work' })).toEqual([]);
    expect(await mapped.list(ACCOUNT, { threadId: 'broken', mode: 'agent' })).toEqual([]);
    expect(await mapped.list(ACCOUNT, { threadId: null, mode: 'agent' })).toEqual([]);
    expect(await mapped.list(ACCOUNT)).toHaveLength(8);
    const chatToo = screenToolSource([...tools.values()], { modes: ['chat'] });
    expect(await chatToo.list(ACCOUNT, { threadId: THREAD, mode: 'chat' })).toHaveLength(8);
  });

  it('passes the policy engine: observing is allowed, input needs authority, a managed deny wins', () => {
    const base: Omit<PolicyContext, 'provenance' | 'tool'> = {
      actor: { kind: 'agent', id: 'agent-1' },
      scopes: [{ kind: 'global' }],
      approvalPolicy: { kind: 'defaults' },
      permissionProfile: { id: 'workspace', hash: 'h' },
      environment: { kind: 'hub', trusted: true, substrate: null },
      fs: { entries: [] },
    };
    const observe = tools.get('screen.observe')!.descriptor;
    const click = tools.get('screen.click')!.descriptor;
    expect(evaluate({ ...base, provenance: { taint: ['capture'] }, tool: observe }).effect).toBe(
      'allow',
    );
    // Screen content never authorizes input (FR-189).
    expect(evaluate({ ...base, provenance: { taint: ['capture'] }, tool: click }).effect).toBe(
      'ask',
    );
    const managed = [
      {
        id: 'm1',
        scope: { kind: 'global' as const },
        match: { tool: ['screen.*'] },
        effect: 'deny' as const,
      },
    ];
    expect(
      evaluate(
        {
          ...base,
          provenance: { taint: [], userInstruction: { messageId: 'm', accountId: ACCOUNT } },
          tool: click,
        },
        { managed },
      ).effect,
    ).toBe('deny');
  });
});

describe('acting', () => {
  it('observes with an image and acts in a granted app', async () => {
    await env.service.setEnabled(ACCOUNT, PC, true);
    await env.service.grant(ACCOUNT, PC, { app: 'Expense Form' });
    const obs = await call('screen.observe');
    expect(obs.ok).toBe(true);
    if (!obs.ok) return;
    expect(obs.content[1]).toMatchObject({ type: 'image', mime: 'image/png' });
    expect(text(obs)).toContain(
      '"Expense Form": "New expense - Expense Form" [full control, granted] focused at 560,20 380x290',
    );
    expect(text(obs)).toContain(
      '"Web Browser": "Example page - Web Browser" [view only, not granted]',
    );
    expect(text(obs)).toContain('Accessibility tree (screen content, untrusted)');
    expect(obs.meta).toMatchObject({ computerId: PC, width: 960, height: 600 });

    const click = await call('screen.click', { x: 690, y: 74 });
    expect(text(click)).toMatch(/^Clicked \(690, 74\) in Expense Form\./);
    expect(click).toMatchObject({
      ok: true,
      meta: { computerId: PC, app: 'Expense Form', tier: 'full' },
    });
    expect(text(await call('screen.type', { text: 'Ada' }))).toMatch(
      /^Typed 3 characters in Expense Form/,
    );
    expect(text(await call('screen.key', { keys: 'Enter' }))).toMatch(/^Pressed Enter/);
    expect(env.desktops.desktop(PC).widget('w-form', 'Status')!.value).toBe('Submitted: Ada');
    expect(text(await call('screen.scroll', { x: 690, y: 74, dy: 20 }))).toMatch(
      /^Scrolled 20 at \(690, 74\)/,
    );
    expect(text(await call('screen.drag', { fromX: 700, fromY: 31, toX: 650, toY: 31 }))).toMatch(
      /^Dragged \(700, 31\) to \(650, 31\)/,
    );
    // The editor was never granted.
    expect(await call('screen.click', { x: 720, y: 482 })).toMatchObject({
      ok: false,
      error: { code: 'screen_grant_required', details: { apps: ['Code Editor'] } },
    });
    // The actor is the thread's agent.
    expect(env.audit.find((a) => a.action === 'screen.click')?.actor).toBe('agent:agent-1');
  });

  it('turns a tier refusal into a clear tool error naming the tool to use instead', async () => {
    await env.service.setEnabled(ACCOUNT, PC, true);
    await env.service.grant(ACCOUNT, PC, { app: 'Web Browser' });
    await call('screen.observe');
    const r = await call('screen.click', { x: 100, y: 100 });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'screen_tier', details: { tier: 'view', useInstead: 'browser' } },
    });
    expect(text(r)).toContain('Use the browser tools');
  });

  it("uses the thread's own computer and refuses another", async () => {
    expect(errCode(await call('screen.observe', { computerId: 'other' }))).toBe(
      'computer_mismatch',
    );
    bound = null;
    expect(errCode(await call('screen.observe'))).toBe('no_computer');
    await env.service.setEnabled(ACCOUNT, PC, true);
    // Outside an agent's thread an explicit computer is used (the actor is then `system`).
    expect(errCode(await call('screen.observe', { computerId: PC }))).toBe('ok');
    // A user's direct invocation acts as the user.
    await env.service.grant(ACCOUNT, PC, { app: 'Expense Form' });
    expect(
      errCode(await call('screen.click', { x: 690, y: 74, computerId: PC }, { origin: 'ui' })),
    ).toBe('ok');
    expect(env.audit.find((a) => a.action === 'screen.click')?.actor).toBe('user');
    expect(errCode(await call('screen.observe', {}, { threadId: '' }))).toBe('no_computer');
    expect(errCode(await call('screen.click', { x: 'a' }, {}))).toBe('no_computer');
    bound = { computerId: PC };
    expect(errCode(await call('screen.click', { y: 3 }))).toBe('invalid_arguments');
    expect(errCode(await call('screen.type', { text: '' }))).toBe('invalid_arguments');
    expect(errCode(await call('screen.key', { keys: ' ' }))).toBe('invalid_arguments');
    expect(errCode(await call('screen.scroll', { x: 1 }))).toBe('invalid_arguments');
    expect(errCode(await call('screen.drag', { fromX: 1 }))).toBe('invalid_arguments');
  });
});

describe('screen.request_access', () => {
  it('grants an app only on the signed-in user allowing it', async () => {
    await env.service.setEnabled(ACCOUNT, PC, true);
    answers = [
      { status: 'resolved', result: { choice: 'Allow for 30 min' }, by: 'user' },
      { status: 'resolved', result: { choice: 'Deny' }, by: 'user' },
      { status: 'resolved', result: { choice: 'Allow for 30 min' }, by: 'hook:h1' },
      { status: 'expired' },
    ];
    const r = await call('screen.request_access', {
      apps: ['Expense Form', 'Code Editor', 'Terminal', 'Spreadsheet', 'Password Manager', ' '],
      reason: 'fill the expense form',
    });
    expect(text(r).split('\n')).toEqual([
      expect.stringMatching(/^Expense Form: granted \(full control\) until /),
      'Code Editor: denied by the user.',
      "Terminal: not granted (only the user's own answer grants access).",
      'Spreadsheet: nobody answered; no access.',
      'Password Manager: never controlled by Nova; ask the user to do that step.',
    ]);
    expect(asked).toHaveLength(4);
    expect(asked[0]).toMatchObject({
      accountId: ACCOUNT,
      kind: 'user_input',
      correlation: { threadId: THREAD, turnId: 'turn-1', callId: 'call-1' },
      payload: { choices: ['Allow for 30 min', 'Deny'] },
    });
    expect((asked[0]!.payload as { question: string }).question).toBe(
      'Allow Nova to control "Expense Form"?\nLevel: Full control\nExpires: 30 minutes after you allow\n' +
        'Stop at any time with Escape or the Stop button.\nThe agent says: fill the expense form',
    );
    expect((asked[2]!.payload as { question: string }).question).toContain('Level: Click only');
    expect((await env.service.listGrants(ACCOUNT, PC)).map((g) => g.app)).toEqual(['Expense Form']);
    // Asking again for a granted app does not ask.
    const again = await call('screen.request_access', { apps: ['Expense Form'] });
    expect(text(again)).toBe('Expense Form: already granted (30 min left).');
    expect(asked).toHaveLength(4);
  });

  it('stops when the turn is cancelled and needs a broker and a computer', async () => {
    answers = [{ status: 'cancelled' }];
    expect(errCode(await call('screen.request_access', { apps: ['Expense Form'] }))).toBe(
      'cancelled',
    );
    expect(errCode(await call('screen.request_access', { apps: [' '] }))).toBe('invalid_arguments');
    bound = { computerId: 'missing' };
    expect(errCode(await call('screen.request_access', { apps: ['X'] }))).toBe('no_computer');
    withBroker = false;
    expect(errCode(await call('screen.request_access', { apps: ['X'] }))).toBe('unavailable');
  });
});

describe('appshot.capture', () => {
  it('saves the window as an artifact of the thread', async () => {
    const r = await call('appshot.capture', { app: 'Terminal' });
    expect(text(r)).toBe(
      'Saved an appshot of Terminal - Terminal - bash (440x260) as an artifact.',
    );
    expect(r).toMatchObject({ ok: true, meta: { computerId: PC } });
    const page = await call('appshot.capture', { source: 'browser' });
    expect(page).toMatchObject({ ok: true, meta: { url: 'https://example.test/' } });
    expect(text(await call('appshot.capture', { source: 'screen' }))).toContain('Screen (960x600)');
    expect(await call('appshot.capture', { windowId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await env.service.listAppshots(ACCOUNT, { threadId: THREAD, limit: 10 })).toHaveLength(
      3,
    );
  });
});
