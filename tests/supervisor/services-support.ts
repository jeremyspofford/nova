// A supervisor in this process, with the stand-in console (fake.ts) and the stand-in service
// (scripts/stand-ins/fake-service.js), every folder the test's own and every port a free one on
// 127.0.0.1. `stop` ends it and checks that no process it started is left: the services, their
// process groups, and the console.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Supervisor } from '../../src/supervisor/supervisor.ts';
import { FAST, fakeRepo, get } from './fake.ts';
import { alive } from '../support/services.ts';
import { scratch, until } from './support.ts';

export const SERVICE_TIMINGS = { ...FAST, healthEveryMs: 300, healthFailures: 2, canaryMs: 1500, probeEveryMs: 200, readyMs: 8000 };

export interface Harness { s: Supervisor; dir: string; repo: string; stop: () => Promise<void>; told: () => Promise<{ playbook: string; said: string; subject?: string }[]> }

export async function supervised(prefix: string, o: { timings?: Partial<typeof SERVICE_TIMINGS>; dir?: string; repo?: string; make?: (dir: string, repo: string) => Supervisor } = {}): Promise<Harness> {
  const dir = o.dir ?? scratch(prefix);
  const repo = o.repo ?? fakeRepo(dir);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const s = o.make?.(dir, repo) ?? new Supervisor({ dir: join(dir, 'sup'), home, repo, base: repo, env: { PATH: process.env.PATH ?? '', NOVA_PORT: '0' }, tests: [process.execPath, '-e', ''], timings: { ...SERVICE_TIMINGS, ...o.timings } });
  await s.run();
  await until(() => s.state.mode === 'running' && !!s.server?.port, 'the stand-in console');
  // Every process this supervisor started, as it goes: none may outlive it.
  const seen = new Set<number>();
  const note = setInterval(() => { for (const p of s.services.pids()) seen.add(p); if (s.server?.pid) seen.add(s.server.pid); }, 50);
  return {
    s, dir, repo,
    told: async () => (await get(`http://127.0.0.1:${s.server!.port}`, '/told')) as { playbook: string; said: string; subject?: string }[],
    async stop() {
      for (const p of s.services.pids()) seen.add(p);
      if (s.server?.pid) seen.add(s.server.pid);
      clearInterval(note);
      await s.close();
      await until(() => [...seen].every((p) => !alive(p)), `every process the supervisor started to be gone (${[...seen].filter(alive).join(', ')})`, 5000);
      assert.deepEqual(s.services.pids(), []);
    },
  };
}
