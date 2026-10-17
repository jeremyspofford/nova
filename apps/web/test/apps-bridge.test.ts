// The MCP Apps bridge and display helpers (FR-198): JSON-RPC parsing with malformed input,
// source and origin filtering, request/response and error mapping, model-context splitting
// (private parts never visible), message and link checks, height caps and the one
// picture-in-picture slot.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostBridge,
  MESSAGE_MAX_CHARS,
  RPC,
  RpcError,
  linkUrl,
  messageText,
  parseRpc,
  splitModelContext,
  toolSegment,
} from '../src/apps/bridge.ts';
import {
  INLINE_MAX_HEIGHT,
  INLINE_MIN_HEIGHT,
  claimPip,
  clampHeight,
  currentPip,
  releasePip,
  subscribePip,
  themeVariables,
  themeVariant,
} from '../src/apps/display.ts';

describe('parseRpc', () => {
  it('reads requests, notifications and responses', () => {
    expect(parseRpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).toEqual({
      kind: 'request',
      id: 1,
      method: 'ping',
      params: {},
    });
    expect(
      parseRpc({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }),
    ).toEqual({
      kind: 'notification',
      method: 'ui/notifications/initialized',
      params: {},
    });
    expect(parseRpc({ jsonrpc: '2.0', id: 'host-1', result: {} })).toEqual({
      kind: 'response',
      id: 'host-1',
    });
  });

  it('refuses malformed messages, answering those that carry an id', () => {
    const cases: [unknown, number | null, number][] = [
      ['hello', null, RPC.invalidRequest],
      [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], null, RPC.invalidRequest],
      [null, null, RPC.invalidRequest],
      [{ jsonrpc: '1.0', id: 2, method: 'ping' }, 2, RPC.invalidRequest],
      [{ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, null, RPC.invalidRequest],
      [{ jsonrpc: '2.0', id: 1.5, method: 'ping' }, null, RPC.invalidRequest],
      [{ jsonrpc: '2.0', id: 3 }, 3, RPC.invalidRequest],
      [{ jsonrpc: '2.0', id: 4, method: '' }, 4, RPC.invalidRequest],
      [{ jsonrpc: '2.0', id: 5, method: 'x'.repeat(201) }, 5, RPC.invalidRequest],
      [{ jsonrpc: '2.0', id: 6, method: 'tools/call', params: ['a'] }, 6, RPC.invalidParams],
      [{ jsonrpc: '2.0', id: 7, method: 'ping', params: 'x' }, 7, RPC.invalidParams],
      [
        { jsonrpc: '2.0', id: 8, method: 'ping', params: { big: 'x'.repeat(MESSAGE_MAX_CHARS) } },
        8,
        RPC.invalidRequest,
      ],
      [{ jsonrpc: '2.0', id: 9, method: 'ping', params: new Map() }, 9, RPC.invalidParams],
    ];
    for (const [data, id, code] of cases) {
      const msg = parseRpc(data);
      expect(msg.kind, JSON.stringify(data)?.slice(0, 80)).toBe('invalid');
      if (msg.kind === 'invalid') {
        expect(msg.id).toBe(id);
        expect(msg.code).toBe(code);
      }
    }
    const cyclic: Record<string, unknown> = { jsonrpc: '2.0', id: 10, method: 'ping' };
    cyclic.params = { self: cyclic };
    expect(parseRpc(cyclic)).toMatchObject({ kind: 'invalid', id: 10 });
  });
});

describe('method payloads', () => {
  it('keeps private model context out of what the model sees', () => {
    expect(
      splitModelContext({
        content: [
          { type: 'text', text: 'Board: 3 cards' },
          { type: 'text', text: 'secret draft', _meta: { 'nova/private': true } },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        structuredContent: { cards: 3 },
      }),
    ).toEqual({
      visible: 'Board: 3 cards\n\n{"cards":3}',
      hidden: [{ type: 'text', text: 'secret draft', _meta: { 'nova/private': true } }],
    });
    // A whole update marked private shares nothing.
    const all = splitModelContext({
      content: [{ type: 'text', text: 'all mine' }],
      structuredContent: { x: 1 },
      _meta: { 'nova/private': true },
    });
    expect(all.visible).toBe('');
    expect(all.hidden).toHaveLength(2);
    expect(() => splitModelContext({ content: 'text' })).toThrow(RpcError);
    expect(() => splitModelContext({ content: ['text'] })).toThrow(RpcError);
    expect(splitModelContext({})).toEqual({ visible: '', hidden: [] });
  });

  it('accepts a user message with text and nothing else', () => {
    expect(
      messageText({ role: 'user', content: { type: 'text', text: ' Summarize the board ' } }),
    ).toBe('Summarize the board');
    expect(
      messageText({
        content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }],
      }),
    ).toBe('one\ntwo');
    expect(() => messageText({ role: 'assistant', content: { type: 'text', text: 'hi' } })).toThrow(
      /user message/,
    );
    expect(() => messageText({ content: { type: 'image' } })).toThrow(/text/);
    expect(() => messageText({ content: { type: 'text', text: 'x'.repeat(20_001) } })).toThrow(
      /long/,
    );
  });

  it('opens http and https links only', () => {
    expect(linkUrl({ url: 'https://example.com/a?b=1' })).toBe('https://example.com/a?b=1');
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'nope', 7])
      expect(() => linkUrl({ url })).toThrow(RpcError);
  });

  it('sanitizes tool names like the MCP client', () => {
    expect(toolSegment('panel_action')).toBe('panel_action');
    expect(toolSegment('do it!')).toBe('do_it_');
    expect(toolSegment('')).toBe('_');
  });
});

describe('HostBridge', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function setup(
    onRequest: (m: string, p: Record<string, unknown>) => unknown = () => ({ ok: 1 }),
  ) {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const win = iframe.contentWindow!;
    const posted: unknown[] = [];
    vi.spyOn(win, 'postMessage').mockImplementation((m: unknown) => void posted.push(m));
    const notes: [string, unknown][] = [];
    const rejects: string[] = [];
    const bridge = new HostBridge({
      frame: () => iframe,
      onRequest,
      onNotification: (m, p) => {
        if (m === 'boom') throw new Error('handler broke');
        notes.push([m, p]);
      },
      onReject: (r) => rejects.push(r),
    });
    bridge.start();
    const send = (data: unknown, opts: { source?: Window | null; origin?: string } = {}) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data,
          source: opts.source === undefined ? win : opts.source,
          origin: opts.origin ?? 'null',
        }),
      );
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { bridge, win, posted, notes, rejects, send, flush };
  }

  it('answers requests from its frame only, on an opaque origin', async () => {
    const b = setup();
    b.send({ jsonrpc: '2.0', id: 1, method: 'ping' }, { source: window });
    b.send({ jsonrpc: '2.0', id: 2, method: 'ping' }, { source: null });
    b.send({ jsonrpc: '2.0', id: 3, method: 'ping' }, { origin: 'https://evil.example' });
    await b.flush();
    expect(b.posted).toEqual([]);
    expect(b.rejects).toEqual(['the frame is not on an opaque origin']);
    b.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    await b.flush();
    expect(b.posted).toEqual([{ jsonrpc: '2.0', id: 4, result: { ok: 1 } }]);
  });

  it('maps errors and malformed input to JSON-RPC errors', async () => {
    const b = setup((method) => {
      if (method === 'refuse') throw new RpcError(RPC.refused, 'not now');
      if (method === 'crash') throw new Error('secret internals');
      if (method === 'empty') return undefined;
      return Promise.resolve({ fine: true });
    });
    b.send({ jsonrpc: '2.0', id: 1, method: 'refuse' });
    b.send({ jsonrpc: '2.0', id: 2, method: 'crash' });
    b.send({ jsonrpc: '2.0', id: 3, method: 'empty' });
    b.send({ jsonrpc: '2.0', id: 4, method: 'async' });
    b.send({ jsonrpc: '1.0', id: 5, method: 'ping' });
    b.send('not json-rpc');
    b.send({ jsonrpc: '2.0', id: 'host-1', result: {} });
    await b.flush();
    // Malformed messages are answered at once, requests once their handler settles.
    const byId = (x: unknown) => String((x as { id: unknown }).id);
    expect([...b.posted].sort((x, y) => byId(x).localeCompare(byId(y)))).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: RPC.refused, message: 'not now' } },
      {
        jsonrpc: '2.0',
        id: 2,
        error: { code: RPC.internal, message: 'the host could not complete the request' },
      },
      { jsonrpc: '2.0', id: 3, result: {} },
      { jsonrpc: '2.0', id: 4, result: { fine: true } },
      {
        jsonrpc: '2.0',
        id: 5,
        error: { code: RPC.invalidRequest, message: 'jsonrpc must be "2.0"' },
      },
    ]);
    expect(b.rejects).toContain('a message must be a JSON-RPC object');
  });

  it('passes notifications on, survives a failing handler and stops listening', async () => {
    const b = setup();
    b.send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 9 } });
    b.send({ jsonrpc: '2.0', method: 'boom' });
    await b.flush();
    expect(b.notes).toEqual([['ui/notifications/size-changed', { height: 9 }]]);
    expect(b.rejects).toContain('handler broke');
    b.bridge.notify('ui/notifications/tool-input', { arguments: {} });
    b.bridge.request('ui/resource-teardown');
    expect(b.posted).toEqual([
      { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: {} } },
      { jsonrpc: '2.0', id: 'host-1', method: 'ui/resource-teardown', params: {} },
    ]);
    b.bridge.stop();
    b.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    await b.flush();
    expect(b.posted).toHaveLength(2);
  });
});

describe('display helpers', () => {
  it('caps the inline height', () => {
    expect(clampHeight(5000)).toBe(INLINE_MAX_HEIGHT);
    expect(clampHeight(3)).toBe(INLINE_MIN_HEIGHT);
    expect(clampHeight(250.4)).toBe(250);
  });

  it('keeps one picture-in-picture owner', () => {
    const seen: (string | null)[] = [];
    const off = subscribePip(() => seen.push(currentPip()));
    claimPip('a');
    claimPip('a');
    claimPip('b');
    releasePip('a');
    releasePip('b');
    off();
    claimPip('c');
    releasePip('c');
    expect(seen).toEqual(['a', 'b', null]);
  });

  it('reads the theme tokens and variant from the document', () => {
    const root = document.documentElement;
    root.style.setProperty('--u-bg', '#101010');
    root.style.colorScheme = 'light';
    expect(themeVariables()['--u-bg']).toBe('#101010');
    expect(themeVariant()).toBe('light');
    root.removeAttribute('style');
    expect(themeVariant()).toBe('dark');
  });
});
