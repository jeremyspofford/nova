// The MCP client over streamable HTTP against the fixture served in process (FR-042): connect,
// list, call, timeout, cancellation, list-changed over the server stream, headers from the vault
// and failure handling when the server goes away.
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../src/index.ts';
import { harness, startHttpHost, waitFor, type Harness, type HttpHost } from './helpers.ts';

let h: Harness | null = null;
let host: HttpHost | null = null;

afterEach(async () => {
  await h?.manager.close();
  await host?.close();
  h = null;
  host = null;
});

function httpConfig(url: string, over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'http-1',
    accountId: 'acct-1',
    name: 'remote',
    transport: 'http',
    command: null,
    args: [],
    url,
    env: {},
    headers: {},
    enabled: true,
    startupTimeoutMs: 5000,
    toolTimeoutMs: 5000,
    enabledTools: null,
    disabledTools: [],
    ...over,
  };
}

describe('streamable HTTP servers', () => {
  it('connects, lists and calls tools', async () => {
    host = await startHttpHost();
    h = harness();
    const cfg = httpConfig(host.url);
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)).toMatchObject({
      status: 'connected',
      protocolVersion: '2025-11-25',
      counts: { tools: 5, resources: 1, prompts: 1 },
    });
    expect(h.manager.tools(cfg.id)[0]!.descriptor.name).toBe('mcp:remote.echo');
    expect(await h.manager.callTool(cfg.id, 'add', { a: 20, b: 22 })).toMatchObject({
      ok: true,
      meta: { structuredContent: { sum: 42 } },
    });
  });

  it('sends env entries as headers whose values come from the vault', async () => {
    const key = 'vault-header-value-123456';
    host = await startHttpHost({ requireHeader: ['x-api-key', key] });
    h = harness();
    h.secrets.set('secret://mcp/http-1/env/X_Api_Key', key);
    const cfg = httpConfig(host.url, {
      env: { X_Api_Key: 'secret://mcp/http-1/env/X_Api_Key', Plain_Value: 'shown' },
    });
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)!.status).toBe('connected');
    expect(host.requests.every((r) => r['x-api-key'] === key && r['plain-value'] === 'shown')).toBe(
      true,
    );
    expect(host.requests.some((r) => 'x_api_key' in r)).toBe(false);
    expect(JSON.stringify([h.manager.logs(cfg.id), h.sink.records, h.statuses])).not.toContain(key);
  });

  it('also sends explicit headers from the vault', async () => {
    const key = 'explicit-header-value-654321';
    host = await startHttpHost({ requireHeader: ['authorization', `Bearer ${key}`] });
    h = harness();
    h.secrets.set('secret://mcp/http-1/header/authorization', `Bearer ${key}`);
    const cfg = httpConfig(host.url, {
      headers: { authorization: 'secret://mcp/http-1/header/authorization' },
    });
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)!.status).toBe('connected');
  });

  it('reports a refused connection without the right header', async () => {
    host = await startHttpHost({ requireHeader: ['x-api-key', 'right'] });
    h = harness({ backoff: { baseMs: 5000, maxMs: 5000 } });
    const cfg = httpConfig(host.url);
    await h.manager.add(cfg);
    const s = h.manager.state(cfg.id)!;
    expect(s.status).toBe('error');
    expect(s.lastError).toBeTruthy();
  });

  it('times out and cancels calls', async () => {
    host = await startHttpHost();
    h = harness();
    const cfg = httpConfig(host.url, { toolTimeoutMs: 1000 });
    await h.manager.add(cfg);
    expect(await h.manager.callTool(cfg.id, 'slow', { ms: 4000 })).toMatchObject({
      ok: false,
      error: { code: 'mcp.timeout' },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    expect(
      await h.manager.callTool(cfg.id, 'slow', { ms: 4000 }, { signal: ac.signal }),
    ).toMatchObject({ ok: false, error: { code: 'mcp.cancelled' } });
  });

  it('refreshes tools when the server announces a change', async () => {
    host = await startHttpHost({ testHooks: true });
    h = harness();
    const cfg = httpConfig(host.url);
    await h.manager.add(cfg);
    await h.manager.callTool(cfg.id, 'add_tool', { name: 'fresh' });
    await waitFor(
      () => h!.manager.tools(cfg.id).some((t) => t.original === 'fresh'),
      5000,
      'list change over HTTP',
    );
  });

  it('rejects URLs that are not http or https', async () => {
    h = harness({ backoff: { baseMs: 5000, maxMs: 5000 } });
    const cfg = httpConfig('file:///etc/passwd');
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)!.lastError).toBe('the server URL must use http or https');
    const bad = httpConfig('not a url', { id: 'http-2' });
    await h.manager.add(bad);
    expect(h.manager.state(bad.id)!.lastError).toBe('the server URL is not valid');
  });

  it('reports an unreachable SSE server as an error', async () => {
    host = await startHttpHost();
    const url = host.url;
    await host.close();
    host = null;
    h = harness({ backoff: { baseMs: 5000, maxMs: 5000 } });
    const cfg = httpConfig(url, { transport: 'sse', id: 'sse-1' });
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)!.status).toBe('error');
  });
});
