// Shared setup for the runner's HTTP tests: local Git repositories as fixtures, a runner server
// with a test token, and helpers. Tests that start sandboxes run only where bubblewrap works.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BwrapSubstrate,
  buildRunnerServer,
  findOnPath,
  newRunnerToken,
  silentLog,
  tokenHash,
  tokenRecord,
  type RunnerServer,
  type RunnerServerOptions,
} from '../src/index.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON read by tests
export type Json = Record<string, any>;

/** Whether bubblewrap can make a sandbox on this host (the skip reason otherwise). */
export async function bwrapReason(): Promise<string | null> {
  const bin = findOnPath('bwrap');
  if (!bin || process.platform !== 'linux') return 'bubblewrap is not installed';
  const a = await new BwrapSubstrate({ bin }).available();
  return a.ok ? null : a.detail;
}

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
}

/** A Git repository with one commit of `files`. */
export function makeRepo(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

export interface TestRunner {
  server: RunnerServer;
  token: string;
  dir: string;
  repos: string;
  req(
    method: string,
    url: string,
    payload?: unknown,
    token?: string | null,
  ): Promise<{ status: number; body: Json; raw: string }>;
  close(): Promise<void>;
}

export async function startRunner(
  over: Partial<RunnerServerOptions> = {},
  dir?: string,
): Promise<TestRunner> {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'nova-runner-'));
  const repos = join(root, 'repos');
  mkdirSync(repos, { recursive: true });
  const token = newRunnerToken();
  const server = await buildRunnerServer({
    dataDir: join(root, 'data'),
    tokens: [tokenRecord(tokenHash(token), 'test-hub')],
    localRepoRoots: [repos],
    log: silentLog,
    limits: { meterIntervalMs: 50, diskIntervalMs: 100 },
    ...over,
  });
  const req: TestRunner['req'] = async (method, url, payload, tok = token) => {
    const r = await server.app.inject({
      method: method as 'GET',
      url,
      headers: tok ? { authorization: `Bearer ${tok}` } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    let body: Json = {};
    try {
      body = r.json();
    } catch {
      // not JSON
    }
    return { status: r.statusCode, body, raw: r.body };
  };
  return {
    server,
    token,
    dir: root,
    repos,
    req,
    close: async () => {
      await server.close();
      if (!dir) rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function until<T>(
  fn: () => T | Promise<T>,
  ok: (v: T) => boolean,
  ms = 15_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Create an environment and wait until it is ready (or failed). */
export async function readyEnv(t: TestRunner, body: Json): Promise<Json> {
  const res = await t.req('POST', '/v1/runner/environments', body);
  if (res.status !== 201 && res.status !== 200) throw new Error(`create: ${res.status} ${res.raw}`);
  return (
    await until(
      () => t.req('GET', `/v1/runner/environments/${res.body.id}`),
      (r) => r.body.status !== 'provisioning',
    )
  ).body;
}

/** Run a command to the end and return its whole output. */
export async function runToEnd(
  t: TestRunner,
  runId: string,
  cmd: string,
  extra: Json = {},
): Promise<{ output: string; exitCode: number | null; processId: string }> {
  const p = await t.req('POST', `/v1/runner/runs/${runId}/exec`, { cmd, ...extra });
  if (p.status !== 201) throw new Error(`exec: ${p.status} ${p.raw}`);
  let offset = 0;
  let output = '';
  for (;;) {
    const r = await t.req(
      'GET',
      `/v1/runner/runs/${runId}/processes/${p.body.id}/output?offset=${offset}&waitMs=2000`,
    );
    output += r.body.data;
    offset = r.body.offset;
    if (!r.body.running) return { output, exitCode: r.body.exitCode, processId: p.body.id };
  }
}
