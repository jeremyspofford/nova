// Resources and prompts of a device's own MCP servers (M8, FR-042, FR-210): passed through novad's
// `/agent/v1/mcp/request` under the same `mcp` grant, only the read-only methods; reads are
// audited, listings are not.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT, devicesEnv, type DevicesEnv } from './devices-env.ts';

let env: DevicesEnv;
beforeEach(async () => {
  env = await devicesEnv();
});
afterEach(() => env.close());

describe('DeviceService.mcpRequest', () => {
  it('passes resources and prompts under the grant and audits reads only', async () => {
    const fake = await env.enroll({
      mcp: {
        notes: {
          tools: [{ name: 'search' }],
          call: () => ({}),
          requests: {
            'resources/list': () => ({ resources: [{ uri: 'note://1', name: 'One' }] }),
            'resources/read': (p) => ({ contents: [{ uri: p.uri, text: 'one' }] }),
            'prompts/get': (p) => ({ messages: [{ role: 'user', content: { text: p.name } }] }),
          },
        },
      },
    });
    const id = fake.deviceId!;
    const grantee = { kind: 'user' as const, id: ACCOUNT };
    const req = (method: string, params: Record<string, unknown> = {}) =>
      env.svc.mcpRequest(ACCOUNT, id, grantee, { server: 'notes', method, params });

    // Without the grant the device refuses.
    await expect(req('resources/list')).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'mcp_grant_required' },
    });
    await env.svc.grant(ACCOUNT, id, { grantee, kind: 'mcp', target: 'notes', access: 'call' });
    expect(await req('resources/list')).toEqual({ resources: [{ uri: 'note://1', name: 'One' }] });
    expect(env.audit.filter((a) => a.action === 'device.mcp.request')).toEqual([]);
    expect(await req('resources/read', { uri: 'note://1' })).toEqual({
      contents: [{ uri: 'note://1', text: 'one' }],
    });
    expect(await req('prompts/get', { name: 'brief' })).toMatchObject({ messages: [{}] });
    expect(env.audit.filter((a) => a.action === 'device.mcp.request')).toEqual([
      expect.objectContaining({
        resource: id,
        detail: expect.objectContaining({ server: 'notes', method: 'resources/read' }),
        inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      expect.objectContaining({
        detail: expect.objectContaining({ method: 'prompts/get' }),
      }),
    ]);
    // Anything else is refused by the device; a method the server lacks is the server's error.
    await expect(req('tools/call')).rejects.toMatchObject({ code: 'validation' });
    await expect(req('prompts/list')).rejects.toThrow(/MCP error/);
  });
});
