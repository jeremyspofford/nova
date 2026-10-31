import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Profile } from '../../src/core/profile.ts';
import { Extensions } from '../../src/core/extensions.ts';
import {
  BUILTIN_DIR, CONTENT_RULES, DEFAULT_DESIGN_SYSTEM, Design, TOKENS, TOKEN_NAMES,
  contrast, cssVar, generateCss, validatePackage,
} from '../../src/core/design.ts';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/design-system.json', import.meta.url), 'utf8'));
const withTokens = (over: Record<string, unknown>) => { const p = fixture(); Object.assign(p.tokens, over); return p; };
const problems = (pkg: unknown) => validatePackage(pkg).problems.join('\n');

function host() {
  const home = mkdtempSync(join(tmpdir(), 'nova-design-'));
  const db = new Db(':memory:');
  db.migrate();
  const profile = new Profile(db);
  const extensions = new Extensions({ db, home, novaVersion: '0.1.0' });
  const design = new Design({ extensions, profile });
  design.ensureBuiltins();
  const events: Record<string, unknown>[] = [];
  design.on('change', (c) => events.push(c));
  return { db, profile, extensions, design, events };
}

// ---- the schema ---------------------------------------------------------------------

test('the schema is DESIGN-SYSTEM §2 in full, plus the weights, line heights, durations and easing', () => {
  const required = [
    'bg/base', 'bg/raised', 'bg/overlay', 'surface/card', 'surface/card-hover', 'text/primary', 'text/secondary', 'text/faint',
    'border/subtle', 'border/strong', 'accent/primary', 'accent/secondary', 'status/ok', 'status/working', 'status/waiting',
    'status/attention', 'status/error', 'orb/core', 'orb/glow', 'orb/listening', 'orb/attention',
    'font/display', 'font/body', 'font/mono', 'type/h1', 'type/h2', 'type/h3', 'type/body', 'type/small', 'type/caption',
    'type/weight-regular', 'type/weight-strong', 'type/line-tight', 'type/line-body',
    'space/1', 'space/2', 'space/3', 'space/4', 'space/5', 'space/6', 'space/7', 'space/8',
    'radius/card', 'radius/pill', 'radius/input', 'shadow/card', 'shadow/raised', 'blur/glass',
    'motion/breathe', 'motion/pulse', 'motion/transition', 'motion/duration-fast', 'motion/duration-slow', 'motion/ease',
    'layout/rail-width', 'layout/content-max', 'layout/card-gap',
  ];
  assert.deepEqual([...TOKEN_NAMES].sort(), [...required].sort());
  for (const name of TOKEN_NAMES) assert.ok(TOKENS[name]!.group && TOKENS[name]!.syntax, name);
});

test('token names become CSS variables by replacing / with -', () => {
  assert.equal(cssVar('bg/base'), '--bg-base');
  assert.equal(cssVar('type/h1'), '--type-h1');
  assert.equal(cssVar('space/3'), '--space-3');
  assert.equal(cssVar('motion/breathe'), '--motion-breathe');
  assert.equal(cssVar('surface/card-hover'), '--surface-card-hover');
});

// ---- validation: every failure kind, in plain words ------------------------------------

test('the example third-party package is valid', () => {
  assert.deepEqual(validatePackage(fixture()).problems, []);
  assert.equal(validatePackage(fixture()).ok, true);
});

test('completeness: every missing token is named', () => {
  const p = fixture();
  delete p.tokens['bg/base'];
  delete p.tokens['motion/ease'];
  const out = problems(p);
  assert.match(out, /Missing token bg\/base\./);
  assert.match(out, /Missing token motion\/ease\./);
  assert.match(problems({ ...fixture(), tokens: undefined }), /tokens must be an object/);
});

test('a token that isn’t in the schema is refused', () => {
  assert.match(problems(withTokens({ 'bg/sparkle': '#ffffff' })), /bg\/sparkle isn’t a token in the schema\./);
  const p = fixture();
  p.modes.dark['text/shiny'] = '#ffffff';
  assert.match(problems(p), /modes\.dark: text\/shiny isn’t a token in the schema\./);
});

test('value syntax is checked per token family', () => {
  const cases: [string, unknown, RegExp][] = [
    ['text/primary', 'blue', /text\/primary must be a colour, like #1b1f24 or rgba\(0, 0, 0, 0\.5\); got "blue"\./],
    ['text/primary', 'red; } body { display: none', /text\/primary must be a colour/],
    ['font/body', 'Inter; color: red', /font\/body must be a list of font names/],
    ['font/body', 'url(https://x.example/f.woff)', /font\/body must be a list of font names/],
    ['type/h1', 'huge', /type\/h1 must be a size in px, rem or em/],
    ['type/weight-strong', '1000', /type\/weight-strong must be a weight from 100 to 900/],
    ['type/line-body', '24px', /type\/line-body must be a plain number, like 1\.5/],
    ['space/3', '12', /space\/3 must be a length/],
    ['radius/card', 'round', /radius\/card must be a length/],
    ['shadow/card', '0 1px 2px expression(alert(1))', /shadow\/card must be "none" or shadows made of lengths and a colour/],
    ['blur/glass', '20', /blur\/glass must be a length/],
    ['motion/duration-fast', 'fast', /motion\/duration-fast must be a duration in ms or s/],
    ['motion/ease', 'bouncy', /motion\/ease must be an easing/],
    ['layout/content-max', 'wide', /layout\/content-max must be a length/],
    ['type/body', 15, /type\/body must be a size/],
  ];
  for (const [name, value, re] of cases) assert.match(problems(withTokens({ [name]: value })), re, `${name}=${String(value)}`);
  assert.deepEqual(validatePackage(withTokens({ 'shadow/card': 'none', 'motion/ease': 'ease-out', 'font/display': '"Iowan Old Style", Georgia, serif' })).problems, []);
});

test('contrast: text on the background and cards, faint text, the accent, and status colours on cards', () => {
  assert.match(problems(withTokens({ 'text/primary': '#9aa3ad' })), /text\/primary on bg\/base is \d\.\d\d:1; it needs 4\.5:1 \(text on the background\)\./);
  assert.match(problems(withTokens({ 'text/faint': '#c9ced4' })), /text\/faint on surface\/card is \d\.\d\d:1; it needs 3:1/);
  assert.match(problems(withTokens({ 'status/error': '#f08a80' })), /status\/error on surface\/card .* needs 4\.5:1/);
  assert.match(problems(withTokens({ 'status/ok': '#a8e0c0' })), /status\/ok on surface\/card .* needs 3:1/);
  assert.match(problems(withTokens({ 'accent/primary': '#9cb8e8' })), /accent\/primary on bg\/raised/);
  const p = fixture();
  p.modes.dark['text/secondary'] = '#3a4048';
  assert.match(problems(p), /In dark mode, text\/secondary on bg\/base is/);
  assert.match(problems(withTokens({ 'bg/base': 'rgba(255, 255, 255, 0.5)' })), /bg\/base must be solid/);
});

test('reduced motion: loops stop and transitions stay short, whatever the package says', () => {
  const p = fixture();
  p.reduced_motion = { 'motion/breathe': '2s', 'motion/duration-slow': '400ms', 'type/h1': '10px' };
  const out = problems(p);
  assert.match(out, /Under reduced motion, motion\/breathe must be 0s because it repeats; got 2s\./);
  assert.match(out, /Under reduced motion, motion\/duration-slow can be at most 200ms; got 400ms\./);
  assert.match(out, /reduced_motion can only set motion tokens; type\/h1 isn’t one\./);
  p.reduced_motion = { 'motion/duration-slow': '150ms' };
  assert.deepEqual(validatePackage(p).problems, []);
});

test('content rules may only tighten DESIGN-SYSTEM §6', () => {
  assert.equal(CONTENT_RULES.card_max_lines, 3);
  const loosen = { ...fixture(), content_rules: { card_max_lines: 5 } };
  assert.match(problems(loosen), /content_rules can only tighten the defaults: card_max_lines can be at most 3; got 5\./);
  assert.match(problems({ ...fixture(), content_rules: { decorate: true } }), /content_rules\.decorate isn’t a content rule\./);
  assert.match(problems({ ...fixture(), content_rules: { numbers_show_basis: false } }), /numbers_show_basis can’t be turned off\./);
});

test('components bind tokens only, and anything beyond the standard set is a declared extra', () => {
  const p = fixture();
  p.components.orb.glow = '#ff0000';
  assert.match(problems(p), /components\.orb\.glow must name tokens from the schema; "#ff0000" isn’t one\./);
  const q = fixture();
  q.components['star-field'] = { background: 'bg/base' };
  assert.match(problems(q), /components\.star-field isn’t a standard component, so it must be declared in extras\./);
  q.extras = [{ id: 'star-field', name: 'Star field', description: 'A quiet field of light behind the home screen.' }];
  assert.deepEqual(validatePackage(q).problems, []);
  assert.match(problems({ ...fixture(), extras: [{ id: 'x' }] }), /Each extra needs an id, a name and a description\./);
});

test('a design system asks for nothing and keeps nothing when removed', () => {
  assert.match(problems({ ...fixture(), permissions: [{ kind: 'network', target: 'fonts.example', why: 'fonts' }] }), /A design system asks for no permissions\./);
  assert.match(problems({ ...fixture(), secrets: ['FONT_KEY'] }), /A design system uses no secrets\./);
  assert.match(problems({ ...fixture(), on_remove: { delete: [], keep: ['tokens.json'], export: [] } }), /A design system keeps nothing when it is removed\./);
  assert.match(problems({ ...fixture(), kind: 'connector' }), /kind must be design-system/);
  assert.match(problems({ ...fixture(), modes: { sepia: {} } }), /modes can only be light and dark; sepia isn’t one\./);
  assert.match(problems({ ...fixture(), preview: ['/etc/passwd'] }), /preview must be a list of image paths inside the package/);
  assert.match(problems({ ...fixture(), id: 'Bad Id' }), /id must be lowercase/);
});

test('contrast math matches WCAG reference values', () => {
  assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(1), '21.0');
  assert.equal(contrast([119, 119, 119], [255, 255, 255]).toFixed(2), '4.48');
});

// ---- CSS generation -------------------------------------------------------------------

test('CSS: every token as a variable, light and dark honoured, auto follows the system', () => {
  const pkg = fixture();
  const light = generateCss(pkg, { mode: 'light' });
  for (const name of TOKEN_NAMES) assert.match(light, new RegExp(`${cssVar(name)}: `), name);
  assert.match(light, /--bg-base: #f4f5f7;/);
  assert.match(light, /color-scheme: light;/);
  assert.doesNotMatch(light, /prefers-color-scheme/);
  const dark = generateCss(pkg, { mode: 'dark' });
  assert.match(dark, /--bg-base: #15181c;/);
  assert.match(dark, /color-scheme: dark;/);
  assert.match(dark, /--type-h1: 1.75rem;/, 'tokens a mode doesn’t change come from the default set (type in rem, M9: 28px is 1.75rem)');
  const auto = generateCss(pkg, { mode: 'auto' });
  assert.match(auto, /--bg-base: #f4f5f7;/);
  assert.match(auto, /@media \(prefers-color-scheme: dark\) \{\s*:root \{[^}]*--bg-base: #15181c;/);
  for (const css of [light, dark, auto]) assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{[^}]*--motion-breathe: 0s;[^}]*--motion-pulse: 0s;/);
});

test('CSS carries the schema tokens and nothing else: Era 2’s temporary aliases are gone', () => {
  for (const mode of ['light', 'dark', 'auto'] as const) {
    const css = generateCss(fixture(), { mode });
    const declared = [...css.matchAll(/(--[\w-]+):/g)].map((m) => m[1]!);
    const schema = new Set(TOKEN_NAMES.map(cssVar));
    assert.deepEqual(declared.filter((n) => !schema.has(n)), [], mode);
    assert.doesNotMatch(css, /--bg:|--text-2:|--t-body:|--accent-text:|--shift:/, mode);
  }
});

test('CSS is never generated from an invalid package', () => {
  assert.throws(() => generateCss(withTokens({ 'text/primary': 'red; } * { display: none' }), { mode: 'light' }), /isn’t valid/);
});

// ---- the built-ins, selection, apply, rollback ---------------------------------------------

test('the six built-ins are present on a blank install, all valid, and Orb Teal is the default', () => {
  const { design, profile } = host();
  const list = design.list();
  assert.deepEqual(list.map((d) => d.id).sort(), ['aurora', 'companion-light', 'nova', 'obsidian', 'orb-teal', 'paper']);
  for (const d of list) assert.deepEqual(d.problems, [], d.id);
  assert.ok(list.every((d) => d.valid && d.builtin));
  assert.equal(DEFAULT_DESIGN_SYSTEM, 'orb-teal');
  assert.equal(design.active().id, 'orb-teal');
  assert.equal(design.active().scope, 'default');
  assert.equal(profile.isEmpty(), true, 'the default needs no profile record, so setup still sees a blank profile');
  assert.match(design.css(), /Orb Teal/);
  assert.ok(BUILTIN_DIR.endsWith('design-systems'));
});

test('built-ins install whatever Nova’s version string, and a broken one is reported, never fatal', () => {
  const db = new Db(':memory:');
  db.migrate();
  const extensions = new Extensions({ db, home: mkdtempSync(join(tmpdir(), 'nova-design-')), novaVersion: 'test' });
  const design = new Design({ extensions, profile: new Profile(db) });
  assert.deepEqual(design.ensureBuiltins(), []);
  assert.equal(design.list().length, 6);

  const dir = mkdtempSync(join(tmpdir(), 'nova-builtins-'));
  writeFileSync(join(dir, 'broken.json'), JSON.stringify({ ...fixture(), id: 'example.broken', permissions: [{ kind: 'network', target: 'x.example', why: 'fonts' }] }));
  writeFileSync(join(dir, 'slate.json'), JSON.stringify(fixture()));
  const db2 = new Db(':memory:');
  db2.migrate();
  const other = new Design({ extensions: new Extensions({ db: db2, home: dir, novaVersion: '0.1.0' }), profile: new Profile(db2), dir });
  const problems = other.ensureBuiltins();
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /The built-in design system Example Slate couldn’t be installed: .*asks for no permissions/);
  assert.deepEqual(other.list().map((d) => d.id), ['example.slate']);
});

test('ensureBuiltins is idempotent and leaves the person’s choice alone', () => {
  const { design } = host();
  design.apply('paper', { scope: 'user' });
  design.ensureBuiltins();
  assert.equal(design.list().length, 6);
  assert.equal(design.active().id, 'paper');
});

test('apply for the user, then roll back: the previous package returns, and each step emits the event', () => {
  const { design, profile, events } = host();
  const out = design.apply('companion-light', { scope: 'user' });
  assert.equal(out.active.id, 'companion-light');
  assert.equal(profile.get('appearance', 'design_system'), 'companion-light');
  assert.equal(profile.get('appearance', 'previous'), 'orb-teal');
  assert.match(design.css(), /Companion Light/);
  design.apply('paper', { scope: 'user' });
  assert.equal(profile.get('appearance', 'previous'), 'companion-light');
  const back = design.rollback({ scope: 'user' });
  assert.equal(back.active.id, 'companion-light');
  assert.equal(profile.get('appearance', 'previous'), 'paper', 'rolling back twice goes forward again');
  assert.deepEqual(events.map((e) => [e.action, e.id]), [['apply', 'companion-light'], ['apply', 'paper'], ['rollback', 'companion-light']]);
});

test('apply per device overrides the user choice on that device only, and rolls back on its own', () => {
  const { design, events } = host();
  design.apply('paper', { scope: 'user' });
  design.apply('obsidian', { scope: 'device', device_id: 'device-aaaa1111' });
  assert.equal(design.active('device-aaaa1111').id, 'obsidian');
  assert.equal(design.active('device-aaaa1111').scope, 'device');
  assert.equal(design.active('device-bbbb2222').id, 'paper');
  assert.equal(design.active().id, 'paper');
  assert.match(design.css('device-aaaa1111'), /Obsidian/);
  assert.match(design.css('device-bbbb2222'), /Paper/);
  design.apply('aurora', { scope: 'device', device_id: 'device-aaaa1111' });
  assert.equal(design.rollback({ scope: 'device', device_id: 'device-aaaa1111' }).active.id, 'obsidian');
  design.rollback({ scope: 'device', device_id: 'device-aaaa1111' });
  assert.equal(design.active('device-aaaa1111').id, 'aurora');
  assert.equal(events.at(-1)!.scope, 'device');
  assert.equal(events.at(-1)!.device_id, 'device-aaaa1111');
  assert.throws(() => design.apply('paper', { scope: 'device' }), /device_id/);
  assert.throws(() => design.apply('paper', { scope: 'device', device_id: 'x' }), /device_id/);
  assert.throws(() => design.apply('paper', { scope: 'everyone' as 'user' }), /scope must be user or device/);
});

test('rollback with nothing to go back to says so', () => {
  const { design } = host();
  assert.throws(() => design.rollback({ scope: 'user' }), /nothing to go back to/);
  assert.throws(() => design.rollback({ scope: 'device', device_id: 'device-aaaa1111' }), /nothing to go back to/);
});

test('the mode is part of the selection and shapes the CSS', () => {
  const { design, events } = host();
  design.apply('paper', { scope: 'user' });
  assert.equal(design.active().mode, 'auto');
  assert.match(design.css(), /prefers-color-scheme: dark/);
  design.setMode('dark');
  assert.doesNotMatch(design.css(), /prefers-color-scheme/);
  assert.match(design.css(), /--bg-base: #171512;/);
  assert.equal(events.at(-1)!.action, 'mode');
  assert.throws(() => design.setMode('sepia'), /light, dark or auto/);
});

test('preview CSS renders any valid package without applying it', () => {
  const { design, events } = host();
  const css = design.previewCss('companion-light');
  assert.match(css, /Companion Light/);
  assert.equal(design.active().id, 'orb-teal');
  assert.equal(events.length, 0);
  assert.match(design.previewCss('paper', 'dark'), /--bg-base: #171512;/);
  assert.throws(() => design.previewCss('nope'), /No design system "nope"/);
});

test('a third-party package installs through the extension host, applies, and removes cleanly', () => {
  const { design, extensions, profile } = host();
  const { design_system } = design.install(fixture());
  assert.equal(design_system.id, 'example.slate');
  assert.equal(design_system.valid, true);
  assert.equal(extensions.get('example.slate').kind, 'design-system');
  design.apply('example.slate', { scope: 'user' });
  design.apply('example.slate', { scope: 'device', device_id: 'device-aaaa1111' });
  assert.match(design.css(), /Example Slate/);
  const removed = extensions.remove('example.slate');
  assert.deepEqual(removed.kept, []);
  assert.equal(design.active().id, 'orb-teal', 'removing the applied package falls back to the previous one');
  assert.equal(design.active('device-aaaa1111').id, 'orb-teal');
  assert.equal(profile.get('appearance', 'design_system'), 'orb-teal');
  assert.ok(!design.list().some((d) => d.id === 'example.slate'));
});

test('an invalid package can be installed and inspected but never applied or previewed', () => {
  const { design } = host();
  const bad = { ...withTokens({ 'text/primary': '#eeeeee' }), id: 'example.faded' };
  const { design_system } = design.install(bad);
  assert.equal(design_system.valid, false);
  assert.match(design_system.problems.join(' '), /text\/primary on bg\/base/);
  assert.deepEqual(design.validate('example.faded').ok, false);
  assert.throws(() => design.apply('example.faded', { scope: 'user' }), /can’t be applied/);
  assert.throws(() => design.previewCss('example.faded'), /can’t be applied/);
  assert.equal(design.active().id, 'orb-teal');
});

test('install refuses a package that isn’t a design system, or that asks for permissions', () => {
  const { design } = host();
  assert.throws(() => design.install({ ...fixture(), kind: 'connector' }), /isn’t a design system/);
  assert.throws(() => design.install({ ...fixture(), permissions: [{ kind: 'network', target: 'fonts.example', why: 'fonts' }] }), /asks for no permissions/);
});

test('built-ins can’t be removed; a disabled design system can’t be applied', () => {
  const { design, extensions } = host();
  assert.throws(() => extensions.remove('nova'), /built in/);
  design.install(fixture());
  extensions.disable('example.slate');
  assert.throws(() => design.apply('example.slate', { scope: 'user' }), /turned off/);
});

// Review finding: turning off the design system in use changed what showed without telling open
// pages, and left the stored choice and its rollback pointing at a package that was off.
test('turning off the design system in use falls back to the previous one and says so', () => {
  const { design, extensions, profile, events } = host();
  design.apply('paper', { scope: 'user' });
  design.apply('companion-light', { scope: 'user' });
  design.apply('companion-light', { scope: 'device', device_id: 'device-aaaa1111' });
  events.length = 0;
  extensions.disable('companion-light');
  assert.equal(design.active().id, 'paper', 'back to the one before');
  assert.equal(design.active('device-aaaa1111').id, 'paper', 'a device override on it is dropped too');
  assert.equal(profile.get('appearance', 'design_system'), 'paper');
  assert.equal(events.length, 1, 'one design-system event for open pages');
  assert.deepEqual([events[0]!.action, events[0]!.id], ['turned-off', 'paper']);
  assert.throws(() => design.rollback({ scope: 'user' }), /nothing to go back to/, 'no rollback onto a package that is off');

  // A built-in that is only the fallback: turning it off moves the fallback, and that is announced.
  events.length = 0;
  extensions.disable('paper');
  assert.notEqual(design.active().id, 'paper');
  assert.equal(events.length, 1);
  extensions.enable('paper', { approved: true });
  assert.equal(events.length, 2, 'turning one back on is announced as well');
});
