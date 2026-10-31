// M10f in a real browser (docs/plans/M10f.md, Gate 1, 3, 4, 6, 7, 8, 9):
//  - setup on stand-in Linux, macOS, Windows and WSL2 detections, each with its own backend summary;
//    the supervisor pre-selected; K3s shown on Linux as not available yet, and not offered elsewhere;
//  - on Linux, the whole path by clicking (discovery against stand-ins on 127.0.0.1, the import, the
//    first view with its one action) and the first win in Memory, timed;
//  - pairing with roles: the hub's approval sheet shows what a computer asked to be for, the person
//    changes it there, and a hub candidacy is confirmed on its own;
//  - Settings › Devices changes roles through a tiered review; Settings › Services says how services
//    run here.
// Real servers on blank homes; the computer that joins is a stand-in speaking the protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { Joiner } from '../core/mesh-support.ts';
import { fakeMdns, fakeRuntime, freePort } from '../support/fake-mdns.ts';
import { NOTE_WORD, seedUserHome } from '../support/onboard-home.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

const meshPort = () => new Promise<number>((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); }); });
const shotDir = () => { const d = shotsDir(); const out = d ? join(dirname(d), 'm10f') : null; if (out) mkdirSync(out, { recursive: true }); return out; };

// Waits for Nova's reply to land: the transcript grows by two bubbles.
async function says(page: Page, act: () => Promise<void>) {
  const before = await page.locator('#setup-log .chat-bubble').count();
  await act();
  await page.waitForFunction((n) => document.querySelectorAll('#setup-log .chat-bubble').length >= n + 2, before, { timeout: 15000 });
}
const typed = (page: Page, text: string) => says(page, async () => { await page.fill('#setup-input', text); await page.keyboard.press('Enter'); });
const lastNova = (page: Page) => page.locator('#setup-log .chat-bubble').last().textContent();

const OS_CASES = [
  { os: 'linux', words: /This is a Linux computer/, summary: /Recommended: ordinary programs, under nova’s supervisor[\s\S]*K3s, for container services, isn’t available in this version yet/i, k3s: 'shown, not available' },
  { os: 'macos', words: /This is a macOS computer/, summary: /K3s isn’t offered on a Mac: it needs Linux/, k3s: 'absent' },
  { os: 'windows', words: /This is a Windows computer/, summary: /K3s isn’t offered on Windows: it needs Linux/, k3s: 'absent' },
  { os: 'wsl2', words: /This is a Linux inside Windows \(WSL2\) computer/, summary: /WSL2\), which counts as Windows here/, k3s: 'absent' },
] as const;

for (const c of OS_CASES) {
  test(`M10f: setup on a stand-in ${c.os} detection says its own backend summary, the supervisor pre-selected`, async (t) => {
    const b = await browser();
    if (typeof b === 'string') return t.skip(b);
    const m = blank(`nova-ui-m10f-${c.os}-`);
    const nova = await m.start({ NOVA_DETECT_OS: c.os });
    const shots = shotDir();
    try {
      const { page, errors } = await device(b, { width: 1280, height: 900 });
      await page.goto(`${m.base}/`);
      await ready(page);
      await page.locator('#setup').waitFor({ state: 'visible' });
      assert.match((await lastNova(page)) ?? '', c.words);
      // Create a network here: the recommended choice is the standout.
      const pick = page.locator('#setup [data-action="setup-pick"]');
      assert.match((await pick.first().getAttribute('class')) ?? '', /primary/);
      await says(page, () => pick.first().click());
      // The hub's roles: general server always, ticked and fixed.
      const general = page.locator('#setup input[name="setup-choice"][value="General server"]');
      assert.equal(await general.isChecked(), true);
      assert.equal(await general.isDisabled(), true);
      await says(page, () => page.locator('#setup [data-action="setup-many"]').click());
      // The backend step: this OS's summary, the supervisor the one choice that can be pressed.
      assert.match((await lastNova(page)) ?? '', c.summary);
      assert.match((await lastNova(page)) ?? '', /Settings › Services/);
      const buttons = await page.locator('#setup [data-action="setup-pick"]').allTextContents();
      assert.deepEqual(buttons, ['Ordinary programs, under Nova’s supervisor']);
      assert.match((await page.locator('#setup [data-action="setup-pick"]').getAttribute('class')) ?? '', /primary/, 'pre-selected');
      const off = page.locator('#setup .setup-choice-off');
      if (c.k3s === 'absent') assert.equal(await off.count(), 0, 'K3s isn’t offered off Linux');
      else assert.match((await off.textContent()) ?? '', /K3s[\s\S]*Not available yet/, 'on Linux, K3s is shown as not available yet, and can’t be pressed');
      if (shots) await shoot(page, join(shots, `setup-backend-${c.os}.png`));
      await says(page, () => page.locator('#setup [data-action="setup-pick"]').click());
      assert.match((await lastNova(page)) ?? '', /Ordinary programs it is[\s\S]*What should I call you\?/);
      assert.deepEqual(errors, []);
    } finally { await stop(nova); }
  });
}

test('M10f: the whole first session on Linux by clicking, ending on the first view and the first win in Memory, timed', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-m10f-path-');
  seedUserHome(m.env.HOME);
  const runtime = await fakeRuntime();
  const mdns = await fakeMdns();
  const nova = await m.start({ NOVA_DETECT_OS: 'linux', NOVA_DISCOVERY_PORTS: `model-runtime=${runtime.port},screenpipe=${await freePort()},home-assistant=${await freePort()}`, NOVA_DISCOVERY_MDNS: `127.0.0.1:${mdns.port}` });
  const shots = shotDir();
  try {
    const { page, errors } = await device(b, { width: 390, height: 844, touch: true });
    const t0 = Date.now();
    const path: string[] = [];
    const mark = (s: string) => path.push(`${Date.now() - t0} ms · ${s}`);
    await page.goto(`${m.base}/`);
    await ready(page);
    await page.locator('#setup').waitFor({ state: 'visible' });
    mark('setup open');
    const click = async (sel: string, what: string) => { await says(page, () => page.locator(sel).first().click()); mark(what); };
    await click('#setup [data-action="setup-pick"]', 'new network');
    await click('#setup [data-action="setup-many"]', 'roles: the recommendation');
    await click('#setup [data-action="setup-pick"]', 'backend: ordinary programs');
    for (const text of ['Alex', 'yes', 'keep', 'plainly', 'keep everything on this machine']) { await typed(page, text); mark(`typed “${text}”`); }
    assert.match((await lastNova(page)) ?? '', /You chose local-only: looking on the network sends one short query/);
    await click('#setup [data-action="setup-pick"][data-label="The network too"]', 'look: the network too');
    // Local-only: the warning is acknowledged before anything is sent onto the network.
    assert.match((await lastNova(page)) ?? '', /beyond this machine[\s\S]*go ahead\?/);
    assert.equal(runtime.hits.length, 0);
    await click('#setup [data-action="setup-pick"][data-label="Yes, look on the network"]', 'acknowledged the warning');
    assert.match((await lastNova(page)) ?? '', /On this computer I found Ollama 0\.35\.1[\s\S]*None of it is connected/);
    // The import: every source found, ticked; Continue brings them in.
    assert.equal(await page.locator('#setup input[name="setup-choice"]').count(), 3);
    await click('#setup [data-action="setup-many"]', 'import: all three');
    await typed(page, 'no');
    mark('no first task');
    // The first view: found (not connected), brought in, this computer, and one standout.
    const first = page.locator('#setup .setup-first');
    await first.waitFor();
    const text = (await first.textContent()) ?? '';
    assert.match(text, /This computer[\s\S]*It is your hub, for general server/);
    assert.match(text, /Ollama 0\.35\.1[\s\S]*found, not connected/);
    assert.match(text, /Home Assistant “Example Home”/);
    assert.match(text, /notes in ~\/Notes: 2 waiting for your OK/);
    assert.equal(await page.locator('#setup .btn.primary').count(), 1, 'exactly one standout at the end');
    assert.equal(await page.locator('#setup .btn.primary').textContent(), 'Review what Nova brought in');
    if (shots) await shoot(page, join(shots, 'first-view-phone.png'));
    await page.locator('#setup [data-action="setup-first"]').click();
    mark('followed the suggested action');
    // Memory: the imported note waits; keeping it makes it Nova's.
    const waiting = page.locator('#waiting .memory-list li', { hasText: NOTE_WORD });
    await waiting.waitFor({ timeout: 10000 });
    await waiting.locator('button', { hasText: /keep/i }).click();
    await page.waitForFunction((w) => !document.querySelector('#waiting') || !document.querySelector('#waiting')!.textContent!.includes(w), NOTE_WORD, { timeout: 10000 });
    mark('kept the note');
    const found = await m.get(`/api/v1/memory/search?q=${NOTE_WORD}`);
    assert.equal(found.records.length, 1);
    const ms = Date.now() - t0;
    mark('Nova finds it');
    assert.ok(ms < 15 * 60_000, `${ms} ms`);
    console.log(`browser first win: ${ms} ms\n  ${path.join('\n  ')}`);
    if (shots) writeFileSync(join(shots, 'first-win-browser.txt'), `${ms} ms\n${path.join('\n')}\n`);
    assert.deepEqual(errors, []);
  } finally { await stop(nova); await runtime.close(); await mdns.close(); }
});

test('M10f: pairing with roles on the hub’s approval sheet, a candidacy confirmed on its own; roles changed in Settings › Devices at their tiers; Settings › Services', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-m10f-roles-');
  const mesh = `http://127.0.0.1:${await meshPort()}`;
  const nova = await m.start({ NOVA_MESH_URL: mesh, NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: mesh });
  const shots = shotDir();
  try {
    await finishSetup(m);
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${m.base}/settings#devices`);
    await ready(page);
    await page.locator('#devices .device-row[data-device]').first().waitFor();
    assert.match((await page.locator('#devices').textContent()) ?? '', /Roles: Hub candidate, General server/);

    // A computer asks to join, for compute and storage.
    const code = (await m.send('POST', '/api/v1/mesh/pairings')).body.code;
    const now = () => Math.floor(Date.now() / 1000);
    const pc = new Joiner(mesh, now, { name: 'Desk box', kind: 'computer', platform: 'linux x64', capabilities: [], purposes: ['compute', 'storage'] });
    assert.equal((await pc.join(code)).status, 201);
    assert.equal((await pc.reveal()).status, 200);
    const sheet = page.locator('#sheet .approval-sheet[data-request]');
    await sheet.waitFor({ timeout: 10000 });
    assert.equal(await sheet.locator('input[name="purpose"][value="compute"]').isChecked(), true);
    assert.equal(await sheet.locator('input[name="purpose"][value="storage"]').isChecked(), true);
    // The person changes it here: not storage; and a hub candidate, which needs its own box.
    await sheet.locator('input[name="purpose"][value="storage"]').uncheck();
    await sheet.locator('input[name="purpose"][value="hub-candidate"]').check();
    await sheet.locator('input[name="confirm"]').check();
    if (shots) await shoot(page, join(shots, 'approval-roles.png'));
    await sheet.locator('[data-action="approve"]').click();
    await page.locator('#toast', { hasText: /confirmed on its own/ }).waitFor();
    assert.equal(await sheet.isVisible(), true, 'not approved without the candidacy box');
    await sheet.locator('input[name="confirm_candidate"]').check();
    await sheet.locator('[data-action="approve"]').click();
    await sheet.waitFor({ state: 'hidden' });
    const desk = () => m.get('/api/v1/mesh/devices').then((ds: { name: string; id: string; purposes: string[] }[]) => ds.find((d) => d.name === 'Desk box')!);
    assert.deepEqual((await desk()).purposes, ['hub-candidate', 'compute']);
    assert.deepEqual((await m.get('/api/v1/mesh/roster')).roster.candidates.map((c: { id: string }) => c.id), [(await desk()).id], 'its key is pinned in the next roster');

    // Settings › Devices: widen (tier 3) then narrow (tier 2).
    const row = page.locator(`#devices .device-row[data-device="${(await desk()).id}"]`);
    await row.waitFor();
    await page.waitForFunction(() => /Roles: Hub candidate, Compute/.test(document.querySelector('#devices')?.textContent ?? ''));
    await row.locator('[data-action="edit-roles"]').click();
    const edit = page.locator('#sheet .roles-sheet');
    await edit.locator('input[value="general-server"]').check();
    await edit.locator('button[type="submit"]').click();
    const review = page.locator('#sheet .approval-sheet[data-roles-confirm]');
    await review.waitFor();
    assert.equal(await review.getAttribute('data-tier'), '3');
    assert.equal(await review.locator('[data-action="approve"]').isDisabled(), true, 'widening waits for the box');
    await review.locator('input[name="confirm"]').check();
    await review.locator('[data-action="approve"]').click();
    await review.waitFor({ state: 'hidden' });
    assert.deepEqual((await desk()).purposes, ['hub-candidate', 'compute', 'general-server']);
    await page.waitForFunction(() => /General server/.test(document.querySelector('#devices')?.textContent ?? ''));
    await row.locator('[data-action="edit-roles"]').click();
    await page.locator('#sheet .roles-sheet input[value="hub-candidate"]').uncheck();
    await page.locator('#sheet .roles-sheet button[type="submit"]').click();
    const narrow = page.locator('#sheet .approval-sheet[data-roles-confirm]');
    await narrow.waitFor();
    assert.equal(await narrow.getAttribute('data-tier'), '2');
    assert.match((await narrow.textContent()) ?? '', /nothing stops/);
    if (shots) await shoot(page, join(shots, 'roles-narrow.png'));
    await narrow.locator('[data-action="approve"]').click();
    await narrow.waitFor({ state: 'hidden' });
    assert.deepEqual((await desk()).purposes, ['compute', 'general-server']);
    assert.equal((await m.get('/api/v1/mesh/roster')).roster.candidates, undefined, 'unpinned in the next roster');

    // Settings › Services.
    await page.goto(`${m.base}/settings#services`);
    const services = page.locator('#services');
    await services.locator('#services-backend').waitFor();
    assert.match((await services.textContent()) ?? '', /In use: ordinary programs[\s\S]*Switching to K3s isn’t available yet/);
    assert.equal(await services.locator('button').count(), 0, 'nothing to press: there is nothing to switch to yet');
    if (shots) await shoot(page, join(shots, 'settings-services.png'));
    assert.deepEqual(errors, []);
  } finally { await stop(nova); }
});
