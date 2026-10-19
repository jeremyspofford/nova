// Runner HTTP tests (contracts/rest-api.md §5; FR-108, FR-071, FR-116): auth on every route and
// per-token rate limits, the environment lifecycle with local Git repositories (two side by side, a
// setup script, a cache), commands with streamed output (SSE) and reattach by offset, cancel, the
// CPU and wall-time caps, the disk cap, sandbox isolation (no host paths, no network), files,
// snapshots and restore, artifacts, persistence across a restart, and the refusal without a
// substrate. Sandboxed tests need bubblewrap; they are skipped with the reason elsewhere.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newRunnerToken, tokenHash, tokenRecord } from '../src/index.ts';
import {
  bwrapReason,
  git,
  makeRepo,
  readyEnv,
  runToEnd,
  startRunner,
  until,
  type Json,
  type TestRunner,
} from './env.ts';

const skip = await bwrapReason();
if (skip) console.warn(`runner sandbox tests skipped: ${skip}`);

const open: TestRunner[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
async function runner(...args: Parameters<typeof startRunner>): Promise<TestRunner> {
  const t = await startRunner(...args);
  open.push(t);
  return t;
}

describe('auth and limits', () => {
  it('requires a known token on every route, including health', async () => {
    const t = await runner({ substrate: null, rateLimits: { authFailuresPerMinute: 1_000 } });
    const id = '01920000-0000-4000-8000-000000000001';
    const routes: [string, string][] = [
      ['GET', '/v1/runner/health'],
      ['POST', '/v1/runner/environments'],
      ['GET', '/v1/runner/environments'],
      ['GET', `/v1/runner/environments/${id}`],
      ['POST', `/v1/runner/environments/${id}/rebuild`],
      ['DELETE', `/v1/runner/environments/${id}`],
      ['GET', `/v1/runner/environments/${id}/files?path=/workspace`],
      ['PUT', `/v1/runner/environments/${id}/files?path=/workspace/a`],
      ['DELETE', `/v1/runner/environments/${id}/files?path=/workspace/a`],
      ['POST', '/v1/runner/runs'],
      ['GET', '/v1/runner/runs'],
      ['GET', `/v1/runner/runs/${id}`],
      ['PATCH', `/v1/runner/runs/${id}`],
      ['POST', `/v1/runner/runs/${id}/cancel`],
      ['POST', `/v1/runner/runs/${id}/finish`],
      ['POST', `/v1/runner/runs/${id}/approve`],
      ['GET', `/v1/runner/runs/${id}/stream`],
      ['POST', `/v1/runner/runs/${id}/exec`],
      ['POST', `/v1/runner/runs/${id}/run`],
      ['GET', `/v1/runner/runs/${id}/processes`],
      ['GET', `/v1/runner/runs/${id}/processes/${id}/output`],
      ['POST', `/v1/runner/runs/${id}/processes/${id}/input`],
      ['POST', `/v1/runner/runs/${id}/kill`],
      ['POST', `/v1/runner/runs/${id}/artifacts`],
      ['GET', `/v1/runner/runs/${id}/artifacts/${id}`],
      ['POST', '/v1/runner/snapshots'],
      ['GET', '/v1/runner/snapshots'],
      ['GET', `/v1/runner/snapshots/${id}`],
      ['POST', `/v1/runner/snapshots/${id}/restore`],
      ['DELETE', `/v1/runner/snapshots/${id}`],
      ['GET', '/v1/runner/nothing-here'],
    ];
    for (const [m, u] of routes) {
      const none = await t.req(m, u, m === 'GET' || m === 'DELETE' ? undefined : {}, null);
      expect(none.status, `${m} ${u}`).toBe(401);
      expect(none.body.error.code).toBe('auth_missing');
      const wrong = await t.req(
        m,
        u,
        m === 'GET' || m === 'DELETE' ? undefined : {},
        newRunnerToken(),
      );
      expect(wrong.status, `${m} ${u}`).toBe(401);
      expect(wrong.body.error.code).toBe('auth_invalid');
    }
    const ok = await t.req('GET', '/v1/runner/health');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ok', substrate: { kind: null, ok: false } });
    expect(ok.body.requestId).toBeUndefined();
  });

  it('limits failed sign-ins per address and requests per token', async () => {
    const t = await runner({
      substrate: null,
      rateLimits: { authFailuresPerMinute: 3, perMinute: 5 },
    });
    for (let i = 0; i < 3; i++)
      expect((await t.req('GET', '/v1/runner/health', undefined, null)).status).toBe(401);
    const limited = await t.req('GET', '/v1/runner/health', undefined, null);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({ code: 'rate_limited', retryable: true });
    for (let i = 0; i < 5; i++) expect((await t.req('GET', '/v1/runner/health')).status).toBe(200);
    expect((await t.req('GET', '/v1/runner/health')).status).toBe(429);
  });

  it('refuses environments when no sandbox can run, saying why', async () => {
    const t = await runner({ substrateMode: 'none' });
    const res = await t.req('POST', '/v1/runner/environments', { repoUrls: [] });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'sandbox_unavailable',
      details: { reason: 'no_substrate' },
    });
    expect(res.body.error.message).toMatch(/turned off/);
    const approve = await t.req('POST', '/v1/runner/runs/x/approve', {});
    expect(approve.status).toBe(501);
    expect(approve.body.error.details.reason).toBe('approvals_on_hub');
  });

  it('validates bodies and refuses repositories outside https and the local roots', async () => {
    const t = await runner({ substrate: null });
    const bad = await t.req('POST', '/v1/runner/environments', { repoUrls: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    const extra = await t.req('POST', '/v1/runner/runs', {
      environmentId: '01920000-0000-4000-8000-000000000001',
      taskCiphertext: 'abc',
    });
    expect(extra.status).toBe(400);
  });
});

describe.skipIf(skip)('environments and commands in the sandbox', () => {
  it('clones two repositories side by side, runs the setup once and keeps caches', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { 'README.md': 'app\n', 'src/main.sh': 'echo main\n' });
    makeRepo(t.repos, 'lib', { 'lib.txt': 'lib\n' });
    git(['checkout', '-q', '-b', 'feature'], join(t.repos, 'lib'));
    const env = await readyEnv(t, {
      name: 'two repos',
      repoUrls: [`file://${t.repos}/app`, `file://${t.repos}/lib#feature`],
      setupScript:
        'echo "in $(pwd)"; echo setting up; ls /workspace; touch /cache/npm/warm; echo "$npm_config_cache" > .setup',
      caches: ['npm'],
    });
    expect(env).toMatchObject({
      name: 'two repos',
      status: 'ready',
      substrate: 'bwrap',
      setup: { status: 'ok', exitCode: 0 },
      connection: {
        workdir: '/workspace',
        repos: [
          { name: 'app', path: '/workspace/app', ref: null },
          { name: 'lib', path: '/workspace/lib', ref: 'feature' },
        ],
        caches: [{ name: 'npm', path: '/cache/npm' }],
      },
    });
    expect(env.setup.log).toContain('setting up');
    expect(env.setup.log).toContain('app\nlib');
    // J9 bug 6: the setup script runs in the first repository, as the environment dialog says.
    expect(env.setup.log).toContain('in /workspace/app\n');
    const bare = await readyEnv(t, { repoUrls: [], setupScript: 'echo "in $(pwd)"' });
    expect(bare.setup.log).toBe('in /workspace\n');
    expect(env.connection.repos[0].head).toMatch(/^[0-9a-f]{40}$/);
    const run = await t.req('POST', '/v1/runner/runs', { environmentId: env.id, label: 'code:s1' });
    expect(run.status).toBe(201);
    const r = await runToEnd(
      t,
      run.body.id,
      'cat app/.setup; ls /cache/npm; cat lib/lib.txt; git -C lib rev-parse --abbrev-ref HEAD',
      { cwd: '/workspace' },
    );
    expect(r).toMatchObject({ exitCode: 0 });
    expect(r.output).toBe('/cache/npm\nwarm\nlib\nfeature\n');
    // A rebuild clones again and runs the setup again; the cache stays.
    const rebuilt = await t.req('POST', `/v1/runner/environments/${env.id}/rebuild`);
    expect(rebuilt.status).toBe(202);
    const again = await until(
      () => t.req('GET', `/v1/runner/environments/${env.id}`),
      (x) => x.body.status !== 'provisioning',
    );
    expect(again.body.status).toBe('ready');
    const after = await runToEnd(
      t,
      run.body.id,
      'ls /cache/npm; test -f app/.setup && echo setup-again',
    );
    expect(after.output).toBe('warm\nsetup-again\n');
    // Another Hub's token sees nothing of it.
    const other = newRunnerToken();
    const t2 = await runner({
      substrate: t.server.runner.substrate,
      tokens: [tokenRecord(tokenHash(other))],
    });
    expect(
      (await t2.req('GET', `/v1/runner/environments/${env.id}`, undefined, other)).status,
    ).toBe(404);
    expect((await t.req('GET', '/v1/runner/environments')).body.items).toHaveLength(2);
  });

  it('fails an environment whose setup fails, and refuses repositories it may not clone', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { a: '1' });
    const failed = await readyEnv(t, {
      repoUrls: [`file://${t.repos}/app`],
      setupScript: 'echo nope; exit 7',
    });
    expect(failed).toMatchObject({ status: 'failed', setup: { status: 'failed', exitCode: 7 } });
    expect(failed.detail).toMatch(/exit 7/);
    const notReady = await t.req('POST', '/v1/runner/runs', { environmentId: failed.id });
    expect(notReady.status).toBe(409);
    const outside = mkdtempSync(join(tmpdir(), 'nova-runner-outside-'));
    try {
      makeRepo(outside, 'secret', { s: 'x' });
      const refused = await t.req('POST', '/v1/runner/environments', {
        repoUrls: [`file://${outside}/secret`],
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error.details.reason).toBe('local_repo_refused');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    const http = await t.req('POST', '/v1/runner/environments', {
      repoUrls: ['http://git.example/x.git'],
    });
    expect(http.body.error.details.reason).toBe('bad_scheme');
    const image = await t.req('POST', '/v1/runner/environments', {
      repoUrls: [],
      baseImage: 'node:24',
    });
    expect(image.body.error.details.reason).toBe('base_image_unsupported');
    const missing = await readyEnv(t, { repoUrls: [`file://${t.repos}/nothing`] }).catch(
      (e: Error) => e,
    );
    expect((missing as Error).message).toMatch(/400/);
    // Review finding 5: no credentials in a repository URL (they would land in .git/config,
    // env.json and snapshots); no private or local hosts.
    for (const [url, reason] of [
      ['https://user:ghp_secret@git.example/x.git', 'credentials_in_url'],
      ['https://token@git.example/x.git', 'credentials_in_url'],
      ['https://127.0.0.1/x.git', 'private_host'],
      ['https://localhost:8443/x.git', 'private_host'],
      ['https://10.1.2.3/x.git', 'private_host'],
      ['https://[::1]/x.git', 'private_host'],
      ['https://192.168.0.9/x.git', 'private_host'],
    ] as const) {
      const r = await t.req('POST', '/v1/runner/environments', { repoUrls: [url] });
      expect(r.status, url).toBe(400);
      expect(r.body.error.details.reason, url).toBe(reason);
      expect(r.raw).not.toContain('ghp_secret');
    }
  });

  it('keeps Nova state out of commands, limits each sandbox and each Hub, counts disk fail-closed', async () => {
    const t = await runner({
      limits: {
        meterIntervalMs: 50,
        diskIntervalMs: 100,
        processesPerSandbox: 16,
        maxProcessesPerOwner: 2,
        sandboxMemoryMb: 128,
        diskMaxEntries: 60,
      },
    });
    makeRepo(t.repos, 'app', { a: '1' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`] });
    const run = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    // Finding 6: /nova is not there for commands; the Hub's own programs still have it.
    const planted = await runToEnd(
      t,
      run.id,
      'echo pwned > /nova/planted 2>&1; echo "x=$?"; ls /nova 2>&1',
    );
    expect(planted.output).toMatch(/x=[12]/);
    expect(planted.output).not.toContain('planted\n');
    const own = await t.req('POST', `/v1/runner/runs/${run.id}/run`, {
      argv: ['sh', '-c', 'echo mine > /nova/f && cat /nova/f'],
    });
    expect(Buffer.from(own.body.stdout, 'base64').toString()).toBe('mine\n');
    expect((await runToEnd(t, run.id, 'cat /nova/f 2>&1; echo "x=$?"')).output).toMatch(/x=1/);
    // Finding 7: a sandbox has its own process limit, whatever the runner's user runs elsewhere.
    if (existsSync('/usr/bin/perl')) {
      const forks = await runToEnd(
        t,
        run.id,
        `perl -e 'my $n=0; for (1..64) { my $p=fork(); last unless defined $p; if (!$p) { sleep 2; exit 0 } $n++ } print "forked=$n\n"'`,
      );
      const n = Number(/forked=(\d+)/.exec(forks.output)?.[1]);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(16);
      // With a cgroup per sandbox, memory of the whole sandbox is capped too.
      const sub = t.server.runner.substrate as { cgroups?: boolean } | null;
      if (sub?.cgroups) {
        const big = await runToEnd(
          t,
          run.id,
          `perl -e '$x = "a" x (512*1024*1024); print "alive\n"'`,
        );
        expect(big.output).not.toContain('alive');
      }
    }
    // ...and each Hub has a share of the command slots, across its runs.
    const run2 = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    const a = await t.req('POST', `/v1/runner/runs/${run.id}/exec`, { cmd: 'sleep 5' });
    const b = await t.req('POST', `/v1/runner/runs/${run2.id}/exec`, { cmd: 'sleep 5' });
    expect([a.status, b.status]).toEqual([201, 201]);
    const c = await t.req('POST', `/v1/runner/runs/${run2.id}/exec`, { cmd: 'true' });
    expect(c.status).toBe(429);
    expect(c.body.error.details.reason).toBe('owner_busy');
    await t.req('POST', `/v1/runner/runs/${run.id}/kill`, { tag: 'exec' }).catch(() => undefined);
    await t.req('POST', `/v1/runner/runs/${run.id}/cancel`);
    await t.req('POST', `/v1/runner/runs/${run2.id}/cancel`);
    // Finding 14: past the entry limit the environment counts as over its disk cap.
    const run3 = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    await runToEnd(t, run3.id, 'mkdir many && cd many && for i in $(seq 1 100); do : > f$i; done');
    await t.server.runner.measure(tokenHash(t.token).slice(0, 16), env.id);
    const refused = await t.req('POST', `/v1/runner/runs/${run3.id}/exec`, { cmd: 'true' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'quota_exceeded',
      details: { resource: 'disk' },
    });
  });

  it('keeps commands away from host paths and the network', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { a: '1' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`] });
    const run = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    const home = await runToEnd(
      t,
      run.id,
      `ls ${JSON.stringify(t.dir)} 2>&1; echo "x=$?"; ls /workspace`,
    );
    expect(home.output).toMatch(/No such file|cannot access/);
    expect(home.output).toContain('x=2');
    expect(home.output).toContain('app');
    const data = await runToEnd(
      t,
      run.id,
      `ls ${JSON.stringify(join(t.dir, 'data'))} >/dev/null 2>&1 && echo visible || echo hidden`,
    );
    expect(data.output).toBe('hidden\n');
    if (existsSync('/usr/bin/perl')) {
      const net = await runToEnd(
        t,
        run.id,
        `perl -e 'use Socket; socket(my $s, AF_INET, SOCK_STREAM, 0) or print "denied\\n"; print "done\\n"'`,
        { network: 'on' },
      );
      // The environment does not allow network, so asking for it changes nothing.
      expect(net.output).toBe('denied\ndone\n');
    }
    const ro = await runToEnd(t, run.id, 'touch /workspace/x 2>&1; echo "x=$?"', {
      readOnly: true,
    });
    expect(ro.output).toMatch(/Read-only|x=1/);
  });

  it('streams output over SSE, reattaches by offset and takes input', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { a: '1' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`] });
    const run = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    const address = await t.server.app.listen({ host: '127.0.0.1', port: 0 });
    const events: { id: string; event: string; data: Json }[] = [];
    const ctrl = new AbortController();
    const res = await fetch(`${address}/v1/runner/runs/${run.id}/stream`, {
      headers: { authorization: `Bearer ${t.token}` },
      signal: ctrl.signal,
    });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reading = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue;
          const f = Object.fromEntries(
            block.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
          );
          events.push({ id: f.id!, event: f.event!, data: JSON.parse(f.data!) as Json });
        }
      }
    })().catch(() => undefined);
    const p = await t.req('POST', `/v1/runner/runs/${run.id}/exec`, {
      cmd: 'echo first; read line; echo "got $line"; sleep 0.1; echo last',
      stdin: true,
      tag: 'turn-1',
    });
    expect(p.status).toBe(201);
    const first = await t.req(
      'GET',
      `/v1/runner/runs/${run.id}/processes/${p.body.id}/output?offset=0&waitMs=5000`,
    );
    expect(first.body).toMatchObject({ data: 'first\n', offset: 6, dropped: 0, running: true });
    expect(
      (
        await t.req('POST', `/v1/runner/runs/${run.id}/processes/${p.body.id}/input`, {
          text: 'hello\n',
        })
      ).status,
    ).toBe(200);
    const done = await until(
      () =>
        t.req(
          'GET',
          `/v1/runner/runs/${run.id}/processes/${p.body.id}/output?offset=6&waitMs=1000`,
        ),
      (r) => !r.body.running,
    );
    expect(done.body).toMatchObject({ exitCode: 0 });
    // Reattach from the start: everything is still there.
    const all = await t.req(
      'GET',
      `/v1/runner/runs/${run.id}/processes/${p.body.id}/output?offset=0`,
    );
    expect(all.body.data).toBe('first\ngot hello\nlast\n');
    await until(
      () => events,
      (e) => e.some((x) => x.event === 'process.exited'),
    );
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(['process.started', 'output', 'process.exited']),
    );
    expect(
      events
        .filter((e) => e.event === 'output')
        .map((e) => e.data.data)
        .join(''),
    ).toBe('first\ngot hello\nlast\n');
    const ids = events.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // A stream resumed with Last-Event-ID gets only what came after.
    const resumed = await fetch(`${address}/v1/runner/runs/${run.id}/stream?output=0`, {
      headers: { authorization: `Bearer ${t.token}`, 'last-event-id': String(ids[0]) },
    });
    const finish = await t.req('POST', `/v1/runner/runs/${run.id}/finish`);
    expect(finish.body.status).toBe('completed');
    const text = await resumed.text();
    expect(text).toContain('event: process.exited');
    expect(text).not.toContain('event: output');
    expect(text).toContain('event: run.ended');
    expect(text).not.toContain(`id: ${ids[0]}\n`);
    ctrl.abort();
    await reading;
    const processes = (await t.req('GET', `/v1/runner/runs/${run.id}/processes`)).body.items;
    expect(processes[0]).toMatchObject({ tag: 'turn-1', running: false, exitCode: 0 });
    expect((await t.req('POST', `/v1/runner/runs/${run.id}/exec`, { cmd: 'true' })).status).toBe(
      409,
    );
  });

  it('runs a program with bytes in and out and keeps Nova state outside the workspace', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { a: '1' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`] });
    const run = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    const bytes = Buffer.from([0, 1, 2, 255, 10, 0x80]);
    const echo = await t.req('POST', `/v1/runner/runs/${run.id}/run`, {
      argv: ['sh', '-c', 'cat; printf "%s|" "$@" >&2', 'x', 'a b', '$HOME;rm -rf /'],
      cwd: '/',
      stdin: bytes.toString('base64'),
    });
    expect(echo.status).toBe(200);
    expect(Buffer.from(echo.body.stdout, 'base64')).toEqual(bytes);
    expect(echo.body).toMatchObject({ code: 0, stderr: 'a b|$HOME;rm -rf /|' });
    const state = await t.req('POST', `/v1/runner/runs/${run.id}/run`, {
      argv: ['sh', '-c', 'mkdir -p /nova/shadow && echo kept > /nova/shadow/f && ls -A /workspace'],
    });
    expect(Buffer.from(state.body.stdout, 'base64').toString()).toBe('app\n');
    const again = await t.req('POST', `/v1/runner/runs/${run.id}/run`, {
      argv: ['cat', '/nova/shadow/f'],
    });
    expect(Buffer.from(again.body.stdout, 'base64').toString()).toBe('kept\n');
    const missing = await t.req('POST', `/v1/runner/runs/${run.id}/run`, {
      argv: ['no-such-program'],
    });
    expect(missing.body.code).toBe(127);
    const big = await t.req('POST', `/v1/runner/runs/${run.id}/run`, {
      argv: ['head', '-c', '5000', '/dev/zero'],
      maxBytes: 100,
    });
    expect(big.status).toBe(413);
    expect((await t.req('GET', `/v1/runner/runs/${run.id}`)).body.usage.commands).toBe(5);
    expect(
      (await t.req('POST', `/v1/runner/runs/${run.id}/run`, { argv: ['true'], cwd: 'rel' })).status,
    ).toBe(400);
  });

  it('cancels a run and kills a turn by tag', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { a: '1' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`] });
    const run = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    const a = (
      await t.req('POST', `/v1/runner/runs/${run.id}/exec`, { cmd: 'sleep 30', tag: 'turn-a' })
    ).body;
    const b = (
      await t.req('POST', `/v1/runner/runs/${run.id}/exec`, { cmd: 'sleep 30', tag: 'turn-b' })
    ).body;
    expect((await t.req('POST', `/v1/runner/runs/${run.id}/kill`, { tag: 'turn-a' })).body).toEqual(
      { killed: 1 },
    );
    await until(
      () => t.req('GET', `/v1/runner/runs/${run.id}`),
      (r) => r.body.processes.find((p: Json) => p.id === a.id)?.running === false,
    );
    const cancelled = await t.req('POST', `/v1/runner/runs/${run.id}/cancel`);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
    const procs = cancelled.body.processes as Json[];
    expect(procs.find((p) => p.id === a.id)).toMatchObject({ running: false, stopped: 'killed' });
    expect(procs.find((p) => p.id === b.id)).toMatchObject({
      running: false,
      stopped: 'cancelled',
    });
    expect(
      (await t.req('POST', `/v1/runner/runs/${run.id}/exec`, { cmd: 'true' })).body.error.details
        .reason,
    ).toBe('ended');
  });

  it('stops at the CPU cap, reports it, and runs again after the cap is raised', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { a: '1' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`] });
    const run = (
      await t.req('POST', '/v1/runner/runs', {
        environmentId: env.id,
        budget: { cpuSeconds: 1, wallSeconds: 60 },
      })
    ).body;
    const p = await t.req('POST', `/v1/runner/runs/${run.id}/exec`, { cmd: 'while :; do :; done' });
    const capped = await until(
      () => t.req('GET', `/v1/runner/runs/${run.id}`),
      (r) => r.body.status !== 'active',
    );
    expect(capped.body).toMatchObject({ status: 'capped', reason: 'cpu' });
    expect(capped.body.usage.cpuSeconds).toBeGreaterThan(0.8);
    expect(capped.body.processes.find((x: Json) => x.id === p.body.id)).toMatchObject({
      running: false,
      stopped: 'cap_cpu',
    });
    const refused = await t.req('POST', `/v1/runner/runs/${run.id}/exec`, { cmd: 'true' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'quota_exceeded',
      details: { resource: 'cpu' },
    });
    const raised = await t.req('PATCH', `/v1/runner/runs/${run.id}`, {
      budget: { cpuSeconds: 30 },
    });
    expect(raised.body).toMatchObject({ status: 'active', caps: { cpuSeconds: 30 } });
    expect((await runToEnd(t, run.id, 'echo ok')).output).toBe('ok\n');
    const tooMuch = await t.req('PATCH', `/v1/runner/runs/${run.id}`, {
      budget: { cpuSeconds: 10 ** 9 },
    });
    expect(tooMuch.body.error.details.reason).toBe('over_limit');
  });

  it('stops at the wall-time cap and warns before it', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { a: '1' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`] });
    const run = (
      await t.req('POST', '/v1/runner/runs', { environmentId: env.id, budget: { wallSeconds: 1 } })
    ).body;
    await t.req('POST', `/v1/runner/runs/${run.id}/exec`, { cmd: 'sleep 10' });
    const capped = await until(
      () => t.req('GET', `/v1/runner/runs/${run.id}`),
      (r) => r.body.status !== 'active',
    );
    expect(capped.body).toMatchObject({ status: 'capped', reason: 'wall' });
    await until(
      () => t.req('GET', `/v1/runner/runs/${run.id}`),
      (r) => !r.body.processes[0].running,
    );
    const owner = tokenHash(t.token).slice(0, 16);
    const sub = t.server.runner.subscribe(owner, run.id, 0, () => undefined);
    sub.unsubscribe();
    const kinds = sub.backlog.map(
      (e) => `${e.type}:${typeof e.data.resource === 'string' ? e.data.resource : ''}`,
    );
    expect(kinds).toEqual(expect.arrayContaining(['cap.warning:wall', 'cap.reached:wall']));
    expect(kinds.indexOf('cap.warning:wall')).toBeLessThan(kinds.indexOf('cap.reached:wall'));
    expect(sub.ended).toBe(false);
    expect(
      (await t.req('POST', `/v1/runner/runs/${run.id}/exec`, { cmd: 'true' })).body.error.details
        .resource,
    ).toBe('wall');
  });

  it('stops a command at the disk cap', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { a: '1' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`], diskMb: 16 });
    const run = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    const r = await runToEnd(t, run.id, 'head -c 40000000 /dev/zero > big; echo "x=$?"');
    expect(r.output).toMatch(/x=(1|153)/);
    const view = await t.req('GET', `/v1/runner/environments/${env.id}`);
    expect(view.body.usage.diskBytes).toBeLessThanOrEqual(view.body.caps.diskBytes + 1024 * 1024);
  });
});

describe.skipIf(skip)('files, snapshots and artifacts', () => {
  it('reads, writes, lists and removes files inside the workspace only', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { 'README.md': 'hello\n' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`] });
    const base = `/v1/runner/environments/${env.id}/files`;
    const put = await t.req('PUT', `${base}?path=/workspace/app/notes/n.txt`, {
      content: Buffer.from('note ✓\n').toString('base64'),
    });
    expect(put.status).toBe(200);
    expect(put.body.size).toBe(Buffer.byteLength('note ✓\n'));
    const read = await t.req('GET', `${base}?path=/workspace/app/notes/n.txt`);
    expect(read.body).toMatchObject({ kind: 'file', truncated: false });
    expect(Buffer.from(read.body.content, 'base64').toString('utf8')).toBe('note ✓\n');
    const list = await t.req('GET', `${base}?path=/workspace/app`);
    expect(list.body.entries.map((e: Json) => `${e.kind}:${e.name}`)).toEqual([
      'dir:.git',
      'dir:notes',
      'file:README.md',
    ]);
    expect((await t.req('GET', `${base}?path=/workspace/app&stat=1`)).body).toMatchObject({
      kind: 'dir',
    });
    expect((await t.req('GET', `${base}?path=/etc/passwd`)).body.error.details.reason).toBe(
      'outside_workspace',
    );
    expect((await t.req('GET', `${base}?path=/workspace/../etc/passwd`)).status).toBe(400);
    expect((await t.req('GET', `${base}?path=/workspace/nothing`)).status).toBe(404);
    // A link to a host folder resolves inside the sandbox, where that folder does not exist.
    const run = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    await runToEnd(t, run.id, `ln -s ${JSON.stringify(t.dir)} /workspace/escape`);
    const link = await t.req('GET', `${base}?path=/workspace/escape`);
    expect(link.status).toBe(400);
    expect(link.body.error.details.reason).toBe('not_a_file');
    expect((await t.req('PUT', `${base}?path=/workspace/escape/x`, { content: '' })).status).toBe(
      500,
    );
    expect(existsSync(join(t.dir, 'x'))).toBe(false);
    expect((await t.req('DELETE', `${base}?path=/workspace/app/notes`)).status).toBe(200);
    expect((await t.req('GET', `${base}?path=/workspace/app/notes`)).status).toBe(404);
    expect((await t.req('DELETE', `${base}?path=/workspace`)).status).toBe(400);
  });

  it('snapshots the workdir and restores it', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { 'a.txt': 'one\n' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`], caches: ['pip'] });
    const run = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    const snap = await t.req('POST', '/v1/runner/snapshots', {
      environmentId: env.id,
      label: 'before risky step',
    });
    expect(snap.status).toBe(201);
    expect(snap.body).toMatchObject({
      environmentId: env.id,
      label: 'before risky step',
      restoredAt: null,
    });
    expect(snap.body.sizeBytes).toBeGreaterThan(0);
    await runToEnd(t, run.id, 'echo two > app/a.txt; rm -rf app/.git; touch /cache/pip/kept');
    const busy = await t.req('POST', `/v1/runner/runs/${run.id}/exec`, { cmd: 'sleep 5' });
    expect(
      (await t.req('POST', `/v1/runner/snapshots/${snap.body.id}/restore`)).body.error.details
        .reason,
    ).toBe('busy');
    await t.req('POST', `/v1/runner/runs/${run.id}/processes/${busy.body.id}/input`, {
      signal: 'terminate',
    });
    await until(
      () => t.req('GET', `/v1/runner/runs/${run.id}/processes`),
      (r) => r.body.items.every((p: Json) => !p.running),
    );
    const restored = await t.req('POST', `/v1/runner/snapshots/${snap.body.id}/restore`);
    expect(restored.body).toMatchObject({ ok: true, snapshot: { id: snap.body.id } });
    expect(restored.body.snapshot.restoredAt).toBeTruthy();
    const after = await runToEnd(
      t,
      run.id,
      'cat app/a.txt; test -d app/.git && echo git; ls /cache/pip',
    );
    expect(after.output).toBe('one\ngit\nkept\n');
    expect(
      (await t.req('GET', `/v1/runner/snapshots?environmentId=${env.id}`)).body.items,
    ).toHaveLength(1);
    expect((await t.req('DELETE', `/v1/runner/snapshots/${snap.body.id}`)).status).toBe(200);
    expect((await t.req('GET', `/v1/runner/snapshots/${snap.body.id}`)).status).toBe(404);
  });

  it('collects an artifact and serves its bytes', async () => {
    const t = await runner();
    makeRepo(t.repos, 'app', { a: '1' });
    const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`] });
    const run = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
    await runToEnd(t, run.id, 'mkdir -p out; printf "report\\n" > out/report.txt');
    const a = await t.req('POST', `/v1/runner/runs/${run.id}/artifacts`, {
      path: '/workspace/out/report.txt',
    });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      name: 'report.txt',
      sizeBytes: 7,
      path: '/workspace/out/report.txt',
    });
    const got = await t.req('GET', `/v1/runner/runs/${run.id}/artifacts/${a.body.id}`);
    expect(got.raw).toBe('report\n');
    expect((await t.req('GET', `/v1/runner/runs/${run.id}`)).body.artifacts).toHaveLength(1);
    expect(
      (await t.req('POST', `/v1/runner/runs/${run.id}/artifacts`, { path: '/workspace/none' }))
        .status,
    ).toBe(404);
  });

  it('keeps environments and runs across a restart and deletes everything of an environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-runner-restart-'));
    try {
      const t = await startRunner({}, root);
      makeRepo(t.repos, 'app', { a: '1' });
      const env = await readyEnv(t, { repoUrls: [`file://${t.repos}/app`] });
      const run = (await t.req('POST', '/v1/runner/runs', { environmentId: env.id })).body;
      await runToEnd(t, run.id, 'echo hi');
      const token = t.token;
      await t.close();
      const t2 = await startRunner({ tokens: [tokenRecord(tokenHash(token))] }, root);
      try {
        expect(
          (await t2.req('GET', `/v1/runner/environments/${env.id}`, undefined, token)).body.status,
        ).toBe('ready');
        const r = await t2.req('GET', `/v1/runner/runs/${run.id}`, undefined, token);
        expect(r.body).toMatchObject({ status: 'active', usage: { commands: 1 } });
        expect(
          (await t2.req('DELETE', `/v1/runner/environments/${env.id}`, undefined, token)).status,
        ).toBe(200);
        expect(existsSync(join(root, 'data', 'envs', env.id))).toBe(false);
        expect((await t2.req('GET', `/v1/runner/runs/${run.id}`, undefined, token)).status).toBe(
          404,
        );
      } finally {
        await t2.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
