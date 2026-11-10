// The hub's one cleaner for what a paired device says (src/core/mesh/device-text.ts): terminal
// escapes and format characters out, control characters to a space, every string bounded, nesting
// bounded; plain words, numbers and booleans untouched. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_REPORT_DEPTH, DEVICE_TEXT_MAX, deviceReport, deviceText } from '../../src/core/mesh/device-text.ts';

test('deviceText: escapes, controls, bidi and zero-width characters out; plain words unchanged', () => {
  assert.equal(deviceText('\u001b[31mred\u001b[0m'), 'red', 'SGR colours');
  assert.equal(deviceText('a\u001b]0;title\u0007b\u001b]8;;https://x.example\u001b\\c'), 'abc', 'OSC title and hyperlink');
  assert.equal(deviceText('a\u009b2Jb\u001b(Bc\u001bcd'), 'abcd', '8-bit CSI, charset and reset escapes');
  assert.equal(deviceText('one\u0000two\r\nthree\u2028four\u0085five\u007fsix'), 'one two three four five six', 'NUL, CR LF, separators, C1 and DEL');
  assert.equal(deviceText('pay\u202eTXT.exe\u202c'), 'payTXT.exe', 'right-to-left override and pop');
  assert.equal(deviceText('\u2066iso\u2069 \u200bzero\u200d\ufeff \u061cmark \u00adsoft'), 'iso zero mark soft', 'isolates, zero-width, BOM, ALM, soft hyphen');
  assert.equal(deviceText('half \ud800 pair'), 'half  pair', 'a lone surrogate');
  for (const honest of ['Installed stand-in 1.0.0: signed by the hub, every file as pinned.', 'Kitchen Mac mini', 'café – naïve 東京 🙂 <b>&amp;</b>', '0.1.0+abc123def456']) {
    assert.equal(deviceText(honest), honest, honest);
  }
});

test('deviceText: bounded, for any input, without splitting a surrogate pair', () => {
  const big = 'x'.repeat(1_000_000);
  assert.equal(deviceText(big).length, DEVICE_TEXT_MAX);
  assert.equal(deviceText(big, 40), 'x'.repeat(40));
  assert.equal(deviceText(`${'\u001b[0m'.repeat(200_000)}ok`).length, 0, 'a flood of escapes is cut before it is cleaned');
  const emoji = `${'a'.repeat(39)}🙂`;
  assert.equal(deviceText(emoji, 40), 'a'.repeat(39), 'never half an emoji');
});

test('deviceReport: every string in a report cleaned, other values kept, nesting bounded', () => {
  const r = deviceReport({
    version: '0.1.0\u0000', safe_mode: false, queued: 3, none: null,
    workloads: [{ service: 'stand-in', said: 'ok\u202e\r\n', health: true }],
    hardware: { gpus: [{ name: '\u001b[1mGPU', vram_bytes: 8 }] },
  });
  assert.deepEqual(r, {
    version: '0.1.0 ', safe_mode: false, queued: 3, none: null,
    workloads: [{ service: 'stand-in', said: 'ok ', health: true }],
    hardware: { gpus: [{ name: 'GPU', vram_bytes: 8 }] },
  });
  let deep: unknown = 'bottom';
  for (let i = 0; i < 100_000; i++) deep = [deep];
  const out = deviceReport({ deep }) as { deep: unknown };
  let depth = 0;
  for (let v = out.deep; Array.isArray(v); v = v[0]) depth++;
  assert.ok(depth < DEVICE_REPORT_DEPTH, `kept ${depth} levels`);
});
