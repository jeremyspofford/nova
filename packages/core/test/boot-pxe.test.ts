// Network boot from the Hub (FR-143, ADR-096 D5): per-device boot tokens kept only as hashes,
// shown once, rotated and revoked; the iPXE menu lists only images that exist in the folder;
// names cannot leave it; every fetch is audited.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, PXE_TOKEN_PREFIX } from '@nova/shared';
import { ipxeScript, pxeTokenHash } from '../src/index.ts';
import { ACCOUNT, bootEnv, type BootEnv } from './boot-env.ts';

const HUB = 'http://192.168.1.10:7419';
let t: BootEnv;

beforeEach(async () => {
  t = await bootEnv();
});

afterEach(async () => {
  await t.close();
});

describe('ipxeScript', () => {
  const token = `${PXE_TOKEN_PREFIX}${'A'.repeat(43)}`;

  it('offers each image and the local disk, chaining to the image routes', () => {
    const s = ipxeScript({ hubUrl: `${HUB}/`, token, images: ['debian.ipxe', 'memtest.efi'] });
    expect(s.startsWith('#!ipxe\n')).toBe(true);
    expect(s).toContain('item img1 debian.ipxe');
    expect(s).toContain('item img2 memtest.efi');
    expect(s).toContain(`chain --autofree ${HUB}/boot/images/${token}/debian.ipxe || goto failed`);
    expect(s).toContain('choose --default local --timeout 30000 target');
    expect(s).toMatch(/:local\nexit\n$/);
  });

  it('leaves out names that are not plain file names and says when there are none', () => {
    const s = ipxeScript({
      hubUrl: HUB,
      token,
      images: ['../etc/passwd', 'a b', '${x}', '.hidden'],
    });
    expect(s).toContain('No boot images on the Hub yet');
    expect(s).not.toContain('passwd');
    expect(s).not.toContain('${x}');
  });

  it('refuses a base URL with a path or credentials and a malformed token', () => {
    for (const hubUrl of ['http://user:pw@hub', 'http://hub/x', 'file:///etc', 'http://hub\nexit'])
      expect(() => ipxeScript({ hubUrl, token, images: [] }), hubUrl).toThrow(NovaError);
    expect(() => ipxeScript({ hubUrl: HUB, token: 'nvb_short', images: [] })).toThrow(NovaError);
    expect(() => ipxeScript({ hubUrl: 'http://[fe80::1]:7419', token, images: [] })).not.toThrow();
  });
});

describe('boot tokens', () => {
  it('shows the token once and keeps only its hash', async () => {
    const created = await t.pxe.createToken(ACCOUNT, t.deviceId, HUB);
    expect(created.token).toMatch(/^nvb_[A-Za-z0-9_-]{43}$/);
    expect(created.scriptUrl).toBe(`${HUB}/boot/ipxe/${created.token}`);
    expect(created).toMatchObject({ active: true, lastUsedAt: null });
    const rows = t.env.db.raw.prepare('SELECT * FROM pxe_token').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(pxeTokenHash(created.token));
    expect(JSON.stringify(rows)).not.toContain(created.token.slice(4));
    const view = await t.pxe.tokenView(ACCOUNT, t.deviceId);
    expect(view).toEqual({
      deviceId: t.deviceId,
      active: true,
      createdAt: created.createdAt,
      lastUsedAt: null,
    });
    expect(JSON.stringify(view)).not.toContain(created.token);
    // Neither events nor the audit carry it.
    expect(JSON.stringify(t.env.events.events)).not.toContain(created.token);
    expect(JSON.stringify(t.env.audit)).not.toContain(created.token);
    expect(t.env.audit.find((a) => a.action === 'device.boot.pxe.token')?.detail).toMatchObject({
      action: 'created',
      before: null,
    });
  });

  it('rotates (the old token stops working) and revokes', async () => {
    const first = await t.pxe.createToken(ACCOUNT, t.deviceId, HUB);
    const second = await t.pxe.createToken(ACCOUNT, t.deviceId, HUB);
    expect(t.pxe.holder(first.token)).toBeNull();
    expect(t.pxe.holder(second.token)).toMatchObject({ accountId: ACCOUNT, deviceId: t.deviceId });
    expect(
      t.env.audit.filter((a) => a.action === 'device.boot.pxe.token').map((a) => a.detail?.action),
    ).toEqual(['created', 'rotated']);
    expect(await t.pxe.revokeToken(ACCOUNT, t.deviceId)).toMatchObject({ active: false });
    expect(t.pxe.holder(second.token)).toBeNull();
    expect(await t.pxe.script(second.token, HUB, '192.168.1.50')).toBeNull();
  });

  it("stops a revoked device's token", async () => {
    const c = await t.pxe.createToken(ACCOUNT, t.deviceId, HUB);
    await t.env.svc.revoke(ACCOUNT, t.deviceId);
    // Even before the revocation hook ran, a revoked device's token is refused.
    expect(t.pxe.holder(c.token)).toBeNull();
    await t.pxe.onDeviceRevoked(ACCOUNT, t.deviceId);
    expect((await t.pxe.tokenView(ACCOUNT, t.deviceId)).active).toBe(false);
    await expect(t.pxe.createToken(ACCOUNT, t.deviceId, HUB)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('refuses tokens that are not boot tokens', () => {
    for (const bad of ['', 'nvb_', 'nvs_' + 'A'.repeat(43), `nvb_${'A'.repeat(43)}x`])
      expect(t.pxe.holder(bad)).toBeNull();
  });
});

describe('images', () => {
  beforeEach(() => {
    writeFileSync(join(t.imagesDir, 'debian-13.ipxe'), '#!ipxe\nchain http://example.invalid/x\n');
    writeFileSync(join(t.imagesDir, 'memtest.efi'), Buffer.alloc(1024, 7));
    writeFileSync(join(t.imagesDir, '.hidden'), 'x');
    writeFileSync(join(t.imagesDir, 'has space.efi'), 'x');
    mkdirSync(join(t.imagesDir, 'folder.efi'));
    writeFileSync(join(t.env.dir, 'secret.txt'), 'top secret');
    symlinkSync(join(t.env.dir, 'secret.txt'), join(t.imagesDir, 'link.efi'));
  });

  it('lists only regular files with plain names', () => {
    expect(t.pxe.images().map((i) => i.name)).toEqual(['debian-13.ipxe', 'memtest.efi']);
    expect(t.pxe.images()[1]).toMatchObject({ size: 1024 });
  });

  it('serves the menu of existing images and audits the fetch', async () => {
    const c = await t.pxe.createToken(ACCOUNT, t.deviceId, HUB);
    t.advance(5_000);
    const s = (await t.pxe.script(c.token, HUB, '192.168.1.50'))!;
    expect(s).toContain('item img1 debian-13.ipxe');
    expect(s).toContain('item img2 memtest.efi');
    expect(s).not.toContain('link.efi');
    expect(s).not.toContain('folder.efi');
    expect(t.env.audit.at(-1)).toMatchObject({
      action: 'device.boot.pxe.script',
      resource: t.deviceId,
      detail: { from: '192.168.1.50', images: 2 },
    });
    expect((await t.pxe.tokenView(ACCOUNT, t.deviceId)).lastUsedAt).toBe(
      new Date(t.env.clock.now).toISOString(),
    );
  });

  it('serves an image by name and refuses traversal, links, folders and unknown names', async () => {
    const c = await t.pxe.createToken(ACCOUNT, t.deviceId, HUB);
    const file = await t.pxe.image(c.token, 'memtest.efi', '192.168.1.50', 'bytes=0-99');
    expect(file).toMatchObject({ size: 1024, path: join(t.imagesDir, 'memtest.efi') });
    expect(t.env.audit.at(-1)).toMatchObject({
      action: 'device.boot.pxe.image',
      detail: { name: 'memtest.efi', size: 1024, range: 'bytes=0-99' },
    });
    for (const name of [
      '../secret.txt',
      '..',
      '.',
      'a/../memtest.efi',
      '%2e%2e',
      '..%2fsecret.txt',
      'link.efi',
      'folder.efi',
      'missing.efi',
      '.hidden',
      '/etc/passwd',
    ])
      expect(await t.pxe.image(c.token, name, 'x', null), name).toBeNull();
    expect(
      await t.pxe.image(`${PXE_TOKEN_PREFIX}${'B'.repeat(43)}`, 'memtest.efi', 'x', null),
    ).toBeNull();
  });

  it('offers nothing when the folder does not exist', async () => {
    await t.close();
    t = await bootEnv();
    const c = await t.pxe.createToken(ACCOUNT, t.deviceId, HUB);
    const { rmSync } = await import('node:fs');
    rmSync(t.imagesDir, { recursive: true });
    expect(t.pxe.images()).toEqual([]);
    expect(await t.pxe.script(c.token, HUB, 'x')).toContain('No boot images');
    expect(await t.pxe.image(c.token, 'memtest.efi', 'x', null)).toBeNull();
  });
});
