// Approved Backups surface: real Home doors, real HTTP settings, synthetic private fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { Joiner } from '../core/mesh-support.ts';
import { createServer } from 'node:net';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, still, until } from './support.ts';
import { trackDocument, assertRetainedDocument } from './navigation-support.ts';

async function openBackups(page: Page) {
  const settings = page.locator('a[href="/settings"]').filter({ visible: true }).first();
  if (!await settings.isVisible()) await page.locator('#nav-menu').click();
  await page.locator('a[href="/settings"]').filter({ visible: true }).first().click();
  await page.locator('#settings-nav a[data-cat="backups"]').click();
  await page.locator('#settings-backups input[name="target"]').waitFor();
}

for (const [layout, width, touch] of [['phone', 390, true], ['rail', 1440, false]] as const) {
  test(`Backups from Home: ${layout} saves, confirms, clears and retains drafts`, async () => {
    const b = await browser();
    assert.notEqual(typeof b, 'string', 'real browser required');
    if (typeof b === 'string') throw new Error(b);
    const m = blank(`nova-backups-app-${layout}-`);
    const target = join(m.dir, 'backup copies');
    const encrypted = join(m.dir, 'encrypted copies');
    mkdirSync(target, { mode: 0o700 }); mkdirSync(encrypted, { mode: 0o700 });
    writeFileSync(join(target, 'saved-archive-sentinel'), 'saved files stay');
    const nova = await m.start({ NOVA_AGENT_CMD: '/bin/false', NOVA_AGENT_EGRESS: 'none' });
    try {
      await finishSetup(m);
      const d = await device(b, { width, height: 900, touch, serviceWorkers: 'block' });
      const p = d.page;
      trackDocument(p);
      await p.goto(`${m.base}/`);
      await ready(p);
      await openBackups(p);
      const section = p.locator('#settings-backups');
      const folder = section.getByLabel('Backup folder', { exact: true });
      const keep = section.getByLabel('Copies to keep', { exact: true });
      const copy = section.getByLabel('Encrypted copy folder', { exact: true });
      const save = section.getByRole('button', { name: 'Save backup settings', exact: true });
      assert.equal(await keep.inputValue(), '7');
      assert.equal(await section.locator('input:disabled').count(), 0);
      await folder.fill(target); await keep.fill('12'); await copy.fill(encrypted);
      await save.click();
      await section.locator('code').waitFor();
      // Read only the synthetic key in memory, never write it to evidence or logs.
      const key = await section.locator('code').innerText();
      assert.ok(/^[a-f0-9]{8}(?:-[a-f0-9]{8}){7}$/.test(key), 'eight groups of eight hex characters');
      const readback = await m.get('/api/v1/backups');
      assert.deepEqual(readback.settings, { target, keep: 12, encrypted_target: encrypted });
      assert.ok(!JSON.stringify(readback).includes(key), 'GET contains no key');
      assert.equal(await section.getByRole('button', { name: 'Remove backup folders', exact: true }).count(), 1);
      // SSE profile updates must preserve the visible key, lexical draft, focus and caret.
      await folder.fill(`${target}/unsaved`);
      await folder.evaluate((e: HTMLInputElement) => e.setSelectionRange(3, 6));
      const beforeDraw = await p.evaluate(() => {
        (window as any).__backupDraws = 0;
        new MutationObserver(() => { (window as any).__backupDraws++; }).observe(document.querySelector('#settings-backups')!, { childList: true, subtree: true });
        return (window as any).__backupDraws;
      });
      const refreshed = p.waitForResponse(r => r.url().endsWith('/api/v1/profile'));
      await m.send('PUT', '/api/v1/profile/user/name', { value: 'Synthetic refresh' });
      await (await refreshed).finished();
      await until(p, async n => (window as any).__backupDraws > n && (await import(String('/js/surfaces.js'))).store.profile?.user?.name === 'Synthetic refresh', beforeDraw);
      await p.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      assert.equal(await folder.inputValue(), `${target}/unsaved`);
      assert.deepEqual(await folder.evaluate((e: HTMLInputElement) => [document.activeElement === e, e.selectionStart, e.selectionEnd]), [true, 3, 6]);
      assert.ok(await section.locator('code').innerText() === key, 'SSE retains just-shown key');
      assert.ok(await p.evaluate((k) => !JSON.stringify(localStorage).includes(k) && !JSON.stringify(sessionStorage).includes(k) && !location.href.includes(k), key));
      assert.equal(await section.locator('input[type="hidden"], [data-key]').count(), 0);
      await section.getByRole('button', { name: 'Hide key', exact: true }).click();
      assert.equal(await section.locator('code').count(), 0);
      assert.equal(await folder.inputValue(), `${target}/unsaved`, 'Hide keeps draft');
      await section.getByRole('button', { name: 'Show recovery key', exact: true }).click();
      const reveal = section.getByRole('button', { name: 'Show recovery key', exact: true });
      assert.equal(await reveal.isDisabled(), true);
      await section.getByLabel('I understand that the recovery key will be visible on this screen.').check();
      const revealed = p.waitForRequest(r => r.url().endsWith('/api/v1/backups/recovery-key') && r.method() === 'POST');
      await reveal.click();
      const { passkey_approval: approval, ...sent } = (await revealed).postDataJSON();
      assert.deepEqual(sent, { confirm: true });
      assert.match(approval?.id ?? '', /^ap_/, 'showing the key again is tier 3: approved with a passkey');
      await section.locator('code').waitFor();
      assert.ok(await section.locator('code').innerText() === key);
      await section.getByRole('button', { name: 'Hide key', exact: true }).click();
      // Real backend validation failure leaves the unsaved folder visible and offers retry.
      await save.click();
      await section.locator('[role="alert"]').waitFor();
      assert.equal(await folder.inputValue(), `${target}/unsaved`);
      assert.equal(await save.isEnabled(), true);
      await folder.fill(target); await save.click();
      await section.getByText('Backup settings saved.', { exact: true }).waitFor();
      await section.getByRole('button', { name: 'Remove backup folders', exact: true }).click();
      await p.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-backups input[name="target"]')?.value === '');
      assert.deepEqual((await m.get('/api/v1/backups')).settings, { target: null, keep: 12, encrypted_target: null });
      assert.equal(readFileSync(join(target, 'saved-archive-sentinel'), 'utf8'), 'saved files stay');
      assert.equal(await section.getByRole('button', { name: 'Show recovery key', exact: true }).count(), 1, 'retained key remains reachable after removing folders');
      assert.match(await section.innerText(), /Saved files stay on disk/);
      const shots = process.env.NOVA_BACKUPS_APP_SHOTS;
      if (shots) { mkdirSync(resolve(shots), { recursive: true }); await still(p); await p.screenshot({ path: join(resolve(shots), `${layout}-empty.png`), fullPage: true }); }
      await assertRetainedDocument(p);
      assert.equal(readFileSync(m.egress, 'utf8'), '');
      assert.deepEqual(d.errors.filter(e => !/Failed to load resource/.test(e)), []);
    } finally { await b.close(); await stop(nova); rmSync(m.dir, { recursive: true, force: true }); }
  });
}

// Each case owns a real process, private directories and browser. Interception only holds or
// fails real requests; it never substitutes a fake application/renderer for the tested surface.
async function appCase(run: (x: { m: ReturnType<typeof blank>; page: Page; target: string; encrypted: string }) => Promise<void>) {
  const b = await browser();
  assert.notEqual(typeof b, 'string');
  if (typeof b === 'string') throw new Error(b);
  const m = blank('nova-backups-case-');
  const target = join(m.dir, 'copies'); const encrypted = join(m.dir, 'encrypted');
  mkdirSync(target, { mode: 0o700 }); mkdirSync(encrypted, { mode: 0o700 });
  const nova = await m.start({ NOVA_AGENT_CMD: '/bin/false', NOVA_AGENT_EGRESS: 'none' });
  try {
    await finishSetup(m);
    const d = await device(b, { width: 1440, height: 900, serviceWorkers: 'block' });
    await d.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: m.base });
    await d.page.goto(`${m.base}/`); await ready(d.page);
    await run({ m, page: d.page, target, encrypted });
    assert.equal(readFileSync(m.egress, 'utf8'), '');
  } finally { await b.close(); await stop(nova); rmSync(m.dir, { recursive: true, force: true }); }
}
async function configure(page: Page, target: string, encrypted: string) {
  await page.locator('#settings-backups [name="target"]').fill(target);
  await page.locator('#settings-backups [name="encrypted_target"]').fill(encrypted);
  await page.locator('[data-action="backups-save"]').click();
  await page.locator('#settings-backups code').waitFor();
  await page.waitForFunction(() => document.querySelector('#settings-backups .backups-settings')?.getAttribute('aria-busy') === 'false');
}
async function confirmKey(page: Page) {
  await page.locator('[data-action="backups-reveal"]').click();
  await page.getByLabel('I understand that the recovery key will be visible on this screen.').check();
  await page.locator('[data-action="backups-confirm"]').click();
}
async function noKey(page: Page) { assert.equal(await page.locator('#settings-backups code').count(), 0, 'no hidden or visible key remains in Settings'); }

// Would fail if same-category search only changes the hash without clearing transient state.
test('Backups search within the same category clears a shown key', async () => appCase(async ({ page, target, encrypted }) => {
  await openBackups(page); await configure(page, target, encrypted);
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('backups');
  await page.getByRole('searchbox', { name: 'Search settings' }).press('Enter');
  assert.equal(new URL(page.url()).hash, '#settings-backups');
  await noKey(page);
}));

// Would fail if a load error cannot be retried without leaving/reloading the app.
test('Backups initial endpoint failure stays local and offers a real retry', async () => appCase(async ({ page }) => {
  await page.route('**/api/v1/backups', async r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic offline backup endpoint"}' }));
  await openBackups(page);
  await page.locator('#settings-backups [role="alert"]').waitFor();
  assert.equal(await page.locator('#settings-backups [data-action="backups-retry"]').count(), 1, 'retry reachable');
  assert.equal(await page.locator('#settings-backups input:disabled').count(), 3);
  assert.equal(await page.evaluate(async () => (await import(String('/js/surfaces.js'))).store.reachable), true, 'other live endpoints keep Core reachable');
  await page.unroute('**/api/v1/backups');
  await page.locator('[data-action="backups-retry"]').click();
  await page.locator('[data-action="backups-save"]').waitFor();
  assert.equal(await page.locator('#settings-backups input:disabled').count(), 0);
}));

// A held response has already committed on the real server. Navigation must still prevent
// delivery into the page's ephemeral state, and normal GET cannot restore it later.
test('Backups delayed first key cannot appear after route exit or category return', async () => appCase(async ({ page, target, encrypted }) => {
  await openBackups(page);
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  let reached!: () => void; const received = new Promise<void>(r => { reached = r; });
  await page.route('**/api/v1/backups/settings', async r => { const response = await r.fetch(); reached(); await held; await r.fulfill({ response }); });
  await page.locator('#settings-backups [name="target"]').fill(target);
  await page.locator('#settings-backups [name="encrypted_target"]').fill(encrypted);
  await page.locator('[data-action="backups-save"]').click(); await received;
  await page.locator('a[href="/"]').filter({ visible: true }).first().click();
  release();
  await openBackups(page);
  await page.waitForFunction(() => document.querySelector('#settings-backups .backups-settings')?.getAttribute('aria-busy') === 'false');
  await noKey(page);
}));

test('Backups delayed repeat key respects Not now, hash navigation and Hide during save', async () => appCase(async ({ page, target, encrypted }) => {
  await openBackups(page); await configure(page, target, encrypted);
  await page.locator('[data-action="backups-hide"]').click();
  let release!: () => void; let reached!: () => void;
  let held = new Promise<void>(r => { release = r; }); let received = new Promise<void>(r => { reached = r; });
  await page.route('**/api/v1/backups/recovery-key', async r => { const response = await r.fetch(); reached(); await held; await r.fulfill({ response }); });
  await confirmKey(page); await received;
  await page.locator('[data-action="backups-cancel"]').click(); release();
  await page.waitForFunction(() => document.querySelector('#settings-backups .backups-settings')?.getAttribute('aria-busy') === 'false'); await noKey(page);
  held = new Promise<void>(r => { release = r; }); received = new Promise<void>(r => { reached = r; });
  await confirmKey(page); await received;
  await page.evaluate(() => { location.hash = '#settings-backups'; });
  await page.waitForFunction(() => !document.querySelector('[data-action="backups-cancel"]')); release();
  await page.waitForFunction(() => document.querySelector('#settings-backups .backups-settings')?.getAttribute('aria-busy') === 'false'); await noKey(page);
  await page.unroute('**/api/v1/backups/recovery-key');
  await confirmKey(page); await page.locator('#settings-backups code').waitFor();
  held = new Promise<void>(r => { release = r; }); received = new Promise<void>(r => { reached = r; });
  await page.route('**/api/v1/backups/settings', async r => { const response = await r.fetch(); reached(); await held; await r.fulfill({ response }); });
  await page.locator('[data-action="backups-save"]').click(); await received;
  await page.locator('[data-action="backups-hide"]').click(); release();
  await page.waitForFunction(() => document.querySelector('#settings-backups .backups-settings')?.getAttribute('aria-busy') === 'false'); await noKey(page);
}));

test('Backups native clipboard changes only on explicit Copy click', async () => appCase(async ({ page, target, encrypted }) => {
  await openBackups(page);
  await page.evaluate(() => navigator.clipboard.writeText('synthetic clipboard sentinel'));
  await configure(page, target, encrypted);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'synthetic clipboard sentinel');
  const key = await page.locator('#settings-backups code').innerText();
  await page.locator('[data-action="backups-copy"]').evaluate(e => (e as HTMLButtonElement).click());
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'synthetic clipboard sentinel', 'synthetic click is not intent');
  await page.locator('[data-action="backups-copy"]').click();
  assert.ok(await page.evaluate(k => navigator.clipboard.readText().then(v => v === k), key));
  await page.locator('[data-action="backups-hide"]').click();
  assert.ok(await page.evaluate(k => navigator.clipboard.readText().then(v => v === k), key), 'Hide never edits clipboard');
  await page.evaluate(() => navigator.clipboard.writeText('synthetic cleanup'));
}));

test('Backups preserves inflight edits and duplicate submit guard, then validates blanks and nulls', async () => appCase(async ({ m, page, target, encrypted }) => {
  await openBackups(page); await configure(page, target, encrypted); await page.locator('[data-action="backups-hide"]').click();
  const folder = page.locator('#settings-backups [name="target"]');
  const keep = page.locator('#settings-backups [name="keep"]');
  await folder.fill('');
  await page.locator('[data-action="backups-save"]').click();
  await page.locator('#settings-backups [role="alert"]').waitFor();
  assert.equal(await folder.getAttribute('aria-invalid'), 'true');
  assert.equal((await m.get('/api/v1/backups')).settings.target, target, 'blank is never removal');
  await folder.fill(target);
  await keep.fill('366'); await page.locator('[data-action="backups-save"]').click();
  assert.equal((await m.get('/api/v1/backups')).settings.keep, 7);
  await keep.fill('9');
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  let reached!: () => void; const received = new Promise<void>(r => { reached = r; }); let writes = 0;
  await page.route('**/api/v1/backups/settings', async r => { writes++; const response = await r.fetch(); reached(); await held; await r.fulfill({ response }); });
  await page.locator('[data-action="backups-save"]').click(); await received;
  assert.equal(await page.locator('[data-action="backups-save"]').isDisabled(), true);
  await page.locator('#settings-backups form').evaluate(e => e.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await folder.fill(`${target}/unsaved later`); await folder.evaluate((e: HTMLInputElement) => e.setSelectionRange(2, 8));
  release();
  await page.waitForFunction(() => document.querySelector('#settings-backups .backups-settings')?.getAttribute('aria-busy') === 'false');
  assert.equal(writes, 1); assert.equal(await folder.inputValue(), `${target}/unsaved later`);
  assert.deepEqual(await folder.evaluate((e: HTMLInputElement) => [e === document.activeElement, e.selectionStart, e.selectionEnd]), [true, 2, 8]);
  await page.unroute('**/api/v1/backups/settings'); await folder.fill(target);
  await page.locator('[data-action="backups-clear-encrypted"]').click();
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-backups [name="encrypted_target"]')?.value === '');
  assert.deepEqual((await m.get('/api/v1/backups')).settings, { target, keep: 9, encrypted_target: null });
}));

// Per-endpoint freshness, actual profile SSE, and delayed permission checks must never
// authorize a write using a cached/unknown mesh response or take all Core views offline.
test('Backups failed mesh refresh clears key and stays read-only; fresh retry recovers drafts', async () => appCase(async ({ m, page, target, encrypted }) => {
  await openBackups(page); await configure(page, target, encrypted);
  const folder = page.locator('#settings-backups [name="target"]');
  await folder.fill(`${target}/draft`); await folder.evaluate((e: HTMLInputElement) => e.setSelectionRange(1, 4));
  await page.route('**/api/v1/mesh/status', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic missing mesh"}' }));
  await m.send('PUT', '/api/v1/profile/user/name', { value: 'Refresh missing mesh' });
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-backups [name="target"]')?.disabled === true);
  await noKey(page);
  assert.equal(await folder.inputValue(), `${target}/draft`);
  assert.equal(await page.evaluate(async () => (await import(String('/js/surfaces.js'))).store.reachable), true);
  assert.equal(await page.locator('[data-action="backups-save"], [data-action="backups-reveal"]').count(), 0);
  assert.equal(await page.locator('[data-action="backups-retry"]').count(), 1, 'unknown authorization has a retry');
  await page.unroute('**/api/v1/mesh/status');
  await page.locator('[data-action="backups-retry"]').click();
  await page.locator('[data-action="backups-save"]').waitFor();
  assert.equal(await folder.inputValue(), `${target}/draft`); await noKey(page);
}));

// The race behind the flaky test above: the failed mesh check shows Try again while the profile's
// Backups read is still on its way. Try again then joined that read, whose mesh answer had already
// failed, so it showed Try again once more and never asked again. Here the read is held until after
// the click, so the order is certain. Would fail if Try again could join a read begun before it.
test('Backups Try again during a slow read still asks again', async () => appCase(async ({ m, page, target, encrypted }) => {
  await openBackups(page); await configure(page, target, encrypted);
  await settleBackupsReads(m, page);
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  let holding = true;
  await page.route('**/api/v1/backups', async r => { if (!holding) return r.continue(); holding = false; const response = await r.fetch(); await held; await r.fulfill({ response }); });
  await page.route('**/api/v1/mesh/status', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic missing mesh"}' }));
  const read = page.waitForRequest(r => r.url().endsWith('/api/v1/backups'));
  await m.send('PUT', '/api/v1/profile/user/name', { value: 'Slow read missing mesh' });
  await read;
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-backups [name="target"]')?.disabled === true);
  await page.unroute('**/api/v1/mesh/status');
  await page.locator('[data-action="backups-retry"]').click();
  release();
  await page.locator('[data-action="backups-save"]').waitFor();
  assert.equal(await page.locator('#settings-backups input:disabled').count(), 0);
  await noKey(page);
}));

// Saving fires profile events of its own, and each starts or joins a Backups read. One still on its
// way when the next profile change arrives is joined, not repeated, so a hold set up in between sees
// no new read and waits forever. This returns once the page has handled one more profile change (and
// so every earlier one: the stream is in order) and the read it started or joined is done.
async function settleBackupsReads(m: ReturnType<typeof blank>, page: Page) {
  await page.evaluate(async () => {
    const core = await import(String('/js/core.js')); const surfaces = await import(String('/js/surfaces.js'));
    (window as any).__backupsSettled = false;
    // Added after the app's own listener, so by now its read has started or been joined.
    const off = core.on('profile', (c: { section?: string } | null) => { if (c?.section !== 'user') return; off(); surfaces.loadBackups().then(() => { (window as any).__backupsSettled = true; }); });
  });
  await m.send('PUT', '/api/v1/profile/user/name', { value: 'Settle earlier Backups reads' });
  await page.waitForFunction(() => (window as any).__backupsSettled === true);
}

test('Backups offline save failure keeps draft and allows a real retry', async () => appCase(async ({ m, page, target }) => {
  await openBackups(page);
  await page.locator('#settings-backups [name="target"]').fill(target);
  await page.locator('#settings-backups [name="keep"]').fill('23');
  await page.route('**/api/v1/backups/settings', r => r.abort('connectionfailed'));
  await page.locator('[data-action="backups-save"]').click();
  await page.locator('#settings-backups [role="alert"]').waitFor();
  assert.equal(await page.locator('#settings-backups [name="keep"]').inputValue(), '23');
  assert.equal(await page.locator('[data-action="backups-save"]').isEnabled(), true);
  await page.unroute('**/api/v1/backups/settings');
  // Record only this key-free fixture's ordinary settings/feedback if retry fails.
  const retryTraffic: { method: string; status: number }[] = [];
  page.on('response', r => { if (r.url().endsWith('/api/v1/backups/settings')) retryTraffic.push({ method: r.request().method(), status: r.status() }); });
  await page.locator('[data-action="backups-save"]').click();
  try { await page.getByText('Backup settings saved.', { exact: true }).waitFor(); }
  catch (error) {
    console.error('Backups key-free offline retry diagnostic', JSON.stringify({ retryTraffic, settings: (await m.get('/api/v1/backups')).settings, feedback: await page.locator('#settings-backups > section > [role]').allTextContents(), draft: await page.locator('#settings-backups [name="target"]').inputValue(), keep: await page.locator('#settings-backups [name="keep"]').inputValue(), saveDisabled: await page.locator('[data-action="backups-save"]').isDisabled() }));
    throw error;
  }
  assert.deepEqual((await m.get('/api/v1/backups')).settings, { target, keep: 23, encrypted_target: null });
}));

// #484: the save's own profile change starts a background Backups read. Under load that read can
// answer after the save has finished; it must not erase "Backup settings saved.". The hold makes
// that order certain: every GET /backups after the click waits until the save has said it saved.
test('Backups background read answering after a save keeps the saved notice', async () => appCase(async ({ page, target }) => {
  await openBackups(page);
  await page.locator('#settings-backups [name="target"]').fill(target);
  const held: import('playwright-core').Route[] = [];
  let holding = true;
  await page.route('**/api/v1/backups', r => { if (holding && r.request().method() === 'GET') held.push(r); else void r.continue(); });
  await page.locator('[data-action="backups-save"]').click();
  await page.getByText('Backup settings saved.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#settings-backups .backups-settings')?.getAttribute('aria-busy') === 'false');
  for (let i = 0; i < 200 && held.length === 0; i++) await page.waitForTimeout(50);
  assert.ok(held.length > 0, 'the save started a background Backups read');
  const answered = page.waitForResponse(r => r.url().endsWith('/api/v1/backups') && r.request().method() === 'GET');
  holding = false;
  for (const r of held.splice(0)) await r.continue();
  await (await answered).finished();
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  assert.equal(await page.getByText('Backup settings saved.', { exact: true }).count(), 1, 'a later read keeps the saved notice');
}));

// Real mesh listener/cookie principal: viewer cannot PUT, paired approver receives only the
// initial setup key; repeated display still belongs to the console after explicit confirmation.
test('Backups real paired viewer and approver enforce roles, initial-only key and live role loss', async () => {
  const b = await browser(); assert.notEqual(typeof b, 'string'); if (typeof b === 'string') throw new Error(b);
  const m = blank('nova-backups-role-');
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port; await new Promise<void>(r => server.close(() => r()));
  const mesh = `http://127.0.0.1:${port}`;
  const target = join(m.dir, 'copies'); const encrypted = join(m.dir, 'encrypted');
  mkdirSync(target, { mode: 0o700 }); mkdirSync(encrypted, { mode: 0o700 });
  const nova = await m.start({ NOVA_AGENT_CMD: '/bin/false', NOVA_AGENT_EGRESS: 'none', NOVA_MESH_URL: mesh, NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: mesh });
  try {
    await finishSetup(m);
    const code = (await m.send('POST', '/api/v1/mesh/pairings')).body.code;
    const joiner = new Joiner(mesh, () => Math.floor(Date.now() / 1000), { name: 'Synthetic Backups viewer' });
    assert.equal((await joiner.join(code)).status, 201); assert.equal((await joiner.reveal()).status, 200);
    assert.equal((await m.send('POST', `/api/v1/mesh/requests/${joiner.requestId}/approve`, { confirm: true })).status, 200);
    await joiner.poll(); const session = await joiner.session({ cookie: true }); assert.equal(session.status, 200);
    const d = await device(b, { width: 390, height: 844, touch: true, serviceWorkers: 'allow' });
    const cookie = session.headers.get('set-cookie')!; const pair = cookie.split(';')[0]!.split('=');
    await d.ctx.addCookies([{ name: pair[0]!, value: pair.slice(1).join('='), url: mesh }]);
    const p = d.page; await p.goto(`${mesh}/`); await ready(p); await openBackups(p);
    assert.equal(await p.locator('#settings-backups input:disabled').count(), 3);
    assert.equal(await p.locator('[data-action="backups-save"], [data-action="backups-reveal"]').count(), 0);
    const put = () => p.evaluate(async body => (await fetch('/api/v1/backups/settings', { method: 'PUT', headers: { 'x-nova': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, { target, encrypted_target: encrypted });
    assert.equal(await put(), 403, 'real viewer PUT guard');
    assert.equal(await p.evaluate(async () => (await fetch('/api/v1/backups/recovery-key', { method: 'POST', headers: { 'x-nova': '1', 'content-type': 'application/json' }, body: '{"confirm":true}' })).status), 403);
    assert.equal((await m.send('PATCH', `/api/v1/mesh/devices/${joiner.deviceId}`, { can_approve: true, confirm: true })).status, 200);
    await p.waitForSelector('[data-action="backups-save"]');
    await configure(p, target, encrypted); assert.equal(await p.locator('#settings-backups code').count(), 1);
    assert.equal(await p.locator('[data-action="backups-reveal"]').count(), 0);
    // Service-worker controller is native; neither mutation/reveal responses nor plaintext can
    // enter Cache Storage. The ordinary GET also has no key bytes.
    await p.evaluate(async () => { await navigator.serviceWorker.ready; });
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    const key = await p.locator('#settings-backups code').innerText();
    assert.ok(await p.evaluate(async k => {
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) {
        const response = await (await caches.open(name)).match(request);
        if (response && (await response.text()).includes(k)) return false;
      }
      return !JSON.stringify(localStorage).includes(k) && !JSON.stringify(sessionStorage).includes(k);
    }, key));
    assert.equal((await m.send('POST', '/api/v1/backups/recovery-key', {})).status, 400, 'console still needs explicit confirmation');
    await p.locator('#settings-backups [name="target"]').fill(`${target}/draft`);
    assert.equal((await m.send('PATCH', `/api/v1/mesh/devices/${joiner.deviceId}`, { can_approve: false, confirm: true })).status, 200);
    await p.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-backups [name="target"]')?.disabled === true);
    await noKey(p); assert.equal(await p.locator('#settings-backups [name="target"]').inputValue(), `${target}/draft`);
    assert.equal(await p.locator('[data-action="backups-save"], [data-action="backups-reveal"]').count(), 0);
    assert.equal(await put(), 403);
    assert.equal(readFileSync(m.egress, 'utf8'), '');
  } finally { await b.close(); await stop(nova); rmSync(m.dir, { recursive: true, force: true }); }
});


test('Backups loading clock is a stable request start and stale GET stays read-only', async () => appCase(async ({ m, page }) => {
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  await page.route('**/api/v1/backups', async r => { const response = await r.fetch(); await held; await r.fulfill({ response, headers: { ...response.headers(), 'x-nova-offline': '1' } }); });
  await page.locator('a[href="/settings"]').filter({ visible: true }).first().click();
  await page.locator('#settings-nav a[data-cat="backups"]').click();
  const wait = page.locator('#settings-backups [data-waiting="view-backups"]'); await wait.waitFor({ state: 'attached' });
  const since = Number(await wait.getAttribute('data-since'));
  assert.ok(Number.isFinite(since) && since > 0 && since <= Date.now());
  await m.send('PUT', '/api/v1/profile/user/name', { value: 'Loading refresh' });
  await until(page, async () => (await import(String('/js/surfaces.js'))).store.profile?.user?.name === 'Loading refresh');
  assert.equal(Number(await wait.getAttribute('data-since')), since);
  assert.equal(await page.locator('#settings-backups input, #settings-backups code').count(), 0);
  release();
  await page.locator('#settings-backups input').first().waitFor();
  assert.equal(await page.locator('#settings-backups input:disabled').count(), 3);
  assert.equal(await page.locator('[data-action="backups-save"], [data-action="backups-reveal"]').count(), 0);
  assert.equal(await page.locator('[data-action="backups-retry"]').count(), 1);
}));

test('Backups generic reconnect with failed mesh has a local retry, and revalidation blocks PUT', async () => appCase(async ({ m, page, target, encrypted }) => {
  await openBackups(page); await configure(page, target, encrypted);
  let puts = 0; page.on('request', r => { if (r.method() === 'PUT' && r.url().endsWith('/api/v1/backups/settings')) puts++; });
  await page.route('**/api/v1/mesh/status', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic missing mesh"}' }));
  // Even a button painted while authorization was known must revalidate before PUT.
  await page.locator('[data-action="backups-save"]').click();
  await page.locator('#settings-backups [role="alert"]').waitFor();
  assert.equal(puts, 0); await noKey(page);
  await page.unroute('**/api/v1/mesh/status');
  await openBackups(page); await page.locator('[data-action="backups-save"]').waitFor();
  await page.route('**/api/v1/mesh/status', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic missing mesh"}' }));
  const failedMesh = page.waitForResponse(r => r.url().endsWith('/api/v1/mesh/status') && r.status() === 503);
  await page.context().setOffline(true); await page.context().setOffline(false);
  await (await failedMesh).finished();
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-backups [name="target"]')?.disabled === true);
  assert.equal(await page.locator('#settings-backups input:disabled').count(), 3);
  assert.equal(await page.locator('[data-action="backups-retry"]').count(), 1);
}));

test('Backups delayed reveal cannot return after fresh authorization becomes unavailable', async () => appCase(async ({ m, page, target, encrypted }) => {
  await openBackups(page); await configure(page, target, encrypted); await page.locator('[data-action="backups-hide"]').click();
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  let reached!: () => void; const received = new Promise<void>(r => { reached = r; });
  await page.route('**/api/v1/backups/recovery-key', async r => { const response = await r.fetch(); reached(); await held; await r.fulfill({ response }); });
  await confirmKey(page); await received;
  await page.route('**/api/v1/mesh/status', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic permission outage"}' }));
  await m.send('PUT', '/api/v1/profile/user/name', { value: 'Late reveal loses permissions' });
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#settings-backups [name="target"]')?.disabled === true);
  release(); await page.waitForFunction(() => document.querySelector('#settings-backups .backups-settings')?.getAttribute('aria-busy') === 'false'); await noKey(page);
  await page.unroute('**/api/v1/mesh/status'); await page.locator('[data-action="backups-retry"]').click();
  await page.locator('[data-action="backups-save"]').waitFor(); await noKey(page);
}));

// Would fail if redrawing an unchecked confirmation discards native keyboard focus.
test('Backups unchecked confirmation keeps keyboard focus through toggle and profile SSE', async () => appCase(async ({ m, page, target, encrypted }) => {
  await openBackups(page); await configure(page, target, encrypted);
  await page.locator('[data-action="backups-hide"]').click();
  await page.locator('[data-action="backups-reveal"]').click();
  const confirm = page.getByLabel('I understand that the recovery key will be visible on this screen.');
  await confirm.press('Space');
  assert.equal(await confirm.isChecked(), true);
  assert.equal(await confirm.evaluate(e => document.activeElement === e), true, 'checked focus retained');
  await page.keyboard.press('Space');
  assert.equal(await confirm.isChecked(), false);
  assert.equal(await confirm.evaluate(e => document.activeElement === e), true, 'unchecked focus retained');
  await refreshProfileBackups(m, page, 'Synthetic unchecked focus');
  assert.equal(await confirm.isChecked(), false);
  assert.equal(await confirm.evaluate(e => document.activeElement === e), true, 'unchecked focus retained after actual SSE redraw');
  assert.equal(await page.locator('[data-action="backups-confirm"]').isDisabled(), true);
  await page.keyboard.press('Space');
  assert.equal(await confirm.isChecked(), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('[data-action="backups-confirm"]').evaluate(e => document.activeElement === e), true, 'native keyboard continues to confirmation action');
  await noKey(page);
}));

// Would fail if an unrelated successful GET erases a failed mutation's feedback.
test('Backups failed-save feedback survives unrelated actual profile SSE until retry', async () => appCase(async ({ m, page, target }) => {
  await openBackups(page);
  const folder = page.locator('#settings-backups [name="target"]');
  const alert = page.locator('#settings-backups [role="alert"]');
  const save = page.locator('[data-action="backups-save"]');
  await folder.fill(`${target}/missing`); await save.click();
  await alert.waitFor();
  const failure = await alert.innerText();
  assert.ok(failure.length > 0, 'actual backend error shown');
  assert.equal((await m.get('/api/v1/backups')).settings.target, null);
  await folder.focus(); await folder.evaluate((e: HTMLInputElement) => e.setSelectionRange(2, 5));
  await refreshProfileBackups(m, page, 'Synthetic failed save refresh');
  assert.equal(await alert.count(), 1, 'failed-save alert survives successful unrelated refresh');
  assert.equal(await alert.innerText(), failure, 'same actionable backend feedback retained');
  assert.equal(await folder.inputValue(), `${target}/missing`);
  assert.deepEqual(await folder.evaluate((e: HTMLInputElement) => [document.activeElement === e, e.selectionStart, e.selectionEnd]), [true, 2, 5]);
  assert.equal(await save.isEnabled(), true);
  await folder.fill(target); await save.click();
  await page.getByText('Backup settings saved.', { exact: true }).waitFor();
  assert.equal(await alert.count(), 0, 'successful retry clears old failure');
  assert.equal((await m.get('/api/v1/backups')).settings.target, target);
}));

// Observe completion of the real profile-triggered Backups/mesh GETs and their actual redraw.
async function refreshProfileBackups(m: ReturnType<typeof blank>, page: Page, name: string) {
  await page.evaluate(() => {
    (window as any).__backupsRefreshDraws = 0;
    new MutationObserver(() => { (window as any).__backupsRefreshDraws++; }).observe(document.querySelector('#settings-backups')!, { childList: true, subtree: true });
  });
  const backups = page.waitForResponse(r => r.url().endsWith('/api/v1/backups'));
  const mesh = page.waitForResponse(r => r.url().endsWith('/api/v1/mesh/status'));
  await m.send('PUT', '/api/v1/profile/user/name', { value: name });
  await Promise.all([(await backups).finished(), (await mesh).finished()]);
  await until(page, async expected => (window as any).__backupsRefreshDraws > 0 && (await import(String('/js/surfaces.js'))).store.profile?.user?.name === expected, name);
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
