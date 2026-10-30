// M9 (DESIGN-SYSTEM §1 "Progress and waiting", binding): the timing bands, real units, general
// estimates, and no artificial delay or simulated streaming anywhere in the PWA. The pure rules are
// in ui/js/wait.js; the browser half is tests/ui/m9-progress.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { QUIET_MS, LONG_MS, band, units, about, left, usually, sofar, longWords, waitingLine } from '../ui/js/wait.js';

test('the bands: nothing under 1 s, an indicator to 10 s, then real progress', () => {
  assert.equal(QUIET_MS, 1000);
  assert.equal(LONG_MS, 10000);
  assert.equal(band(0), 'quiet');
  assert.equal(band(999), 'quiet');
  assert.equal(band(1000), 'indicator');
  assert.equal(band(9999), 'indicator');
  assert.equal(band(10000), 'progress');
  assert.equal(band(NaN), 'quiet');
});

test('progress is in real units: no fraction without a total, never full before it is done', () => {
  assert.deepEqual(units(3, 9), { text: '3 of 9 parts', value: 3, max: 9 });
  assert.deepEqual(units(1, 1, 'step'), { text: '1 of 1 step', value: 1, max: 1 });
  assert.deepEqual(units(4, null, 'step'), { text: '4 steps done', value: null, max: null }, 'unknown total: no bar, no percentage');
  assert.deepEqual(units(0, 0), { text: '', value: null, max: null });
  // 8 of 9 is 8 of 9: the bar shows the real count, so it can't sprint to 99% and hang.
  assert.equal(units(8, 9).value, 8);
  assert.equal(units(12, 9).value, 9, 'never past the total');
  for (const [d, t] of [[1, 3], [50, 100], [99, 100]]) assert.doesNotMatch(units(d, t).text, /%/);
});

test('a general estimate, in words, from a measured rate only, erring long', () => {
  assert.equal(about(5000), 'a few seconds');
  assert.equal(about(30000), 'about half a minute');
  assert.equal(about(70000), 'about a minute');
  assert.equal(about(5 * 60000), 'about 5 minutes');
  assert.equal(about(3600000), 'about an hour');
  assert.equal(about(3 * 3600000), 'about 3 hours');
  assert.equal(left(5, 10, 9000), '', 'not before a wait is long');
  assert.equal(left(0, 10, 20000), '', 'no basis until something is done');
  assert.equal(left(10, 10, 20000), '', 'nothing left');
  assert.equal(left(1, 4, 20000), 'about a minute left', '20 s for one of four: about a minute (60 s, padded)');
  assert.doesNotMatch(left(1, 4, 20000), /\d+ s/, 'never a countdown');
  assert.equal(usually([400, 600, 500]), 'under a second');
  assert.equal(usually([20000, 25000, 30000]), 'about half a minute');
  assert.equal(usually([5000]), '', 'one wait is no basis');
  assert.equal(sofar(14200), '14 s so far');
  assert.equal(sofar(130000), '2 min so far');
});

test('a long wait says what is done, an estimate where there is a basis, else the time so far', () => {
  assert.equal(longWords({ elapsed: 5000, done: 1, total: 4 }), '', 'under 10 s the indicator says enough');
  assert.equal(longWords({ elapsed: 20000, done: 1, total: 4 }), '1 of 4 parts · about a minute left');
  assert.equal(longWords({ elapsed: 12000, done: null }), '12 s so far');
  assert.equal(longWords({ elapsed: 12000, done: null, usual: 'under a second' }), '12 s so far · it usually takes under a second');
  assert.equal(longWords({ elapsed: 12000, done: 2, total: null, noun: 'step' }), '2 steps done · 12 s so far');
});

test('a waiting line carries when the wait began, so a redraw keeps its age; it is hidden for its first second', () => {
  const html = waitingLine('Loading your tasks', { since: 1000, done: 2, total: 12 });
  assert.match(html, /data-since="1000"/);
  assert.match(html, /data-done="2" data-total="12"/);
  assert.match(html, /role="status"/);
  assert.match(html, /class="waiting is-late is-long"/, 'a wait older than 1 s shows at once when redrawn (and this one is past 10 s)');
  assert.match(waitingLine('Loading', { since: Date.now() }), /class="waiting"/);
  const css = readFileSync('ui/styles/components.css', 'utf8');
  assert.match(css, /\.waiting \{[^}]*opacity: 0;/, 'a fresh waiting line starts unseen');
  assert.match(css, /\.waiting \{[^}]*animation: appear var\(--motion-duration-fast\) var\(--motion-ease\) var\(--wait-left\) forwards;/, 'and appears once the wait is 1 s old');
  assert.match(css, /--wait-quiet: 1000ms; --wait-left: var\(--wait-quiet\);/);
  assert.match(waitingLine('Loading', { since: Date.now() - 400 }), /style="--wait-left: (59\d|600)ms"/, 'a redraw keeps the wait’s own clock');
});

// ---- the code itself -----------------------------------------------------------------------

const UI = 'ui/js';
const sources = readdirSync(UI).filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(join(UI, f), 'utf8')]);

test('no artificial delay: every timer in the PWA is named for what it is', () => {
  // A timer is allowed only as: a poll of something really happening, a debounce, an expiry (a toast,
  // a mark), a long press, or the clock behind live words. Each carries a `wait:` note saying which.
  const unnamed = [];
  for (const [f, src] of sources) {
    src.split('\n').forEach((line, i) => {
      if (!/\b(setTimeout|setInterval)\(/.test(line)) return;
      const near = src.split('\n').slice(Math.max(0, i - 3), i + 1).join('\n');
      if (!/wait: (poll|debounce|expiry|long press|clock|retry|frame|after the event)/.test(near)) unnamed.push(`${f}:${i + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(unnamed, []);
});

test('no fake work: no “checking…” or padding, and every wait is drawn by wait.js', () => {
  const found = [];
  for (const [f, src] of sources) {
    if (f === 'wait.js' || f === 'styleguide.js') continue;
    for (const m of src.matchAll(/(['"`>])(Loading|Checking|Waiting for|Starting)[^'"`<]*…/g)) {
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      if (!/waitingLine\(\s*$/.test(before)) found.push(`${f}: ${m[0].slice(1, 50)}`);
    }
  }
  assert.deepEqual(found, []);
});

test('no simulated streaming: text grows only from the server’s deltas, never replayed', () => {
  const app = readFileSync('ui/js/app.js', 'utf8');
  // The live text is set in one place, from the delta event, and painted once per frame.
  const writes = [...app.matchAll(/state\.live\.text\s*=/g)].map((m) => app.slice(m.index - 320, m.index + 60));
  assert.ok(writes.length >= 1);
  for (const w of writes) assert.match(w, /addEventListener\('delta'|ev\.type === 'assistant'/, `live text is only written from a delta or cleared by the saved reply:\n${w}`);
  for (const [f, src] of sources) {
    assert.doesNotMatch(src, /(setInterval|setTimeout|requestAnimationFrame)\([^\n]*\.slice\(0,/, `${f}: no typewriter: text revealed a piece at a time on a timer`);
    assert.doesNotMatch(src, /typewriter|typeOut|revealText/i, `${f}: no typewriter`);
  }
});
