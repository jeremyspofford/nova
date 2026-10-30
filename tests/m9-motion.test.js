// M9 (Amendment 2026-10-30-C Part 2): animation tokens. Transitions and one-off animations take
// 150–300 ms, only transform and opacity move, nothing bounces, and reduced motion is honoured.
// Here: the package validation and the token lint. The browser half is tests/ui/m9-motion.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validatePackage, generateCss, MOTION_MIN_MS, MOTION_MAX_MS, overshoots } from '../src/core/index.ts';
import { lint } from '../scripts/lint-tokens.js';

const fixture = () => JSON.parse(readFileSync(new URL('./core/fixtures/design-system.json', import.meta.url), 'utf8'));
const msgs = (css, path = 'ui/x.css') => lint(path, css).map((p) => p[1]);

// Outside the range is a warning, and the CSS is clamped (a design made before M9 still applies:
// tests/core/design-before-m9.test.ts). Nova's own built-ins are in range (below).
test('a package’s transitions outside 150–300 ms are named, in every mode, and clamped', () => {
  assert.equal(MOTION_MIN_MS, 150);
  assert.equal(MOTION_MAX_MS, 300);
  for (const [token, value, ok] of [['motion/transition', '200ms', true], ['motion/duration-fast', '149ms', false], ['motion/duration-fast', '150ms', true], ['motion/duration-slow', '300ms', true], ['motion/duration-slow', '0.42s', false], ['motion/transition', '120ms', false]]) {
    const p = fixture();
    p.tokens[token] = value;
    const { problems, warnings } = validatePackage(p);
    assert.deepEqual(problems, [], `${token} ${value}: never a problem`);
    const said = warnings.some((x) => x.includes(token) && /150–300ms/.test(x));
    assert.equal(said, !ok, `${token} ${value}: ${warnings.join(' ')}`);
    const used = new RegExp(`--${token.replace('/', '-')}: (\\d+)ms;`).exec(generateCss(p, { mode: 'light' }))?.[1];
    assert.ok(Number(used) >= 150 && Number(used) <= 300, `${token} ${value}: the CSS uses ${used}ms`);
  }
  const p = fixture();
  p.modes = { dark: { 'motion/duration-slow': '450ms' } };
  assert.match(validatePackage(p).warnings.join(' '), /In dark mode, motion\/duration-slow should be 150–300ms/);
});

test('the loops (breathing, pulse) show a state as long as it lasts: not held to the range', () => {
  const p = fixture();
  p.tokens['motion/breathe'] = '6500ms';
  p.tokens['motion/pulse'] = '1800ms';
  assert.deepEqual(validatePackage(p).problems.filter((x) => /breathe|pulse/.test(x)), []);
  // …and reduced motion still stops them.
  assert.match(generateCss(p), /prefers-reduced-motion: reduce[\s\S]*--motion-breathe: 0s;[\s\S]*--motion-pulse: 0s;/);
});

test('no bounce or elastic: an easing curve may not overshoot', () => {
  assert.equal(overshoots('cubic-bezier(0.34, 1.56, 0.64, 1)'), true);
  assert.equal(overshoots('cubic-bezier(0.6, -0.28, 0.735, 0.045)'), true);
  assert.equal(overshoots('cubic-bezier(0.2, 0, 0, 1)'), false);
  assert.equal(overshoots('ease-out'), false);
  const p = fixture();
  p.tokens['motion/ease'] = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  assert.match(validatePackage(p).warnings.join(' '), /motion\/ease overshoots/);
  assert.doesNotMatch(generateCss(p, { mode: 'light' }), /--motion-ease: cubic-bezier\([^)]*1\.56/, 'the CSS never bounces');
});

test('every built-in design is within the range and doesn’t bounce', () => {
  for (const f of readdirSync('design-systems').filter((x) => x.endsWith('.json'))) {
    const p = JSON.parse(readFileSync(join('design-systems', f), 'utf8'));
    for (const t of ['motion/transition', 'motion/duration-fast', 'motion/duration-slow']) {
      const v = Number.parseFloat(p.tokens[t]) * (p.tokens[t].endsWith('ms') ? 1 : 1000);
      assert.ok(v >= 150 && v <= 300, `${f}: ${t} is ${p.tokens[t]}`);
    }
    assert.equal(overshoots(p.tokens['motion/ease']), false, `${f}: motion/ease`);
  }
});

test('the lint: only transform and opacity may transition', () => {
  const t = (decl) => msgs(`.a{transition:${decl}}`);
  assert.deepEqual(t('opacity var(--motion-duration-fast) var(--motion-ease)'), []);
  assert.deepEqual(t('opacity var(--motion-transition) var(--motion-ease), translate var(--motion-transition) var(--motion-ease), visibility 0s linear var(--motion-transition)'), []);
  assert.deepEqual(t('transform var(--motion-duration-slow) var(--motion-ease), scale var(--motion-duration-fast) var(--motion-ease), rotate var(--motion-duration-fast) var(--motion-ease)'), []);
  assert.match(t('background-color var(--motion-duration-fast) var(--motion-ease)').join(' '), /only transform and opacity animate: background-color/);
  assert.match(t('color var(--motion-duration-fast) var(--motion-ease)').join(' '), /only transform and opacity animate: color/);
  assert.match(t('all var(--motion-duration-fast) var(--motion-ease)').join(' '), /only transform and opacity animate: all/);
  assert.match(t('filter var(--motion-duration-slow) var(--motion-ease)').join(' '), /only transform and opacity animate: filter/);
  assert.match(t('visibility var(--motion-transition) linear').join(' '), /visibility only flips/);
  assert.match(msgs('.a{transition-property:width}').join(' '), /only transform and opacity animate: width/);
  assert.match(msgs('const x = `<span style="transition: left var(--motion-transition) var(--motion-ease)">`;', 'ui/x.js').join(' '), /only transform and opacity animate: left/);
});

test('the lint: a transition or one-off animation uses a 150–300 ms token as it is', () => {
  assert.match(msgs('.a{transition:opacity var(--motion-breathe) var(--motion-ease)}').join(' '), /--motion-transition, --motion-duration-fast or --motion-duration-slow/);
  assert.match(msgs('.a{transition:opacity calc(var(--motion-duration-slow) * 2) var(--motion-ease)}').join(' '), /--motion-transition, --motion-duration-fast or --motion-duration-slow/);
  assert.match(msgs('.a{animation:fade-in calc(var(--motion-duration-slow) * 4) var(--motion-ease) both}').join(' '), /--motion-transition, --motion-duration-fast or --motion-duration-slow/);
  assert.deepEqual(msgs('.a{animation:fade-in var(--motion-duration-slow) var(--motion-ease) both}'), []);
  // A loop shows a state; it may run as long as the state lasts.
  assert.deepEqual(msgs('.a{animation:breathe calc(var(--motion-duration-slow) * 3) var(--motion-ease) infinite alternate}'), []);
  assert.deepEqual(msgs('.a{animation:orb-pulse var(--motion-pulse) var(--motion-ease) infinite}'), []);
  assert.deepEqual(msgs('.a{animation:none}'), []);
  assert.match(msgs('const a = el.animate([{ opacity: 0 }], 200);', 'ui/x.js').join(' '), /animate\(\) bypasses the motion tokens/);
});

test('the lint: keyframes move only transform and opacity, and a one-off never bounces', () => {
  assert.deepEqual(msgs('@keyframes rise { from { opacity: 0; translate: 0 var(--space-1); } }'), []);
  assert.match(msgs('@keyframes found { from { background-color: var(--accent-primary); } to { background-color: transparent; } }').join(' '), /keyframes found: only transform and opacity animate: background-color/);
  assert.match(msgs('@keyframes grow { to { width: 100%; } }').join(' '), /only transform and opacity animate: width/);
  const pop = '@keyframes pop { 0% { scale: 1; } 50% { scale: 1.2; } 100% { scale: 1; } }';
  assert.match(msgs(`${pop} .a{animation:pop var(--motion-duration-fast) var(--motion-ease)}`).join(' '), /keyframes pop bounces: scale goes 1 → 1.2 → 1/);
  assert.deepEqual(msgs(`${pop} .a{animation:pop var(--motion-pulse) var(--motion-ease) infinite}`), [], 'a loop may go there and back');
  assert.deepEqual(msgs('@keyframes stamp { from { opacity: 0; scale: 1.35; } 60% { opacity: 1; } } .a{animation:stamp var(--motion-transition) var(--motion-ease) both}'), []);
});

test('ui/ itself passes the motion rules', () => {
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(css|js|html)$/.test(e.name) ? [join(dir, e.name)] : []));
  const motion = files('ui').flatMap((f) => lint(f).filter(([, m]) => /animate|keyframes|--motion-transition, --motion|visibility only/.test(m)).map(([l, m]) => `${f}:${l} ${m}`));
  assert.deepEqual(motion, []);
});
