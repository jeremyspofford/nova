// MCP tools the owner declared read-only in Settings (FR-082, FR-189, docs/08 §1): the declaration
// is the user's, never the server's, so it may make a tool read-only, but only when nothing the
// engine knows about the tool (its annotations, declared and inferred effects) says it changes
// anything. Built-in tools are unaffected.
import { describe, expect, it } from 'vitest';
import { effectiveEffects, isReadOnly } from '../src/classify.ts';
import { evaluate } from '../src/engine.ts';
import type { PolicyContext, PolicyRule, ToolDescriptor } from '../src/types.ts';

const listEvents: ToolDescriptor = {
  name: 'mcp:calendar.list_events',
  source: 'mcp',
  serverId: 'srv-cal',
  title: 'List events',
  description: 'Lists the events in a date range',
};
const declared: ToolDescriptor = { ...listEvents, userReadOnly: true };

const readOnly = (t: ToolDescriptor) => isReadOnly(t, effectiveEffects(t));

function ctx(tool: ToolDescriptor, over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    actor: { kind: 'agent', id: 'a1' },
    scopes: [{ kind: 'thread', ref: 't1' }, { kind: 'global' }],
    approvalPolicy: { kind: 'defaults' },
    permissionProfile: { id: 'read-only', hash: 'h' },
    // A proactive research turn: no typed instruction behind it.
    provenance: { taint: [] },
    tool,
    environment: { kind: 'local', trusted: true, substrate: 'os_sandbox' },
    fs: { entries: [] },
    ...over,
  };
}

/** The deny rule an agent's proactive research thread carries (agents area, FR-082). */
const researchOnlyReads: PolicyRule = {
  id: 'agent-proactive-read-only:a1',
  label: 'Proactive research only reads',
  priority: 0,
  source: 'user',
  scope: { kind: 'thread', ref: 't1' },
  match: { readOnly: false },
  effect: 'deny',
};

describe('isReadOnly with a user declaration', () => {
  it('makes a declared MCP tool read-only and leaves an undeclared one as it was', () => {
    expect(readOnly(declared)).toBe(true);
    expect(readOnly(listEvents)).toBe(false);
    expect(readOnly({ ...listEvents, userReadOnly: false })).toBe(false);
    // The server's own hint still counts for nothing.
    expect(readOnly({ ...listEvents, annotations: { readOnly: true } })).toBe(false);
    // Network access is reading too.
    expect(isReadOnly(declared, ['network'])).toBe(true);
  });

  it('never covers a tool whose name or description says it sends, deletes or buys', () => {
    expect(readOnly({ ...declared, name: 'mcp:calendar.send_invite' })).toBe(false);
    expect(readOnly({ ...declared, name: 'mcp:calendar.delete_event' })).toBe(false);
    expect(readOnly({ ...declared, description: 'Purchases a ticket for the event' })).toBe(false);
    expect(readOnly({ ...declared, name: 'mcp:calendar.invite_guest' })).toBe(false);
    // Declared effects count the same way.
    expect(readOnly({ ...declared, effects: ['file_write'] })).toBe(false);
    expect(readOnly({ ...declared, effects: ['network'] })).toBe(true);
  });

  it('never covers a tool whose annotations say it writes, sends, deletes or executes', () => {
    for (const action of ['write', 'send', 'delete', 'execute'] as const)
      expect(readOnly({ ...declared, annotations: { action } }), action).toBe(false);
    expect(readOnly({ ...declared, annotations: { action: 'read' } })).toBe(true);
    // The server's destructive hint tightens: the declaration does not cover it.
    expect(readOnly({ ...declared, annotations: { destructive: true } })).toBe(false);
    expect(readOnly({ ...declared, annotations: { requiresNetwork: true } })).toBe(true);
  });

  it('applies only to MCP tools: other untrusted sources and built-ins are unchanged', () => {
    for (const source of ['plugin', 'page', 'device'] as const)
      expect(readOnly({ ...declared, source }), source).toBe(false);
    const builtin: ToolDescriptor = {
      name: 'fs.read',
      source: 'builtin',
      annotations: { readOnly: true },
    };
    expect(readOnly(builtin)).toBe(true);
    // A built-in is read-only by its own annotation only.
    expect(readOnly({ name: 'fs.write', source: 'builtin', userReadOnly: true })).toBe(false);
    expect(readOnly({ ...builtin, userReadOnly: false })).toBe(true);
  });
});

describe('the engine with a declared read-only MCP tool', () => {
  it('allows it by the read-only fallback, with no instruction behind the call', () => {
    expect(evaluate(ctx(declared))).toMatchObject({
      effect: 'allow',
      source: 'fallback',
      reason: 'read-only action',
      review: false,
    });
    // Undeclared: it asks, and without a typed instruction nothing authorizes it.
    expect(evaluate(ctx(listEvents))).toMatchObject({ effect: 'ask' });
  });

  it('passes the proactive research deny rule; an undeclared tool is denied by it', () => {
    const set = { rules: [researchOnlyReads] };
    expect(evaluate(ctx(declared), set)).toMatchObject({ effect: 'allow' });
    expect(evaluate(ctx(listEvents), set)).toMatchObject({
      effect: 'deny',
      ruleId: researchOnlyReads.id,
    });
    expect(evaluate(ctx({ ...declared, name: 'mcp:calendar.send_invite' }), set)).toMatchObject({
      effect: 'deny',
    });
  });

  it("keeps the user's own server and tool defaults above the read-only fallback", () => {
    expect(evaluate(ctx(declared), { serverDefaults: { 'srv-cal': 'ask' } })).toMatchObject({
      effect: 'ask',
      source: 'tool_default',
      userSet: true,
    });
    expect(evaluate(ctx(declared), { serverDefaults: { 'srv-cal': 'deny' } }).effect).toBe('deny');
    expect(
      evaluate(ctx(declared), { toolDefaults: { 'mcp:calendar.list_events': 'deny' } }).effect,
    ).toBe('deny');
    expect(evaluate(ctx(declared), { serverDefaults: { 'srv-cal': 'allow' } }).effect).toBe(
      'allow',
    );
  });

  it('needs no network allowlist entry for its host, like a read-only built-in', () => {
    const net = { ...declared, annotations: { requiresNetwork: true } };
    const host = { kind: 'host' as const, value: 'calendar.example.com' };
    expect(evaluate(ctx(net, { resource: host }))).toMatchObject({ effect: 'allow' });
    // A host on the deny list stays denied.
    expect(
      evaluate(ctx(net, { resource: host, egress: { deny: ['calendar.example.com'] } })),
    ).toMatchObject({ effect: 'deny', source: 'builtin' });
  });
});
