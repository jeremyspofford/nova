// Tool naming, tool lists and descriptor hints (docs/08 §1, §8).
import { describe, expect, it } from 'vitest';
import {
  MCP_TOOL_NAME,
  canonicalNames,
  envHeaders,
  listNames,
  serverSegment,
  toDescriptor,
  toolExposed,
  toolSegment,
} from '../src/index.ts';

describe('names', () => {
  it('turns env names into header names for HTTP servers', () => {
    expect(envHeaders({ X_Api_Key: 'a', Authorization: 'b', _x: 'c' })).toEqual({
      'X-Api-Key': 'a',
      Authorization: 'b',
      '-x': 'c',
    });
  });

  it('sanitizes server and tool segments to the descriptor pattern', () => {
    expect(serverSegment('Linear Prod_1')).toBe('linear-prod-1');
    expect(serverSegment('')).toBe('server');
    expect(serverSegment('x'.repeat(60))).toHaveLength(40);
    expect(toolSegment('create issue/now!')).toBe('create_issue_now_');
    expect(toolSegment('search.v2-beta')).toBe('search.v2-beta');
    expect(toolSegment('')).toBe('_');
    expect(toolSegment('é'.repeat(200))).toHaveLength(128);
  });

  it('keeps canonical names unique and valid when sanitizing collides', () => {
    const names = canonicalNames('Dev Tools', ['a b', 'a_b', 'a_b_2', 'ok', 'a b']);
    expect([...names.entries()]).toEqual([
      ['a b', 'mcp:dev-tools.a_b'],
      ['a_b', 'mcp:dev-tools.a_b_2'],
      ['a_b_2', 'mcp:dev-tools.a_b_2_2'],
      ['ok', 'mcp:dev-tools.ok'],
    ]);
    for (const n of names.values()) expect(n).toMatch(MCP_TOOL_NAME);
  });

  it('matches tool list entries by original, segment or canonical name', () => {
    expect(listNames(['create issue'], 'create issue', 'mcp:x.create_issue')).toBe(true);
    expect(listNames(['create_issue'], 'create issue', 'mcp:x.create_issue')).toBe(true);
    expect(listNames(['mcp:x.create_issue'], 'create issue', 'mcp:x.create_issue')).toBe(true);
    expect(listNames(['other'], 'create issue', 'mcp:x.create_issue')).toBe(false);
  });

  it('applies the deny list after the allow list', () => {
    const lists = (enabledTools: string[] | null, disabledTools: string[]) => ({
      enabledTools,
      disabledTools,
    });
    expect(toolExposed(lists(null, []), 'a', 'mcp:s.a')).toBe(true);
    expect(toolExposed(lists(['b'], []), 'a', 'mcp:s.a')).toBe(false);
    expect(toolExposed(lists(['a'], ['a']), 'a', 'mcp:s.a')).toBe(false);
    expect(toolExposed(lists([], []), 'a', 'mcp:s.a')).toBe(false);
  });

  it('only lets hints make a tool stricter', () => {
    const server = { id: 's1', toolTimeoutMs: 30_000 };
    const d = toDescriptor(
      server,
      {
        name: 'wipe',
        inputSchema: { type: 'object' },
        annotations: {
          readOnlyHint: true,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      'mcp:s.wipe',
    );
    expect(d.annotations).toEqual({ destructive: true, requiresNetwork: true });
    expect(d.effects).toBeUndefined();
    const quiet = toDescriptor(
      server,
      {
        name: 'look',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      'mcp:s.look',
    );
    expect(quiet.annotations).toBeUndefined();
  });

  it('clips titles and descriptions and strips control characters', () => {
    const d = toDescriptor(
      { id: 's', toolTimeoutMs: 1000 },
      {
        name: 'n',
        title: 't'.repeat(300),
        description: `line one\u0007\u001b[31m ${'d'.repeat(3000)}`,
        inputSchema: 'nope' as unknown as Record<string, unknown>,
      },
      'mcp:s.n',
    );
    expect(d.title).toHaveLength(120);
    expect(d.description).toHaveLength(2000);
    expect(d.description).not.toContain('\u0007');
    expect(d.description).not.toContain('\u001b');
    expect(d.inputSchema).toEqual({ type: 'object' });
    expect(d.title.endsWith('…')).toBe(true);
    const plain = toDescriptor(
      { id: 's', toolTimeoutMs: 1000 },
      { name: 'n', inputSchema: {} },
      'mcp:s.n',
    );
    expect(plain).toMatchObject({ title: 'n', description: '', loading: 'deferrable' });
  });
});
