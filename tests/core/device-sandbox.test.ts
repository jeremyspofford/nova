// The runtime agent's sandbox (ADR-3): code started exactly the way the boot agent starts the
// runtime must not reach anything outside state/ (writing) and runtime/ + state/ (reading), by any
// route Node offers. Each route below was tried by hand against Node 26 under the permission model;
// the ones that got through before (node:sqlite, sockets, diagnostic reports, V8 flags, trace
// files) are why the runtime's launch flags look the way they do. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNet } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLocalRuntime, paths, runtimeCommand } from '../../src/device/boot.ts';

// Tries every route; prints what each one did. Anything other than a refusal is a hole, unless the
// route only touches state/.
const PROBE = String.raw`
import fs from 'node:fs';
import { createRequire } from 'node:module';
const home = process.argv[2];
const boot = home + '/boot';
const out = {};
const t = async (k, f) => { try { const r = await f(); out[k] = r === undefined ? 'ok' : 'ok:' + String(r); } catch (e) { out[k] = e?.code ?? String(e?.message ?? e).slice(0, 60); } };
const net = await import('node:net');
const sock = (path) => new Promise((ok, no) => { const c = net.connect(path); c.on('connect', () => { c.end('runtime-was-here'); ok('connected'); }); c.on('error', no); });
await t('trace_events', async () => { (await import('node:trace_events')).createTracing({ categories: ['node.perf'] }).enable(); });
await t('sqlite_import', async () => { await import('node:sqlite'); });
await t('sqlite_builtin', () => { if (!process.getBuiltinModule('node:sqlite')) throw Object.assign(new Error('absent'), { code: 'ABSENT' }); });
await t('sqlite_require', () => createRequire(import.meta.url)('node:sqlite'));
await t('read_keys', () => fs.readFileSync(boot + '/keys.json', 'utf8'));
await t('write_boot', () => fs.writeFileSync(boot + '/planted', 'x'));
await t('dotdot', () => fs.writeFileSync(home + '/state/../boot/planted', 'x'));
await t('symlink', () => fs.symlinkSync(boot + '/keys.json', home + '/state/link'));
await t('symlink_relative', () => fs.symlinkSync('../boot/keys.json', home + '/state/rlink'));
await t('hardlink', () => fs.linkSync(boot + '/keys.json', home + '/state/hard'));
await t('rename_out', () => { fs.writeFileSync(home + '/state/m', 'x'); fs.renameSync(home + '/state/m', boot + '/m'); });
await t('copy_in', () => fs.cpSync(boot + '/keys.json', home + '/state/copy'));
await t('chdir_boot', () => process.chdir(boot));
await t('load_env_file', () => process.loadEnvFile(boot + '/keys.json'));
// Node checks a signal report against the working folder but writes it to report.directory.
try { process.chdir(home + '/state'); } catch { /* chdir is locked now; the runtime starts in state/ anyway */ }
await t('report_write', () => process.report.writeReport(boot + '/report.json'));
await t('report_signal', async () => { process.report.directory = boot; process.report.reportOnSignal = true; process.kill(process.pid, 'SIGUSR2'); await new Promise((r) => setTimeout(r, 200)); });
await t('heap_snapshot', async () => (await import('node:v8')).writeHeapSnapshot(boot + '/heap.heapsnapshot'));
await t('v8_flags', async () => { (await import('node:v8')).setFlagsFromString('--trace-turbo --trace-turbo-path=' + boot); for (let i = 0, s = 0; i < 2e5; i++) s += Math.sqrt(i); });
await t('compile_cache', async () => { const r = (await import('node:module')).enableCompileCache(boot + '/cache'); if (r.status !== 1 && r.status !== 2) throw Object.assign(new Error(r.message), { code: 'REFUSED' }); });
await t('unix_connect', () => sock(process.argv[3]));
await t('unix_listen', () => new Promise((ok, no) => { const s = net.createServer(); s.on('error', no); s.listen(boot + '/planted.sock', () => ok('listening')); }));
await t('tcp_connect', () => sock({ host: '127.0.0.1', port: Number(process.argv[4]) }));
await t('fetch', async () => (await fetch('http://127.0.0.1:' + process.argv[4] + '/')).status);
await t('dns', async () => (await import('node:dns')).promises.lookup('localhost'));
await t('wasi', async () => { const { WASI } = await import('node:wasi'); new WASI({ version: 'preview1', preopens: { '/boot': boot } }); });
await t('inspector', async () => { (await import('node:inspector')).open(0); });
await t('inspector_session', async () => { const i = await import('node:inspector'); new i.Session().connect(); });
await t('process_binding', () => process.binding('fs'));
await t('child_process', async () => (await import('node:child_process')).spawnSync('true'));
await t('execve', () => process.execve('/bin/sh', ['sh', '-c', 'echo x > ' + boot + '/execve']));
await t('worker', async () => { const { Worker } = await import('node:worker_threads'); new Worker('1', { eval: true }); });
await t('addon', () => process.dlopen({ exports: {} }, boot + '/addon.node'));
await t('kill', () => process.kill(process.ppid, 0));
// The raw bindings under process.kill and the inspector signal reach other processes too (re-check
// finding): another process of the person's, here a harmless sleep.
await t('raw_kill', () => process._kill(Number(process.argv[5]), 0));
await t('debug_process', () => process._debugProcess(Number(process.argv[5])));
await t('debug_end', () => process._debugEnd());
await t('chdir_runtime', () => process.chdir(home + '/runtime'));
try { process.chdir(home + '/state'); } catch { /* chdir is locked now; the runtime starts in state/ anyway */ }
await t('local_storage', () => { if (globalThis.localStorage === undefined) throw Object.assign(new Error('absent'), { code: 'ABSENT' }); globalThis.localStorage.setItem('k', 'v'); });
await t('write_state', () => fs.writeFileSync(home + '/state/fine.txt', 'ok'));
console.log(JSON.stringify(out));
// A listener that got through would keep it running.
process.exit(0);
`;

test('the runtime’s sandbox: no node:sqlite, and no way out of state/ by links, reports, V8 flags, trace files, sockets, WASI or the inspector', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-sandbox-'));
  const p = paths(home);
  for (const d of [p.boot, p.runtime, p.state]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(p.keys, JSON.stringify({ secret: 'test-private-key' }), { mode: 0o600 });
  installLocalRuntime(p);
  writeFileSync(join(p.runtime, 'probe.mjs'), PROBE);
  // A local service outside state/ (a unix socket, like an SSH agent or a container daemon) and one
  // on loopback TCP: the runtime must reach neither.
  const touched: string[] = [];
  const unixPath = join(p.boot, 'service.sock');
  const unix = createNet((c) => { touched.push('unix'); c.destroy(); });
  const tcp = createNet((c) => { touched.push('tcp'); c.destroy(); });
  await new Promise<void>((r) => unix.listen(unixPath, r));
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  const port = (tcp.address() as { port: number }).port;
  const bootBefore = readdirSync(p.boot).sort();
  // Another process of the person's; SIGUSR1 (what _debugProcess sends) would end it.
  const bystander = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    // Started from the device home (not state/), so a file written "here" would land outside state/.
    const child = spawn(process.execPath, [...runtimeCommand(p, join(p.runtime, 'probe.mjs')).slice(0, -1), home, unixPath, String(port), String(bystander.pid)], { cwd: home, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    clearTimeout(kill);
    assert.equal(code, 0, stderr);
    const out = JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, string>;
    const refused = (k: string) => assert.ok(!String(out[k]).startsWith('ok'), `${k} should be refused, got ${out[k]}`);
    // node:sqlite ignores the permission model (it opens, ATTACHes and VACUUMs INTO any path), so
    // it isn't there at all.
    for (const k of ['sqlite_import', 'sqlite_builtin', 'sqlite_require']) refused(k);
    for (const k of [
      'read_keys', 'write_boot', 'dotdot', 'symlink', 'symlink_relative', 'hardlink', 'rename_out', 'copy_in', 'chdir_boot', 'load_env_file',
      'report_write', 'report_signal', 'heap_snapshot', 'v8_flags', 'compile_cache', 'unix_connect', 'unix_listen', 'tcp_connect', 'fetch', 'dns',
      'wasi', 'inspector', 'inspector_session', 'process_binding', 'child_process', 'execve', 'worker', 'addon', 'kill', 'local_storage',
      'raw_kill', 'debug_process', 'debug_end', 'chdir_runtime',
    ]) refused(k);
    assert.equal(bystander.exitCode ?? bystander.signalCode, null, 'the other process was not signalled');
    assert.equal(out.write_state, 'ok', 'state/ stays writable');
    // Nothing appeared outside state/: not in boot/, not where it was started, and no service heard it.
    assert.deepEqual(readdirSync(p.boot).sort(), bootBefore, 'boot/ is unchanged');
    assert.deepEqual(readdirSync(home).sort(), ['boot', 'runtime', 'state'], 'nothing landed in the folder it was started from');
    assert.deepEqual(readdirSync(p.runtime).sort(), ['package.json', 'probe.mjs', 'queue.ts', 'runtime.ts'], 'runtime/ is unchanged');
    assert.deepEqual(touched, [], 'no local service was reached');
    assert.equal(JSON.parse(readFileSync(p.keys, 'utf8')).secret, 'test-private-key');
  } finally {
    bystander.kill('SIGKILL');
    unix.close();
    tcp.close();
  }
});
