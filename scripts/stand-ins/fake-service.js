#!/usr/bin/env node
// A stand-in service for the supervisor driver's tests (M10e): a plain program that answers HTTP on
// 127.0.0.1 at the port it is given (PORT), the way a service Nova runs would. It never touches
// the network beyond loopback and writes only into its state folder (NOVA_SERVICE_STATE).
//
//   GET  /health         200 while healthy, 500 once sick
//   GET  /contract       200, or 404 with --no-contract (a version that fails its contract tests)
//   GET  /whoami         {service, version, pid, port, flavour}
//   GET  /reset          resets the connection (RST) instead of answering
//   POST /sicken         makes /health answer 500 from now on (until it is started again)
//   POST /state/<name>   writes the body to <state>/<name>;  GET /state/<name> reads it back
//
// Flags (part of a version's command, so each version behaves as its definition says):
//   --flavour <word>        said by /whoami, to tell versions apart
//   --no-contract           /contract answers 404
//   --healthy-for-ms <n>    healthy for n ms after it starts, then sick for good
//   --child                 starts a child process in its process group that does nothing, notes
//                           a SIGTERM in <state>/child-<version>.sigterm and otherwise ignores it
//                           (only the group's SIGKILL ends it), and writes its pid to
//                           <state>/child-<version>.pid: the whole group is asked, then made, to stop
//   --chdir                 moves its working folder to / once started, as many daemons do
//   --refuse-real-state     exits at once (code 3) unless it runs on a scratch copy of its state
//   --start-once            starts once on its real state; started there again, it exits (code 4),
//                           as a program would with a stale lock
//   --slow-stop             ignores SIGTERM: only SIGKILL, after the grace period, stops it
//   --exclusive-state       one writer: exits at once (code 5) if another copy runs on its real
//                           state (a live pid in <state>/running.pid); removes the mark as it stops
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const started = Date.now();
const healthyFor = value('--healthy-for-ms') === undefined ? Infinity : Number(value('--healthy-for-ms'));
const state = process.env.NOVA_SERVICE_STATE ?? process.cwd();
const version = process.env.NOVA_SERVICE_VERSION ?? 'unknown';
const port = Number(process.env.PORT ?? 0);
mkdirSync(state, { recursive: true });

if (flag('--child')) {
  const termed = join(state, `child-${version}.sigterm`);
  const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => require('node:fs').writeFileSync(${JSON.stringify(termed)}, 'SIGTERM')); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
  writeFileSync(join(state, `child-${version}.pid`), String(child.pid));
}

if (flag('--chdir')) setTimeout(() => process.chdir('/'), 50);
const scratch = state.includes('/scratch/');
if (flag('--refuse-real-state') && !scratch) { console.error('refusing the real state'); process.exit(3); }
if (flag('--start-once') && !scratch) {
  const lock = join(state, `started-${version}`);
  try { readFileSync(lock); console.error('a stale lock: started here before'); process.exit(4); } catch { writeFileSync(lock, String(process.pid)); }
}
if (flag('--exclusive-state') && !scratch) {
  const mark = join(state, 'running.pid');
  let other = 0;
  try { other = Number(readFileSync(mark, 'utf8')); } catch { /* none */ }
  if (other && other !== process.pid) { try { process.kill(other, 0); console.error(`another copy (${other}) runs on this state`); process.exit(5); } catch { /* stale */ } }
  writeFileSync(mark, String(process.pid));
  process.on('exit', () => { try { if (Number(readFileSync(mark, 'utf8')) === process.pid) rmSync(mark); } catch { /* gone */ } });
}
let sick = false;

const NAME = /^[a-z0-9-]{1,40}$/;
const server = createServer((req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const url = req.url ?? '/';
  if (url === '/health') return !sick && Date.now() - started < healthyFor ? json(200, { ok: true }) : json(500, { ok: false, said: 'sick' });
  if (url === '/sicken' && req.method === 'POST') { sick = true; return json(200, { ok: true }); }
  if (url === '/contract') return flag('--no-contract') ? json(404, { ok: false }) : json(200, { ok: true });
  if (url === '/reset') return req.socket.resetAndDestroy();
  if (url === '/whoami') return json(200, { service: process.env.NOVA_SERVICE, version, pid: process.pid, port, flavour: value('--flavour') ?? null, home: process.env.HOME });
  const m = /^\/state\/([^/?]+)$/.exec(url);
  if (m && NAME.test(m[1])) {
    const file = join(state, m[1]);
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { writeFileSync(file, Buffer.concat(chunks)); json(200, { ok: true }); });
      return;
    }
    try { return json(200, { value: readFileSync(file, 'utf8') }); } catch { return json(404, { value: null }); }
  }
  json(404, { ok: false });
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => { if (!flag('--slow-stop')) process.exit(0); });
