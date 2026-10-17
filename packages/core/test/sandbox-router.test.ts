// Commands by thread (FR-062, FR-078): a Code session on another machine runs its commands there;
// polls, writes and kills follow the session; everything else stays on the Hub's sandbox.
import { describe, expect, it } from 'vitest';
import { threadSandboxRouter } from '../src/tools/sandbox.ts';
import type { ExecRequest, ExecResult, SandboxClient } from '../src/tools/types.ts';

function fake(name: string) {
  const calls: string[] = [];
  let n = 0;
  const client: SandboxClient = {
    substrate: name === 'hub' ? 'container' : null,
    available: () => Promise.resolve({ ok: true, detail: name }),
    exec: (req: ExecRequest): Promise<ExecResult> => {
      calls.push(`exec ${req.cmd}`);
      return Promise.resolve(
        req.yieldMs === 0
          ? { status: 'running', sessionId: `${name}-${++n}`, output: '' }
          : { status: 'exited', exitCode: 0, output: name },
      );
    },
    poll: (id) => {
      calls.push(`poll ${id}`);
      return Promise.resolve({ status: 'exited', exitCode: 0, output: name });
    },
    write: (id, input) => {
      calls.push(`write ${id} ${input.signal ?? input.text ?? ''}`);
      return Promise.resolve();
    },
    killTurn: (turnId) => {
      calls.push(`kill ${turnId}`);
      return Promise.resolve();
    },
  };
  return { client, calls };
}

/** An exec request; `owner` and `egress` are the extras callers add (ExecRequestExtras). */
type RoutedRequest = ExecRequest & {
  owner?: { accountId: string; threadId: string; turnId: string; callId: string | null };
  egress?: { accountId: string; threadId?: string | null };
};

const req = (over: Partial<RoutedRequest> = {}): RoutedRequest => ({
  cmd: 'ls',
  cwd: '/w',
  roots: [],
  network: 'off',
  yieldMs: 1000,
  signal: new AbortController().signal,
  ...over,
});

describe('threadSandboxRouter', () => {
  it("runs a remote session's commands on its machine and keeps the rest on the Hub", async () => {
    const hub = fake('hub');
    const remote = fake('ssh');
    const router = threadSandboxRouter(hub.client, (_a, threadId) =>
      threadId === 'T-remote' ? remote.client : null,
    );
    expect(router.substrate).toBe('container');
    const owner = (threadId: string) => ({
      owner: { accountId: 'a', threadId, turnId: 'turn-1', callId: 'c1' },
    });
    expect(await router.exec(req({ ...owner('T-remote'), cmd: 'make' }))).toMatchObject({
      output: 'ssh',
    });
    expect(await router.exec(req({ ...owner('T-local') }))).toMatchObject({ output: 'hub' });
    // Callers without an exec owner name the thread through `egress`.
    expect(
      await router.exec(req({ egress: { accountId: 'a', threadId: 'T-remote' }, cmd: 'test' })),
    ).toMatchObject({ output: 'ssh' });
    expect(await router.exec(req())).toMatchObject({ output: 'hub' });
    expect(remote.calls).toEqual(['exec make', 'exec test']);
    expect(hub.calls).toEqual(['exec ls', 'exec ls']);
  });

  it('sends polls, writes and kills to the machine the session started on', async () => {
    const hub = fake('hub');
    const remote = fake('ssh');
    const router = threadSandboxRouter(hub.client, () => remote.client);
    const started = await router.exec(
      req({
        yieldMs: 0,
        turnId: 'turn-9',
        owner: { accountId: 'a', threadId: 'T', turnId: 'turn-9', callId: null },
      }),
    );
    expect(started).toMatchObject({ status: 'running', sessionId: 'ssh-1' });
    await router.write('ssh-1', { text: 'y\n' });
    expect(await router.poll('ssh-1', 10, new AbortController().signal)).toMatchObject({
      output: 'ssh',
    });
    // Once exited, an unknown session goes to the Hub (which answers not found itself).
    await router.poll('ssh-1', 10, new AbortController().signal);
    await router.killTurn('turn-9');
    expect(remote.calls).toEqual(['exec ls', 'write ssh-1 y\n', 'poll ssh-1', 'kill turn-9']);
    expect(hub.calls).toEqual(['poll ssh-1', 'kill turn-9']);
  });
});
