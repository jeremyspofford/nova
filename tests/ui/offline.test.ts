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
    await page.waitForFunction(() => document.querySelector('.orb[data-orb-live]')?.getAttribute('data-state') === 'idle');

    const orb = () => page.evaluate(() => document.querySelector('.orb[data-orb-live]')?.getAttribute('data-state'));
    const toState = (want: string, timeout = 15000) => page.waitForFunction((w) => document.querySelector('.orb[data-orb-live]')?.getAttribute('data-state') === w, want, { timeout });
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
