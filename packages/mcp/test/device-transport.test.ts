// Device-hosted stdio servers (FR-042 `deviceId`, FR-210): the manager never spawns them on the
// Hub; it reaches them through the device bridge, by the name the device lists, so their tools
// list and run like any server's. Without a bridge the server reports an error; a bridge failure
// becomes the call's error; malformed tool entries from a device are dropped.
import { describe, expect, it } from 'vitest';
import { deviceTransport, type DeviceMcpBridge, type DeviceMcpTool } from '../src/index.ts';
import { harness, stdioConfig } from './helpers.ts';

function bridge(over: Partial<DeviceMcpBridge> = {}): DeviceMcpBridge & {
  seen: unknown[];
} {
  const seen: unknown[] = [];
  return {
    seen,
    list: (target) => {
      seen.push(['list', target]);
      // A device may send anything: only well-formed entries become tools.
      return Promise.resolve([
        {
          name: 'read_note',
          description: 'Read a note',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        },
        { name: '' },
        { description: 'nameless' },
        'junk',
      ] as unknown as DeviceMcpTool[]);
    },
    call: (target, call) => {
      seen.push(['call', target, call]);
      return Promise.resolve({
        content: [{ type: 'text', text: `note ${String(call.arguments.id)}` }],
        isError: false,
      });
    },
    ...over,
  };
}

const deviceConfig = (over = {}) =>
  stdioConfig({
    name: 'notes',
    command: 'notes-server',
    args: ['--never-sent'],
    deviceId: 'dev-1',
    ...over,
  });

describe('device-hosted MCP servers', () => {
  it('lists and calls the device server’s tools through the bridge, never spawning it', async () => {
    const b = bridge();
    const h = harness({ deviceBridge: b });
    const cfg = deviceConfig();
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)).toMatchObject({
      status: 'connected',
      serverInfo: { name: 'device:notes-server' },
      counts: { tools: 1, resources: 0, prompts: 0 },
    });
    expect(h.manager.tools(cfg.id).map((t) => t.descriptor.name)).toEqual(['mcp:notes.read_note']);
    const r = await h.manager.callTool(cfg.id, 'read_note', { id: '7' });
    expect(r).toMatchObject({ ok: true });
    expect(b.seen).toEqual([
      ['list', { accountId: 'acct-1', deviceId: 'dev-1', server: 'notes-server' }],
      [
        'call',
        { accountId: 'acct-1', deviceId: 'dev-1', server: 'notes-server' },
        { tool: 'read_note', arguments: { id: '7' } },
      ],
    ]);
    await h.manager.close();
  });

  it('reports an error without a bridge, and connects once one is wired and it restarts', async () => {
    const h = harness();
    const cfg = deviceConfig();
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)).toMatchObject({ status: 'error' });
    expect(h.manager.state(cfg.id)!.lastError).toMatch(/device the Hub cannot reach/);
    h.manager.useDeviceBridge(bridge());
    await h.manager.restart(cfg.id);
    expect(h.manager.state(cfg.id)).toMatchObject({ status: 'connected' });
    await h.manager.close();
  });

  it('turns a failed device call into the call’s error and a failed listing into a start error', async () => {
    const h = harness({
      deviceBridge: bridge({ call: () => Promise.reject(new Error('device offline')) }),
    });
    const cfg = deviceConfig();
    await h.manager.add(cfg);
    const r = await h.manager.callTool(cfg.id, 'read_note', {});
    expect(JSON.stringify(r)).toContain('device offline');
    await h.manager.close();
    const h2 = harness({
      deviceBridge: bridge({ list: () => Promise.reject(new Error('no grant')) }),
    });
    const cfg2 = deviceConfig();
    await h2.manager.add(cfg2);
    expect(h2.manager.state(cfg2.id)).toMatchObject({ status: 'error' });
    await h2.manager.close();
  });

  it('answers what a device server does not offer as method not found, and stops after close', async () => {
    const t = deviceTransport(bridge(), { accountId: 'a', deviceId: 'd', server: 's' });
    const got: unknown[] = [];
    t.onmessage = (m) => void got.push(m);
    let closed = 0;
    t.onclose = () => void closed++;
    await t.start();
    await t.send({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} });
    await t.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await t.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found: resources/list' },
      },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
    await t.close();
    await t.close();
    await t.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(2);
    expect(closed).toBe(1);
  });
});
