// Approved Backups surface: real Home doors, real HTTP settings, synthetic private fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, still } from './support.ts';
import { trackDocument, assertRetainedDocument } from './navigation-support.ts';

async function openBackups(page: Page) {
  const settings = page.locator('a[href="/settings"]').filter({ visible: true }).first();
  if (!await settings.isVisible()) await page.locator('#more-btn').click();
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
      const refreshed = p.waitForResponse(r => r.url().endsWith('/api/v1/profile'));
      await m.send('PUT', '/api/v1/profile/user/name', { value: 'Synthetic refresh' });
      await refreshed;
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
      assert.deepEqual((await revealed).postDataJSON(), { confirm: true });
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
