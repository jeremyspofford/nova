// M10a gate: from inside a workspace, Nova's console, its mesh port, its home, the Docker socket,
// the host's network and any undeclared host can't be reached, and nothing runs as root. Each escape
// is really attempted by a probe inside the workspace, against a real Nova server (console on
// loopback, mesh listener on the Docker bridge's gateway, where a container could reach it). The same
// probe is then run with that one piece of isolation removed (host network, a bridge network, the
// home or the Docker socket mounted, root), and must get through: so a "refused" means the isolation
// held, not that the probe was broken. Set NOVA_EVIDENCE=<file> to keep the record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerComputer } from '../../src/core/computer/docker.ts';
import { IMAGE, runUser } from '../../src/core/computer/policy.ts';
import type { Machine } from '../../src/core/computer/computer.ts';
import { docker, dockerSkip } from '../core/computer-support.ts';
import { blank, stop } from './support.ts';

const skip = await dockerSkip();

// Runs inside a container. Every attempt says whether it got through, and how it failed if not.
const PROBE = `
const net = require('net'), fs = require('fs'), os = require('os'), dns = require('dns'), path = require('path');
const o = JSON.parse(process.argv[1]);
const out = [];
const tcp = (what, host, port) => new Promise((ok) => {
  const s = net.connect({ host, port, timeout: 3000 });
  const done = (reached, detail) => { s.destroy(); out.push({ what, target: host + ':' + port, reached, detail }); ok(); };
  s.on('connect', () => done(true, 'connected'));
  s.on('timeout', () => done(false, 'timed out'));
  s.on('error', (e) => done(false, e.code || e.message));
});
const unix = (what, p) => new Promise((ok) => {
  const s = net.connect(p);
  let data = '';
  const done = (reached, detail) => { s.destroy(); out.push({ what, target: p, reached, detail }); ok(); };
  s.on('connect', () => s.write('GET /_ping HTTP/1.0\\r\\n\\r\\n'));
  s.on('data', (d) => { data += d; });
  s.on('end', () => done(/OK/.test(data), /OK/.test(data) ? 'the Docker engine answered /_ping' : 'connected, no answer'));
  s.on('error', (e) => done(false, e.code || e.message));
  setTimeout(() => done(false, 'timed out'), 3000);
});
const found = [];
const scan = (d, depth) => {
  if (depth > 12 || ['/proc', '/sys', '/dev'].includes(d)) return;
  let names; try { names = fs.readdirSync(d); } catch { return; }
  for (const n of names) {
    const p = path.join(d, n); let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (n === o.canary || n === 'docker.sock' || st.isSocket()) found.push(p);
    if (st.isDirectory()) scan(p, depth + 1);
  }
};
(async () => {
  for (const h of o.hosts) { await tcp('console', h, o.console); await tcp('mesh', h, o.mesh); }
  scan('/', 0);
  const homeSeen = fs.existsSync(o.home) || found.some((p) => p.endsWith(o.canary));
  out.push({ what: 'home', target: o.home, reached: homeSeen, detail: homeSeen ? 'Nova’s home is visible: ' + found.filter((p) => p.endsWith(o.canary)).join(', ') : 'not there; no file of it anywhere in the filesystem' });
  const socks = [...new Set(['/var/run/docker.sock', '/run/docker.sock', ...found.filter((p) => !p.endsWith(o.canary))])];
  for (const s of socks) await unix('docker-socket', s);
  for (const h of o.hosts) { await tcp('docker-tcp', h, 2375); }
  const ifs = Object.entries(os.networkInterfaces()).filter(([, l]) => l.some((a) => !a.internal)).map(([n]) => n);
  out.push({ what: 'host-network', target: 'interfaces', reached: ifs.length > 0, detail: ifs.length ? 'interfaces besides loopback: ' + ifs.join(', ') : 'loopback only' });
  await tcp('outside', '1.1.1.1', 443);
  const named = await new Promise((ok) => dns.lookup('example.com', (e, a) => ok(e ? (e.code || e.message) : a)));
  out.push({ what: 'outside', target: 'dns example.com', reached: !/^E|ENOTFOUND|EAI_/.test(String(named)), detail: String(named) });
  await tcp('undeclared', o.undeclared, 443);
  await tcp('undeclared-via-proxy', '127.0.0.1', 3128);
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const cap = /CapEff:\\s*(\\w+)/.exec(status)[1];
  let rootWrite = 'refused';
  try { fs.appendFileSync('/etc/passwd', ''); rootWrite = 'wrote /etc/passwd'; } catch (e) { rootWrite = e.code; }
  let setuid = 'refused';
  try { process.setuid(0); setuid = 'became root'; } catch (e) { setuid = e.code || e.message; }
  const root = process.getuid() === 0 || BigInt('0x' + cap) !== 0n || rootWrite !== 'EACCES' || setuid === 'became root';
  out.push({ what: 'root', target: 'privileges', reached: root, detail: 'uid ' + process.getuid() + ', CapEff ' + cap + ', NoNewPrivs ' + /NoNewPrivs:\\s*(\\d)/.exec(status)[1] + ', write /etc/passwd: ' + rootWrite + ', setuid(0): ' + setuid });
  process.stdout.write(JSON.stringify(out));
})();
`;

const bindable = (host: string) => new Promise<boolean>((ok) => {
  const s = createServer();
  s.once('error', () => ok(false));
  s.listen(0, host, () => s.close(() => ok(true)));
});

interface Attempt { what: string; target: string; reached: boolean; detail: string }

test('M10a gate: no escape from a workspace to the console, the mesh, Nova’s home, the Docker socket, the host network or an undeclared host', { skip: skip ?? false, timeout: 300_000 }, async () => {
  const gateway = (await docker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'])).out.trim();
  assert.match(gateway, /^\d+\.\d+\.\d+\.\d+$/, 'the Docker bridge has a gateway');
  // A real Nova: its console on loopback (as always), its mesh listener where a container on Docker's
  // default network could reach it: the bridge's gateway on Linux's own Docker. Docker Desktop has
  // no such address here, but forwards host.docker.internal to this machine's loopback, so there
  // loopback is reachable from a bridged container, console included.
  const meshBind = await bindable(gateway) ? gateway : '127.0.0.1';
  const m = blank('nova-m10a-iso-');
  const nova = await m.start({ NOVA_MESH_URL: `http://${meshBind}:0`, NOVA_MESH_TRANSPORT: 'network' });
  const meshPort = Number(new URL(nova.mesh!).port);
  const canary = `canary-${randomBytes(6).toString('hex')}.txt`;
  writeFileSync(join(m.home, canary), 'Nova’s home\n');
  const hostIps = Object.values(networkInterfaces()).flatMap((l) => (l ?? []).filter((a) => a.family === 'IPv4').map((a) => a.address));
  // In the kept record this machine's own addresses are named, not written out (they are the owner's).
  const own = hostIps.filter((a) => a !== '127.0.0.1');
  const label = (t: string) => own.reduce((x, a, i) => x.split(`${a}:`).join(`<this machine’s address ${i + 1}>:`), t);
  const probeArgs = { hosts: [...new Set(['127.0.0.1', gateway, ...hostIps, 'host.docker.internal', 'gateway.docker.internal'])], console: nova.port, mesh: meshPort, home: m.home, canary, undeclared: '93.184.215.14' };

  const folder = mkdtempSync(join(tmpdir(), 'nova-m10a-project-'));
  writeFileSync(join(folder, 'README.md'), '# placeholder project\n');
  const c = new DockerComputer({ home: m.home });
  const ws: Machine = { id: `i${Date.now().toString(36)}`, folder, egress: { mode: 'none', hosts: [] }, container: null, image: IMAGE };
  const evidence: string[] = ['# M10a isolation: each escape attempted from inside a workspace', '', `Docker: ${(await docker(['info', '--format', '{{.OperatingSystem}}'])).out.trim()}. Console port ${nova.port} (loopback), mesh port ${meshPort} on ${meshBind}, Nova’s home ${m.home}.`, ''];
  try {
    await c.create(ws);
    const r = await c.exec(ws, { argv: ['node', '-e', PROBE, JSON.stringify(probeArgs)], timeoutS: 120 });
    assert.equal(r.exit, 0, r.stderr);
    const inside: Attempt[] = JSON.parse(r.stdout);
    evidence.push('## From inside the workspace', '', '| Attempt | Target | Result |', '|---|---|---|', ...inside.map((a) => `| ${a.what} | ${label(a.target)} | ${a.reached ? '**REACHED**' : 'refused'}: ${a.detail} |`), '');
    for (const kind of ['console', 'mesh', 'home', 'docker-socket', 'docker-tcp', 'host-network', 'outside', 'undeclared', 'undeclared-via-proxy', 'root']) {
      const tries = inside.filter((a) => a.what === kind);
      assert.ok(tries.length > 0, `${kind} was attempted`);
      for (const a of tries) assert.equal(a.reached, false, `${kind} ${a.target}: ${a.detail}`);
    }
    // Docker's own view agrees: no network, no mounts but the project, no capabilities, not root.
    const inspect = JSON.parse((await docker(['container', 'inspect', ws.container!])).out)[0];
    assert.equal(inspect.HostConfig.NetworkMode, 'none');
    assert.deepEqual(inspect.Mounts.map((x: { Source: string; Destination: string }) => [x.Source, x.Destination]), [[folder, '/workspace']]);
    assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']);
    assert.equal(inspect.HostConfig.Privileged, false);
    assert.ok(inspect.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.notEqual(inspect.Config.User.split(':')[0], '0');
    evidence.push('## Docker’s view of the workspace', '', `- Network: ${inspect.HostConfig.NetworkMode}; mounts: ${inspect.Mounts.map((x: { Source: string; Destination: string }) => `${x.Source} → ${x.Destination}`).join(', ')}`,
      `- User ${inspect.Config.User}; CapDrop ${inspect.HostConfig.CapDrop.join(',')}; SecurityOpt ${inspect.HostConfig.SecurityOpt.join(',')}; Privileged ${inspect.HostConfig.Privileged}`,
      `- Memory ${inspect.HostConfig.Memory} bytes; NanoCpus ${inspect.HostConfig.NanoCpus}; PidsLimit ${inspect.HostConfig.PidsLimit}`, '');

    // Positive controls: the same probe, with one piece of isolation removed, gets through.
    const control = async (what: string, args: string[], kinds: string[]) => {
      const res = await docker(['run', '--rm', '--user', runUser(), ...args, '--entrypoint', 'node', IMAGE, '-e', PROBE, JSON.stringify(probeArgs)], 180_000);
      assert.equal(res.code, 0, res.out);
      const got: Attempt[] = JSON.parse(res.out.slice(res.out.indexOf('[')));
      for (const k of kinds) assert.ok(got.some((a) => a.what === k && a.reached), `the control "${what}" reaches ${k}: ${JSON.stringify(got.filter((a) => a.what === k))}`);
      evidence.push(`- **${what}:** ${kinds.map((k) => `${k} reached (${got.filter((a) => a.what === k && a.reached).map((a) => label(a.target)).join(', ')})`).join('; ')}`);
    };
    evidence.push('## Positive controls (the same probe, one piece of isolation removed)', '');
    await control('with the host’s network', ['--network', 'host'], ['console', 'mesh', 'host-network']);
    await control('on Docker’s default bridge', ['--network', 'bridge'], ['mesh']);
    await control('with Nova’s home mounted', ['--network', 'none', '--mount', `type=bind,source=${m.home},target=${m.home},readonly`], ['home']);
    await control('with the Docker socket mounted', ['--network', 'none', '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock', '--user', '0:0'], ['docker-socket']);
    await control('as root with capabilities', ['--network', 'none', '--user', '0:0'], ['root']);
    evidence.push('');
  } finally {
    await c.destroy(ws, []).catch(() => {});
    await stop(nova);
    rmSync(folder, { recursive: true, force: true });
  }
  if (process.env.NOVA_EVIDENCE) writeFileSync(process.env.NOVA_EVIDENCE, evidence.join('\n'));
});
