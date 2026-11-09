// Honest offline (M3 §2): with the service worker installed and the server killed, the page says
// Nova is unreachable and keeps saying so; cached answers never count as "back". When the server
// returns on the same address, the page notices. (Review finding: a cached health check made the
// orb flip back to idle every two seconds while the hub was down.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sleep, stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

test('M3: with the server down, the PWA stays honestly offline, and recovers when it returns', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-offline-');
  let nova = await m.start();
  const port = new URL(m.base).port;
  const shots = shotsDir();
  try {
    await finishSetup(m);
    const { page } = await device(b, { width: 1280 });
    await page.goto(`${m.base}/`);
    await ready(page);
    // The service worker is installed and controls the page, with the app and its API answers cached.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await ready(page);
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, 'the service worker controls the page');
    await page.waitForFunction(() => document.querySelector('.status-icon[data-presence]')?.getAttribute('data-state') === 'idle');

    const orb = () => page.evaluate(() => document.querySelector('.status-icon[data-presence]')?.getAttribute('data-state'));
    const toState = (want: string, timeout = 15000) => page.waitForFunction((w) => document.querySelector('.status-icon[data-presence]')?.getAttribute('data-state') === w, want, { timeout });
    // Two outages: after the first, the reconnect check has succeeded once, which is when a cached
    // health answer could exist to fool the second.
    for (const round of [1, 2]) {
      await stop(nova);
      await toState('offline', 10000);
      // Several reconnect checks later (one every two seconds), still offline: nothing cached said "up".
      for (let i = 0; i < 6; i++) {
        await sleep(1000);
        assert.equal(await orb(), 'offline', `outage ${round}: still offline after ${i + 1}s`);
        assert.match((await page.textContent('#banner')) ?? '', /isn’t answering/);
        assert.equal(await page.isVisible('#banner'), true);
      }
      if (shots && round === 2) await shoot(page, join(shots, 'offline-server-down.png'));
      if (round === 2) {
        // The page itself still opens from the cache, and says it's offline.
        await page.goto(`${m.base}/tasks`);
        await toState('offline', 10000);
      }
      // Back on the same address: the page reconnects by itself.
      nova = await m.start({ NOVA_PORT: port });
      await toState('idle');
      await page.waitForFunction(() => (document.getElementById('banner') as HTMLElement).hidden, null, { timeout: 5000 }).catch(() => {});
      assert.equal(await page.isVisible('#banner'), false, `outage ${round}: the banner goes once Nova answers (it says: ${await page.textContent('#banner')})`);
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});

// The race behind the flaky outage 2 above: the reconnect check refreshes every part of the core at
// once, and one slow part can still be on its way when the server goes down again. The parts that
// answered before the outage are live, so the refresh used to finish with "live" after the page had
// already said Nova was unreachable, and the orb went back to idle with the server down. Here the
// slow part is held in the page until the outage is on screen, so the order is certain.
test('M3: an answer begun before an outage never brings the orb back', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-offline-race-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    const { page } = await device(b, { width: 1280 });
    await page.goto(`${m.base}/`);
    await ready(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await ready(page);
    const orb = () => page.evaluate(() => document.querySelector('.status-icon[data-presence]')?.getAttribute('data-state'));
    await page.waitForFunction(() => document.querySelector('.status-icon[data-presence]')?.getAttribute('data-state') === 'idle');
    // From here, the core's work-costs read waits in the page until the test lets it go; every other
    // read goes straight through and is counted until it settles.
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const real = window.fetch.bind(window);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      Object.assign(w, { __release: release, __held: false, __heldDone: false, __pending: 0 });
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
        if (path === '/api/v1/caps' && !w.__held) {
          w.__held = true;
          return gate.then(() => real(input, init)).finally(() => { w.__heldDone = true; });
        }
        (w.__pending as number)++;
        return real(input, init).finally(() => { (w.__pending as number)--; });
      };
    });
    // A refresh of every part, as the reconnect check starts one.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => { const w = window as unknown as Record<string, unknown>; return w.__held === true && w.__pending === 0; });
    assert.equal(await orb(), 'idle');
    // The server goes down while the slow part is still out; the page says so.
    await stop(nova);
    await page.waitForFunction(() => document.querySelector('.status-icon[data-presence]')?.getAttribute('data-state') === 'offline', null, { timeout: 10000 });
    // The slow part now meets a dead server (the cached copy, marked offline), and the refresh ends.
    await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await page.waitForFunction(() => (window as unknown as Record<string, unknown>).__heldDone === true);
    for (let i = 0; i < 3; i++) {
      await sleep(500);
      assert.equal(await orb(), 'offline', `still offline ${(i + 1) * 500} ms after the slow answer`);
      assert.equal(await page.isVisible('#banner'), true);
    }
  } finally {
    await b.close();
    await stop(nova);
  }
});
