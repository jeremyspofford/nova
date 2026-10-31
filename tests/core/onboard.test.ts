// Onboarding (M10f, docs/plans/M10f.md §3; the orchestration ADR, Point 11; Amendment 2026-10-31-B
// Part 2): the device detected, the per-OS backend words, discovery against stand-ins on loopback
// (found, never connected), the consent-first import through the ingest gate, the populated first
// view with one action, and the closing rule (every first action backed by the eval suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIRST_ACTIONS, backendFor, decodeMdns, detectOs, discover, encodeMdnsQuery, encodeMdnsResponse, evals, findSources, importSources, loopbackTransport,
  recommendedHubPurposes, transportFromEnv, type DeviceFacts,
} from '../../src/core/index.ts';
import { CLAIMS } from '../evals/claims.ts';
import { TASKS } from '../evals/tasks/index.ts';
import { HOME_ANSWERS, fakeMdns, fakeRuntime, freePort } from '../support/fake-mdns.ts';
import { NOTE_WORD, seedUserHome } from '../support/onboard-home.ts';
import { hub } from './mesh-support.ts';

const GB = 1024 ** 3;

test('the device: Linux, macOS, Windows, and a Linux inside WSL2 told apart; the hub’s roles recommended from its hardware', () => {
  assert.equal(detectOs({ platform: 'darwin' }), 'macos');
  assert.equal(detectOs({ platform: 'win32' }), 'windows');
  assert.equal(detectOs({ platform: 'linux', release: '6.8.0-generic', env: {}, procVersion: 'Linux version 6.8.0' }), 'linux');
  assert.equal(detectOs({ platform: 'linux', release: '6.6.0-microsoft-standard-WSL2', env: {}, procVersion: null }), 'wsl2');
  assert.equal(detectOs({ platform: 'linux', release: '6.8.0', env: { WSL_DISTRO_NAME: 'Example' }, procVersion: null }), 'wsl2');
  const facts = (gpus: DeviceFacts['gpus'], ram = 16 * GB): DeviceFacts => ({ os: 'linux', arch: 'x64', cpu: 'Example CPU', threads: 8, ram_bytes: ram, gpus, disk_free_bytes: 100 * GB });
  assert.deepEqual(recommendedHubPurposes(facts([])), ['hub-candidate', 'general-server']);
  assert.deepEqual(recommendedHubPurposes(facts([{ name: 'Example GPU', vram_bytes: 12 * GB, unified: false }])), ['hub-candidate', 'compute', 'general-server']);
  assert.deepEqual(recommendedHubPurposes(facts([{ name: 'Example GPU', vram_bytes: 4 * GB, unified: false }])), ['hub-candidate', 'general-server'], 'a small GPU isn’t recommended for models');
});

test('the backend, per OS: the supervisor pre-selected everywhere; K3s never offered as working; switching said to be in Settings › Services', () => {
  for (const os of ['linux', 'macos', 'windows', 'wsl2'] as const) {
    const b = backendFor(os);
    assert.equal(b.recommended, 'supervisor');
    assert.deepEqual(b.options.filter((o) => o.available).map((o) => o.id), ['supervisor'], `${os}: only what is built is offered`);
    assert.equal(b.options.find((o) => o.recommended)?.id, 'supervisor');
    assert.match(b.words, /Settings › Services/);
    assert.match(b.words, /nothing in Nova needs Kubernetes/);
  }
  assert.deepEqual(backendFor('linux').options.map((o) => [o.id, o.available]), [['supervisor', true], ['k3s', false]]);
  assert.match(backendFor('linux').options[1]!.note, /Not available yet/);
  for (const os of ['macos', 'windows', 'wsl2'] as const) {
    assert.deepEqual(backendFor(os).options.map((o) => o.id), ['supervisor'], `${os}: K3s isn’t offered`);
    assert.match(backendFor(os).misses, /can’t do is host container services/);
  }
  assert.match(backendFor('macos').misses, /K3s isn’t offered on a Mac: it needs Linux/);
  assert.match(backendFor('windows').misses, /on Windows: it needs Linux/);
  assert.match(backendFor('wsl2').misses, /WSL2[\s\S]*counts as Windows/);
});

test('the mDNS codec: a query, an answer with compressed names, and garbage refused', () => {
  const q = decodeMdns(encodeMdnsQuery(['_home-assistant._tcp.local'], 7));
  assert.deepEqual([q.id, q.response, q.questions], [7, false, [{ name: '_home-assistant._tcp.local', type: 12 }]]);
  const r = decodeMdns(encodeMdnsResponse(HOME_ANSWERS, 7));
  assert.equal(r.answers.length, HOME_ANSWERS.length);
  const txt = r.answers.find((a) => a.type === 16) as { txt: Record<string, string> };
  assert.deepEqual({ ...txt, txt: { ...txt.txt } }, HOME_ANSWERS.find((a) => a.type === 16));
  // A compressed name: the second record's name points back into the first.
  const name = Buffer.from([4, ...Buffer.from('desk'), 5, ...Buffer.from('local'), 0]);
  const rec = (n: Buffer, type: number, data: Buffer) => { const m = Buffer.alloc(10); m.writeUInt16BE(type, 0); m.writeUInt16BE(1, 2); m.writeUInt32BE(60, 4); m.writeUInt16BE(data.length, 8); return Buffer.concat([n, m, data]); };
  const head = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 2, 0, 0, 0, 0]);
  const packet = Buffer.concat([head, rec(name, 1, Buffer.from([192, 0, 2, 30])), rec(Buffer.from([0xc0, 12]), 1, Buffer.from([192, 0, 2, 31]))]);
  assert.deepEqual(decodeMdns(packet).answers.map((a) => [a.name, (a as { address: string }).address]), [['desk.local', '192.0.2.30'], ['desk.local', '192.0.2.31']]);
  assert.throws(() => decodeMdns(Buffer.from([1, 2, 3])));
  assert.throws(() => decodeMdns(Buffer.concat([head, Buffer.from([0xc0, 0xff])])));
});

test('discovery, on loopback stand-ins only: found and named, never connected; the network query bound to 127.0.0.1', async () => {
  const runtime = await fakeRuntime();
  const mdns = await fakeMdns();
  try {
    const t = loopbackTransport({ ports: { 'model-runtime': runtime.port, screenpipe: await freePort(), 'home-assistant': await freePort() }, mdns: mdns.port });
    const here = await discover({ scope: 'device', transport: t, timeoutMs: 400 });
    assert.deepEqual(here.found.map((f) => [f.kind, f.name, f.where, f.connected]), [['model-runtime', 'Ollama 0.35.1', 'this computer', false]]);
    assert.equal(mdns.queries.length, 0, 'this computer only: no query onto the network');
    const all = await discover({ scope: 'network', transport: t, timeoutMs: 400 });
    assert.equal(all.bound, '127.0.0.1', 'the discovery socket was bound to loopback');
    assert.deepEqual(mdns.queries.map((q) => [q.from, q.names]), [['127.0.0.1', ['_home-assistant._tcp.local', '_workstation._tcp.local']]], 'one query, both service types');
    assert.deepEqual(all.found.map((f) => [f.kind, f.name, f.address, f.connected]), [
      ['model-runtime', 'Ollama 0.35.1', `127.0.0.1:${runtime.port}`, false],
      ['home-assistant', 'Home Assistant “Example Home” 2026.10.0', '192.0.2.10:8123', false],
      ['computer', 'desk-box', '192.0.2.20:9', false],
    ]);
    // Finding is one GET per known service: no login, no other path, nothing changed.
    assert.deepEqual(runtime.hits, ['GET /api/version', 'GET /api/version']);
    // The environment's stand-ins are loopback only.
    assert.equal(transportFromEnv({ NOVA_DISCOVERY_MDNS: '192.0.2.1:5353' })?.name, 'loopback stand-ins');
    assert.equal(transportFromEnv({}), null);
  } finally { await runtime.close(); await mdns.close(); }
});

test('import sources: listed by place without reading a file; only what is picked is read, screened, and left waiting', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-onboard-'));
  seedUserHome(home, { firefox: true });
  // A note nobody may read: listing still works, so finding never opened a file.
  chmodSync(join(home, 'Notes', 'reading.md'), 0o000);
  const found = findSources(home, 'linux');
  chmodSync(join(home, 'Notes', 'reading.md'), 0o644);
  assert.deepEqual(found.map((s) => [s.kind, s.label, s.files]), [
    ['notes', 'notes in ~/Notes', 2],
    ['calendar', 'a calendar file, ~/Documents/example.ics', 1],
    ['bookmarks', 'bookmarks from Chrome', 1],
    ['bookmarks', 'bookmarks from Firefox', 1],
  ]);
  const screened: string[] = [];
  const waiting: { kind: string; content: string; source: string }[] = [];
  const gate = {
    screen: async (text: string, origin: string) => { screened.push(origin); return { verdict: /lighthouses/.test(text) ? 'block' as const : 'quarantine' as const, taint: { origin } }; },
    candidate: (c: { kind: string; content: string; source: string }) => { waiting.push(c); },
    kept: () => new Set<string>(),
  };
  const out = await importSources([found[0]!, found[1]!, found[3]!], gate, { userHome: home, now: new Date('2026-10-31T00:00:00Z') });
  assert.deepEqual(screened, ['~/Notes/garden/plants.md', '~/Notes/reading.md', '~/Documents/example.ics', 'Firefox bookmarks'], 'every file read was screened first; Chrome’s, not picked, was never read');
  assert.deepEqual(out.map((r) => [r.label, r.waiting, r.held]), [['notes in ~/Notes', 1, 1], ['a calendar file, ~/Documents/example.ics', 2, 0], ['bookmarks from Firefox', 1, 0]]);
  assert.match(out[0]!.said, /1 held back because it looked like it was trying to give instructions/);
  assert.deepEqual(waiting.map((w) => [w.kind, w.content, w.source]), [
    ['fact', `Note “Garden plans”: Plant ${NOTE_WORD} by the north fence in spring. The soil there is clay.`, 'imported from ~/Notes/garden/plants.md'],
    ['timeline', 'Has “Dentist check-up” on 2026-11-12 at Example Clinic.', 'imported from ~/Documents/example.ics'],
    ['timeline', 'Had “Book club” on 2026-10-03.', 'imported from ~/Documents/example.ics'],
    ['fact', 'Has 1 Firefox bookmark in “Travel”: Example maps (maps.example).', 'imported from Firefox bookmarks'],
  ]);
});

test('setup, end to end in the core: the ADR’s order, discovery and import on loopback, the populated first view with one action', async () => {
  const userHome = mkdtempSync(join(tmpdir(), 'nova-onboard-user-'));
  seedUserHome(userHome);
  const runtime = await fakeRuntime();
  const mdns = await fakeMdns();
  const transport = loopbackTransport({ ports: { 'model-runtime': runtime.port, screenpipe: await freePort(), 'home-assistant': await freePort() }, mdns: mdns.port });
  const h = await hub({ core: { onboarding: { os: 'macos', transport, userHome, platform: 'linux' } } });
  try {
    const say = async (text: string) => { const r = await h.c('POST', '/setup/messages', { text }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
    const v0 = (await h.c('GET', '/setup')).body;
    assert.equal(v0.step, 'device');
    assert.match(v0.question, /This is a macOS computer/);
    assert.deepEqual(v0.options.choices.map((c: { id: string; selected: boolean }) => [c.id, c.selected]), [['new', true], ['join', false]]);
    assert.match((await say('join')).reply, /Settings › Devices › Add a device/);
    const roles = await say('new');
    assert.equal(roles.view.step, 'roles');
    assert.equal(roles.view.options.kind, 'many');
    assert.deepEqual(roles.view.options.choices.find((c: { id: string }) => c.id === 'general-server'), { id: 'general-server', label: 'General server', note: 'Runs other services Nova manages.', selected: true, locked: true });
    const backend = await say('Compute, Storage, General server');
    assert.equal(backend.view.step, 'backend');
    assert.match(backend.reply, /This hub is for: compute, storage, general server/);
    assert.deepEqual((await h.c('GET', '/mesh/devices')).body.find((d: { role: string }) => d.role === 'hub').purposes, ['hub-candidate', 'compute', 'storage', 'general-server']);
    assert.deepEqual(backend.view.options.choices.map((c: { id: string; selected: boolean }) => [c.id, c.selected]), [['supervisor', true]], 'a Mac: K3s isn’t offered');
    assert.match(backend.view.question, /K3s isn’t offered on a Mac: it needs Linux/);
    assert.equal((await say('yes')).view.step, 'user_name');
    for (const t of ['Sam', 'yes', 'keep', 'plainly', 'keep everything on this machine']) await say(t);
    const asked = (await h.c('GET', '/setup')).body;
    assert.equal(asked.step, 'discover');
    assert.match(asked.question, /You chose local-only: looking on the network sends one short query/);
    // Under local-only, a network yes waits for the warning to be acknowledged (review finding 1).
    const warned = await say('this computer and the network too');
    assert.match(warned.reply, /beyond this machine[\s\S]*go ahead\?/);
    assert.equal(runtime.hits.length, 0, 'nothing looked at before the acknowledgement');
    const found = await say('yes');
    assert.match(found.reply, /On this computer I found Ollama 0\.35\.1[\s\S]*On your network: Home Assistant “Example Home”[\s\S]*None of it is connected/);
    assert.equal(found.view.step, 'import');
    assert.match(found.view.question, /notes in ~\/Notes \(2 files\)[\s\S]*Nothing has been read yet/);
    const imported = await say('notes and the calendar');
    assert.match(imported.reply, /notes in ~\/Notes: 2 waiting for your OK[\s\S]*It waits in Memory for your OK/);
    const done = await say('no');
    assert.equal(done.view.done, true);
    const first = done.view.first;
    assert.deepEqual(first.found.map((f: { kind: string }) => f.kind), ['model-runtime', 'home-assistant', 'computer']);
    assert.equal(first.waiting, 4);
    assert.equal(first.device.backend, 'supervisor');
    assert.equal(first.device.roles_words, 'Compute, Storage, General server');
    assert.equal(first.action.id, 'review-imports', 'one suggested action, and it is the one that fits');
    // Imported things wait for the person: none of it is memory yet.
    const c = (await h.c('GET', '/ingest/candidates')).body as { content: string; source: string }[];
    assert.equal(c.filter((x) => /imported from ~\/(Notes|Documents)/.test(x.source)).length, 4);
    assert.equal((await h.c('GET', `/memory/search?q=${NOTE_WORD}`)).body.records.length, 0);
    assert.equal(runtime.hits.length, 1, 'found, not connected: one GET, nothing after');
    assert.deepEqual((await h.c('GET', '/services/backend')).body.options.map((o: { id: string }) => o.id), ['supervisor']);
  } finally { await h.stop(); await runtime.close(); await mdns.close(); }
});

test('the closing rule: every first action is backed by regression tasks, and every onboarding claim is registered and backed or worded to its evidence', () => {
  const shown = evals.demonstrated(TASKS);
  for (const a of FIRST_ACTIONS) for (const tag of a.needs) assert.ok(shown.has(tag), `${a.id} needs ${tag}, which no regression task demonstrates`);
  const onboarding = CLAIMS.filter((c) => c.id.startsWith('onboard.'));
  assert.ok(onboarding.length >= 5);
  const ROOT = join(import.meta.dirname, '..', '..');
  for (const c of onboarding) {
    assert.ok(readFileSync(join(ROOT, c.where), 'utf8').replace(/\s+/g, ' ').includes(c.text), `${c.id}: its words are in ${c.where}`);
    if (c.needs.length) for (const t of c.needs) assert.ok(shown.has(t), `${c.id}: ${t} is demonstrated`);
    else assert.match(c.note ?? '', /tests\/|docs\/evidence\//, `${c.id}: an unbacked claim names the evidence it is worded to`);
  }
});

test('hostile mDNS replies: bounded work (answers per reply, instances per discovery), no prototype pollution, names within DNS’s limit (review finding 5)', async () => {
  const { decodeMessage, instances, MAX_ANSWERS, MAX_INSTANCES } = await import('../../src/core/onboard/mdns.ts');
  const SVC = '_home-assistant._tcp.local';
  // The reviewer's probe: replies packed with PTR answers for the asked-for service, every name compressed.
  const packed = (per: number, salt: number) => {
    const head = Buffer.alloc(12); head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(per, 6);
    const parts = [head];
    for (const l of SVC.split('.')) parts.push(Buffer.from([l.length]), Buffer.from(l));
    parts.push(Buffer.from([0, 0, 12, 0, 1]));
    for (let i = 0; i < per; i++) {
      const tag = (salt * 65536 + i).toString(36).padStart(4, '0').slice(-4);
      const rdata = Buffer.concat([Buffer.from([4]), Buffer.from(tag), Buffer.from([0xc0, 12])]);
      const meta = Buffer.alloc(10); meta.writeUInt16BE(12, 0); meta.writeUInt16BE(1, 2); meta.writeUInt32BE(120, 4); meta.writeUInt16BE(rdata.length, 8);
      parts.push(Buffer.from([0xc0, 12]), meta, rdata);
    }
    return Buffer.concat(parts);
  };
  const t0 = performance.now();
  const decoded = Array.from({ length: 16 }, (_, k) => decodeMessage(packed(3600, k)));
  assert.ok(decoded.every((m) => m.answers.length <= MAX_ANSWERS), 'answers per reply are capped');
  const list = instances(decoded, [SVC]);
  const ms = performance.now() - t0;
  assert.ok(list.length <= MAX_INSTANCES, `instances capped: ${list.length}`);
  assert.ok(ms < 1000, `16 hostile replies took ${ms.toFixed(0)} ms`);
  // TXT: a length past its data is refused; a __proto__ key pollutes nothing.
  const txtReply = (txt: Buffer) => {
    const meta = Buffer.alloc(10); meta.writeUInt16BE(16, 0); meta.writeUInt16BE(1, 2); meta.writeUInt16BE(txt.length, 8);
    const head = Buffer.alloc(12); head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(1, 6);
    return Buffer.concat([head, Buffer.from([0]), meta, txt]);
  };
  assert.throws(() => decodeMessage(txtReply(Buffer.concat([Buffer.from([20]), Buffer.from('__proto__=x')]))), /TXT/);
  const ok = decodeMessage(txtReply(Buffer.concat([Buffer.from([11]), Buffer.from('__proto__=x'), Buffer.from([5]), Buffer.from('a=b=c')]))).answers[0] as { txt: Record<string, string> };
  assert.equal(Object.getPrototypeOf(ok.txt), null);
  assert.equal(({} as Record<string, unknown>).x, undefined);
  assert.equal(ok.txt.a, 'b=c');
  // A name longer than DNS allows (255 bytes) is refused; so is a question cut short.
  const parts: Buffer[] = [Buffer.alloc(12)]; parts[0]!.writeUInt16BE(1, 4);
  for (let i = 0; i < 70; i++) parts.push(Buffer.from([63]), Buffer.alloc(63, 0x61));
  parts.push(Buffer.from([0, 0, 12, 0, 1]));
  assert.throws(() => decodeMessage(Buffer.concat(parts)), /too long/);
  const q = encodeMdnsQuery([SVC]);
  assert.throws(() => decodeMessage(q.subarray(0, q.length - 3)), /question runs past the end/);
});
