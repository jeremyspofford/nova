// M4 gate (ROADMAP-AND-GATES): pair a phone (QR) and a computer (command) to a fresh hub; revoke
// one; kill the hub and promote the standby; no data loss, no orphaned trust.
//
// All real processes: a hub and a standby (two Nova servers, each with a home of its own), the
// computer's boot and runtime agents installed by the exact one-line command, and Chromium as the
// hub's own screen and as a phone. Devices reach the mesh over HTTPS at this machine's own
// non-loopback address (inside the test container), with a certificate made for the test, so the
// device path is the remote one. The QR is decoded from the pixels the hub drew.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import jsQRModule from 'jsqr';
import type { Locator, Page } from 'playwright-core';
import { ROOT, sleep, stop, until, type Running } from '../acceptance/support.ts';
import { agent as fakeAgent, freePort, kill } from '../acceptance/m4c-support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

const jsQR = jsQRModule as unknown as typeof jsQRModule.default;
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');

// This machine's own address on its network: not loopback, so nothing reaching the mesh by it is
// the console.
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
}

// Rows by key, hashed, from a home's database (read-only while its server runs).
function rows(home: string, sql: string, key: string, ...params: string[]): Record<string, string> {
  const db = new DatabaseSync(join(home, 'nova.db'), { readOnly: true });
  try {
    return Object.fromEntries((db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => [String(r[key]), sha(r)]));
  } finally {
    db.close();
  }
}

// The QR exactly as the page drew it, read back from a screenshot of the element.
async function readQr(page: Page, qr: Locator): Promise<string | null> {
  const png = await qr.screenshot();
  const px = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, data: Array.from(g.getImageData(0, 0, c.width, c.height).data) };
  }, png.toString('base64'));
  return jsQR(Uint8ClampedArray.from(px.data), px.w, px.h, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

// Approve whatever join request the hub's screen is showing: the same six digits as the joining
// device, tier 3 (Confirm stays locked until the box is ticked).
async function approveOnHub(page: Page, digits: string) {
  const approval = page.locator('#sheet form[data-request]');
  await approval.waitFor({ timeout: 15000 });
  assert.equal(((await approval.locator('.digits').textContent()) ?? '').replace(/\s/g, ''), digits, 'both screens show the same six digits');
  assert.equal(await approval.getAttribute('data-tier'), '3');
  const confirm = approval.locator('[data-action="approve"]');
  assert.equal(await confirm.isDisabled(), true, 'tier 3: locked until confirmed');
  await approval.locator('input[name="confirm"]').check();
  await confirm.click();
  await approval.waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
}

test('M4 gate: phone by QR and computer by command; revoke one; kill the hub, promote the standby; no data loss, no orphaned trust', { timeout: 300_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const ip = lanAddress();
  if (!ip) { await b.close(); return t.skip('no non-loopback address on this machine to serve the mesh on'); }
  const certs = mkdtempSync(join(tmpdir(), 'nova-m4-tls-'));
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=nova-test-mesh',
    '-addext', `subjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost`, '-keyout', join(certs, 'key.pem'), '-out', join(certs, 'cert.pem')], { encoding: 'utf8' });
  if (made.status !== 0) { await b.close(); return t.skip(`openssl could not make a test certificate: ${made.stderr}`); }
  const ca = join(certs, 'cert.pem');
  const tls = { NOVA_TLS_CERT: ca, NOVA_TLS_KEY: join(certs, 'key.pem'), NODE_EXTRA_CA_CERTS: ca, NOVA_CA_FILE: ca };

  const shots3 = shotsDir();
  const shots = shots3 ? join(dirname(shots3), 'm4') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  const log: string[] = ['# M4 gate — evidence', '', `Run ${new Date().toISOString()}. Mesh over HTTPS at ${ip} (not loopback); every process real.`, ''];
  const step = (s: string) => { log.push(`- ${s}`); console.log(`  · ${s}`); };

  const hub = blank('nova-m4-hub-');
  const standby = blank('nova-m4-standby-');
  const hubMesh = `https://${ip}:${await freePort()}`;
  const standbyMesh = `https://${ip}:${await freePort()}`;
  const meshEnv = (url: string) => ({ ...fakeAgent, ...tls, NOVA_MESH_URL: url, NOVA_MESH_PUBLIC_URL: url, NOVA_SYNC_WAIT_S: '5', NOVA_EGRESS_ALLOW: ip });
  const deviceEnv = (dir: string) => ({ PATH: process.env.PATH ?? '', HOME: join(dir, 'user'), NOVA_DEVICE_HOME: join(dir, 'device'), NOVA_CA_FILE: ca, CURL_CA_BUNDLE: ca,
    NOVA_DEVICE_POLL_MS: '200', NOVA_DEVICE_HEARTBEAT_MS: '500', NOVA_DEVICE_TICK_MS: '200', NOVA_DEVICE_RETRY_MS: '300' });
  const computerDir = mkdtempSync(join(tmpdir(), 'nova-m4-computer-'));
  const cEnv = deviceEnv(computerDir);
  const agentCli = (...args: string[]) => spawnSync(process.execPath, [join(cEnv.NOVA_DEVICE_HOME, 'agent', 'src', 'device', 'boot.ts'), ...args], { env: cEnv, encoding: 'utf8' });

  let hubProc: Running | null = null;
  let standbyProc: Running | null = null;
  const children: ChildProcess[] = [];
  try {
    // ---- a fresh hub --------------------------------------------------------------------------
    hubProc = await hub.start(meshEnv(hubMesh));
    const consolePort = new URL(hub.base).port;
    const outside = await fetch(`http://${ip}:${consolePort}/api/v1/health`).then(() => 'answered', () => 'refused');
    assert.equal(outside, 'refused', 'the console listener is not reachable beyond loopback');
    await finishSetup(hub);
    step(`Fresh hub: setup done; its console answers only on loopback (http://${ip}:${consolePort} refused); devices use ${hubMesh}.`);

    const console_ = await device(b, { width: 1280, height: 900 });
    const hubPage = console_.page;
    await hubPage.goto(`${hub.base}/settings#devices`);
    await ready(hubPage);
    await hubPage.locator('#devices .device-row[data-device]').first().waitFor();

    // ---- the standby, by command ----------------------------------------------------------------
    const sCode = (await hub.send('POST', '/api/v1/mesh/pairings')).body.code;
    const sJoin = spawn(process.execPath, ['src/device/boot.ts', 'join', hubMesh, '--code', sCode, '--kind', 'standby', '--name', 'Standby', '--nova-home', standby.home, '--address', standbyMesh],
      { cwd: ROOT, env: deviceEnv(standby.dir) });
    children.push(sJoin);
    const sSaid: string[] = [];
    sJoin.stdout!.on('data', (d) => sSaid.push(String(d)));
    sJoin.stderr!.on('data', (d) => sSaid.push(String(d)));
    const sDigits = (await until(async () => sSaid.join(''), (s) => /\b\d{3} ?\d{3}\b/.test(s), 400)).match(/\b(\d{3}) ?(\d{3})\b/);
    assert.ok(sDigits, `the standby's command shows six digits:\n${sSaid.join('')}`);
    await approveOnHub(hubPage, sDigits[1]! + sDigits[2]!);
    for (let i = 0; i < 400 && sJoin.exitCode === null; i++) await sleep(25);
    assert.equal(sJoin.exitCode, 0, sSaid.join(''));
    standbyProc = await standby.start(meshEnv(standbyMesh));
    assert.match(standbyProc.out.join(''), /This is the standby/);
    step('Standby: enrolled by command (digits matched, approved on the hub’s screen with confirm), started from a blank home, syncing.');

    // ---- the phone, by QR -----------------------------------------------------------------------
    await hubPage.locator('#devices [data-action="add-device"]').click();
    const sheet = hubPage.locator('#sheet .add-device');
    await sheet.waitFor();
    const qrUrl = await readQr(hubPage, sheet.locator('.qr'));
    assert.ok(qrUrl, 'the QR on the hub’s screen decodes');
    assert.ok(qrUrl!.startsWith(`${hubMesh}/pair#c=`), qrUrl!);
    if (shots) await shoot(hubPage, join(shots, 'gate-1-add-a-device.png'));
    const phoneCtx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true });
    const phone = await phoneCtx.newPage();
    await phone.goto(qrUrl!);
    await phone.locator('#join').click();
    const pDigits = ((await phone.locator('.pair-digits').textContent({ timeout: 15000 })) ?? '').replace(/\s/g, '');
    assert.match(pDigits, /^\d{6}$/);
    if (shots) await shoot(phone, join(shots, 'gate-2-phone-digits.png'));
    await approveOnHub(hubPage, pDigits);
    await phone.waitForURL(`${hubMesh}/`, { timeout: 20000 });
    await ready(phone);
    const phoneMemory = await phone.evaluate(() => fetch('/api/v1/memory', { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify({ kind: 'fact', content: 'The bike pump is in the shed.' }) }).then((r) => r.json()));
    assert.ok(phoneMemory.id, 'the phone, signed in over HTTPS, changes things like the person does');
    if (shots) await shoot(phone, join(shots, 'gate-3-phone-home.png'));
    step('Phone: QR decoded from the hub’s screen, opened over HTTPS on a phone-sized browser, non-extractable keys, same digits on both screens, approved with confirm; signed in and saved a memory.');

    // ---- the computer, by the one-line command ----------------------------------------------------
    await hubPage.goto(`${hub.base}/settings#devices`);
    await ready(hubPage);
    await hubPage.locator('#devices [data-action="add-device"]').click();
    await hubPage.locator('#sheet .add-device').waitFor();
    const command = ((await hubPage.locator('#add-command').textContent()) ?? '').trim();
    assert.match(command, new RegExp(`^curl -fsS ${hubMesh.replace(/[.:/]/g, '\\$&')}/join\\.sh \\| sh -s -- [0-9A-Z]{4}-[0-9A-Z]{4}$`));
    const cJoin = spawn('sh', ['-c', command], { env: cEnv });
    children.push(cJoin);
    const cSaid: string[] = [];
    cJoin.stdout!.on('data', (d) => cSaid.push(String(d)));
    cJoin.stderr!.on('data', (d) => cSaid.push(String(d)));
    const cDigits = (await until(async () => cSaid.join(''), (s) => /\b\d{3} ?\d{3}\b/.test(s), 600)).match(/\b(\d{3}) ?(\d{3})\b/);
    assert.ok(cDigits, `the command shows six digits:\n${cSaid.join('')}`);
    await approveOnHub(hubPage, cDigits[1]! + cDigits[2]!);
    type Dev = { id: string; kind: string; role: string; trust: string; online: boolean; last_seen: string | null; agent?: { safe_mode: boolean } };
    const devices = (node: typeof hub) => node.get('/api/v1/mesh/devices') as Promise<Dev[]>;
    // The joined computer, not the hub's own row (the hub is a computer too).
    const isComputer = (d: Dev) => d.kind === 'computer' && d.role !== 'hub';
    const computer = (await until(() => devices(hub), (ds) => ds.some((d) => isComputer(d) && d.online && d.agent), 2400)).find(isComputer);
    const agentLog = () => { try { return readFileSync(join(cEnv.NOVA_DEVICE_HOME, 'agent.log'), 'utf8'); } catch { return '(no agent.log)'; } };
    assert.ok(computer?.online && computer.agent, `the computer shows Online with its runtime:\n${JSON.stringify(computer)}\n${cSaid.join('')}\n${agentLog()}`);
    assert.equal(computer.agent!.safe_mode, false);
    if (shots) { await hubPage.goto(`${hub.base}/settings#devices`); await ready(hubPage); await hubPage.locator('#devices .device-row', { hasText: 'Standby' }).waitFor(); await shoot(hubPage, join(shots, 'gate-4-registry.png')); }
    step(`Computer: the exact command from the sheet (\`${command.replace(/[0-9A-Z]{4}-[0-9A-Z]{4}$/, '<code>')}\`) installed the boot agent, digits matched, approved with confirm; its runtime heartbeats and it shows Online.`);

    // ---- data on the hub --------------------------------------------------------------------------
    const mem = (await hub.send('POST', '/api/v1/memory', { kind: 'preference', content: 'Prefers tea in the afternoon.' })).body;
    const task = (await hub.send('POST', '/api/v1/tasks', {
      title: 'Save a shopping list', owner: 'workspace', goal: 'The list is saved.', evidence_required: [{ kind: 'read_back', target: 'workspace:lists/shopping.md' }],
      inputs: { action: 'write', path: 'lists/shopping.md', content: '- bread\n- lemons\n' },
    })).body;
    assert.equal((await until(() => hub.get(`/api/v1/tasks/${task.id}`), (x: any) => x.state === 'done')).state, 'done');
    const chat = (await hub.send('POST', '/api/sessions', { text: 'hello there' })).body;
    await until(() => hub.get(`/api/sessions/${chat.id}`), (v: any) => !v.live);
    mkdirSync(join(hub.home, 'workspace', 'notes'), { recursive: true });
    writeFileSync(join(hub.home, 'workspace', 'notes', 'trip.md'), '# Trip\n\n- book the ferry\n');
    step('Data on the hub: a memory (plus the phone’s), a verified workspace task, a conversation, a file in the workspace.');

    // ---- revoke the phone (tier 3) ------------------------------------------------------------------
    const phoneId = (await devices(hub)).find((d) => d.kind === 'phone')!.id;
    await hubPage.goto(`${hub.base}/settings#devices`);
    await ready(hubPage);
    const row = hubPage.locator('#devices .device-row', { hasText: 'Phone' });
    await row.locator('[data-action="revoke-device"]').click();
    const revoke = hubPage.locator('#sheet form[data-revoke]');
    await revoke.waitFor();
    assert.equal(await revoke.locator('[data-action="approve"]').isDisabled(), true, 'revoking is tier 3');
    await revoke.locator('input[name="confirm"]').check();
    await revoke.locator('[data-action="approve"]').click();
    await phone.waitForURL(`${hubMesh}/pair`, { timeout: 15000 });
    assert.equal(await phone.evaluate(() => fetch('/api/v1/tasks').then((r) => r.status)), 401, 'its next request is refused');
    assert.equal((await devices(hub)).find((d) => d.id === phoneId)!.trust, 'revoked');
    if (shots) await shoot(phone, join(shots, 'gate-5-phone-revoked.png'));
    step('Revoked the phone from the hub’s screen (tier 3): its page went back to /pair at once and its next request got 401.');

    // ---- catch up, snapshot, kill the hub ---------------------------------------------------------------
    const caughtUp = (h: any) => h.checks.mesh.standby?.lag?.acked_seq > 0 && h.checks.mesh.standby.lag.rows === 0;
    assert.ok(caughtUp(await until(() => hub.get('/api/v1/health'), caughtUp, 2400)), 'the standby has everything');
    await sleep(4000); // the file journal scans every 3 s
    const lag = (await until(() => hub.get('/api/v1/health'), caughtUp, 2400)).checks.mesh.standby.lag;
    assert.equal(lag.rows, 0, `the standby has the files too: ${JSON.stringify(lag)}`);
    const memIds = [mem.id, phoneMemory.id];
    const snapshot = (home: string) => ({
      profile: rows(home, 'SELECT * FROM profile', 'key'),
      task: rows(home, 'SELECT * FROM task WHERE id = ?', 'id', task.id),
      events: rows(home, 'SELECT * FROM task_event WHERE task_id = ?', 'seq', task.id),
      memory: rows(home, 'SELECT * FROM memory WHERE id IN (?, ?)', 'id', ...memIds),
      receipts: rows(home, 'SELECT * FROM receipt WHERE session_id = ?', 'id', chat.id),
      trust: rows(home, 'SELECT id, trust, revoked_at, public_key FROM device', 'id'),
      files: Object.fromEntries(['workspace/lists/shopping.md', 'workspace/notes/trip.md', `sessions/${chat.id}.jsonl`].map((f) => [f, sha(readFileSync(join(home, f)))])),
    });
    const before = snapshot(hub.home);
    await kill(hubProc);
    hubProc = null;
    step('Standby caught up (lag 0 rows); the hub was killed with SIGKILL.');

    // ---- the computer works offline --------------------------------------------------------------------
    const offlineTask = { title: 'Note from the computer while the hub was down', owner: 'workspace', goal: 'The note exists.', evidence_required: [{ kind: 'read_back', target: 'notes/offline.md' }], inputs: { path: 'notes/offline.md', content: 'queued offline' } };
    assert.equal(agentCli('queue', 'task_request', JSON.stringify(offlineTask), '--key', 'gate-offline-task').status, 0);
    assert.equal(agentCli('queue', 'memory_note', JSON.stringify({ content: 'Written down while the hub was unreachable.' }), '--key', 'gate-offline-note').status, 0);
    step('While the hub was down, the computer queued a task request and a memory note.');

    // ---- promote the standby from its own screen (tier 3) ------------------------------------------------
    const sb = await device(b, { width: 1280, height: 900 });
    await sb.page.goto(`${standby.base}/health`);
    await ready(sb.page);
    const banner = sb.page.locator('#banner');
    await banner.locator('[data-action="promote"]').waitFor({ timeout: 15000 }).catch(async () => {
      assert.fail(`no promote control; banner: ${await banner.evaluate((e) => `${(e as HTMLElement).hidden ? '[hidden] ' : ''}${e.innerHTML}`)}\nstatus: ${JSON.stringify(await standby.get('/api/v1/mesh/status'))}`);
    });
    await banner.locator('[data-action="promote"]').click();
    const promote = sb.page.locator('#sheet .approval-sheet[data-promote]');
    await promote.waitFor();
    assert.equal(await promote.locator('[data-action="approve"]').isDisabled(), true, 'promotion is tier 3');
    await promote.locator('input[name="confirm"]').check();
    await promote.locator('[data-action="approve"]').click();
    await sb.page.getByText(/This node is the hub now \(epoch 2\)\./).first().waitFor({ timeout: 20000 });
    const promoted = (await standby.get('/api/v1/tasks') as any[]).find((x) => x.title === 'Standby promoted to hub');
    assert.equal(promoted?.state, 'done', 'the promotion is a verified ledger task');
    if (shots) await shoot(sb.page, join(shots, 'gate-6-promoted.png'));
    step('Promoted the standby from its own screen (tier 3): epoch 2, recorded in the ledger as a verified task.');

    // ---- no data loss ----------------------------------------------------------------------------------
    assert.deepEqual(snapshot(standby.home), before, 'everything from before the crash, by content hash');
    step('No data loss: profile, the task and its events, both memories, receipts, device trust and the files match the dead hub by content hash.');

    // ---- the computer moves to the new hub; its offline work arrives exactly once -------------------------
    const moved = await until(() => devices(standby), (ds) => ds.some((d) => isComputer(d) && d.online && !!d.last_seen && Date.parse(d.last_seen) > Date.parse(promoted.created_at)), 1200);
    assert.ok(moved.find(isComputer)?.online, 'the computer found the new hub by itself');
    const arrived = await until(() => standby.get('/api/v1/tasks') as Promise<any[]>, (ts) => ts.some((x) => x.title === offlineTask.title), 1200);
    assert.equal(arrived.filter((x) => x.title === offlineTask.title).length, 1, 'the queued task arrived once');
    const notes = (await standby.get('/api/v1/memory') as any[]).filter((m) => m.content === 'Written down while the hub was unreachable.');
    assert.equal(notes.length, 1, 'the queued note arrived once');
    assert.match(notes[0].recorded_by, /^device:/, 'with its provenance');
    assert.match(agentCli('status', '--json').stdout, new RegExp(`"epoch":\\s*2`));
    step('The computer moved to the new hub by itself (signed roster, epoch 2); its queued task and note each arrived exactly once, with provenance.');

    // ---- no orphaned trust ----------------------------------------------------------------------------
    const after = await devices(standby);
    assert.equal(after.find((d) => d.id === phoneId)!.trust, 'revoked', 'the phone is still revoked on the new hub');
    assert.equal(after.find((d) => d.kind === 'standby')?.role, 'hub', 'the standby’s record now says hub');
    await hubPage.close();
    hubProc = await hub.start(meshEnv(hubMesh));
    assert.match(hubProc.out.join(''), /isn’t the hub any more/);
    const refused = await hub.send('POST', '/api/v1/memory', { kind: 'fact', content: 'x' });
    assert.equal(refused.status, 409, 'the old hub, back, refuses changes');
    assert.equal((await standby.get('/api/v1/mesh/status')).role, 'hub', 'still exactly one hub');
    step('No orphaned trust: the phone is still revoked on the new hub; the old hub, restarted, saw epoch 2 and stepped down (writes refused, saying why); exactly one hub.');

    // Local-only held: nothing tried to reach beyond this machine and its mesh.
    for (const node of [hub, standby]) assert.equal(readFileSync(node.egress, 'utf8'), '', `no egress from ${node.home}`);
    step('Local-only held: neither Nova process tried to connect anywhere outside this machine and its own mesh.');
    if (shots) {
      const evidence = join(ROOT, 'docs', 'evidence');
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, 'm4-gate.md'), `${log.join('\n')}\n\nScreenshots: docs/screenshots/m4/gate-*.png\n`);
    }
    assert.deepEqual([...console_.errors, ...sb.errors].filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(e)), [], 'no errors on the hub’s screens');
  } finally {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    // The computer's boot agent runs in the background; stop it by its pid file.
    try { process.kill(Number(readFileSync(join(cEnv.NOVA_DEVICE_HOME, 'boot', 'run.pid'), 'utf8')), 'SIGTERM'); } catch { /* not running */ }
    await b.close();
    if (hubProc) await stop(hubProc);
    if (standbyProc) await stop(standbyProc);
  }
});
