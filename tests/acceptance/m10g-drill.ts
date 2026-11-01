// The promotion drill (M10g, docs/plans/M10g.md §6; the orchestration ADR's Point 10 gate): two Nova
// homes in temp folders on this machine, real processes on loopback, a paired stand-in computer (the
// real boot agent, joined with its own command) and a stand-in phone, a stand-in stable name (a
// loopback forwarder, scripts/stand-ins/stable-name.js) and a backup folder. Nothing outside the temp
// folders is touched: no real device, DNS, tailnet or network change. Shared by the test
// (tests/acceptance/m10g-drill.test.ts) and the runnable script (scripts/promotion-drill.ts).
//
// Every case asserts as it goes, so a run that returns is a run that passed. `say` gets each line of
// the record as it happens.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, blank, sleep, stop, type Running } from './support.ts';
import { agent, freePort, kill } from './m4c-support.ts';
import { Joiner, call } from '../core/mesh-support.ts';
import { startStableName } from '../../scripts/stand-ins/stable-name.js';
import { ensureMark, helloProofMessage, importDeviceKeys, signMessage, signRoster } from '../../src/core/index.ts';
import { Signer, findHub, paths } from '../../src/device/boot.ts';

export interface DrillStep { case: number; what: string; ms: number; facts: string[] }
export interface DrillResult { steps: DrillStep[]; probes: { ticks: number; both: number; n1: number; n2: number }; keys: { files: Record<string, { before: string; after: string }>; scanned: { files: number; bytes: number; tapped: number }; found: string[] }; seconds: number }

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const nowS = () => Math.floor(Date.now() / 1000);

async function wait<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let v: T | undefined;
  let err: unknown = null;
  while (Date.now() < end) {
    try { v = await read(); err = null; if (done(v)) return v; } catch (e) { err = e; }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}: ${err ? (err as Error).message : JSON.stringify(v)?.slice(0, 2000)}`);
}

// Every file under a folder, for the key scan.
function files(dir: string, skip: (p: string) => boolean = () => false): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (skip(p)) continue;
    if (e.isDirectory()) out.push(...files(p, skip));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// A private key in every way it could be written down: the JWK `d` as stored (base64url), and its raw
// bytes as hex and as standard base64.
function encodings(d: string): string[] {
  const raw = Buffer.from(d, 'base64url');
  return [d, raw.toString('hex'), raw.toString('base64').replace(/=+$/, '')];
}

export async function runDrill(o: { say?: (line: string) => void } = {}): Promise<DrillResult> {
  const say = o.say ?? (() => {});
  const t0 = Date.now();
  const steps: DrillStep[] = [];
  let stepAt = Date.now();
  const step = (n: number, what: string, facts: string[]) => {
    steps.push({ case: n, what, ms: Date.now() - stepAt, facts });
    say(`case ${n}: ${what}`);
    for (const f of facts) say(`  - ${f}`);
    stepAt = Date.now();
  };

  const root = mkdtempSync(join(tmpdir(), 'nova-m10g-drill-'));
  const tapDir = join(root, 'tap');
  const backups = join(root, 'backups');
  mkdirSync(backups, { mode: 0o700 });
  const name = await startStableName();
  const n1 = blank('nova-m10g-n1-');
  const n2 = blank('nova-m10g-n2-');
  const mesh1 = `http://127.0.0.1:${await freePort()}`;
  const mesh2 = `http://127.0.0.1:${await freePort()}`;
  const kHome = join(root, 'computer');
  const env = (mesh: string) => ({
    ...agent, NOVA_MESH_URL: mesh, NOVA_MESH_PUBLIC_URL: name.url, NOVA_MESH_TRANSPORT: 'network', NOVA_SYNC_WAIT_S: '2',
    NOVA_MESH_NAME_CONTROL: name.control, NOVA_PROMOTION_WINDOW_S: '6', NOVA_PROMOTION_PROBE_MS: '400', NOVA_DRILL_TAP: tapDir,
  });
  const running: Record<'n1' | 'n2', Running | null> = { n1: null, n2: null };
  const node = { n1, n2 } as const;
  const startNode = async (k: 'n1' | 'n2') => { running[k] = await node[k].start(env(k === 'n1' ? mesh1 : mesh2)); };
  const stopNode = async (k: 'n1' | 'n2', how: 'term' | 'kill' = 'term') => { const r = running[k]; running[k] = null; if (r) await (how === 'kill' ? kill(r) : stop(r)); };
  const hello = async (mesh: string) => (await call(mesh, 'GET', '/api/v1/mesh/hello')).body;

  // Case 8, throughout: both nodes asked to take a change at the same moment, every 100 ms. A tick
  // where both took it would be two hubs accepting writes. The change is one the gate decides and the
  // handler then refuses (a profile section that doesn't exist), so the probe itself changes nothing:
  // 409 is the node refusing writes (a standby, or a hub holding them), 400 is a node taking writes.
  const ticks = { ticks: 0, both: 0, n1: 0, n2: 0 };
  let probing = true;
  let probeN = 0;
  const writes = async (k: 'n1' | 'n2') => {
    if (!running[k] || !node[k].base) return false;
    try {
      const r = await fetch(`${node[k].base}/api/v1/profile/drill/probe`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify({ value: String(++probeN) }), signal: AbortSignal.timeout(1500) });
      const text = await r.text();
      if (r.status === 400 && !/no profile section/.test(text)) throw new Error(`the probe met another refusal: ${text}`);
      return r.status === 400;
    } catch { return false; }
  };
  const prober = (async () => {
    while (probing) {
      const [a, b] = await Promise.all([writes('n1'), writes('n2')]);
      ticks.ticks++;
      if (a) ticks.n1++;
      if (b) ticks.n2++;
      if (a && b) ticks.both++;
      await sleep(100);
    }
  })();

  // A computer's agent, as the real boot agent sees the mesh: findHub over its pinned roster.
  const computer = () => {
    const p = paths(kHome);
    const d = JSON.parse(readFileSync(p.device, 'utf8'));
    const keys = importDeviceKeys(JSON.parse(readFileSync(p.keys, 'utf8')));
    return { p, d, find: () => findHub(p, d, new Signer(keys)) };
  };
  const taskDone = (base: () => string, id: string, ms = 120_000) => wait(`task ${id}`, async () => (await fetch(`${base()}/api/v1/tasks/${id}`)).json(), (t: any) => ['done', 'failed', 'cancelled'].includes(t.state), ms);
  const backupAndDrill = async (k: 'n1' | 'n2') => {
    const n = node[k];
    const b = await n.send('POST', '/api/v1/backups');
    assert.equal(b.status, 202, JSON.stringify(b.body));
    const bt = await taskDone(() => n.base, b.body.id);
    assert.equal(bt.state, 'done', JSON.stringify(bt.reason));
    const d = await n.send('POST', '/api/v1/backups/drill', {});
    const dt = await taskDone(() => n.base, d.body.id, 180_000);
    assert.equal(dt.state, 'done', JSON.stringify(dt.reason));
    return (await n.get('/api/v1/backups')).complete[0];
  };

  try {
    // ---- setup -----------------------------------------------------------------------------------
    name.point(mesh1);
    ensureMark(n1.home);
    await startNode('n1');
    // The standby joins at the stable name, with the real command.
    const enrollWith = async (args: string[], envExtra: Record<string, string>) => {
      const code = (await n1.send('POST', '/api/v1/mesh/pairings')).body.code;
      const p = spawn(process.execPath, ['src/device/boot.ts', 'join', name.url, '--code', code, ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', NOVA_DEVICE_POLL_MS: '100', ...envExtra } });
      const said: string[] = [];
      p.stdout!.on('data', (d) => said.push(String(d)));
      p.stderr!.on('data', (d) => said.push(String(d)));
      const req = (await wait('a join request', () => n1.get('/api/v1/mesh/requests'), (rs: any[]) => rs.length > 0)).at(-1);
      assert.equal((await n1.send('POST', `/api/v1/mesh/requests/${req.id}/approve`, { confirm: true })).status, 200);
      for (let i = 0; i < 400 && p.exitCode === null; i++) await sleep(25);
      assert.equal(p.exitCode, 0, said.join(''));
      return req;
    };
    await enrollWith(['--kind', 'standby', '--name', 'Spare', '--nova-home', n2.home, '--address', mesh2], { HOME: join(n2.dir, 'user'), NOVA_DEVICE_HOME: join(n2.dir, 'device') });
    const n2Id = JSON.parse(readFileSync(join(n2.home, 'mesh', 'role.json'), 'utf8')).device_id as string;
    const n1Id = (await hello(mesh1)).id as string;
    await startNode('n2');
    await enrollWith(['--kind', 'computer', '--name', 'Desk computer'], { HOME: join(root, 'user'), NOVA_DEVICE_HOME: kHome });
    const kId = computer().d.device_id as string;
    // A phone, paired at the stable name.
    const phone = new Joiner(name.url, nowS, { name: 'Pocket phone', kind: 'phone' });
    await phone.join((await n1.send('POST', '/api/v1/mesh/pairings')).body.code);
    await phone.reveal();
    assert.equal((await n1.send('POST', `/api/v1/mesh/requests/${phone.requestId}/approve`, { confirm: true })).status, 200);
    await phone.poll();
    assert.equal((await phone.session()).status, 200);
    // Data of each kind, and a connector's secret in the vault.
    assert.equal((await n1.send('PUT', '/api/v1/profile/user/name', { value: 'Sam' })).status, 200);
    const mem = (await n1.send('POST', '/api/v1/memory', { kind: 'preference', content: 'Prefers aisle seats on trains.' })).body;
    assert.equal((await n1.send('PUT', '/api/v1/vault/DRILL_TOKEN', { value: 'placeholder-connector-token-6141' })).status, 200);
    mkdirSync(join(n1.home, 'workspace', 'notes'), { recursive: true });
    writeFileSync(join(n1.home, 'workspace', 'notes', 'plan.md'), '# Plan\n\n- book the train\n');
    // The keys, as they are now.
    const keyFiles = { n1: join(n1.home, 'mesh', 'identity.json'), n2: join(n2.home, 'mesh', 'identity.json'), computer: paths(kHome).keys };
    const before = Object.fromEntries(Object.entries(keyFiles).map(([k, f]) => [k, sha(readFileSync(f))]));
    step(0, 'Two Nova homes, a standby enrolled with its own command at the stable name, a computer and a phone paired there', [
      `N1 (hub) ${mesh1}, N2 (standby “Spare”) ${mesh2}, the stable name ${name.url} pointing at N1`,
      `the computer ${kId} pinned ${computer().d.pinned.length} keys at epoch ${computer().d.epoch}`,
    ]);

    // ---- case 1: pre-checks refuse -------------------------------------------------------------
    const check = async (id: string) => (await n1.send('POST', '/api/v1/mesh/promotions/check', { device_id: id })).body;
    const rPhone = await check(phone.deviceId);
    assert.equal(rPhone.ok, false);
    assert.match(rPhone.checks[0].said, /never a hub/);
    const rComputer = await check(kId);
    assert.match(rComputer.checks[0].said, /isn’t a hub candidate/);
    await wait('the standby to catch up', () => n1.get('/api/v1/health'), (h: any) => h.checks.mesh.standby?.lag?.acked_seq > 0 && h.checks.mesh.standby.lag.rows === 0);
    const rNoBackup = await check(n2Id);
    assert.equal(rNoBackup.checks.find((c: any) => c.name === 'backup').ok, false);
    assert.equal((await n1.send('POST', '/api/v1/mesh/promotions', { device_id: n2Id, confirm: true })).status, 409);
    step(1, 'The pre-checks refuse an ineligible candidate, for each reason the drill can make', [
      `the phone: ${rPhone.checks[0].said}`, `the computer: ${rComputer.checks[0].said}`, `the standby with no backup: ${rNoBackup.checks.find((c: any) => c.name === 'backup').said}`,
    ]);

    // ---- case 2: a planned promotion N1 → N2 ---------------------------------------------------
    assert.equal((await n1.send('PUT', '/api/v1/backups/settings', { target: backups })).status, 200);
    const b1 = await backupAndDrill('n1');
    await wait('the standby to catch up', () => n1.get('/api/v1/health'), (h: any) => h.checks.mesh.standby?.lag?.rows === 0);
    const snapshot = (home: string) => {
      const db = new DatabaseSync(join(home, 'nova.db'), { readOnly: true });
      try {
        return {
          memory: sha(JSON.stringify(db.prepare('SELECT * FROM memory ORDER BY id').all())),
          profile: sha(JSON.stringify(db.prepare('SELECT * FROM profile ORDER BY section, key').all())),
          messages: sha(JSON.stringify(db.prepare('SELECT * FROM message ORDER BY id').all())),
          plan: sha(readFileSync(join(home, 'workspace', 'notes', 'plan.md'))),
        };
      } finally { db.close(); }
    };
    const pre = await check(n2Id);
    assert.equal(pre.ok, true, JSON.stringify(pre.checks));
    const started = await n1.send('POST', '/api/v1/mesh/promotions', { device_id: n2Id, confirm: true });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await wait('N2 to be the hub at epoch 2', () => hello(mesh2), (h: any) => h.role === 'hub' && h.epoch === 2);
    await wait('N1 to be N2’s standby', () => n1.get('/api/v1/mesh/status'), (s: any) => s.role === 'standby');
    assert.equal(name.target(), mesh2, 'the new hub pointed the stable name at itself');
    const held = (await n1.send('PUT', '/api/v1/profile/user/name', { value: 'x' }));
    assert.equal(held.status, 409, 'the old hub refuses changes');
    await wait('N1 to copy N2', () => n2.get('/api/v1/health'), (h: any) => h.checks.mesh.standby?.lag?.acked_seq > 0 && h.checks.mesh.standby.lag.rows === 0);
    const after1 = { n1: snapshot(n1.home), n2: snapshot(n2.home) };
    assert.deepEqual(after1.n2, after1.n1, 'no data lost: content hashes');
    const k1 = await computer().find();
    assert.ok(k1.ok && k1.epoch === 2, JSON.stringify(k1));
    assert.equal(computer().d.roster.roster.hub.id, n2Id, 'the computer follows N2, without pairing again');
    const ps1 = await phone.session();
    assert.equal(ps1.status, 200, 'the phone signs in at the stable name, now N2, without pairing again');
    const verified = await wait('the window to pass', () => n1.get('/api/v1/mesh/promotion'), (v: any) => v.promotion?.state === 'verified', 60_000);
    const chain2 = await wait('the chain on N2', () => n2.get('/api/v1/mesh/promotion'), (v: any) => v.tasks.length >= 6 && v.tasks.every((t: any) => t.state === 'done'));
    step(2, 'A planned promotion N1 → N2: every step ledgered, no data lost, devices re-pointed through the stable name, N1 a live standby, the window passed', [
      `backup ${b1.seq} of ${b1.at}, its drill passed; every pre-check passed (${pre.checks.map((c: any) => c.name).join(', ')})`,
      ...chain2.tasks.map((t: any) => `ledger: “${t.title}”: ${t.state}`),
      `content hashes equal on both: ${JSON.stringify(after1.n2)}`,
      `the computer: epoch ${k1.ok ? k1.epoch : '?'} at ${k1.ok ? k1.url : '?'}; the phone: session ${ps1.status} at the stable name`,
      `window: ${verified.promotion.probes.length} probes over ${verified.promotion.window_s} s, the last passed`,
    ]);

    // ---- case 3: a planned promotion N2 → N1 that fails its checks: roll-back at epoch + 2 --------
    await backupAndDrill('n2');
    await wait('N1 to catch up', () => n2.get('/api/v1/health'), (h: any) => h.checks.mesh.standby?.lag?.rows === 0);
    name.stuck(true);
    const s3 = await n2.send('POST', '/api/v1/mesh/promotions', { device_id: n1Id, confirm: true });
    assert.equal(s3.status, 202, JSON.stringify(s3.body));
    await wait('N1 to take the role at epoch 3', () => hello(mesh1), (h: any) => h.role === 'hub' && h.epoch === 3);
    const rolled = await wait('the roll-back', () => n2.get('/api/v1/mesh/promotion'), (v: any) => v.promotion?.state === 'rolled-back', 60_000);
    const h2 = await hello(mesh2);
    assert.deepEqual([h2.role, h2.epoch], ['hub', 4], 'N2 is hub again by itself, at epoch 2 + 2');
    await wait('N1 to step down and copy N2', () => n1.get('/api/v1/mesh/promotion'), (v: any) => v.promotion?.state === 'stepped-down');
    assert.equal((await hello(mesh1)).role, 'standby', 'one hub');
    name.stuck(false);
    const problems = (await n2.get('/api/v1/problems?open=1')) as any;
    const said = JSON.stringify(problems);
    assert.match(said, /didn’t pass its checks after it became the hub/);
    const k3 = await computer().find();
    assert.ok(k3.ok && k3.epoch === 4, JSON.stringify(k3));
    step(3, 'A planned promotion N2 → N1 whose new hub fails its checks (the stable name didn’t move): N2 hub again by itself at epoch 4 = 2 + 2; N1 stepped down to copy it', [
      ...rolled.tasks.map((t: any) => `ledger: “${t.title}”: ${t.state}`),
      `failing probe: ${rolled.promotion.probes.at(-1).checks.filter((c: any) => !c.ok).map((c: any) => c.said).join(' ')}`,
      `the computer follows N2 at epoch ${k3.ok ? k3.epoch : '?'}`,
    ]);

    // ---- case 4: M4's emergency with a live standby; the old hub fenced -------------------------
    await wait('N1 to copy N2 again', () => n2.get('/api/v1/health'), (h: any) => h.checks.mesh.standby?.lag?.rows === 0 && h.checks.mesh.standby?.lag?.acked_seq > 0);
    await stopNode('n2', 'kill');
    const pr = await n1.send('POST', '/api/v1/mesh/promote', { confirm: true });
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    assert.equal(pr.body.epoch, 5);
    await wait('the name to lead to N1', async () => name.target(), (t) => t === mesh1);
    await startNode('n2');
    const fenced = await n2.get('/api/v1/mesh/status');
    assert.equal(fenced.role, 'standby');
    const refused4 = await n2.send('POST', '/api/v1/memory', { kind: 'fact', content: 'x' });
    assert.equal(refused4.status, 409);
    // It copies nothing now, so it can't be made the hub with what it had (its role file still says hub).
    const stale = await n2.send('POST', '/api/v1/mesh/promote', { confirm: true });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.match(stale.body.error, /no copy of the hub’s latest data/);
    step(4, 'N2 killed; N1, its live standby, made the hub (M4’s promotion, epoch 5); N2 back and fenced', [`N2 says: ${refused4.body.error}`, `asked to become the hub with what it had: ${stale.body.error}`]);

    // ---- case 6: an emergency promotion from the latest backup onto N2, not the standby ---------
    const b6 = await backupAndDrill('n1');
    const lost = (await n1.send('POST', '/api/v1/memory', { kind: 'fact', content: 'Written after the last backup.' })).body;
    await stopNode('n1', 'kill');
    const sheet = await wait('the emergency sheet', () => n2.get('/api/v1/mesh/promotion/cold'), (v: any) => v.eligible === true, 30_000);
    const words = sheet.sheet.map((f: any) => `${f.label}: ${f.text}`);
    assert.ok(words.some((w: string) => w.includes(b6.at)), 'the backup’s time');
    assert.ok(words.some((w: string) => /^What is lost: Everything written after/.test(w)), 'what was lost');
    assert.ok(words.some((w: string) => /^Connectors: Connectors need signing in again/.test(w)), 'connectors');
    assert.equal((await n2.send('POST', '/api/v1/mesh/promotion/cold', {})).status, 400, 'tier 3 every time');
    const cold = await n2.send('POST', '/api/v1/mesh/promotion/cold', { confirm: true });
    assert.equal(cold.status, 202, JSON.stringify(cold.body));
    await wait('N2 to come back as the hub at epoch 6', () => hello(mesh2), (h: any) => h.role === 'hub' && h.epoch === 6, 120_000);
    await wait('N2’s console after its restart', () => n2.get('/api/v1/mesh/status'), (s: any) => s.role === 'hub');
    const done6 = await wait('the cold chain', () => n2.get('/api/v1/mesh/promotion'), (v: any) => v.promotion?.state === 'done' && v.tasks.length >= 2 && v.tasks.every((t: any) => t.state === 'done'));
    const memories = (await n2.get('/api/v1/memory')) as any[];
    assert.ok(memories.some((m) => m.id === mem.id), 'what the backup held is there');
    assert.ok(!memories.some((m) => m.id === lost.id), 'what was written after it is lost, as the sheet said');
    const vault = await n2.get('/api/v1/vault');
    assert.ok(!(vault.names ?? []).includes('provider/DRILL_TOKEN'), 'the connector’s secret didn’t come back: it needs signing in again');
    await wait('the name to lead to N2', async () => name.target(), (t) => t === mesh2);
    const k6 = await computer().find();
    assert.ok(k6.ok && k6.epoch === 6, JSON.stringify(k6));
    assert.equal(computer().d.roster.roster.hub.id, n2Id);
    assert.equal((await phone.session()).status, 200, 'the phone, paired before the backup, signs in without pairing again');
    step(6, 'An emergency promotion from the latest backup onto N2 (a hub candidate, not the standby), with N1 unreachable', [
      ...words.map((w: string) => `sheet: ${w}`),
      ...done6.tasks.map((t: any) => `ledger: “${t.title}”: ${t.state}`),
      `memory written after the backup: absent on N2 (lost, as said); the connector secret: not in N2’s vault (${(vault.names ?? []).length} secrets)`,
      `the computer follows N2 at epoch ${k6.ok ? k6.epoch : '?'} with no new pairing; the phone signs in at the stable name`,
    ]);

    // ---- case 5: the old hub back while the new one is down: refused for its lower epoch --------
    await stopNode('n2');
    await startNode('n1');
    assert.deepEqual([(await hello(mesh1)).role, (await hello(mesh1)).epoch], ['hub', 5], 'it can’t reach anyone, so it can’t know');
    const k5 = await computer().find();
    assert.equal(k5.ok, false);
    assert.match((k5 as { reason: string }).reason, /epoch 5, older than 6; it was replaced/);
    assert.equal(computer().d.epoch, 6, 'the computer still holds epoch 6');
    await stopNode('n1');
    step(5, 'The old hub back while the new one is down: the computer refuses its lower epoch', [`the computer says: ${(k5 as { reason: string }).reason}`]);

    // ---- case 7: the old hub returns and fences itself ------------------------------------------
    await startNode('n2');
    await startNode('n1');
    assert.equal((await n1.get('/api/v1/mesh/status')).role, 'standby');
    const r7 = await n1.send('POST', '/api/v1/memory', { kind: 'fact', content: 'x' });
    assert.equal(r7.status, 409);
    assert.deepEqual([(await hello(mesh2)).role, (await hello(mesh1)).role], ['hub', 'standby'], 'one hub');
    step(7, 'N1 returns, finds N2 at epoch 6 (a pinned candidate), and steps down before it takes any change', [`N1 says: ${r7.body.error}`]);

    // ---- case 10: a key that isn't pinned can't take the role --------------------------------------
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const liar = createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      const claim = { id: 'impostor', role: 'hub', epoch: 99, public_key: pub };
      res.writeHead(200, { 'content-type': 'application/json' });
      if (u.pathname === '/api/v1/mesh/hello/proof') res.end(JSON.stringify({ ...claim, signature: signMessage(privateKey, helloProofMessage(u.searchParams.get('challenge')!, claim)) }));
      else res.end(JSON.stringify(signRoster({ epoch: 99, hub: { id: 'impostor', url: name.url, public_key: pub, x25519_public_key: pub }, issued_at: new Date().toISOString() }, privateKey)));
    });
    await new Promise<void>((r) => liar.listen(0, '127.0.0.1', r));
    const liarUrl = `http://127.0.0.1:${(liar.address() as AddressInfo).port}`;
    name.point(liarUrl);
    const k10 = computer();
    k10.d.hub_url = name.url;
    const f10 = await findHub(k10.p, { ...k10.d, roster: { ...k10.d.roster, roster: { ...k10.d.roster.roster, hub: { ...k10.d.roster.roster.hub, url: name.url }, candidates: [] } } }, new Signer(importDeviceKeys(JSON.parse(readFileSync(k10.p.keys, 'utf8')))));
    liar.close();
    name.point(mesh2);
    assert.equal(computer().d.epoch, 6, 'nothing was taken from it');
    const said10 = f10.ok ? '' : f10.reason;
    assert.match(said10, /Its key isn’t one this device pinned/);
    step(10, 'A node with a valid signature from a key that isn’t pinned, at epoch 99, can’t take the role', [`the computer says: ${said10.split(/(?<=\.) /).find((x) => /pinned/.test(x))}`]);

    // ---- case 8: never two nodes accepting writes ----------------------------------------------
    probing = false;
    await prober;
    assert.ok(ticks.n1 > 0 && ticks.n2 > 0, `both nodes took changes at some point: ${JSON.stringify(ticks)}`);
    assert.equal(ticks.both, 0, `two nodes accepted writes at the same moment: ${JSON.stringify(ticks)}`);
    step(8, 'Throughout: both nodes asked to take a change at the same moment, every 100 ms', [`${ticks.ticks} ticks; N1 took ${ticks.n1}, N2 took ${ticks.n2}; both in the same tick: ${ticks.both}`]);

    // ---- case 9: no private key leaves its device -----------------------------------------------
    await stopNode('n1');
    await stopNode('n2');
    const after = Object.fromEntries(Object.entries(keyFiles).map(([k, f]) => [k, sha(readFileSync(f))]));
    assert.deepEqual(after, before, 'every key file is byte-identical');
    const priv = (f: string) => { const j = JSON.parse(readFileSync(f, 'utf8')); return [j.ed25519.private, j.x25519.private] as string[]; };
    const owners: { who: string; keys: string[]; own: (p: string) => boolean }[] = [
      { who: 'N1', keys: priv(keyFiles.n1), own: (p) => p === keyFiles.n1 || p.startsWith(join(n1.home, 'checkpoints')) },
      { who: 'N2', keys: priv(keyFiles.n2), own: (p) => p === keyFiles.n2 || p.startsWith(join(n2.home, 'checkpoints')) },
      { who: 'the computer', keys: priv(keyFiles.computer), own: (p) => p === keyFiles.computer },
    ];
    const everything = [...files(root), ...files(n1.dir), ...files(n2.dir)];
    const tapped = files(tapDir).reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 0);
    assert.ok(tapped > 0, 'the tap recorded what crossed');
    const kinds = new Set(files(tapDir).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).kind as string)));
    for (const k of ['sync', 'handover', 'transfer-answer', 'ready-answer', 'hello']) assert.ok(kinds.has(k), `the tap saw ${k}`);
    const found: string[] = [];
    let bytes = 0;
    for (const f of everything) {
      const text = readFileSync(f).toString('latin1');
      bytes += text.length;
      for (const o2 of owners) {
        if (o2.own(f)) continue;
        for (const k of o2.keys) for (const e of encodings(k)) if (text.includes(e)) found.push(`${o2.who}'s private key in ${f}`);
      }
    }
    assert.deepEqual(found, [], 'no private key anywhere but its own key file (and its own checkpoints, which never leave it)');
    // No vault-key escrow: no backup holds the vault's key.
    const vk = readFileSync(join(n1.home, 'vault', 'key'));
    assert.equal(vk.length, 32);
    const vaultKey = [vk.toString('latin1'), vk.toString('hex'), vk.toString('base64').replace(/=+$/, ''), vk.toString('base64url')];
    const inBackups = files(backups).filter((f) => { const t = readFileSync(f).toString('latin1'); return vaultKey.some((e) => t.includes(e)); });
    assert.deepEqual(inBackups, [], 'no backup holds the vault’s key');
    step(9, 'No private key left its device', [
      `key files byte-identical before and after: ${Object.entries(after).map(([k, h]) => `${k} ${h.slice(0, 12)}…`).join(', ')}`,
      `scanned ${everything.length} files (${Math.round(bytes / 1024)} KB): both homes, the computer’s home, every backup and ${tapped} tapped messages (${[...kinds].sort().join(', ')}), for 6 private keys in 3 encodings each: none found outside its own key file`,
      `no backup in ${backups} holds the vault’s key`,
    ]);
    return { steps, probes: ticks, keys: { files: Object.fromEntries(Object.keys(before).map((k) => [k, { before: before[k]!, after: after[k]! }])), scanned: { files: everything.length, bytes, tapped }, found }, seconds: Math.round((Date.now() - t0) / 1000) };
  } finally {
    probing = false;
    await prober.catch(() => {});
    for (const k of ['n1', 'n2'] as const) await stopNode(k).catch(() => {});
    await name.close();
    if (!process.env.NOVA_DRILL_KEEP) for (const d of [root, n1.dir, n2.dir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* left */ } }
  }
}
