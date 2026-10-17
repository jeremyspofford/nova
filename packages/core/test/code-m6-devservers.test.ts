// Dev servers (FR-097, FR-067; docs/10 §7): detection of common frameworks and
// `.nova/launch.json`, start in the session sandbox as an exec session, the URL handed to the
// browser pane through the egress proxy's dev-server grant, stop, stop-all and exits noticed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isNovaError } from '@nova/shared';
import { MAX_DEV_SERVERS, detectDevServers } from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { SessionSandbox, makeCodeM6Env, until, type CodeM6Env } from './code-m6-env.ts';

let e: CodeM6Env | null = null;
let box: SessionSandbox | null = null;
afterEach(async () => {
  box?.stop();
  await e?.close();
  e = null;
  box = null;
});

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (isNovaError(err)) return String((err.details as { reason?: string } | undefined)?.reason);
    throw err;
  }
  throw new Error('expected a failure');
}

/** A tiny HTTP server the launch configuration starts (node is on the test host). */
const SERVER = `node -e "require('http').createServer((q,s)=>s.end('hello from dev')).listen(+process.env.PORT,'127.0.0.1')"`;

describe('dev server detection', () => {
  it('finds package.json scripts, Django, Rails, Go and launch configurations', async () => {
    e = await makeCodeM6Env();
    const dir = join(e.dir, 'proj');
    mkdirSync(join(dir, '.nova'), { recursive: true });
    mkdirSync(join(dir, 'web'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: { dev: 'vite', start: 'next start', build: 'tsc' },
        devDependencies: { vite: '7.0.0' },
      }),
    );
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(dir, 'manage.py'), '');
    writeFileSync(join(dir, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 8.0'\n");
    writeFileSync(join(dir, 'go.mod'), 'module x\n');
    writeFileSync(join(dir, 'main.go'), 'package main\n');
    writeFileSync(
      join(dir, '.nova', 'launch.json'),
      JSON.stringify({
        configurations: [
          { name: 'web', command: 'npm run serve', cwd: 'web', port: 4000 },
          { name: 'escape', command: 'x', cwd: '../elsewhere' },
          { name: 'git', command: 'x', cwd: '.git' },
          { name: 'multi', command: 'a\nb' },
          { command: 'nameless' },
        ],
      }),
    );
    const found = await detectDevServers(dir);
    expect(found.map((c) => c.id)).toEqual([
      'launch:web',
      'pnpm:dev',
      'pnpm:start',
      'django',
      'rails',
      'go',
    ]);
    expect(found[0]).toMatchObject({ cwd: 'web', port: 4000, source: 'launch.json' });
    expect(found[1]).toMatchObject({ framework: 'Vite', command: 'pnpm dev', port: 5173 });
    expect(found[2]).toMatchObject({ framework: 'Next.js', port: 3000 });
    expect(await detectDevServers(join(e.dir, 'nothing-here'))).toEqual([]);
  });
});

describe('dev servers', () => {
  it('starts a server in the session sandbox, exposes its URL through the grant, and stops it', async () => {
    box = new SessionSandbox();
    e = await makeCodeM6Env({ sandbox: box });
    mkdirSync(join(e.repo, '.nova'));
    writeFileSync(
      join(e.repo, '.nova', 'launch.json'),
      JSON.stringify({ configurations: [{ name: 'api', command: SERVER, port: 43_219 }] }),
    );
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    const grants: { host: string; port: number }[] = [];
    let revoked = 0;
    e.devServers.useGrant((input) => {
      grants.push({ host: input.host, port: input.port });
      return Promise.resolve({
        url: `http://127.0.0.1:${input.port}/`,
        revoke: () => {
          revoked++;
          return Promise.resolve();
        },
      });
    });
    const opened: string[] = [];
    e.devServers.useOpener((input) => {
      opened.push(input.url);
      return Promise.resolve();
    });
    const v = await e.devServers.start(ACCOUNT, s.id, {}, 'user');
    expect(v).toMatchObject({ status: 'running', candidateId: 'launch:api', port: 43_219 });
    expect(v.url).toBe('http://127.0.0.1:43219/');
    expect(grants).toEqual([{ host: '127.0.0.1', port: 43_219 }]);
    expect(opened).toEqual([v.url]);
    expect(box.reqs.at(-1)).toMatchObject({
      network: 'off',
      env: { PORT: '43219' },
      turnId: `devserver:${v.id}`,
    });
    await until(async () => {
      try {
        return (await (await fetch(v.url!)).text()) === 'hello from dev';
      } catch {
        return false;
      }
    });
    // Starting the same one again returns it.
    expect(
      (await e.devServers.start(ACCOUNT, s.id, { candidateId: 'launch:api' }, 'agent')).id,
    ).toBe(v.id);
    expect(e.events.events.find((x) => x.name === 'code.devserver.started')?.payload).toMatchObject(
      {
        serverId: v.id,
        url: v.url,
      },
    );
    const stopped = await e.devServers.stop(ACCOUNT, s.id, v.id, 'user');
    expect(stopped.status).toBe('stopped');
    expect(revoked).toBe(1);
    expect(e.events.events.some((x) => x.name === 'code.devserver.stopped')).toBe(true);
    expect(e.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['code.devserver.start', 'code.devserver.stop']),
    );
  });

  it('stops all servers of a session and notices one that exits by itself', async () => {
    box = new SessionSandbox();
    e = await makeCodeM6Env({ sandbox: box });
    mkdirSync(join(e.repo, '.nova'));
    writeFileSync(
      join(e.repo, '.nova', 'launch.json'),
      JSON.stringify({
        configurations: [
          { name: 'a', command: 'sleep 30', port: 41_001 },
          { name: 'b', command: 'sleep 30', port: 41_002 },
          { name: 'short', command: 'sleep 4; exit 2', port: 41_003 },
        ],
      }),
    );
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    await e.devServers.start(ACCOUNT, s.id, { candidateId: 'launch:a' }, 'user');
    await e.devServers.start(ACCOUNT, s.id, { candidateId: 'launch:b' }, 'user');
    const short = await e.devServers.start(ACCOUNT, s.id, { candidateId: 'launch:short' }, 'user');
    await until(async () => {
      const list = await e!.devServers.list(ACCOUNT, s.id);
      return list.find((x) => x.id === short.id)?.status === 'failed';
    }, 8_000);
    expect((await e.devServers.list(ACCOUNT, s.id)).find((x) => x.id === short.id)?.exitCode).toBe(
      2,
    );
    const all = await e.devServers.stopAll(ACCOUNT, s.id, 'user');
    expect(all.filter((x) => x.status === 'stopped')).toHaveLength(2);
  }, 15_000);

  it('refuses a server that exits at once, unknown candidates, a remote folder and too many', async () => {
    box = new SessionSandbox();
    e = await makeCodeM6Env({ sandbox: box });
    const s0 = await e.svc.create(ACCOUNT, { folder: e.repo });
    await expect(reason(e.devServers.start(ACCOUNT, s0.id, {}, 'agent'))).resolves.toBe(
      'no_dev_server',
    );
    mkdirSync(join(e.repo, '.nova'));
    writeFileSync(
      join(e.repo, '.nova', 'launch.json'),
      JSON.stringify({
        configurations: [
          { name: 'broken', command: 'echo nope; exit 1' },
          ...[1, 2, 3, 4, 5].map((i) => ({ name: `s${i}`, command: 'sleep 30', port: 42_000 + i })),
        ],
      }),
    );
    await expect(
      reason(e.devServers.start(ACCOUNT, s0.id, { candidateId: 'launch:broken' }, 'agent')),
    ).resolves.toBe('dev_server_exited');
    await expect(
      reason(e.devServers.start(ACCOUNT, s0.id, { candidateId: 'launch:none' }, 'agent')),
    ).resolves.toBe('no_dev_server');
    for (let i = 1; i <= MAX_DEV_SERVERS; i++)
      await e.devServers.start(ACCOUNT, s0.id, { candidateId: `launch:s${i}` }, 'agent');
    await expect(
      reason(e.devServers.start(ACCOUNT, s0.id, { candidateId: 'launch:s5' }, 'agent')),
    ).resolves.toBe('too_many_dev_servers');
    // Servers of sessions that are no longer active are stopped by the sweep.
    expect(await e.devServers.stopInactive(() => false)).toBe(MAX_DEV_SERVERS);
    // A session on another machine has no Hub-side dev servers yet.
    const v = await e.svc.envs.create(ACCOUNT, {
      kind: 'ssh',
      label: 'r',
      connection: { host: 'h.example', port: 22, user: 'u', auth: 'key' },
      credential: { privateKey: 'PRIVATE KEY' },
    });
    const remoteDir = join(e.dir, 'remote');
    mkdirSync(remoteDir);
    const remote = await e.svc.create(ACCOUNT, { folder: remoteDir, environmentId: v.id });
    expect(await e.devServers.detect(ACCOUNT, remote.id)).toEqual([]);
    await expect(reason(e.devServers.start(ACCOUNT, remote.id, {}, 'agent'))).resolves.toBe(
      'remote_environment',
    );
  });

  it('needs a sandbox', async () => {
    e = await makeCodeM6Env({ sandbox: null });
    writeFileSync(join(e.repo, 'manage.py'), '');
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    await expect(e.devServers.start(ACCOUNT, s.id, {}, 'user')).rejects.toThrow(/no sandbox/);
  });
});
