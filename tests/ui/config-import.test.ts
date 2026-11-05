// Config onboarding, door 1, in Chromium against the real server: Settings › Configuration takes a
// file, shows its diff (a secret left out, saying why) before anything applies, applies it, and a
// file that changes privacy is tier 3 and goes through the passkey step. Export gives the file back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stop, until } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready } from './support.ts';

const file = (settings: object) => ({ name: 'nova-config.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'nova-config/1', settings })) });

test('Config door 1: a file is checked and shown first, applied on the OK; tier 3 asks for the passkey; export', { timeout: 180_000 }, async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-config-');
  const nova = await m.start();
  try {
    await finishSetup(m);
    const base = m.base.replace('//127.0.0.1', '//localhost');
    const { page, errors } = await device(b, { width: 1280, height: 900 });
    await page.goto(`${base}/settings#config`);
    await ready(page);
    const door = page.locator('#config');
    await door.locator('[data-config-import="choose"]').waitFor();

    await door.locator('[data-config-file]').setInputFiles(file({ user: { name: 'Sam' }, identity: { api_key: 'nope' } }));
    await door.locator('[data-config-import="review"]').waitFor();
    assert.match(await door.innerText(), /User › Name[\s\S]*Sam/);
    assert.match(await door.locator('[data-config-key="identity.api_key"]').innerText(), /Secrets never go in a configuration file/);
    assert.notEqual((await m.get('/api/v1/profile')).user?.name, 'Sam', 'nothing applied before the OK');
    await door.locator('[data-action="config-apply"]').click();
    await door.locator('[data-config-import="applied"]').waitFor();
    assert.equal((await m.get('/api/v1/profile')).user.name, 'Sam');

    // Tier 3: what stays private. The apply goes through the passkey step on this screen.
    await door.locator('[data-action="config-cancel"]').click();
    await door.locator('[data-config-import="choose"]').waitFor();
    await door.locator('[data-config-file]').setInputFiles(file({ privacy: { default: 'cloud-allowed' } }));
    await door.locator('[data-config-import="review"]').waitFor();
    await door.locator('[data-action="config-apply"]').click();
    await door.locator('[data-config-import="applied"]').waitFor();
    assert.equal((await until<any>(() => m.get('/api/v1/profile'), (x) => x.privacy?.default === 'cloud-allowed')).privacy.default, 'cloud-allowed');

    const download = page.waitForEvent('download');
    await door.locator('[data-action="config-export"]').click();
    const exported = JSON.parse(await (await (await download).createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')));
    assert.equal(exported.format, 'nova-config/1');
    assert.equal(exported.settings.user.name, 'Sam');
    assert.deepEqual(errors, []);
  } finally {
    await b.close();
    await stop(nova);
  }
});
