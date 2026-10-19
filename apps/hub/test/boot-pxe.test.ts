// Network boot over HTTP (FR-143, ADR-096 D5): the public iPXE routes answer 404 while
// `devices.pxe.enabled` is off and for any token that is not a live boot token, list only images
// that exist, never leave the images folder, serve byte ranges, are rate-limited per address and
// audited per fetch; the boot token is shown once and kept only as its hash.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pxeTokenHash } from '@nova/core';
import { bootHub, type BootHub } from './boot-env.ts';

let h: BootHub;
let token: string;
let images: string;

beforeEach(async () => {
  h = await bootHub({ scriptsPerMinute: 5, imagesPerMinute: 20 });
  images = join(h.dir, 'data', 'boot-images');
  mkdirSync(images, { recursive: true });
  writeFileSync(join(images, 'debian-13.ipxe'), '#!ipxe\necho debian\n');
  writeFileSync(join(images, 'memtest.efi'), Buffer.from('0123456789abcdef'));
  writeFileSync(join(h.dir, 'secret.txt'), 'top secret');
  symlinkSync(join(h.dir, 'secret.txt'), join(images, 'link.efi'));
  mkdirSync(join(images, 'folder.efi'));
  const r = await h.api('POST', `/api/v1/devices/${h.deviceId}/boot/pxe/token`, {});
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  expect(r.headers['cache-control']).toBe('no-store');
  token = r.json.token as string;
});

afterEach(async () => {
  await h.close();
});

/** A public request: no session, as iPXE sends it. */
async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${h.url}${path}`, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('the public PXE routes', () => {
  it('are 404 while PXE is off, even with a valid token', async () => {
    expect((await get(`/boot/ipxe/${token}`)).status).toBe(404);
    expect((await get(`/boot/images/${token}/memtest.efi`)).status).toBe(404);
  });

  it('serve the menu of existing images to a valid token only', async () => {
    h.settings['devices.pxe.enabled'] = true;
    const s = await get(`/boot/ipxe/${token}`);
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toContain('text/plain');
    expect(s.text.startsWith('#!ipxe\n')).toBe(true);
    expect(s.text).toContain('item img1 debian-13.ipxe');
    expect(s.text).toContain('item img2 memtest.efi');
    expect(s.text).toContain(`${h.url}/boot/images/${token}/memtest.efi`);
    expect(s.text).not.toContain('link.efi');
    expect(s.text).not.toContain('folder.efi');
    for (const bad of [`nvb_${'A'.repeat(43)}`, 'nope', ':token', token.slice(0, -1)])
      expect((await get(`/boot/ipxe/${bad}`)).status, bad).toBe(404);
    expect(h.audit.filter((a) => a.action === 'device.boot.pxe.script')).toHaveLength(1);
    expect(h.audit.at(-1)).toMatchObject({
      resource: h.deviceId,
      detail: { from: '127.0.0.1', images: 2 },
    });
  });

  it('serve images whole and by range, and never leave the folder', async () => {
    h.settings['devices.pxe.enabled'] = true;
    const whole = await get(`/boot/images/${token}/memtest.efi`);
    expect(whole.status).toBe(200);
    expect(whole.text).toBe('0123456789abcdef');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    const part = await get(`/boot/images/${token}/memtest.efi`, { range: 'bytes=2-5' });
    expect(part.status).toBe(206);
    expect(part.text).toBe('2345');
    expect(part.headers.get('content-range')).toBe('bytes 2-5/16');
    const tail = await get(`/boot/images/${token}/memtest.efi`, { range: 'bytes=-3' });
    expect(tail.text).toBe('def');
    const past = await get(`/boot/images/${token}/memtest.efi`, { range: 'bytes=99-' });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */16');
    for (const name of [
      '%2e%2e%2fsecret.txt',
      '..%2Fsecret.txt',
      '%2e%2e',
      'link.efi',
      'folder.efi',
      'missing.efi',
      '%2Fetc%2Fpasswd',
    ]) {
      const r = await get(`/boot/images/${token}/${name}`);
      expect(r.status, name).toBe(404);
      expect(r.text).not.toContain('top secret');
    }
    expect((await get(`/boot/images/nvb_${'A'.repeat(43)}/memtest.efi`)).status).toBe(404);
    const fetches = h.audit.filter((a) => a.action === 'device.boot.pxe.image');
    expect(fetches.map((a) => a.detail?.range)).toEqual([
      null,
      'bytes=2-5',
      'bytes=-3',
      'bytes=99-',
    ]);
  });

  it('are rate-limited per address', async () => {
    h.settings['devices.pxe.enabled'] = true;
    for (let i = 0; i < 5; i++) expect((await get(`/boot/ipxe/${token}`)).status).toBe(200);
    const r = await get(`/boot/ipxe/${token}`);
    expect(r.status).toBe(429);
    expect(JSON.parse(r.text)).toMatchObject({ error: { code: 'rate_limited' } });
  });
});

describe('boot tokens', () => {
  it('keeps only the hash, rotates and revokes', async () => {
    h.settings['devices.pxe.enabled'] = true;
    const rows = h.db.raw.prepare('SELECT token_hash FROM pxe_token').all() as {
      token_hash: string;
    }[];
    expect(rows).toEqual([{ token_hash: pxeTokenHash(token) }]);
    const v = await h.api('GET', `/api/v1/devices/${h.deviceId}/boot`);
    expect(v.json.pxe).toMatchObject({ active: true, lastUsedAt: null });
    expect(JSON.stringify(v.json)).not.toContain(token);
    const rotated = await h.api('POST', `/api/v1/devices/${h.deviceId}/boot/pxe/token`, {});
    const next = rotated.json.token as string;
    expect(next).not.toBe(token);
    expect(rotated.json.scriptUrl).toBe(`${h.url}/boot/ipxe/${next}`);
    expect((await get(`/boot/ipxe/${token}`)).status).toBe(404);
    expect((await get(`/boot/ipxe/${next}`)).status).toBe(200);
    const revoked = await h.api('DELETE', `/api/v1/devices/${h.deviceId}/boot/pxe/token`);
    expect(revoked.json).toMatchObject({ active: false });
    expect((await get(`/boot/ipxe/${next}`)).status).toBe(404);
    expect(JSON.stringify(h.audit)).not.toContain(next);
  });

  it('lists the images for the owner', async () => {
    const r = await h.api('GET', '/api/v1/devices/boot-images');
    expect(r.json).toMatchObject({ enabled: false, folder: images });
    expect((r.json.items as { name: string }[]).map((i) => i.name)).toEqual([
      'debian-13.ipxe',
      'memtest.efi',
    ]);
  });
});
