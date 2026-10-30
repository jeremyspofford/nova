// The live contrast check and its one-tap fix (Amendment 2026-10-30-C Part 1 §5): stricter than
// validation, it warns about body text under 4.5:1 and control outlines under 3:1, and the fix
// nudges just the failing colours, for one device only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Profile } from '../../src/core/profile.ts';
import { Extensions } from '../../src/core/extensions.ts';
import { BUILTIN_DIR, Design, LIVE_CHECKS, NUDGE_STEP, STARTERS, applyNudge, contrastNudge, generateCss, liveCheck, looks, validatePackage } from '../../src/core/design.ts';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/design-system.json', import.meta.url), 'utf8'));
// A valid package (it can be applied) that a person could make: its secondary text is hard to read
// on raised surfaces, and its field outlines nearly vanish.
export const misty = () => {
  const p = fixture();
  Object.assign(p, { id: 'example.mist', name: 'Example Mist' });
  Object.assign(p.tokens, { 'border/strong': '#d3d7dc', 'bg/raised': '#d9dde3', 'accent/primary': '#234a8c', 'text/secondary': '#5f6872' });
  return p;
};
const builtins = () => readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(BUILTIN_DIR, f), 'utf8')));

function host() {
  const home = mkdtempSync(join(tmpdir(), 'nova-design-live-'));
  const db = new Db(':memory:');
  db.migrate();
  const profile = new Profile(db);
  const extensions = new Extensions({ db, home, novaVersion: '0.1.0' });
  const design = new Design({ extensions, profile });
  design.ensureBuiltins();
  const events: Record<string, unknown>[] = [];
  design.on('change', (c) => events.push(c));
  return { profile, extensions, design, events };
}

test('the live check: body text at 4.5:1 and outlines at 3:1, on the surfaces they sit on', () => {
  const kinds = new Set(LIVE_CHECKS.map(([, , min, kind]) => `${kind}:${min}`));
  assert.deepEqual([...kinds].sort(), ['control:3', 'text:4.5']);
  for (const fg of ['text/primary', 'text/secondary']) for (const bg of ['bg/base', 'bg/raised', 'surface/card']) {
    assert.ok(LIVE_CHECKS.some(([f, b, min]) => f === fg && b === bg && min === 4.5), `${fg} on ${bg}`);
  }
  assert.ok(LIVE_CHECKS.some(([f, b, min]) => f === 'border/strong' && b === 'bg/base' && min === 3));
});

test('every built-in design passes the live check in every look it has, starters included', () => {
  for (const pkg of builtins()) {
    for (const [look, tokens] of Object.entries(looks(pkg))) {
      const c = liveCheck(tokens);
      assert.ok(c.ok, `${pkg.id} (${look}): ${c.results.filter((r) => !r.ok).map((r) => `${r.fg} on ${r.bg} ${r.ratio}:1`).join(', ')}`);
    }
  }
  assert.deepEqual([...STARTERS], ['orb-teal', 'companion-light']);
});

test('a valid package can still fail the live check, and says what and by how much', () => {
  const p = misty();
  assert.deepEqual(validatePackage(p).problems, [], 'it is valid, so it can be applied');
  const c = liveCheck(p.tokens);
  assert.equal(c.ok, false);
  const failed = c.results.filter((r) => !r.ok).map((r) => `${r.kind}:${r.fg}/${r.bg}`);
  assert.deepEqual(failed, ['text:text/secondary/bg/raised', 'control:border/strong/bg/base', 'control:border/strong/bg/raised']);
  assert.ok(c.margin < 1);
  assert.equal(c.results.find((r) => r.fg === 'text/secondary' && r.bg === 'bg/raised')!.ratio, 4.15);
});

test('the fix nudges only the failing colours, by the smallest step that passes', () => {
  const p = misty();
  const { nudge, unfixable } = contrastNudge(p);
  assert.deepEqual(Object.keys(nudge).sort(), ['border/strong', 'text/secondary']);
  assert.deepEqual(unfixable, []);
  const fixed = applyNudge(p.tokens, nudge);
  assert.ok(liveCheck(fixed).ok, 'everything passes after the fix');
  for (const [token, k] of Object.entries(nudge)) {
    const less = applyNudge(p.tokens, { [token]: Math.round((k - NUDGE_STEP) * 100) / 100 });
    assert.ok(k === NUDGE_STEP || liveCheck(less).results.some((r) => r.fg === token && !r.ok), `${token}: one step less still fails`);
  }
  for (const name of Object.keys(p.tokens)) if (!(name in nudge)) assert.equal(fixed[name], p.tokens[name], `${name} untouched`);
  assert.deepEqual(contrastNudge(builtins().find((x) => x.id === 'paper')).nudge, {}, 'nothing to nudge in a package that passes');
});

test('the CSS carries a nudge in every look, light and dark', () => {
  const paper = builtins().find((x) => x.id === 'paper');
  const nudge = { 'text/secondary': 0.5 };
  const css = generateCss(paper, { nudge });
  const plain = generateCss(paper);
  const vars = (s: string) => [...s.matchAll(/--text-secondary: ([^;]+);/g)].map((m) => m[1]);
  assert.equal(vars(plain).length, 2, 'the default look and the dark one');
  assert.equal(vars(css).length, 2);
  for (let i = 0; i < 2; i++) assert.notEqual(vars(css)[i], vars(plain)[i]);
  assert.match(css, /with this device’s contrast fix/);
});

test('fixContrast applies on one device, for the design it shows, and undoes', () => {
  const { design, extensions, events } = host();
  design.install(misty());
  extensions.enable('example.mist');
  design.apply('example.mist', { scope: 'user' });
  const before = design.css('device-aaaa1111');
  const out = design.fixContrast({ device_id: 'device-aaaa1111' });
  assert.deepEqual(out.fixed.sort(), ['border/strong', 'text/secondary']);
  assert.equal(events.at(-1)!.action, 'contrast-fix');
  assert.equal(events.at(-1)!.device_id, 'device-aaaa1111');
  assert.deepEqual(Object.keys(design.active('device-aaaa1111').fix ?? {}).sort(), ['border/strong', 'text/secondary']);
  assert.notEqual(design.css('device-aaaa1111'), before);
  assert.equal(design.css('device-bbbb2222'), before, 'another device is untouched');
  assert.equal(design.css(), before, 'and so is the person’s choice');
  // Another design on that device: the fix stays with the design it was made for.
  design.apply('paper', { scope: 'device', device_id: 'device-aaaa1111' });
  assert.equal(design.active('device-aaaa1111').fix, undefined);
  design.rollback({ scope: 'device', device_id: 'device-aaaa1111' });
  assert.ok(design.active('device-aaaa1111').fix);
  design.undoFix({ device_id: 'device-aaaa1111' });
  assert.equal(design.css('device-aaaa1111'), before);
  assert.throws(() => design.undoFix({ device_id: 'device-aaaa1111' }), /no contrast fix/);
  assert.throws(() => design.fixContrast({ device_id: null }), /device_id/);
});

test('nothing to fix says so; removing a design forgets its fixes', () => {
  const { design, extensions, profile } = host();
  assert.throws(() => design.fixContrast({ device_id: 'device-aaaa1111' }), /Nothing to fix/);
  design.install(misty());
  extensions.enable('example.mist');
  design.apply('example.mist', { scope: 'device', device_id: 'device-aaaa1111' });
  design.fixContrast({ device_id: 'device-aaaa1111' });
  extensions.remove('example.mist');
  assert.deepEqual(profile.get('appearance', 'device_fixes'), {});
});

test('a device can drop its own choice and follow the person’s again, and roll that back', () => {
  const { design, events } = host();
  design.apply('paper', { scope: 'user' });
  design.apply('obsidian', { scope: 'device', device_id: 'device-aaaa1111' });
  const out = design.follow({ device_id: 'device-aaaa1111' });
  assert.equal(out.active.id, 'paper');
  assert.equal(out.active.scope, 'user');
  assert.equal(events.at(-1)!.device_id, 'device-aaaa1111');
  assert.equal(design.rollback({ scope: 'device', device_id: 'device-aaaa1111' }).active.id, 'obsidian');
  assert.equal(design.follow({ device_id: 'device-bbbb2222' }).active.id, 'paper', 'nothing to drop is fine');
});

test('the list says how each look reads, with colours for a thumbnail, and which are starters', () => {
  const { design } = host();
  const list = design.list();
  const teal = list.find((d) => d.id === 'orb-teal')!;
  assert.equal(teal.starter, true);
  assert.equal(list.find((d) => d.id === 'paper')!.starter, false);
  assert.deepEqual(Object.keys(teal.looks), ['default']);
  assert.equal(teal.looks.default!.scheme, 'dark');
  assert.equal(teal.looks.default!.ok, true);
  assert.deepEqual(Object.keys(teal.looks.default!.swatch).sort(), ['accent', 'bg', 'card', 'orb', 'raised', 'text']);
  const paper = list.find((d) => d.id === 'paper')!;
  assert.deepEqual(Object.keys(paper.looks).sort(), ['dark', 'default']);
  assert.equal(paper.looks.default!.scheme, 'light');
  assert.equal(paper.looks.dark!.scheme, 'dark');
  assert.equal(list.find((d) => d.id === 'companion-light')!.looks.default!.scheme, 'light');
});
