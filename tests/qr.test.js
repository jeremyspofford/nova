// The QR encoder (ui/js/qr.js) is checked by decoding what it draws with an independent decoder
// (jsqr, a test-only dependency): every version from 1 to 10, every mask, URL-shaped and
// non-ASCII text, and the SVG's quiet zone and colour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { MAX_VERSION, qrEncode, qrSvg } from '../ui/js/qr.js';

// The modules as an RGBA image: `scale` pixels per module, a four-module light quiet zone.
function image({ size, dark }, scale = 4) {
  const n = (size + 8) * scale;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!dark[y * size + x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + 4) * scale + dy) * n + (x + 4) * scale + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  return { px, n };
}

const decode = (q) => { const { px, n } = image(q); return jsQR(px, n, n, { inversionAttempts: 'dontInvert' }); };

test('decodes back exactly, at every version from 1 to 10', () => {
  // Byte capacities at level M: 14, 26, 42, 62, 84, 106, 122, 152, 180, 213.
  const caps = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  for (let v = 1; v <= MAX_VERSION; v++) {
    for (const len of [caps[v - 1], v > 1 ? caps[v - 2] + 1 : 1]) {
      const text = `https://hub.example:4320/pair#c=ABCD-EFGH&h=${'X'.repeat(200)}`.slice(0, len);
      const q = qrEncode(text);
      assert.equal(q.version, v, `${len} bytes is version ${v}`);
      assert.equal(q.size, v * 4 + 17);
      const got = decode(q);
      assert.ok(got, `version ${v}, ${len} bytes: jsQR found no code`);
      assert.equal(got.data, text);
      assert.equal(got.version, v);
    }
  }
  assert.throws(() => qrEncode('x'.repeat(214)), /too long/);
});

test('every mask decodes, with and without version information, and UTF-8 round-trips', () => {
  for (const len of [20, 60, 130, 200]) {
    const text = `https://hub.example:4320/pair#c=ABCD-EFGH&h=${'ABCD-'.repeat(40)}`.slice(0, len);
    for (let mask = 0; mask < 8; mask++) {
      const q = qrEncode(text, { mask });
      assert.equal(q.mask, mask);
      assert.equal(decode(q)?.data, text, `${len} bytes (version ${q.version}), mask ${mask}`);
    }
  }
  const words = 'Caf\u00e9 \u2014 \u00fcber 東京';
  assert.equal(decode(qrEncode(words))?.data, words, 'UTF-8 in byte mode');
});

test('the SVG: one currentColor path, a four-module quiet zone, a label, no raw colours', () => {
  const svg = qrSvg('https://hub.example:4320/pair#c=ABCD-EFGH', { label: 'Scan to pair "this" & that' });
  const q = qrEncode('https://hub.example:4320/pair#c=ABCD-EFGH');
  assert.match(svg, new RegExp(`viewBox="0 0 ${q.size + 8} ${q.size + 8}"`));
  assert.match(svg, /<path fill="currentColor" d="M4 4h7v1h-7z/, 'the top-left finder starts inside the quiet zone');
  assert.equal((svg.match(/<path/g) ?? []).length, 1);
  assert.doesNotMatch(svg, /#[0-9a-f]{3,6}|rgb|fill="(?!currentColor)/i);
  assert.match(svg, /aria-label="Scan to pair &quot;this&quot; &amp; that"/);
  assert.match(svg, /class="qr"/);
});
