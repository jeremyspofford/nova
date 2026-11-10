// F-038 in the page: each memory's row says where it came from (a conversation, captured items on a
// named device, a device, an import, by hand, or "Nova cannot show where this came from yet."), and
// what Nova wrote that the person hasn't checked says "Not yet checked" with a Confirm, quietly, on
// its own row: no count or badge anywhere (owner ruling on F-034). Confirm calls the core's existing
// route and the mark goes, with focus kept on the row. The Memory data is stubbed so every origin form
// is on screen at once; the server (seeded) only serves the app. Chromium.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { Browser, Route } from 'playwright-core';
import { stop } from '../acceptance/support.ts';
import { browser, device, until } from './support.ts';
import { seeded, settled } from './m9-support.ts';

let server: Awaited<ReturnType<typeof seeded>> | null = null;
before(async () => { server = await seeded('nova-memorigin-'); });
after(async () => { if (server) { await stop(server.nova); rmSync(server.m.dir, { recursive: true, force: true }); } });

const row = (id: string, extra: Record<string, unknown>) => ({ id, text: `Memory ${id}.`, time: null, from: null, at: '2026-11-09T10:00:00Z', updated: null, by: 'nova', state: 'confirmed', device: null, root: id, ...extra });

test('memory origins and "Not yet checked": true words on every row, Confirm clears the mark', async (t) => {
  const b = await browser();
  if (typeof b === 'string') { t.skip(b); return; }
  t.after(() => (b as Browser).close());
  const { page, errors } = await device(b, { width: 1280, height: 900, serviceWorkers: 'block' });
  let confirmed = false;
  const confirms: string[] = [];
  const stub = () => ({
    sections: [{ title: 'Facts', entries: [
      row('a0000001-0000-4000-8000-000000000001', { from: 'capture:e1,e2', state: confirmed ? 'confirmed' : 'unreviewed' }),
      row('a0000001-0000-4000-8000-000000000002', { from: 'device:phone-1' }),
      row('a0000001-0000-4000-8000-000000000003', { from: 'imported from notes/garden.md' }),
      row('a0000001-0000-4000-8000-000000000004', { from: 's9/k1' }),
      row('a0000001-0000-4000-8000-000000000005', { by: 'hand' }),
    ] }],
    days: [], candidates: [], titles: {},
    devices: { 'phone-1': 'Kitchen phone', 'laptop-1': 'Work laptop' },
    captured: { 'a0000001-0000-4000-8000-000000000001': { count: 2, devices: ['laptop-1'] } },
  });
  await page.route('**/api/memory', (r: Route) => (r.request().method() === 'GET' ? r.fulfill({ json: stub() }) : r.continue()));
  await page.route('**/api/v1/memory/*/confirm', (r: Route) => { confirms.push(new URL(r.request().url()).pathname); confirmed = true; return r.fulfill({ json: { ok: true } }); });
  await page.goto(`${server!.m.base}/memory`);
  await settled(page, 'memory');

  const source = (n: number) => page.$eval(`#m-a0000001-0000-4000-8000-00000000000${n} .memory-source`, (e) => (e.textContent ?? '').trim());
  assert.equal(await source(1), 'from 2 captured items on “Work laptop” · Not yet checked');
  assert.equal(await source(2), 'sent by your device “Kitchen phone”');
  assert.equal(await source(3), 'imported from notes/garden.md');
  assert.equal(await source(4), 'Nova cannot show where this came from yet.');
  assert.equal(await source(5), 'written into MEMORY.md by hand');
  assert.equal(await page.locator('#memory').getByText('from a conversation').count(), 0);
  assert.equal(await page.locator('#memory [data-action="confirm-memory"]').count(), 1, 'Confirm only where something is unchecked');
  // Quiet: the rail and the page say no count of unchecked memories.
  assert.doesNotMatch(await page.locator('body').innerText(), /\d+\s+(?:not yet checked|unchecked|to check)/i);

  // Confirm, by keyboard: Tab from the row reaches it.
  await page.focus('#m-a0000001-0000-4000-8000-000000000001');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.action), 'confirm-memory');
  await page.keyboard.press('Enter');
  await until(page, () => !document.querySelector('#memory .memory-unchecked'));
  assert.deepEqual(confirms, ['/api/v1/memory/a0000001-0000-4000-8000-000000000001/confirm']);
  assert.equal(await source(1), 'from 2 captured items on “Work laptop”');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'm-a0000001-0000-4000-8000-000000000001', 'focus stays on the row');
  await until(page, () => /Confirmed\./.test(document.querySelector('#toast')?.textContent ?? ''));
  assert.deepEqual(errors, []);
});
