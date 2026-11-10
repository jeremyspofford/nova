// The per-device Models screen in the app (model-fit step 3), built from the approved styleguide
// composition (models-screen, PR #326): Settings › Devices › [device] › Models against the real server,
// the stand-in Ollama and fixed hardware readings. The quant and context controls recompute with the
// fit engine; an over-budget plan says so and can't be installed; a device that is asleep shows what
// it last reported, stamped with its age; Install and assign asks first, then goes through the models
// subsystem's own routes (POST /models/install, the tier-2 OK each download waits for); Settings ›
// Models shows every device and where each task runs; picks put privacy first. The device-setup hook
// shows the same component. Every size of the owner's matrix, in Chromium and WebKit: no horizontal
// scroll, 44 px targets, labelled controls, axe. No real model, Ollama or network is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Locator, Page } from 'playwright-core';
import { browser, webkitBrowser, device, ready, still, ROOT, shortTargets } from './support.ts';
import { enrollPasskeys } from '../acceptance/passkey-support.ts';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { ensureMark } from '../../src/core/resilience/home-mark.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { generateDeviceKeys } from '../../src/core/index.ts';
import { INSTALLED, hubHardware } from '../support/models.ts';

const GiB = 1024 ** 3;
const MATRIX = {
  'desktop-1920': { width: 1920, height: 1080 }, 'desktop-1440': { width: 1440, height: 900 }, 'desktop-1280': { width: 1280, height: 800 },
  'tablet-portrait': { width: 820, height: 1180 }, 'tablet-landscape': { width: 1180, height: 820 },
  'phone': { width: 390, height: 844 }, 'phone-large': { width: 430, height: 932 }, 'pixel': { width: 412, height: 915 },
  'fold-cover': { width: 344, height: 882 }, 'fold-open': { width: 884, height: 1104 }, 'fold-half-open': { width: 884, height: 540 },
  'pixel-fold-open': { width: 840, height: 701 }, 'duo-open': { width: 720, height: 540 },
};
// The design folder's sizes, per engine (docs/screenshots/models-screen-2026-11-04/README.md).
const SHOT_SIZES = { chromium: ['desktop-1440', 'tablet-portrait', 'phone', 'fold-cover', 'fold-half-open', 'duo-open'], webkit: ['desktop-1440', 'phone', 'fold-cover'] };
const CONTEXTS = [2048, 4096, 8192, 16384, 32768];

const gpu = (name: string, gb: number, used = 0) => ({ vendor: 'nvidia', name, vram_bytes: gb * GiB, vram_free_bytes: Math.round((gb - used) * GiB), unified: false });
const HW = {
  gpu24: hubHardware({ gpus: [gpu('Example GPU 24GB', 24, 0.45)], ram_bytes: 64 * GiB }),
  // The same card with a little more in use by other programs: a reading that changes the screen.
  gpu24busy: hubHardware({ gpus: [gpu('Example GPU 24GB', 24, 0.6)], ram_bytes: 64 * GiB }),
  gpu8: hubHardware({ gpus: [gpu('Example GPU 8GB', 8)], ram_bytes: 32 * GiB }),
  gpu12: hubHardware({ gpus: [gpu('Example GPU 12GB', 12, 0.3)], ram_bytes: 32 * GiB }),
  mac16: hubHardware({ platform: 'darwin', arch: 'arm64', gpus: [{ vendor: 'apple', name: 'Example Apple GPU', vram_bytes: 12 * GiB, vram_free_bytes: null, unified: true }], ram_bytes: 16 * GiB }),
  cpu32: hubHardware({ gpus: [], ram_bytes: 32 * GiB }),
  // A Mac whose GPU memory limit was raised to 56 GB (the 3/4 estimate would be 48 GB).
  mac64set: hubHardware({ platform: 'darwin', arch: 'arm64', gpus: [{ vendor: 'apple', name: 'Example Apple GPU', vram_bytes: 48 * GiB, vram_free_bytes: null, unified: true }], ram_bytes: 64 * GiB, gpu_wired_limit_bytes: 56 * GiB }),
};
type Plan = [string, string, number][];
// The design's states, on the app: the hub's hardware, its privacy, and the plan the person makes.
const STATES: Record<string, { hw: keyof typeof HW; privacy?: string; plan: Plan }> = {
  '3090-one-model': { hw: 'gpu24', plan: [['qwen3:14b', 'Q8_0', 16384]] },
  '3090-two-models': { hw: 'gpu24', plan: [['qwen3:32b', 'Q4_K_M', 4096], ['nomic-embed-text', 'F16', 2048]] },
  '8gb-nothing-at-16k': { hw: 'gpu8', plan: [['qwen3:8b', 'Q4_K_M', 16384]] },
  'mac-16gb-unified': { hw: 'mac16', privacy: 'local-preferred', plan: [['qwen3:8b', 'Q4_K_M', 16384]] },
  'unknown-shape': { hw: 'gpu12', plan: [['example-mid:8b', 'Q4_K_M', 8192]] },
  'no-gpu': { hw: 'cpu32', plan: [['qwen3:4b', 'Q4_K_M', 4096]] },
  // 2026-11-06: a tight plan, with the acknowledgement Install waits for.
  'tight-ack': { hw: 'gpu24', plan: [['qwen3:32b', 'Q4_K_M', 4096]] },
};
const LIBRARY = {
  'qwen3:8b': { size: 5.2e9, layers: 3, parameter_size: '8.2B', capabilities: ['completion'] },
  'qwen3:32b': { size: 20.2e9, layers: 3, parameter_size: '32.8B', capabilities: ['completion'] },
};
const ACK = 'I understand this model leaves little memory headroom, so replies may slow down sharply or fail under load.';

async function fixture(run: (o: { base: string; nova: ReturnType<typeof createNova>; setHw: (k: keyof typeof HW) => Promise<void>; ollama: Awaited<ReturnType<typeof startFakeOllama>>; spoke: Awaited<ReturnType<typeof startFakeOllama>> }) => Promise<void>, { finish = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nova-models-app-'));
  chmodSync(dir, 0o700);
  const ollama = await startFakeOllama({ models: INSTALLED, library: LIBRARY, pullDelayMs: 30 });
  const spoke = await startFakeOllama({ models: [{ name: 'example-small:3b', size: 2.0e9, parameter_size: '3.2B', capabilities: ['completion'] }] });
  let hw = HW.gpu24;
  let nova: ReturnType<typeof createNova> | undefined;
  try {
    const home = join(dir, 'nova');
    const user = join(dir, 'user');
    mkdirSync(user, { mode: 0o700 });
    ensureMark(home, { userHome: user });
    nova = createNova(loadConfig({ HOME: user, NOVA_HOME: home, NOVA_HOST: '127.0.0.1', NOVA_PORT: '0', NOVA_VAULT_KEY: 'file', NOVA_AGENT_CMD: '/bin/false', NOVA_AGENT_EGRESS: 'none', TZ: 'UTC' }), { models: { ollamaUrl: ollama.url, hardware: async () => hw as never, watchMs: 200 } });
    const server = nova.server;
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const plain = async (method: string, p: string, body?: unknown, headers: Record<string, string> = { 'x-nova': '1' }) => {
      const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const answers = ['new', 'yes', 'yes', 'Hi, I am Alex.', 'yes', 'keep', 'plainly', 'keep everything on this machine', 'no', 'no'];
    for (const text of finish ? answers : answers.slice(0, -1)) assert.equal((await plain('POST', '/api/v1/setup/messages', { text })).status, 200);
    if (finish) await enrollPasskeys(plain, base);
    const setHw = async (k: keyof typeof HW) => { hw = HW[k]; await nova!.core.models.hubHardware(true); };
    await run({ base, nova, setHw, ollama, spoke });
  } finally {
    if (nova) {
      nova.scheduler.stop();
      nova.server.closeAllConnections();
      if (nova.server.listening) await new Promise<void>((done) => nova!.server.close(() => done()));
      await nova.core.close();
    }
    await ollama.close();
    await spoke.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A paired computer with the compute role whose runtime Nova has read once, then went to sleep three
// hours ago: its hardware and model list are what it last reported.
async function sleepingSpoke(nova: ReturnType<typeof createNova>, spoke: { url: string }) {
  const core = nova.core;
  const keys = generateDeviceKeys();
  const d = core.mesh.devices.add({ name: 'Example den PC', platform: 'linux x64', kind: 'computer', purposes: ['compute'], public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat', 'queue'] }, 'test');
  core.mesh.spokes.heartbeat(d, { hardware: hubHardware({ hostname: 'example-den', gpus: [gpu('Example GPU 8GB', 8)], network: [{ name: 'eth0', mac: '02:00:00:00:00:42', address: '127.0.0.1', netmask: '255.0.0.0' }] }) });
  core.profile.set('models', `runtime.${d.id}`, spoke.url, 'settings');
  await core.models.inventory(d.id);
  await fetch(`${spoke.url}/__stand-in/asleep`, { method: 'POST', body: JSON.stringify({ asleep: true }) });
  const then = new Date(Date.now() - 3 * 3600_000).toISOString();
  core.db.run('UPDATE device SET last_seen = ? WHERE id = ?', then, d.id);
  core.db.run('UPDATE device_hardware SET updated_at = ? WHERE device_id = ?', then, d.id);
  core.db.run('UPDATE model_version SET last_seen = ? WHERE device_id = ?', then, d.id);
  return d;
}

const screen = (page: Page) => page.locator('#settings-devices [data-device-models]');

async function openHub(page: Page, base: string) {
  await page.goto(`${base}/settings#models-on-hub`);
  await ready(page);
  await screen(page).waitFor();
}

// The person's plan, made with the screen's own controls.
async function setPlan(root: Locator, plan: Plan) {
  while (await root.locator('[data-action="models-remove"]').count()) {
    const n = await root.locator('[data-action="models-remove"]').count();
    await root.locator('[data-action="models-remove"]').first().click();
    await root.page().waitForFunction((k) => document.querySelectorAll('#settings-devices [data-action="models-remove"]').length < k, n);
  }
  for (const [i, [name, quant, context]] of plan.entries()) {
    await root.locator('select[id$="-add"]').selectOption(name);
    await root.locator('[data-action="models-add"]').click();
    await root.locator(`[data-models-quant="${i}"]`).waitFor();
    await root.locator(`[data-models-quant="${i}"]`).selectOption(quant);
    const range = root.locator(`[data-models-context="${i}"]`);
    if (await range.count()) await range.fill(String(CONTEXTS.indexOf(context)));
  }
}

async function geometry(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `${label}: no horizontal scroll`);
  // Each check queries the live page and measures in the same task (page.evaluate). A locator's
  // evaluate or evaluateAll first finds its elements, then runs the function in a second step; a
  // redraw in between (the styleguide's whole page when the appearance arrives, a device's screen when
  // its models refresh) hands the function nodes no longer in the page: no size and no labels.
  const root = '#settings-devices';
  assert.deepEqual(await page.evaluate((sel) => [...document.querySelector(sel)!.querySelectorAll<HTMLElement>('button, label, p, h3, h4, h5, .fit-verdict, .fit-what, .fit-gb, .dm-out, .settings-label')].filter((el) => el.clientWidth && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent), root), [], `${label}: clipped text`);
  assert.deepEqual(await page.evaluate((sel) => { const r = document.querySelector(sel)!; const box = r.querySelector('[data-device-models]')!.getBoundingClientRect(); return [...r.querySelectorAll<HTMLElement>('[data-device-models] *')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > box.right + 1 || b.left < box.left - 1); }).map((el) => el.className || el.tagName); }, root), [], `${label}: nothing spills out of the panel`);
  assert.deepEqual(await shortTargets(page, `${root} :is(button, select, input)`, { visible: true }), [], `${label}: 44px targets`);
  assert.deepEqual(await page.evaluate((sel) => [...document.querySelectorAll<HTMLInputElement>(`${sel} select, ${sel} input`)].filter((e) => !e.labels?.length).map((e) => e.outerHTML.slice(0, 80)), root), [], `${label}: every control is labelled`);
}

// The whole screen for the owner's comparison, after every check at the real size: the app scrolls
// inside its own column, so for the picture only, that column and its frame are let grow to their
// content and the fixed chrome (tab bar, header) is hidden; then the page is captured around the frame.
async function capture(page: Page, path: string) {
  await page.evaluate(() => {
    const frame = document.querySelector('#settings-devices .dm-screen')!;
    for (let n: HTMLElement | null = frame.parentElement; n; n = n.parentElement) {
      n.style.setProperty('overflow', 'visible', 'important');
      n.style.setProperty('height', 'auto', 'important');
      n.style.setProperty('max-height', 'none', 'important');
    }
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (!el.contains(frame) && !frame.contains(el) && ['fixed', 'sticky'].includes(getComputedStyle(el).position)) el.style.setProperty('visibility', 'hidden', 'important');
    }
  });
  await still(page);
  const r = await page.evaluate(() => { const b = document.querySelector('#settings-devices .dm-screen')!.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height, vw: document.documentElement.clientWidth }; });
  const x = Math.max(0, r.x - 16), y = Math.max(0, r.y - 16);
  await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide', clip: { x, y, width: Math.min(r.vw - x, r.w + 32), height: r.h + 32 } });
}

async function axe(page: Page, label: string) {
  await still(page);
  if (!await page.evaluate(() => 'axe' in window)) await page.evaluate(readFileSync(join(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8'));
  const r = await page.evaluate(async () => (window as any).axe.run(document.querySelector('#settings-devices')));
  assert.deepEqual(r.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), [], `${label}: axe`);
}

test('Models screen (app): live recompute, an over-budget warning, a sleeping device’s age, Install and assign with its OK, the overview, privacy first', { timeout: 300_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  try {
    await fixture(async ({ base, nova, setHw, ollama, spoke }) => {
      const { page, errors } = await device(b, { width: 1280, height: 900 });
      const changes: string[] = [];
      page.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) changes.push(`${r.method()} ${new URL(r.url()).pathname}`); });

      // The bar has a text equivalent; verdicts are words, not colour alone; every verdict names its quant and context.
      await setHw('gpu8');
      await openHub(page, base);
      const root = screen(page);
      await setPlan(root, [['qwen3:8b', 'Q4_K_M', 16384]]);
      await root.locator('.dm-model .fit-verdict[data-verdict="wont-fit"]').waitFor();
      const bar = root.locator('.fit-bar[role="img"]');
      assert.match(await page.locator(`#${await bar.getAttribute('aria-labelledby')}`).innerText(), /\d+\.\d GB needed, \d+\.\d GB more than the 8\.0 GB budget\./, 'the over-budget total is said in words');
      assert.equal(await root.locator('.fit-limit').count(), 1, 'the budget’s end is marked');
      assert.match(await root.locator('.fit-legend-row.is-over').innerText(), /Over budget/);
      assert.match(await root.locator('.dm-model .dm-words').innerText(), /Won’t fit at Q4_K_M with 16k context\. At Q4_K_M it fits up to 6k\./);
      assert.equal(await root.locator('[data-action="models-install"]').isDisabled(), true, 'a plan that won’t fit can’t be installed');
      assert.match(await root.locator('.dm-model .fit-verdict').innerText(), /Won’t fit/);

      // Live recompute: the context comes down to 4k and it fits; Q8_0 doesn't. Focus stays on the control.
      await root.locator('[data-models-context="0"]').fill('1');
      await root.locator('.dm-model .fit-verdict[data-verdict="fits"]').waitFor();
      assert.match(await root.locator('.dm-model .dm-words').innerText(), /Fits comfortably at Q4_K_M with 4k context\./);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-models-context')), '0', 'focus stays on the slider');
      await root.locator('[data-models-quant="0"]').selectOption('Q8_0');
      await root.locator('.dm-model .fit-verdict[data-verdict="wont-fit"]').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-models-quant')), '0', 'focus stays on the quant');
      // Keyboard: the slider moves with the arrow keys and recomputes.
      await root.locator('[data-models-quant="0"]').selectOption('Q4_K_M');
      await root.locator('[data-models-context="0"]').focus();
      await page.keyboard.press('ArrowRight');
      await root.locator('.dm-model .dm-out', { hasText: '8k' }).waitFor();
      assert.equal(changes.length, 0, 'planning sends nothing');

      // Install and assign: it asks first, says what downloads where and what it serves; Not now sends nothing.
      await setHw('gpu24');
      await openHub(page, base);
      await setPlan(screen(page), [['qwen3:8b', 'Q4_K_M', 4096]]);
      await screen(page).locator('[data-action="models-install"]').click();
      const ask = screen(page).locator('[data-models-confirm]');
      await ask.waitFor();
      assert.match(await ask.innerText(), /qwen3:8b at Q4_K_M, about 4\.8 GB, downloads to .+, then serves thinking and writing\./);
      assert.match(await ask.innerText(), /nothing of yours is sent/);
      assert.doesNotMatch(await screen(page).innerText(), /ollama (pull|run|rm|serve)|\$ /i, 'no Ollama commands are shown');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-action')), 'models-confirm', 'focus moves to the OK');
      assert.equal(await screen(page).locator('.btn.primary').count(), 1, 'one standout');
      await screen(page).locator('[data-action="models-not-now"]').click();
      await screen(page).locator('[data-action="models-install"]').waitFor();
      assert.equal(changes.length, 0, 'Not now sends nothing');
      await screen(page).locator('[data-action="models-install"]').click();
      await screen(page).locator('[data-action="models-confirm"]').click();
      await page.waitForFunction(() => /qwen3:8b is downloaded and checked, and serves thinking and writing/.test(document.querySelector('#settings-devices')?.textContent ?? ''), null, { timeout: 30_000 });
      assert.deepEqual(changes.filter((c) => !c.startsWith('POST /api/v1/tasks/') || !c.endsWith('/approve')), ['POST /api/v1/models/install'], 'through the models subsystem only');
      assert.equal(changes.filter((c) => /\/approve$/.test(c)).length, 1, 'the OK each download waits for, given once');
      assert.ok(ollama.installed().includes('qwen3:8b'));
      await page.waitForFunction(() => true);
      const placed = await (async () => { for (let i = 0; i < 200; i++) { const p = nova.core.models.placement('reasoner'); if (p) return p; await new Promise((r) => setTimeout(r, 25)); } return null; })();
      assert.equal(placed?.model, 'qwen3:8b');
      assert.equal(placed?.context, 4096, 'the role runs at the context planned');
      const task = nova.core.ledger.list({ limit: 20 }).find((x) => x.title === 'Download qwen3:8b')!;
      assert.equal(task.approval_tier, 2, 'the same tier every model download has');

      // The overview: every device, and where each task runs.
      const d = await sleepingSpoke(nova, spoke);
      // A fresh page. From #models-on-hub, going to #models only changes the fragment, so goto alone
      // keeps this page and the overview it drew before the spoke joined until a refresh lands.
      await page.goto(`${base}/settings#models`);
      await page.reload();
      await ready(page);
      const models = page.locator('#models');
      await models.locator('.dm-routes').waitFor();
      assert.equal(await models.locator('.dm-route').count(), 6, 'each task class');
      // Chat on the chat command goes where that program sends it, not to the reasoner (F-025).
      assert.match(await models.locator('.dm-route').first().innerText(), /General chat[\s\S]*Chat (uses|goes to) /);
      assert.match(await models.locator('.dm-route').nth(1).innerText(), /Coding[\s\S]*goes where thinking and writing does/);
      assert.match(await models.innerText(), /Local only: every task stays on your devices/);
      assert.equal(await models.locator('.model-device').count(), 2, 'every device');
      assert.match(await models.locator(`.model-device[data-device="${d.id}"]`).innerText(), /Asleep or away[\s\S]*Last seen 3 h ago/);

      // A sleeping device, from the overview: what it last reported, stamped with its age.
      await models.locator(`.model-device[data-device="${d.id}"] [data-action="device-models"]`).click();
      const den = page.locator(`#models-on-${d.id} [data-device-models]`);
      await den.waitFor();
      // Its wake state (the WoL ADR's styleguide states, from the hub): asleep, and why Nova doesn't wake it.
      const status = den.locator('[data-wake="asleep"]');
      assert.match(await status.innerText(), /Asleep or away\s+Last seen 3 h ago\. What shows here is what it last reported: its hardware 3 h ago, its models just now\./, 'Nova read its model list during this test; its hardware reading is three hours old');
      assert.match(await status.innerText(), /Nova doesn’t wake Example den PC: you chose to wait until it’s turned on/);
      // Sleep and wake, the screen's last section: each choice goes to the hub as the person makes it.
      const sleep = den.locator('.dm-sleep');
      assert.equal(await den.locator('section').last().getAttribute('class'), 'dm-sleep');
      await sleep.locator('[data-models-sleep="demand"]').selectOption('wake');
      await page.waitForFunction((id) => !/you chose to wait/.test(document.querySelector(`#models-on-${id} [data-wake]`)?.textContent ?? 'you chose to wait'), d.id);
      assert.equal(nova.core.models.power(d.id).on_demand, true);
      // Its only card is loopback, so Nova still can't wake it, and says so.
      assert.match(await den.locator('[data-wake]').innerText(), /None of Example den PC’s network cards is on a private network Nova can send a wake signal on/);
      await den.locator('[data-models-sleep="idle"]').selectOption('30');
      for (let i = 0; i < 50 && nova.core.models.power(d.id).sleep_after_min !== 30; i++) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(nova.core.models.power(d.id), { on_demand: true, sleep_after_min: 30 });
      assert.match(await den.locator('.dm-sleep').innerText(), /Its device agent can’t put it to sleep yet; the OS’s own power settings decide/);
      assert.match(await den.locator('.dm-device').innerText(), /Example GPU 8GB · 8\.0 GB video memory/);
      assert.ok((await den.locator('select[id$="-add"] option').allTextContents()).includes('example-small:3b'), 'its last-seen models are there to plan with');
      assert.equal(new URL(page.url()).hash, `#models-on-${d.id}`);
      await page.locator('[data-action="dm-back"]').click();
      await page.locator('#settings-devices #devices').waitFor();

      // Privacy first: local-only names no cloud option; local first lists it after every local pick.
      await openHub(page, base);
      assert.equal(await screen(page).locator('[data-cloud]').count(), 0);
      assert.doesNotMatch(await screen(page).innerText(), /cloud model|off your devices/i);
      nova.core.profile.set('privacy', 'default', 'local-preferred', 'settings');
      nova.core.models.setCloud({ name: 'Example cloud', base_url: 'http://127.0.0.1:9/v1', model: 'example' }, true);
      await openHub(page, base);
      await screen(page).locator('[data-cloud]').waitFor();
      const order = await screen(page).evaluate((r) => [...r.querySelectorAll('.dm-pick, [data-cloud]')].map((e) => (e.matches('[data-cloud]') ? 'cloud' : 'local')));
      assert.equal(order.at(-1), 'cloud', 'the cloud comes after every local pick');
      assert.ok(order.filter((o) => o === 'local').length >= 4);
      assert.match(await screen(page).locator('.dm-privacy').innerText(), /Local first\./);
      assert.equal(await screen(page).locator('[data-cloud] .fit-verdict').count(), 0, 'a cloud option has no fit verdict');
      nova.core.profile.set('privacy', 'default', 'local-only', 'settings');
      assert.deepEqual(errors, []);
    });
  } finally { await b.close(); }
});

test('Models screen (app): device setup shows the same component when Nova finds a GPU', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  try {
    await fixture(async ({ base }) => {
      const { page, errors } = await device(b, { width: 390, height: 844, touch: true });
      await page.goto(`${base}/`);
      await ready(page);
      await page.locator('#setup').waitFor({ state: 'visible' });
      await page.fill('#setup-input', 'no');
      await page.keyboard.press('Enter');
      const step = page.locator('#setup .setup-models');
      await step.waitFor();
      assert.match(await step.innerText(), /Nova found a GPU here\./);
      const root = step.locator('[data-device-models]');
      await root.waitFor();
      assert.match(await root.innerText(), /Setup › /);
      assert.match(await root.innerText(), /Recommended for this device/i);
      // The same controls: a pick joins the plan and the engine says how it fits.
      await root.locator('[data-task="coding"] [data-action="models-plan"]').click();
      await root.locator('.dm-model .fit-verdict').waitFor();
      assert.match(await root.locator('.dm-model .dm-words').innerText(), / with 16k context./, 'the coding pick, at the coding context');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
      assert.deepEqual(errors, []);
    }, { finish: false });
  } finally { await b.close(); }
});

test('Models screen (app): a Mac’s budget line says whether it is the limit set on the Mac or Nova’s estimate', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  try {
    await fixture(async ({ base, setHw }) => {
      const { page, errors } = await device(b, { width: 1280, height: 900 });
      await setHw('mac64set');
      await openHub(page, base);
      await setPlan(screen(page), [['qwen3:8b', 'Q4_K_M', 4096]]);
      await screen(page).locator('.fit-bar').waitFor();
      let text = await screen(page).innerText();
      assert.match(text, /GPU memory limit set on this Mac: 56\.0 GB\./, 'the measured limit is the budget, and says so');
      assert.doesNotMatch(text, /Estimated GPU share/);
      // The picks were worked out against the same budget; with the budget line on screen, not said twice.
      assert.equal(await screen(page).locator('[data-picks-budget]').count(), 0, 'the picks don’t repeat the budget line');
      // With nothing planned there is no budget line, so the picks say it, in the same words.
      await setPlan(screen(page), []);
      await screen(page).locator('.dm-picks [data-picks-budget="measured"]').waitFor();
      assert.equal(await screen(page).locator('.dm-picks [data-picks-budget="measured"]').innerText(), 'GPU memory limit set on this Mac: 56.0 GB.');
      await setHw('mac16');
      // The same URL again is a same-document navigation; reload so the new reading is fetched.
      await page.reload();
      await ready(page);
      await screen(page).waitFor();
      await page.waitForFunction(() => document.querySelector('#settings-devices [data-device-models]')?.textContent?.includes('16.0 GB unified memory'));
      await setPlan(screen(page), [['qwen3:8b', 'Q4_K_M', 4096]]);
      await screen(page).locator('.fit-bar').waitFor();
      text = await screen(page).innerText();
      assert.match(text, /Estimated GPU share of 16\.0 GB unified memory: 10\.7 GB \(macOS default\)\./, 'without a limit, the estimate is labelled');
      assert.deepEqual(errors, []);
    });
  } finally { await b.close(); }
});

test('Models screen (app): a refresh from Nova keeps the model picked to add, a slider still being moved, and a tight plan’s acknowledgement', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  try {
    await fixture(async ({ base, nova, setHw }) => {
      const { page, errors } = await device(b, { width: 1280, height: 900 });
      await openHub(page, base);
      const root = screen(page);
      await setPlan(root, [['qwen3:8b', 'Q4_K_M', 4096]]);
      const add = root.locator('select[id$="-add"]');
      const pick = (await add.locator('option').allTextContents()).at(-1)!;
      await add.selectOption(pick);
      assert.notEqual(pick, (await add.locator('option').allTextContents())[0], 'the pick is not the list’s first');
      // The slider moved to 16k ('input' events) and not yet let go ('change').
      const range = root.locator('[data-models-context="0"]');
      await range.evaluate((r: HTMLInputElement) => { r.value = '3'; r.dispatchEvent(new Event('input', { bubbles: true })); });
      await add.focus();
      // What a computer's heartbeat or a new hardware reading does: the model manager says it changed,
      // and the screen reads its data again.
      const read = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/models');
      nova.core.models.emit('change', { action: 'hardware', device: 'hub' });
      await read;
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      assert.equal(await add.inputValue(), pick, 'the model picked to add is still picked');
      assert.equal(await range.inputValue(), '3', 'the slider stays where it is being moved');
      assert.equal(await page.evaluate(() => document.activeElement?.id), await add.getAttribute('id'), 'focus stays on the list');
      // A change to the plan itself still draws from the plan: removing the model clears its row.
      await root.locator('[data-action="models-remove"]').click();
      await page.waitForFunction(() => !document.querySelector('#settings-devices [data-models-context="0"]'));
      // A tight plan, acknowledged: a reading that redraws the screen (more memory in use by other
      // programs, the plan unchanged) keeps the tick and Install on.
      await setPlan(root, [['qwen3:32b', 'Q4_K_M', 4096]]);
      await root.locator('[data-models-ack]').click();
      await root.locator('[data-action="models-install"]:not([disabled])').waitFor();
      await setHw('gpu24busy');
      const redrawn = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/models');
      nova.core.models.emit('change', { action: 'hardware', device: 'hub' });
      await redrawn;
      await page.waitForFunction(() => document.querySelector('#settings-devices .fit-key[data-seg="other"]')?.parentElement?.textContent?.includes('0.6 GB'));
      assert.equal(await root.locator('[data-models-ack]').isChecked(), true, 'the acknowledgement survives a refresh of the same plan');
      assert.equal(await root.locator('[data-action="models-install"]').isDisabled(), false, 'and Install stays on');
      assert.deepEqual(errors, []);
    });
  } finally { await b.close(); }
});

test('Models screen (app): a tight model is never the pick; Install waits for the acknowledgement, a change to the plan clears it, and the install carries it', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  try {
    await fixture(async ({ base, nova }) => {
      const { page, errors } = await device(b, { width: 1280, height: 900 });
      await openHub(page, base);
      const root = screen(page);
      // On the 24 GB card 32B at Q4_K_M is only Tight: chat picks 14B at Q8_0, which Fits.
      const chat = root.locator('[data-task="general-chat"]');
      assert.match(await chat.innerText(), /qwen3:14b at Q8_0, 4k context/);
      assert.equal(await chat.locator('.fit-verdict').getAttribute('data-verdict'), 'fits');
      await setPlan(root, [['qwen3:32b', 'Q4_K_M', 4096]]);
      const box = root.locator('input[type="checkbox"][data-models-ack]');
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('#settings-devices input[data-models-ack]')].map((e) => [...(e.labels ?? [])].map((l) => l.textContent!.trim()).join('|'))), [ACK], 'labelled in the owner’s words');
      assert.equal(await box.isChecked(), false, 'never ticked for the person');
      assert.equal(await root.locator('[data-action="models-install"]').isDisabled(), true, 'Install waits for the tick');
      await box.click();
      await root.locator('[data-action="models-install"]:not([disabled])').waitFor();
      // The plan changes (8k context, still tight): the tick is gone, and stays gone back at 4k.
      await root.locator('[data-models-context="0"]').fill('2');
      await root.locator('.dm-model .dm-out', { hasText: '8k' }).waitFor();
      assert.equal(await root.locator('input[data-models-ack]').isChecked(), false, 'a change to the plan clears the tick');
      assert.equal(await root.locator('[data-action="models-install"]').isDisabled(), true);
      await root.locator('[data-models-context="0"]').fill('1');
      await root.locator('.dm-model .dm-out', { hasText: '4k' }).waitFor();
      assert.equal(await root.locator('input[data-models-ack]').isChecked(), false, 'and it isn’t given back by undoing the change');
      // Ticked for this plan, Install and assign sends the acknowledgement, and the download, once
      // verified, serves the role.
      await root.locator('input[data-models-ack]').click();
      const sent = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/v1/models/install');
      const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/models/install');
      await root.locator('[data-action="models-install"]').click();
      await root.locator('[data-action="models-confirm"]').click();
      assert.equal(JSON.parse((await sent).postData()!).accept_tight, true);
      assert.equal((await answered).status(), 201);
      await page.waitForFunction(() => /qwen3:32b is downloaded and checked, and serves thinking and writing/.test(document.querySelector('#settings-devices')?.textContent ?? ''), null, { timeout: 30_000 });
      const placed = await (async () => { for (let i = 0; i < 200; i++) { const p = nova.core.models.placement('reasoner'); if (p) return p; await new Promise((r) => setTimeout(r, 25)); } return null; })();
      assert.equal(placed?.model, 'qwen3:32b');
      assert.deepEqual(errors, []);
    });
  } finally { await b.close(); }
});

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
// The add list and the first slider as they are now, kept in the page, so a check can ask whether a
// refresh replaced them (an open native list, or a drag, goes with the element).
const holdControls = (page: Page) => page.evaluate(() => { const r = document.querySelector('#settings-devices')!; (window as unknown as { held: Element[] }).held = [r.querySelector('select[id$="-add"]')!, r.querySelector('[data-models-context="0"]')!]; });
const inPlace = (page: Page) => page.evaluate(() => { const [list, range] = (window as unknown as { held: [Element, Element] }).held; return { list: list.isConnected, range: range.isConnected, focused: document.activeElement === list }; });
// A press held on the slider's middle (its 8k, the plan's context), not let go.
async function pressSlider(page: Page, root: Locator) {
  const range = root.locator('[data-models-context="0"]');
  await range.scrollIntoViewIfNeeded();
  const box = (await range.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

test('Models screen (app): a heartbeat that changes nothing on the screen leaves the list and the slider in use in place', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  try {
    await fixture(async ({ base, nova }) => {
      const core = nova.core;
      const keys = generateDeviceKeys();
      const den = core.mesh.devices.add({ name: 'Example den PC', platform: 'linux x64', kind: 'computer', purposes: ['compute'], public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat', 'queue'] }, 'test');
      const hardware = hubHardware({ hostname: 'example-den', gpus: [gpu('Example GPU 8GB', 8)] });
      const beat = () => core.mesh.spokes.heartbeat(den, { capabilities: ['heartbeat', 'queue'], hardware });
      beat();
      const { page, errors } = await device(b, { width: 1280, height: 900 });
      await openHub(page, base);
      const root = screen(page);
      await setPlan(root, [['qwen3:8b', 'Q4_K_M', 8192]]);
      // What a paired computer's heartbeat does: its device event refreshes the device list (Settings ›
      // Devices draws its pane again) and its hardware reading refreshes the models.
      const heartbeat = async () => {
        await page.evaluate(() => { (window as unknown as { listed: Promise<void> }).listed = new Promise((r) => addEventListener('nova:devices', () => setTimeout(r), { once: true })); });
        const read = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/models');
        beat();
        await Promise.all([read, page.evaluate(() => (window as unknown as { listed: Promise<void> }).listed)]);
        await frames(page);
      };
      await root.locator('select[id$="-add"]').focus();
      await holdControls(page);
      await heartbeat();
      assert.deepEqual(await inPlace(page), { list: true, range: true, focused: true }, 'a focused list (one that may be open) is the same element after a heartbeat');
      await pressSlider(page, root);
      await heartbeat();
      const held = await inPlace(page);
      await page.mouse.up();
      assert.equal(held.range, true, 'a slider held down is the same element after a heartbeat');
      assert.equal(held.list, true, 'and so is the list');
      assert.deepEqual(errors, []);
    });
  } finally { await b.close(); }
});

test('Models screen (app): a refresh that does change the screen waits for a focused list or a held slider, then shows the latest', { timeout: 120_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  try {
    await fixture(async ({ base, nova, setHw }) => {
      const { page, errors } = await device(b, { width: 1280, height: 900 });
      await openHub(page, base);
      const root = screen(page);
      await setPlan(root, [['qwen3:8b', 'Q4_K_M', 8192]]);
      const line = root.locator('.dm-device');
      const reading = async (k: 'gpu8' | 'gpu12') => {
        await setHw(k);
        const read = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/models');
        nova.core.models.emit('change', { action: 'hardware', device: 'hub' });
        await read;
        await frames(page);
      };
      // A list focused: the new reading (an 8 GB GPU) waits until it loses focus.
      const add = root.locator('select[id$="-add"]');
      const pick = (await add.locator('option').allTextContents()).at(-1)!;
      await add.selectOption(pick);
      await add.focus();
      await holdControls(page);
      const was = await line.innerText();
      await reading('gpu8');
      assert.deepEqual(await inPlace(page), { list: true, range: true, focused: true }, 'the list in use is the same element while the new reading waits');
      assert.equal(await line.innerText(), was, 'the new reading waits');
      await add.evaluate((el: HTMLElement) => el.blur());
      await page.waitForFunction(() => document.querySelector('#settings-devices .dm-device')?.textContent?.includes('8.0 GB video memory'));
      assert.equal(await add.inputValue(), pick, 'the model picked to add is still picked');
      // The slider held down: the next reading (a 12 GB GPU) waits until it is let go.
      await holdControls(page);
      await pressSlider(page, root);
      await reading('gpu12');
      const during = { range: (await inPlace(page)).range, line: await line.innerText() };
      await page.mouse.up();
      assert.equal(during.range, true, 'the slider held down is the same element while the new reading waits');
      assert.match(during.line, /8\.0 GB video memory/, 'the new reading waits');
      await page.waitForFunction(() => document.querySelector('#settings-devices .dm-device')?.textContent?.includes('12.0 GB video memory'));
      assert.equal(await root.locator('[data-models-context="0"]').inputValue(), '2', 'the slider stays where it was let go');
      assert.deepEqual(errors, []);
    });
  } finally { await b.close(); }
});

for (const [engine, launch] of [['chromium', browser], ['webkit', webkitBrowser]] as const) {
  test(`Models screen (app) ${engine}: the design's states across the responsive matrix; accessible; screenshots for the owner`, { timeout: 900_000 }, async () => {
    let b: Browser | undefined;
    try {
      const launched = await launch();
      assert.notEqual(typeof launched, 'string', 'a browser is required');
      b = launched as Browser;
      await fixture(async ({ base, nova, setHw, spoke }) => {
        const den = await sleepingSpoke(nova, spoke);
        for (const [state, s] of [...Object.entries(STATES), ['asleep', null] as const]) {
          if (s) { await setHw(s.hw); nova.core.profile.set('privacy', 'default', s.privacy ?? 'local-only', 'settings'); }
          for (const [size, dimensions] of Object.entries(MATRIX)) {
            const d = await device(b!, { ...dimensions, touch: !size.startsWith('desktop'), scheme: 'dark', serviceWorkers: 'block' });
            const p = d.page;
            const label = `${engine}/${size}/${state}`;
            if (s) { await openHub(p, base); await setPlan(screen(p), s.plan); }
            else { await p.goto(`${base}/settings#models-on-${den.id}`); await ready(p); await p.locator('#settings-devices [data-device-models]').waitFor(); }
            await p.locator('#settings-devices [data-device-models] .dm-pick').first().waitFor();
            await still(p); // the Settings view's entrance has finished: a moving panel measures smaller than it is
            await geometry(p, label);
            if (size === 'phone' || size === 'desktop-1440' || size === 'fold-cover') await axe(p, label);
            const folder = process.env.NOVA_MODELS_APP_SHOTS;
            if (folder && (SHOT_SIZES[engine] as string[]).includes(size)) {
              const out = resolve(folder, engine);
              mkdirSync(out, { recursive: true });
              await p.mouse.move(0, 0);
              await still(p);
              await capture(p, join(out, `${state}-${size}.png`));
            }
            assert.deepEqual(d.errors, [], label);
            await d.ctx.close();
          }
        }
      });
    } finally { await b?.close(); }
  });
}
