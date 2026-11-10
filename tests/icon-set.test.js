// Nova's icon set (owner, 2026-11-10): one master artwork, used exactly as given, sized out per
// platform by scripts/app-icon.py. Only formats, sizes and backgrounds change. These tests pin that:
// the master is the owner's file byte for byte, the in-app mark is that master inside a transparent
// SVG, losslessly, and the iOS icon has no alpha channel (App Store Connect rejects one that does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel));
// The owner's artwork, cut from its white background to real transparency (2026-11-10).
const MASTER_SHA256 = '715e74d856bae1a2342ef01a6e87a600239a00ad5de1bb8ac55da10070a71db0';

// A PNG's IHDR (width, height, colour type) and the names of its chunks.
function png(rel) {
  const b = read(rel);
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${rel} is a PNG`);
  const chunks = [];
  for (let at = 8; at < b.length;) {
    const len = b.readUInt32BE(at);
    chunks.push(b.subarray(at + 4, at + 8).toString('latin1'));
    at += 12 + len;
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colourType: b[25], chunks };
}
const RGB = 2, RGBA = 6;

test('the master is the owner’s artwork, unchanged: 1024 px, RGBA', () => {
  assert.equal(createHash('sha256').update(read('ui/icons/mark-master-1024.png')).digest('hex'), MASTER_SHA256);
  const m = png('ui/icons/mark-master-1024.png');
  assert.deepEqual([m.width, m.height, m.colourType], [1024, 1024, RGBA]);
});

test('the in-app mark is the master in a transparent SVG, embedded losslessly', () => {
  const svg = read('ui/icons/mark.svg').toString('utf8');
  // 1024 px intrinsic size, a power of two, so the status icon can mipmap it.
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1024" height="1024" viewBox="0 0 1024 1024">/);
  // Nothing drawn but the one image: no background, no shape, no filter, no external reference.
  const tags = [...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]);
  assert.deepEqual(tags, ['svg', 'image']);
  const hrefs = [...svg.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 1);
  assert.match(hrefs[0], /^data:image\/webp;base64,/);
  losslessWebp(Buffer.from(hrefs[0].split(',')[1], 'base64'), 1024, 'mark.svg');
});

// A lossless WebP with alpha, at `px` square. VP8L is WebP's lossless bitstream; its header holds
// width − 1 and height − 1 in 14 bits each, then the alpha flag.
function losslessWebp(webp, px, name) {
  assert.equal(webp.subarray(0, 4).toString('latin1'), 'RIFF', name);
  assert.equal(webp.subarray(8, 12).toString('latin1'), 'WEBP', name);
  assert.equal(webp.subarray(12, 16).toString('latin1'), 'VP8L', `${name}: lossless WebP`);
  const bits = webp.readUInt32LE(21);
  assert.deepEqual([(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1], [px, px], `${name}: ${px} px`);
  assert.equal((bits >> 28) & 1, 1, `${name}: carries alpha`);
}

test('the mark’s small source is a lossless downscale, small enough for every small use', () => {
  // Owner, 2026-11-10: small uses get a small source, never the master.
  losslessWebp(read('ui/icons/mark-128.webp'), 128, 'mark-128.webp');
  assert.ok(read('ui/icons/mark-128.webp').length < 32 * 1024, 'the small source stays under 32 KB');
});

test('the app loads the small source now and the master only for a hero; the styleguide has both', () => {
  // The hero keeps the full master (owner, 2026-11-10); scripts/app-icon.py HERO is the switch.
  const index = read('ui/index.html').toString('utf8');
  assert.deepEqual([...index.matchAll(/<img data-nova-mark ([^>]*)>/g)].map((m) => m[1]), [
    'src="/icons/mark-128.webp" alt="" hidden',
    'data-src="/icons/mark.svg" alt="" hidden',
  ]);
  const styleguide = read('ui/styleguide.html').toString('utf8');
  assert.deepEqual([...styleguide.matchAll(/<img data-nova-mark src="([^"]+)"/g)].map((m) => m[1]), ['/icons/mark-128.webp', '/icons/mark.svg']);
  assert.match(read('ui/pair.html').toString('utf8'), /<img data-nova-mark src="data:image\/webp;base64,/);
  const sw = read('ui/sw.js').toString('utf8');
  assert.match(sw, /'\/icons\/mark-128\.webp'/, 'the service worker keeps the small source offline');
  assert.doesNotMatch(sw, /\/icons\/mark(-512\.webp|\.svg)/, 'and never precaches the large ones');
  for (const gone of ['ui/icons/mark-1024.webp', 'ui/icons/mark-vortex-512.webp', 'ui/assets/nova-mark.webp']) {
    assert.ok(!existsSync(join(ROOT, gone)), `${gone} (the old tiled mark) is gone`);
  }
});

test('the iOS icon is fully opaque: RGB, no alpha channel, no transparency chunk', () => {
  for (const [rel, px] of [['ui/icons/ios-1024.png', 1024], ['ui/icons/apple-touch-icon-180.png', 180]]) {
    const p = png(rel);
    assert.deepEqual([p.width, p.height, p.colourType], [px, px, RGB], rel);
    assert.ok(!p.chunks.includes('tRNS'), `${rel} has no tRNS chunk`);
  }
});

test('web and Android icons are transparent; the maskable one is full bleed', () => {
  for (const px of [32, 192, 512]) {
    const p = png(`ui/icons/icon-${px}.png`);
    assert.deepEqual([p.width, p.height, p.colourType], [px, px, RGBA], `icon-${px}.png`);
  }
  const m = png('ui/icons/maskable-512.png');
  assert.deepEqual([m.width, m.height, m.colourType], [512, 512, RGB]);
});

test('every icon the manifest and the app shell name exists', () => {
  const manifest = JSON.parse(read('ui/manifest.webmanifest').toString('utf8'));
  const html = read('ui/index.html').toString('utf8');
  const named = [...manifest.icons.map((i) => i.src), ...[...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1])];
  assert.ok(named.includes('/icons/apple-touch-icon-180.png'));
  for (const src of named) assert.ok(existsSync(join(ROOT, 'ui', src)), `${src} exists`);
});
