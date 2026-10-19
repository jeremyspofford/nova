// What an approval card shows besides the arguments (M7, M6 gap): a built-in tool's
// `approvalDetail` reaches the gate's preview, redacted (the gate also bounds it); a detail that
// cannot be made leaves the arguments alone. A device-file commit's card shows its staged diff.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '@nova/telemetry';
import {
  deviceFileTools,
  type DeviceAgentThread,
  type GateRequest,
  type ToolContext,
  type ToolGate,
  type ToolSourceProvider,
} from '../src/index.ts';
import { builtinDescriptor, ok, type BuiltinTool } from '../src/tools/builtin.ts';
import { ACCOUNT, makeToolEnv, type ToolEnv } from './helpers.ts';
import { devicesEnv, type DevicesEnv } from './devices-env.ts';

let env: ToolEnv | null = null;
let denv: DevicesEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await denv?.close();
  denv = null;
});

function tool(name: string, detail: () => Promise<string | null>): BuiltinTool {
  return {
    descriptor: builtinDescriptor({
      name,
      title: name,
      description: 'test',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      annotations: { action: 'write' },
    }),
    origin: null,
    approvalDetail: detail,
    handler: () => Promise.resolve(ok('done')),
  };
}

describe('approval details', () => {
  it('reach the gate redacted, and a failing one leaves the arguments alone', async () => {
    const seen: GateRequest[] = [];
    const gate: ToolGate = {
      check: (req) => {
        seen.push(req);
        return Promise.resolve({ effect: 'allow', reason: 'test', tier: 'pre_approvable' });
      },
      preview: () => Promise.reject(new Error('unused')),
    };
    const source: ToolSourceProvider = {
      source: 'builtin',
      list: () =>
        Promise.resolve([
          tool('test.detail', () =>
            Promise.resolve('Diff of a.env:\n+TOKEN=ghp_fake0123456789abcdefghijklmn'),
          ),
          tool('test.broken', () => Promise.reject(new Error('no diff'))),
        ]),
    };
    env = await makeToolEnv({ gate, sources: [source] });
    for (const name of ['test.detail', 'test.broken']) {
      const { done } = await env.runtime.invoke({ accountId: ACCOUNT, name, args: { id: 's1' } });
      expect((await done).ok).toBe(true);
    }
    expect(seen[0]!.argsPreview).toContain('"id":"s1"');
    expect(seen[0]!.argsPreview).toContain('Diff of a.env:');
    expect(seen[0]!.argsPreview).not.toContain('ghp_fake0123456789abcdefghijklmn');
    expect(seen[1]!.argsPreview).toBe(JSON.stringify({ id: 's1' }));
  });

  it("show a device-file commit's staged diff to the owner, only for the thread's own agent", async () => {
    denv = await devicesEnv();
    const fake = await denv.enroll({ name: 'Laptop' });
    const proj = join(denv.dir, 'proj', 'src');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'notes.md'), '# Notes\n\nfirst\n');
    const links = new Map<string, DeviceAgentThread>([
      ['thread-1', { agentId: 'agent-1', kind: 'main', audience: 'private' }],
      ['thread-2', { agentId: 'agent-2', kind: 'main', audience: 'private' }],
    ]);
    const tools = new Map(
      deviceFileTools({
        service: denv.svc,
        agentOf: () => (_a, threadId) => Promise.resolve(links.get(threadId) ?? null),
      }).map((t) => [t.descriptor.name, t]),
    );
    await denv.svc.connect(ACCOUNT, {
      agentId: 'agent-1',
      deviceId: fake.deviceId!,
      capabilities: ['files', 'staged_writes'],
    });
    await denv.svc.grant(ACCOUNT, fake.deviceId!, {
      grantee: { kind: 'agent', id: 'agent-1' },
      kind: 'folder',
      target: proj,
      access: 'write',
    });
    const ctx = (threadId: string) =>
      ({
        accountId: ACCOUNT,
        threadId,
        turnId: 't',
        callId: 'c',
        projectId: null,
        origin: 'model',
        profile: { id: 'workspace', hash: 'h' },
        roots: [],
        sandbox: {} as never,
        signal: new AbortController().signal,
        log: new Logger({ module: 'test', sinks: [] }),
      }) as ToolContext;
    const staged = await tools
      .get('device.files.stage_write')!
      .handler({ path: join(proj, 'notes.md'), content: '# Notes\n\nsecond\n' }, ctx('thread-1'));
    expect(staged.ok).toBe(true);
    const stagedId = String(staged.ok ? staged.meta?.stagedId : '');
    const commit = tools.get('device.files.commit')!;
    const detail = await commit.approvalDetail!({ stagedId }, ctx('thread-1'));
    expect(detail).toContain(`Diff of ${join(proj, 'notes.md')} (+1 -1):`);
    expect(detail).toContain('-first');
    expect(detail).toContain('+second');
    expect(detail!.length).toBeLessThan(1_800);
    // Another agent's thread gets no detail about this write.
    expect(await commit.approvalDetail!({ stagedId }, ctx('thread-2'))).toBeNull();
  });
});
