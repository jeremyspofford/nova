// Version checks and transport injection against an in-memory peer (docs/08 §2.1).
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSIONS } from '../src/index.ts';
import { createTestServer } from './fixtures/test-server.mjs';
import { harness, stdioConfig, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.manager.close();
  h = null;
});

describe('protocol and transports', () => {
  it('offers only 2025-11-25 and later', () => {
    expect(PROTOCOL_VERSIONS).toContain('2025-11-25');
    for (const v of PROTOCOL_VERSIONS) expect(v >= '2025-11-25').toBe(true);
  });

  it('connects through an injected transport', async () => {
    const seen: string[] = [];
    h = harness({
      createTransport: (cfg, launch) => {
        seen.push(`${cfg.name}:${Object.keys(launch.env).join(',')}`);
        const [client, server] = InMemoryTransport.createLinkedPair();
        void createTestServer({ log: () => undefined }).connect(server);
        return client;
      },
    });
    const cfg = stdioConfig({ name: 'mem', env: { A: 'literal-a' } });
    await h.manager.add(cfg);
    expect(seen).toEqual(['mem:A']);
    expect(h.manager.state(cfg.id)).toMatchObject({ status: 'connected', counts: { tools: 5 } });
    expect(await h.manager.callTool(cfg.id, 'echo', { text: 'm' })).toMatchObject({ ok: true });
  });

  it('refuses a peer that answers with an unsupported version', async () => {
    h = harness({
      backoff: { baseMs: 5000, maxMs: 5000 },
      createTransport: () => {
        const [client, server] = InMemoryTransport.createLinkedPair();
        void createTestServer({ log: () => undefined, protocolVersions: ['2024-11-05'] }).connect(
          server,
        );
        return client;
      },
    });
    const cfg = stdioConfig();
    await h.manager.add(cfg);
    expect(h.manager.state(cfg.id)!.lastError).toBe(
      'the server speaks MCP protocol 2024-11-05; Nova supports 2025-11-25 or later',
    );
  });
});
