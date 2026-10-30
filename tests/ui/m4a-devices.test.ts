// M4a in a real browser: Settings › Devices on the hub's own screen makes a code and draws the QR
// (decoded here with jsqr from what the page actually rendered); a phone-sized browser opens that
// address on the mesh listener, makes non-extractable keys, joins and shows six digits; the hub's
// approval sheet shows the same digits and is approved with its confirm box; the phone reaches
// Home signed in. Revoking it from the hub sends it back to /pair. /pair says plainly when the
// browser can't make the keys, and refuses an address that isn't the hub that made the code.
// The full M4 gate (HTTPS, a standby, failover) is tests/ui/m4-mesh.test.ts, not this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import jsQRModule from 'jsqr';
import { stop } from '../acceptance/support.ts';
import { blank, browser, device, finishSetup, ready, shoot, shotsDir } from './support.ts';

// jsqr is a CommonJS module whose types describe an ES default export; at run time Node hands over
// the function itself.
const jsQR = jsQRModule as unknown as typeof jsQRModule.default;

const freePort = () => new Promise<number>((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); }); });

test('M4a: pair a phone by QR, approve it with matching digits, then revoke it', async (t) => {
  const b = await browser();
  if (typeof b === 'string') return t.skip(b);
  const m = blank('nova-ui-m4a-');
  const port = await freePort();
  // The mesh listener stays on loopback inside the test's own machine or container: loopback is a
  // secure context for the browser, and it is not the console, because it is the mesh listener.
  const mesh = `http://127.0.0.1:${port}`;
  const nova = await m.start({ NOVA_MESH_URL: mesh, NOVA_MESH_TRANSPORT: 'network', NOVA_MESH_PUBLIC_URL: mesh });
  const m3 = shotsDir();
  const shots = m3 ? join(dirname(m3), 'm4') : null;
  if (shots) mkdirSync(shots, { recursive: true });
  try {
    await finishSetup(m);
    const hub = await device(b, { width: 1280, height: 900 });
    await hub.page.goto(`${m.base}/settings#devices`);
    await ready(hub.page);
    const section = hub.page.locator('#devices');
    await section.locator('.device-row').first().waitFor();
    assert.match((await section.textContent()) ?? '', /Hub\s*· this device/);
    assert.match((await section.textContent()) ?? '', new RegExp(`Devices reach Nova at ${mesh.replace(/[.:/]/g, '\\$&')}`));
    const add = section.locator('[data-action="add-device"]');
    assert.match((await add.getAttribute('class')) ?? '', /primary/, 'Add a device is the one standout');
    await add.click();
    const sheet = hub.page.locator('#sheet .add-device');
    await sheet.waitFor();
    assert.match((await sheet.locator('.warning').textContent()) ?? '', new RegExp(`Only enter this code at ${mesh.replace(/[.:/]/g, '\\$&')} on a device you already trust\\.`));
    const code = ((await sheet.locator('.pair-code-text').textContent()) ?? '').trim();
    assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(await hub.page.locator('#add-command').textContent(), `curl -fsS ${mesh}/join.sh | sh -s -- ${code}`);

    // Decode the QR exactly as the page drew it: a screenshot of the element, read back as pixels,
    // without letting the decoder invert it: dark on light, in light mode and in dark.
    const read = async () => {
      const png = await sheet.locator('.qr').screenshot();
      const pixels = await hub.page.evaluate(async (b64) => {
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
      return jsQR(Uint8ClampedArray.from(pixels.data), pixels.w, pixels.h, { inversionAttempts: 'dontInvert' });
    };
    await hub.page.emulateMedia({ colorScheme: 'dark' });
    const inDark = await read();
    await hub.page.emulateMedia({ colorScheme: 'light' });
    const qr = await read();
    assert.ok(qr, 'the QR on screen decodes as dark on light, in light mode');
    assert.ok(inDark, 'and in dark mode');
    assert.equal(inDark!.data, qr!.data);
    const fingerprint = (await m.get('/api/v1/mesh/hello')).fingerprint;
    assert.equal(qr!.data, `${mesh}/pair#c=${code}&h=${fingerprint}`);
    if (shots) await shoot(hub.page, join(shots, 'add-a-device.png'));

    // The phone: opens the address from the QR, joins, shows digits.
    // A phone: a narrow, touch-first browser (so /pair calls it a phone).
    const phoneCtx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' });
    const phone = { ctx: phoneCtx, page: await phoneCtx.newPage() };
    await phone.page.goto(qr!.data);
    await phone.page.locator('#join').waitFor();
    assert.equal(await phone.page.locator('#code').inputValue(), code, 'the code came from the fragment');
    assert.equal(new URL(phone.page.url()).hash, '', 'and the fragment was dropped from the address bar');
    await phone.page.click('#join');
    const digits = ((await phone.page.locator('.pair-digits').textContent({ timeout: 10000 })) ?? '').replace(/\s/g, '');
    assert.match(digits, /^\d{6}$/);
    const keys = await phone.page.evaluate(() => new Promise<{ ed: boolean; x: boolean; pub: boolean }>((ok) => {
      const r = indexedDB.open('nova-device');
      r.onsuccess = () => {
        const g = r.result.transaction('keys').objectStore('keys').get('self');
        g.onsuccess = () => ok({ ed: g.result.ed.privateKey.extractable, x: g.result.x.privateKey.extractable, pub: g.result.ed.publicKey.extractable });
      };
    }));
    assert.deepEqual(keys, { ed: false, x: false, pub: true }, 'the private keys can’t be read, not even by the page');
    if (shots) await shoot(phone.page, join(shots, 'phone-digits.png'));

    // The hub's approval sheet opens by itself with the same digits; Confirm waits for the box.
    const approval = hub.page.locator('#sheet form[data-request]');
    await approval.waitFor({ timeout: 10000 });
    assert.equal(((await approval.locator('.digits').textContent()) ?? '').replace(/\s/g, ''), digits, 'both screens show the same six digits');
    assert.equal(await approval.getAttribute('data-tier'), '3');
    const confirm = approval.locator('[data-action="approve"]');
    assert.equal(await confirm.isDisabled(), true);
    if (shots) await shoot(hub.page, join(shots, 'approve-with-digits.png'));
    await approval.locator('input[name="confirm"]').check();
    await confirm.click();

    // The phone reaches Home, signed in, and can do what the person does.
    await phone.page.waitForURL(`${mesh}/`, { timeout: 15000 });
    await ready(phone.page);
    const made = await phone.page.evaluate(() => fetch('/api/v1/memory', { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify({ kind: 'fact', content: 'The spare key is in the blue box.' }) }).then((r) => r.status));
    assert.equal(made, 201);
    if (shots) await shoot(phone.page, join(shots, 'phone-home.png'));

    // The hub lists it; revoking is tier 3; the phone is sent back to /pair.
    await hub.page.goto(`${m.base}/settings#devices`);
    await ready(hub.page);
    const row = hub.page.locator('#devices .device-row', { hasText: 'Phone' });
    await row.waitFor();
    await row.locator('[data-action="revoke-device"]').click();
    const revoke = hub.page.locator('#sheet form[data-revoke]');
    await revoke.waitFor();
    assert.equal(await revoke.locator('[data-action="approve"]').isDisabled(), true);
    await revoke.locator('input[name="confirm"]').check();
    await revoke.locator('[data-action="approve"]').click();
    await hub.page.locator('#devices details.raw summary', { hasText: 'Revoked (1)' }).waitFor();
    await phone.page.waitForURL(`${mesh}/pair`, { timeout: 15000 });
    await phone.page.getByText('This device’s pairing ended').waitFor({ timeout: 10000 });
    assert.equal(await phone.page.evaluate(() => fetch('/api/v1/tasks').then((r) => r.status)), 401);
    if (shots) await shoot(phone.page, join(shots, 'phone-revoked.png'));

    // An address that isn't the hub that made the code, and a browser that can't make the keys.
    const wrong = await device(b, { width: 390, height: 844 });
    await wrong.page.goto(`${mesh}/pair#c=${code}&h=AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH`);
    await wrong.page.getByText('This isn’t the hub that made the code').waitFor();
    const old = await device(b, { width: 390, height: 844 });
    await old.ctx.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
    await old.page.goto(`${mesh}/pair`);
    await old.page.getByText('isn’t on a secure connection').waitFor();
    assert.equal(await old.page.locator('#join').count(), 0, 'no way forward with a weaker key');

    assert.deepEqual(hub.errors, [], 'no errors on the hub’s page');
  } finally {
    await b.close();
    await stop(nova);
  }
});
