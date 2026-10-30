// A design made before M9 (review of PR #234, must-fix 1): M9 holds Nova's own motion to 150–300 ms
// and its live contrast check to the page gradient's worse end, but a person's design built from a
// pre-M9 starter must still validate, still apply, and still be offered. Out-of-range motion is
// clamped when the CSS is generated and reported as a warning; contrast beyond validation's own
// pairs is the live check's (and its one-tap fix's) business, never a reason to drop the design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Profile } from '../../src/core/profile.ts';
import { Extensions } from '../../src/core/extensions.ts';
import { Design, generateCss, validatePackage } from '../../src/core/design.ts';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/design-system.json', import.meta.url), 'utf8'));

// Orb Teal as it shipped before M9, copied by a person under their own name.
function oldOrbTeal() {
  const p = JSON.parse(readFileSync(new URL('../../design-systems/orb-teal.json', import.meta.url), 'utf8'));
  Object.assign(p, { id: 'example.my-teal', name: 'My Teal', version: '1.0.0' });
  Object.assign(p.tokens, {
    'motion/transition': '240ms', 'motion/duration-fast': '160ms', 'motion/duration-slow': '420ms',
    'status/error': '#ff8f85', 'text/secondary': '#b8d6d2',
  });
  return p;
}

test('the fixture is a pre-M9 design: its motion is outside 150–300 ms, as it always was', () => {
  const p = fixture();
  assert.equal(p.tokens['motion/duration-fast'], '120ms');
  assert.equal(p.tokens['motion/duration-slow'], '320ms');
});

test('a design with pre-M9 motion still validates; the motion is a warning, not a problem', () => {
  for (const p of [fixture(), oldOrbTeal()]) {
    const v = validatePackage(p);
    assert.deepEqual(v.problems, [], `${p.id}: no problems`);
    assert.equal(v.ok, true);
    assert.match(v.warnings.join(' '), /motion\/duration-(fast|slow).*150–300ms/, `${p.id}: the motion is named as a warning`);
  }
  const bouncy = fixture();
  bouncy.tokens['motion/ease'] = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  const v = validatePackage(bouncy);
  assert.equal(v.ok, true);
  assert.match(v.warnings.join(' '), /motion\/ease overshoots/);
});

test('the CSS a pre-M9 design becomes is clamped to 150–300 ms and never bounces', () => {
  const css = generateCss(fixture(), { mode: 'light' });
  assert.match(css, /--motion-duration-fast: 150ms;/, '120 ms is brought up to 150');
  assert.match(css, /--motion-duration-slow: 300ms;/, '320 ms is brought down to 300');
  assert.match(css, /--motion-transition: 200ms;/, 'in range: unchanged');
  assert.match(css, /--motion-breathe: 6000ms;/, 'loops are a state, not clamped');
  const bouncy = fixture();
  bouncy.tokens['motion/ease'] = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  const b = generateCss(bouncy, { mode: 'light' });
  assert.match(b, /--motion-ease: cubic-bezier\(0\.34, 1, 0\.64, 1\);/, 'the overshoot is clipped to the end it was heading for');
  // Reduced motion is untouched by the clamp.
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*--motion-duration-fast: 1ms;/);
});

test('validation’s contrast is what it was: an old Orb Teal copy is not disabled by M9’s stricter live check', () => {
  const v = validatePackage(oldOrbTeal());
  assert.deepEqual(v.problems, [], 'the old error colour on cards was valid before M9 and still is');
});

test('a pre-M9 design installed by a person still applies, still shows, and is offered without “Has problems”', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-design-old-'));
  const db = new Db(':memory:');
  db.migrate();
  const extensions = new Extensions({ db, home, novaVersion: '0.1.0' });
  const design = new Design({ extensions, profile: new Profile(db) });
  design.ensureBuiltins();
  for (const p of [oldOrbTeal(), Object.assign(fixture(), { id: 'example.fixture', name: 'Fixture' })]) {
    extensions.install(p);
    extensions.enable(p.id);
    design.apply(p.id, { scope: 'user' });
    assert.equal(design.active().id, p.id, `${p.id}: it is what shows, not a silent fallback`);
    const listed = design.list().find((d) => d.id === p.id)!;
    assert.equal(listed.valid, true, `${p.id}: offered as valid`);
    assert.deepEqual(listed.problems, []);
    assert.ok(listed.warnings.length > 0, `${p.id}: its motion is mentioned as a warning`);
    assert.match(design.css(), /--motion-duration-(fast: 150ms|slow: 300ms)/, `${p.id}: and its CSS is clamped`);
  }
});
