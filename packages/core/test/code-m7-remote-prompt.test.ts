// The tools section of the system prompt in a session on another machine (M7 security fix,
// docs/10 §2): the thread has no root on the Hub, so the model is told the folder there (or that
// the machine cannot be reached), never a Hub folder.
import { afterEach, describe, expect, it } from 'vitest';
import { UnavailableSandbox, type RemoteFiles, type SandboxClient } from '../src/index.ts';
import { ACCOUNT, THREAD, TURN, flaggedEnv, type FlaggedEnv } from './flagged-env.ts';

let env: FlaggedEnv;
afterEach(() => env.close());

/** A sandbox router whose thread is on another machine (or cannot be reached: `null`). */
function routed(files: RemoteFiles | null): SandboxClient {
  return Object.assign(new UnavailableSandbox('elsewhere'), { filesFor: () => files });
}

const files = {
  label: 'build-box',
  root: '/srv/proj',
  access: 'write',
} as RemoteFiles;

async function systemOf(): Promise<string> {
  const turn = await env.runtime.beginTurn({
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: TURN,
    projectId: null,
    mode: 'code',
    signal: new AbortController().signal,
  });
  return (await turn.offer()).system;
}

describe('the tools prompt in a session on another machine', () => {
  it('names the folder on that machine, not a Hub folder', async () => {
    env = await flaggedEnv({ mode: 'code', sandbox: routed(files) });
    const system = await systemOf();
    expect(system).toContain(
      '- /srv/proj on build-box (read and write, relative paths start here)',
    );
    expect(system).not.toContain(env.workspace);
  });

  it('says the machine cannot be reached when it cannot', async () => {
    env = await flaggedEnv({ mode: 'code', sandbox: routed(null) });
    const system = await systemOf();
    expect(system).toContain('cannot be reached now');
    expect(system).not.toContain(env.workspace);
  });

  it('lists the Hub roots for a thread on the Hub, as before', async () => {
    env = await flaggedEnv({ mode: 'code' });
    expect(await systemOf()).toContain(`- ${env.workspace} (read and write`);
  });
});
