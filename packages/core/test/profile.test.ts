// Profile (FR-113): display name, a unique username, and an avatar that is validated by its
// bytes, stripped of metadata (EXIF for JPEG, text chunks for PNG, EXIF/XMP for WebP) and stored
// as a sealed blob; replacing or removing it deletes the old blob.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AVATAR_MAX_BYTES,
  ProfileService,
  prepareAvatar,
  sniffImage,
  stripJpeg,
  stripPng,
  stripWebp,
  useBlobKey,
} from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

// ---- tiny image builders (structure only; the pixels do not matter) -------------------------------

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(withMeta = true): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(withMeta
      ? [
          pngChunk('tEXt', Buffer.from('Author\0Somebody Private', 'latin1')),
          pngChunk('eXIf', Buffer.from('MM\0*GPSLatitude', 'latin1')),
        ]
      : []),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpegSegment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

function jpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    jpegSegment(0xe1, Buffer.from('Exif\0\0MM\0*GPSLatitude 40.0N', 'latin1')),
    jpegSegment(0xfe, Buffer.from('a private comment', 'latin1')),
    jpegSegment(0xdb, Buffer.alloc(65, 1)),
    jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function riffChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webp(): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04; // EXIF and XMP present
  const body = Buffer.concat([
    riffChunk('VP8X', vp8x),
    riffChunk('VP8 ', Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01])),
    riffChunk('EXIF', Buffer.from('MM\0*GPSLatitude', 'latin1')),
    riffChunk('XMP ', Buffer.from('<x:xmpmeta>private</x:xmpmeta>', 'latin1')),
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

const b64 = (b: Buffer) => b.toString('base64');

// ---- avatar handling --------------------------------------------------------------------------

describe('avatar images', () => {
  it('recognises PNG, JPEG and WebP by their bytes', () => {
    expect(sniffImage(png())).toBe('image/png');
    expect(sniffImage(jpeg())).toBe('image/jpeg');
    expect(sniffImage(webp())).toBe('image/webp');
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
  });

  it('strips EXIF, XMP and comments from a JPEG and keeps the image data', () => {
    const out = stripJpeg(jpeg());
    expect(out.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(out.includes(Buffer.from('private comment'))).toBe(false);
    expect(out.includes(Buffer.from('JFIF'))).toBe(true);
    expect(out.subarray(-7)).toEqual(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]));
    expect(sniffImage(out)).toBe('image/jpeg');
  });

  it('strips the text and EXIF chunks of a PNG', () => {
    const out = stripPng(png());
    expect(out.includes(Buffer.from('tEXt'))).toBe(false);
    expect(out.includes(Buffer.from('eXIf'))).toBe(false);
    expect(out).toEqual(png(false));
  });

  it('strips the EXIF and XMP chunks of a WebP and clears their flags', () => {
    const out = stripWebp(webp());
    expect(out.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(out.includes(Buffer.from('xmpmeta'))).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20]! & 0x0c).toBe(0);
    expect(sniffImage(out)).toBe('image/webp');
  });

  it('refuses bad base64, an empty or oversized image, a mismatched type and damaged files', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (err) {
        return (err as { details?: { reason?: string } }).details?.reason;
      }
    };
    expect(code(() => prepareAvatar('image/png', '***'))).toBe('encoding');
    expect(code(() => prepareAvatar('image/png', ''))).toBe('empty');
    const big = Buffer.concat([png(false), Buffer.alloc(AVATAR_MAX_BYTES)]);
    expect(code(() => prepareAvatar('image/png', b64(big)))).toBe('size');
    expect(code(() => prepareAvatar('image/jpeg', b64(png())))).toBe('content');
    expect(code(() => prepareAvatar('image/jpeg', b64(jpeg().subarray(0, 12))))).toBe('content');
    expect(code(() => prepareAvatar('image/png', b64(png().subarray(0, 30))))).toBe('content');
    const badWebp = webp();
    badWebp.writeUInt32LE(9999, 4);
    expect(code(() => prepareAvatar('image/webp', b64(badWebp)))).toBe('content');
    // A data: URL prefix is accepted.
    expect(prepareAvatar('image/png', `data:image/png;base64,${b64(png())}`)).toEqual(png(false));
  });
});

// ---- the profile service ----------------------------------------------------------------------

let env: Env;
let profile: ProfileService;
let dataDir: string;
beforeEach(async () => {
  env = await makeEnv();
  dataDir = join(env.dir, 'data');
  profile = new ProfileService({ db: env.db, dataDir, events: env.events });
});
afterEach(async () => {
  useBlobKey(dataDir, null);
  await env.close();
});

const OTHER = '01920000-0000-7000-8000-0000000000aa';
function addAccount(id: string): void {
  const now = new Date().toISOString();
  env.db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Other', ?, ?)",
    )
    .run(id, now, now);
}

describe('ProfileService', () => {
  it('reads and updates the display name and username', async () => {
    expect(await profile.get(ACCOUNT)).toMatchObject({
      accountId: ACCOUNT,
      displayName: 'Owner',
      username: null,
      hasAvatar: false,
    });
    const v = await profile.update(ACCOUNT, { displayName: '  Jeremy ', username: 'jeremy' });
    expect(v).toMatchObject({ displayName: 'Jeremy', username: 'jeremy' });
    expect(await profile.update(ACCOUNT, { displayName: '   ' })).toMatchObject({
      displayName: null,
      username: 'jeremy',
    });
    expect(await profile.update(ACCOUNT, { username: null })).toMatchObject({ username: null });
    const evt = env.events.events.filter((e) => e.name === 'account.updated');
    expect(evt.map((e) => e.payload.fields)).toEqual([
      ['displayName', 'username'],
      ['displayName'],
      ['username'],
    ]);
  });

  it('keeps usernames unique across accounts', async () => {
    addAccount(OTHER);
    await profile.update(OTHER, { username: 'taken' });
    await expect(profile.update(ACCOUNT, { username: 'taken' })).rejects.toMatchObject({
      code: 'conflict',
      details: { field: 'username' },
    });
    // The database refuses it too, whatever the service checks.
    expect(() =>
      env.db.raw.prepare("UPDATE account SET username = 'taken' WHERE id = ?").run(ACCOUNT),
    ).toThrow(/UNIQUE/);
    // An account can keep its own name.
    expect(await profile.update(OTHER, { username: 'taken' })).toMatchObject({ username: 'taken' });
    await expect(profile.get('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('stores the avatar sealed, without its metadata, and serves it back', async () => {
    useBlobKey(dataDir, randomBytes(32));
    const v = await profile.update(ACCOUNT, { avatar: { mime: 'image/jpeg', data: b64(jpeg()) } });
    expect(v.hasAvatar).toBe(true);
    const row = env.db.raw.prepare('SELECT avatar_path FROM account WHERE id = ?').get(ACCOUNT) as {
      avatar_path: string;
    };
    const onDisk = readFileSync(join(dataDir, row.avatar_path));
    expect(onDisk.includes(Buffer.from('JFIF'))).toBe(false); // encrypted at rest
    const image = await profile.avatar(ACCOUNT);
    expect(image?.mime).toBe('image/jpeg');
    expect(image!.bytes).toEqual(stripJpeg(jpeg()));
    expect(image!.bytes.includes(Buffer.from('GPSLatitude'))).toBe(false);
  });

  it('replaces and removes the avatar, deleting the old blob', async () => {
    await profile.update(ACCOUNT, { avatar: { mime: 'image/png', data: b64(png()) } });
    const first = (
      env.db.raw.prepare('SELECT avatar_path FROM account WHERE id = ?').get(ACCOUNT) as {
        avatar_path: string;
      }
    ).avatar_path;
    expect(existsSync(join(dataDir, first))).toBe(true);
    await profile.update(ACCOUNT, { avatar: { mime: 'image/webp', data: b64(webp()) } });
    expect(existsSync(join(dataDir, first))).toBe(false);
    expect((await profile.avatar(ACCOUNT))?.mime).toBe('image/webp');
    const second = (
      env.db.raw.prepare('SELECT avatar_path FROM account WHERE id = ?').get(ACCOUNT) as {
        avatar_path: string;
      }
    ).avatar_path;
    expect(await profile.update(ACCOUNT, { avatar: null })).toMatchObject({ hasAvatar: false });
    expect(existsSync(join(dataDir, second))).toBe(false);
    expect(await profile.avatar(ACCOUNT)).toBeNull();
  });

  it('keeps a blob another account still uses, and treats a missing blob as no avatar', async () => {
    addAccount(OTHER);
    await profile.update(ACCOUNT, { avatar: { mime: 'image/png', data: b64(png()) } });
    await profile.update(OTHER, { avatar: { mime: 'image/png', data: b64(png()) } });
    const path = (
      env.db.raw.prepare('SELECT avatar_path FROM account WHERE id = ?').get(ACCOUNT) as {
        avatar_path: string;
      }
    ).avatar_path;
    await profile.update(ACCOUNT, { avatar: null });
    expect(existsSync(join(dataDir, path))).toBe(true);
    expect((await profile.avatar(OTHER))?.mime).toBe('image/png');
    env.db.raw
      .prepare("UPDATE account SET avatar_path = 'blobs/attachments/gone' WHERE id = ?")
      .run(OTHER);
    expect(await profile.avatar(OTHER)).toBeNull();
  });

  it('refuses an invalid avatar without changing the profile', async () => {
    await expect(
      profile.update(ACCOUNT, {
        displayName: 'New',
        avatar: { mime: 'image/png', data: b64(jpeg()) },
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      details: { field: 'avatar', reason: 'content' },
    });
    expect(await profile.get(ACCOUNT)).toMatchObject({ displayName: 'Owner', hasAvatar: false });
  });
});
