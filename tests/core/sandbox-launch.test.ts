// The change sandbox starts through resilience's `startSandbox` (Ponytail P6). These pin what each
// side's sandbox process is given, exactly: the env (nothing of the caller's secrets or mesh, loopback
// only, the change sandbox's remote-declared model for the privacy probe, its test clock and
// timezone, TZ only when set, the egress tripwire's settings), the preloads it keeps, abort, and the
// failed-start output and wording the change pipeline records as evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { sandboxEnv, startSandbox } from '../../src/core/resilience/sandbox.ts';
import { Sandbox, changesLaunch } from '../../src/core/changes/sandbox.ts';

const caller = {
  PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', SYSTEMROOT: 'C:\\Windows', NOVA_EGRESS_LOG: '/e/egress.log', NOVA_EGRESS_ALLOW: '127.0.0.1',
  // None of these may reach a sandbox.
  HOME: '/home/person', NOVA_HOME: '/home/person/Nova', NOVA_HOST: '0.0.0.0', NOVA_PORT: '8080', NOVA_AGENT_EGRESS: 'none', NOVA_AGENT_CMD: 'claude',
  NOVA_OLLAMA_URL: 'http://127.0.0.1:11434', NOVA_MESH_URL: 'http://mesh:1', NOVA_SECRET_GMAIL: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', NOVA_VAULT_KEY: 'keychain',
};

test('the change sandbox’s env is exactly the same as before the fold', () => {
  const home = '/scratch/c1/home';
  assert.deepEqual(sandboxEnv(home, changesLaunch('Europe/Paris', caller, []).env), {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', SYSTEMROOT: 'C:\\Windows', NOVA_EGRESS_LOG: '/e/egress.log', NOVA_EGRESS_ALLOW: '127.0.0.1',
    HOME: '/scratch/c1/user', NOVA_HOME: home, NOVA_HOST: '127.0.0.1', NOVA_PORT: '0', NOVA_SANDBOX: '1', NOVA_TEST_CLOCK: '1', NOVA_VAULT_KEY: 'file',
    NOVA_AGENT_CMD: 'false', NOVA_AGENT_EGRESS: 'remote', NOVA_OLLAMA_URL: 'http://127.0.0.1:9', NOVA_TZ: 'Europe/Paris',
  }, 'no TZ here, so none there (not UTC)');
  const bare = sandboxEnv(home, changesLaunch(undefined, { TZ: 'America/New_York' }, []).env);
  assert.deepEqual(bare, {
    TZ: 'America/New_York', HOME: '/scratch/c1/user', NOVA_HOME: home, NOVA_HOST: '127.0.0.1', NOVA_PORT: '0', NOVA_SANDBOX: '1', NOVA_TEST_CLOCK: '1',
    NOVA_VAULT_KEY: 'file', NOVA_AGENT_CMD: 'false', NOVA_AGENT_EGRESS: 'remote', NOVA_OLLAMA_URL: 'http://127.0.0.1:9',
  }, 'only what is set passes; no NOVA_TZ without a timezone');
  assert.equal(sandboxEnv(home, { ...changesLaunch(undefined, caller, []).env, NOVA_HOST: '0.0.0.0' }).NOVA_HOST, '127.0.0.1', 'loopback whatever is passed');
});

test('the change sandbox keeps only --import/--require preloads', () => {
  assert.deepEqual(changesLaunch(undefined, {}, ['--import', '/t/tripwire.js', '--inspect=9229', '--require=/t/a.cjs', '--max-old-space-size=64', '--expose-gc', '--require']).execArgv,
    ['--import', '/t/tripwire.js', '--require=/t/a.cjs']);
});

test('the drill’s and supervisor’s sandbox env is unchanged', () => {
  assert.deepEqual(sandboxEnv('/scratch/d/home'), {
    PATH: process.env.PATH ?? '', HOME: '/scratch/d/user', TZ: process.env.TZ ?? 'UTC', NOVA_HOME: '/scratch/d/home', NOVA_PORT: '0', NOVA_SANDBOX: '1',
    NOVA_VAULT_KEY: 'file', NOVA_AGENT_CMD: 'false', NOVA_AGENT_EGRESS: 'none', NOVA_OLLAMA_URL: 'http://127.0.0.1:9', NOVA_HOST: '127.0.0.1',
  });
});

// A stand-in for src/server.js: says what it was given, then behaves as `NOVA_FAKE` says.
function fakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nova-sb-launch-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'pre.cjs'), 'globalThis.preloaded = true;\n');
  writeFileSync(join(root, 'src', 'server.js'), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.NOVA_HOME + '/given.json', JSON.stringify({ env: process.env, preloaded: globalThis.preloaded === true, pid: process.pid }));
const mode = process.env.NOVA_FAKE;
if (mode === 'ready') { console.log('Nova is ready at http://127.0.0.1:4321'); setInterval(() => {}, 1000); }
else if (mode === 'boom') { console.error('boom: the database is locked'); process.exit(3); }
else setInterval(() => {}, 1000);
`);
  return root;
}

test('the child gets exactly that env and the preload', async () => {
  const root = fakeRoot();
  const home = join(root, 'home');
  mkdirSync(home);
  const launch = changesLaunch('Europe/Paris', caller, ['--require', join(root, 'pre.cjs'), '--inspect']);
  const env = { ...launch.env, NOVA_FAKE: 'ready' };
  const sb = await startSandbox({ root, home, env, execArgv: launch.execArgv, timeoutMs: 10_000 });
  try {
    assert.equal(sb.port, 4321);
    const given = JSON.parse(readFileSync(join(home, 'given.json'), 'utf8'));
    assert.deepEqual(given.env, sandboxEnv(home, env));
    assert.equal(given.preloaded, true);
  } finally { await sb.stop(); }
});

const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
// The child a failed start stopped, as its error names it. Not given.json: when the stop lands before
// or during the child's first write, that file is missing, a previous child's, or empty (CI 2026-11-07:
// "Unexpected end of JSON input").
const stoppedPid = (seen: { pid?: number | null }) => (e: Error & { pid?: number | null }) => { seen.pid = e.pid ?? null; return true; };

test('abort stops the child and says “stopped”', async () => {
  const root = fakeRoot();
  const home = join(root, 'home');
  mkdirSync(home);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const began = Date.now();
  const seen: { pid?: number | null } = {};
  await assert.rejects(startSandbox({ root, home, env: { NOVA_FAKE: 'hang' }, timeoutMs: 20_000, signal: ac.signal }), (e: Error & { exitCode?: number | null; pid?: number | null }) => stoppedPid(seen)(e) && e.message === 'stopped' && e.exitCode === null);
  assert.ok(Date.now() - began < 10_000, 'it did not wait for the timeout');
  assert.equal(typeof seen.pid, 'number', 'the error names the child it stopped');
  assert.ok(gone(seen.pid!), 'the child is gone');
});

test('a failed start throws with all its output and exit code; the timeout stops the child', async () => {
  const root = fakeRoot();
  const home = join(root, 'home');
  mkdirSync(home);
  await assert.rejects(startSandbox({ root, home, env: { NOVA_FAKE: 'boom' } }), (e: Error & { output?: string; exitCode?: number | null }) =>
    e.exitCode === 3 && /boom: the database is locked/.test(e.output ?? '') && e.message.startsWith('The sandbox Nova stopped as it started (exit 3):'));
  const seen: { pid?: number | null } = {};
  await assert.rejects(startSandbox({ root, home, env: { NOVA_FAKE: 'hang' }, timeoutMs: 300 }), (e: Error & { exitCode?: number | null; pid?: number | null }) =>
    stoppedPid(seen)(e) && e.exitCode === null && e.message.startsWith('The sandbox Nova didn’t start in time'));
  assert.equal(typeof seen.pid, 'number', 'the error names the child it stopped');
  assert.ok(gone(seen.pid!), 'the child is gone');
});

test('the change sandbox’s failed start keeps its wording and output as evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-sb-change-'));
  const db = new Db(join(dir, 'live', 'nova.db'));
  db.migrate();
  const sandbox = new Sandbox(join(dir, 'c1'));
  // A preload that can't load: the real server exits at once, as a broken start would.
  process.execArgv.push('--require', join(dir, 'missing-preload.cjs'));
  try {
    await assert.rejects(sandbox.start({ db, liveHome: join(dir, 'live') }), (e: Error) => e.message.startsWith('the sandbox Nova stopped as it started: ') && /MODULE_NOT_FOUND/.test(e.message) && e.message.length <= 'the sandbox Nova stopped as it started: '.length + 400);
  } finally { process.execArgv.splice(-2, 2); }
  assert.match(sandbox.output(), /missing-preload/, 'the output stays readable for the pipeline’s evidence');
  assert.ok(existsSync(join(dir, 'c1', 'user')), 'its HOME was made');
  await sandbox.stop();
  assert.ok(!existsSync(join(dir, 'c1')), 'the scratch copy is deleted');
  db.raw.close();
});
