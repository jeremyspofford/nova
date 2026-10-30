// The review of the UI fixes (Amendment 2026-10-30-C Part 1), the pure parts: Undo after Save
// undoes exactly what Save changed; the contrast check covers every colour the UI draws as a
// control's outline; every time on screen passes 4.5:1; the contrast panel never says "passes"
// when it couldn't check, and a fix can always be undone; Settings search knows more words.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { undoPlan, contrastView } from '../ui/js/look.js';
import { searchSettings } from '../ui/js/settings-ia.js';
import { renderTurn } from '../ui/js/view.js';
import { BUILTIN_DIR, LIVE_CHECKS, TOKEN_NAMES, cssVar, liveCheck, looks } from '../src/core/index.ts';
import { Design } from '../src/core/design.ts';
import { Db } from '../src/core/db.ts';
import { Profile } from '../src/core/profile.ts';
import { Extensions } from '../src/core/extensions.ts';

// ---- 1. Undo after Save ------------------------------------------------------------------------------

test('Undo after Save undoes exactly what Save changed, and nothing it didn’t', () => {
  const before = { mode: 'auto', synced: 'paper', device: null };
  assert.deepEqual(undoPlan(before, { id: 'aurora' }), { device: false, user: true, mode: null });
  assert.deepEqual(undoPlan(before, { mode: 'dark' }), { device: false, user: false, mode: 'auto' });
  assert.deepEqual(undoPlan(before, { id: 'aurora', mode: 'dark' }), { device: false, user: true, mode: 'auto' });
  // Saving the design that was already synced changes nothing there (and the core keeps no
  // "previous" for it), so there is nothing of it to undo.
  assert.deepEqual(undoPlan(before, { id: 'paper', mode: 'dark' }), { device: false, user: false, mode: 'auto' });
  assert.equal(undoPlan(before, { id: 'paper' }), null, 'nothing changed: no Undo');
  assert.equal(undoPlan(before, { mode: 'auto' }), null);
  // This device had its own design and Save made it follow the synced one: that comes back too.
  const own = { mode: 'auto', synced: 'paper', device: 'obsidian' };
  assert.deepEqual(undoPlan(own, { id: 'paper' }), { device: true, user: false, mode: null });
  assert.deepEqual(undoPlan(own, { id: 'aurora', mode: 'light' }), { device: true, user: true, mode: 'auto' });
  assert.deepEqual(undoPlan(own, { mode: 'light' }), { device: false, user: false, mode: 'auto' }, 'a mode alone doesn’t touch this device’s design');
});

// ---- 2. Control outlines --------------------------------------------------------------------------------

// The classes the templates put on things a person operates, and the colours the CSS gives those
// things as a border: read from the code, not listed by hand.
function controlBorderTokens() {
  const js = [...readdirSync('ui/js').filter((f) => f.endsWith('.js')).map((f) => `ui/js/${f}`), 'ui/index.html'].map((f) => readFileSync(f, 'utf8')).join('\n');
  const classes = new Set();
  for (const m of js.matchAll(/<(button|input|select|textarea|label|a)\b[^>]*?\bclass="([^"]*)"/g)) {
    for (const c of m[2].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (/^[a-z][\w-]*$/.test(c)) classes.add(c);
  }
  const names = new Map(TOKEN_NAMES.map((n) => [cssVar(n), n]));
  const tokens = new Map();
  for (const f of readdirSync('ui/styles').filter((x) => x.endsWith('.css') && x !== 'styleguide.css')) {
    const css = readFileSync(`ui/styles/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const borders = [...m[2].matchAll(/(?:^|;)\s*border(?:-(?:top|right|bottom|left))?(?:-color)?\s*:\s*([^;]+)/g)].map((b) => b[1]);
      if (!borders.length) continue;
      for (const sel of m[1].split(',').map((s) => s.trim())) {
        if (/:disabled|\[disabled\]/.test(sel)) continue; // a disabled control is exempt (WCAG 1.4.11)
        const last = sel.split(/[\s>+~]+/).at(-1);
        const control = /^(button|input|select|textarea)\b/.test(last) || [...last.matchAll(/\.([\w-]+)/g)].some((c) => classes.has(c[1]));
        if (!control) continue;
        for (const v of borders) for (const t of v.matchAll(/var\((--[\w-]+)\)/g)) if (names.has(t[1])) tokens.set(names.get(t[1]), `${f}: ${sel}`);
      }
    }
  }
  return tokens;
}

test('the live check covers every colour the UI draws as a control’s outline', () => {
  const found = controlBorderTokens();
  assert.ok(found.size >= 2, `found ${[...found.keys()]}`);
  const checked = new Set(LIVE_CHECKS.filter(([, bg, min]) => bg === 'bg/base' && min >= 3).map(([fg]) => fg));
  for (const [token, where] of found) assert.ok(checked.has(token), `${token} outlines a control (${where}) but the live check doesn’t test it`);
  assert.equal(found.has('border/subtle'), false, 'border/subtle is for separators and cards, never a control’s outline');
});

test('every built-in passes the widened check in every look', () => {
  for (const f of readdirSync(BUILTIN_DIR).filter((x) => x.endsWith('.json'))) {
    const pkg = JSON.parse(readFileSync(join(BUILTIN_DIR, f), 'utf8'));
    for (const [look, t] of Object.entries(looks(pkg))) {
      const c = liveCheck(t);
      assert.ok(c.ok, `${pkg.id} (${look}): ${c.results.filter((r) => !r.ok).map((r) => `${r.fg} on ${r.bg} ${r.ratio}:1`).join(', ')}`);
    }
  }
});

// ---- 3. Every time on screen passes 4.5:1 ------------------------------------------------------------------

// The classes of elements whose text is a time or a date: wherever a template puts one of the
// time helpers' output, or a <time>, inside an element with a class.
function timeClasses() {
  const helpers = 'clock|relWhen|shortDay|longDate|ago|took|exactTime|toLocaleTimeString|toLocaleDateString|when';
  const out = new Set();
  for (const f of readdirSync('ui/js').filter((x) => x.endsWith('.js'))) {
    const js = readFileSync(`ui/js/${f}`, 'utf8');
    for (const m of js.matchAll(new RegExp(`class="([^"]+)"[^>]*>(?:[^<]|<(?:time|span)[^>]*>)*?\\$\\{[^}]*\\b(?:${helpers})\\(`, 'g'))) for (const c of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (/^[a-z][\w-]*$/.test(c)) out.add(c);
    for (const m of js.matchAll(/class="([^"]+)"[^>]*>(?:[^<]*)<time\b/g)) for (const c of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (/^[a-z][\w-]*$/.test(c)) out.add(c);
    for (const m of js.matchAll(/<time\b[^>]*class="([^"]+)"/g)) for (const c of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (/^[a-z][\w-]*$/.test(c)) out.add(c);
  }
  return out;
}

test('nothing that shows a time or a date is drawn in the faint grey', () => {
  const classes = timeClasses();
  for (const c of ['schedule-next', 'approval-next', 'record-time', 'act-time', 'gap-divider', 'when', 'task-meta', 'card-line']) assert.ok(classes.has(c), `${c} is found as time-bearing`);
  const css = readdirSync('ui/styles').map((f) => readFileSync(`ui/styles/${f}`, 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/color:\s*var\(--text-faint\)/.test(m[2].replace(/(background|border[\w-]*):[^;]+;?/g, ''))) continue;
    for (const sel of m[1].split(',')) {
      const hit = [...sel.matchAll(/\.([\w-]+)/g)].map((x) => x[1]).filter((c) => classes.has(c));
      assert.deepEqual(hit, [], `${sel.trim()} shows a time in text/faint`);
    }
  }
  // And a <time> anywhere reads at least as well as secondary text.
  assert.match(css, /(^|\n|\})\s*time\s*\{[^}]*color: var\(--text-secondary\)/);
});

// ---- 5, 15. The contrast panel -----------------------------------------------------------------------------

const CHECKS = LIVE_CHECKS.map(([fg, bg, min, kind, what]) => ({ fg, bg, min, kind, what }));
const mist = { 'bg/base': '#f4f5f7', 'bg/raised': '#d9dde3', 'surface/card': '#ffffff', 'text/primary': '#1b1f24', 'text/secondary': '#5f6872', 'border/strong': '#d3d7dc', 'accent/primary': '#234a8c', 'orb/listening': '#2b6f6a', 'status/attention': '#8a5108', 'status/error': '#b3261e' };
const getter = (t) => (name) => t[name];

test('the contrast panel says when it couldn’t check, never that it passed', () => {
  const v = contrastView({ checks: [], get: getter(mist) });
  assert.equal(v.state, 'unknown');
  assert.equal(v.offerFix, false);
  assert.match(v.line, /couldn’t check/);
});

test('a fix is offered only where it helps, and once applied it can always be undone', () => {
  const failing = contrastView({ checks: CHECKS, get: getter(mist), fixable: ['border/strong', 'text/secondary'] });
  assert.equal(failing.state, 'fail');
  assert.equal(failing.offerFix, true);
  assert.equal(failing.offerUndo, false);
  // A fix is applied and everything passes: Undo.
  const fixed = contrastView({ checks: CHECKS, get: getter({ ...mist, 'border/strong': '#5b636d', 'text/secondary': '#4d555e' }), fix: { 'border/strong': 0.5 }, fixable: ['border/strong'] });
  assert.equal(fixed.state, 'ok');
  assert.equal(fixed.offerUndo, true);
  // A fix is applied but something still fails: Undo, no second offer, and it says what's left.
  const partial = contrastView({ checks: CHECKS, get: getter({ ...mist, 'border/strong': '#5b636d' }), fix: { 'border/strong': 0.5 }, fixable: ['border/strong', 'text/secondary'], unfixable: ['text/secondary'] });
  assert.equal(partial.state, 'fail');
  assert.equal(partial.offerFix, false);
  assert.equal(partial.offerUndo, true);
  assert.deepEqual(partial.cantFix, ['Secondary text on raised surfaces']);
  // Nothing fixable fails: no button, and it says so plainly.
  const none = contrastView({ checks: CHECKS, get: getter(mist), fixable: [], unfixable: ['border/strong', 'text/secondary'] });
  assert.equal(none.offerFix, false);
  assert.ok(none.cantFix.length >= 2);
  // While a design is only being tried, the fix waits.
  assert.equal(contrastView({ checks: CHECKS, get: getter(mist), fixable: ['border/strong'], pending: true }).offerFix, false);
});

// ---- 10. Search words ---------------------------------------------------------------------------------------

test('search knows more of people’s words, and “mode” means light and dark', () => {
  const top = (q) => searchSettings(q)[0];
  assert.equal(top('mode').path, 'Appearance › Light and dark');
  for (const [q, path] of [['screenpipe', 'Privacy and permissions › Capture'], ['capture source', 'Privacy and permissions › Capture'], ['API key', 'Models and providers › Providers'],
    ['privacy mode', 'Privacy and permissions › Privacy'], ['tailscale', 'Devices › Paired devices'], ['voice', 'Privacy and permissions › Privacy'],
    ['text size', 'Appearance › Theme'], ['high contrast', 'Appearance › Contrast'], ['microphone', 'Privacy and permissions › Privacy'], ['restore', 'Backups and changes › Backups']]) {
    assert.equal(top(q)?.path, path, q);
  }
});

// ---- 16. A letter that doesn’t scroll isn’t a tab stop ------------------------------------------------------

test('an approval’s letter is not a tab stop now that it doesn’t scroll', () => {
  const turn = { id: 't1', text: 'Draft a reply', ts: '2026-10-28T09:00:00.000Z', state: 'open', items: [
    { kind: 'tool', id: 'c1', name: 'gmail_draft', args: {}, ts: '2026-10-28T09:00:01.000Z', needsApproval: true, approval: null, result: null, preview: { to: 'a@example.com', subject: 'Hello', body: 'Hi there' } }] };
  const html = renderTurn(turn, { live: { phase: 'thinking' } });
  assert.match(html, /class="approval-letter"/);
  assert.doesNotMatch(html, /class="approval-letter"[^>]*tabindex/);
});

// ---- 11. A revoked device leaves no appearance behind ----------------------------------------------------------

test('revoking a device forgets its own design, its rollback and its contrast fix', () => {
  const db = new Db(':memory:');
  db.migrate();
  const profile = new Profile(db);
  const extensions = new Extensions({ db, home: mkdtempSync(join(tmpdir(), 'nova-rev-')), novaVersion: '0.1.0' });
  const design = new Design({ extensions, profile });
  design.ensureBuiltins();
  design.own('browser-aaaa1111', 'dev-phone-1');
  design.apply('paper', { scope: 'device', device_id: 'browser-aaaa1111' });
  design.apply('obsidian', { scope: 'device', device_id: 'browser-bbbb2222' });
  const a = profile.section('appearance');
  profile.set('appearance', 'device_fixes', { ...a.device_fixes, 'browser-aaaa1111': { design_system: 'paper', nudge: { 'border/strong': 0.1 } } }, 'settings');
  design.forgetDevice('dev-phone-1');
  const after = design.appearance();
  assert.equal(after.device_overrides['browser-aaaa1111'], undefined);
  assert.equal('browser-aaaa1111' in after.device_previous, false);
  assert.equal(after.device_fixes['browser-aaaa1111'], undefined);
  assert.equal(after.device_overrides['browser-bbbb2222'], 'obsidian', 'other devices keep theirs');
  assert.deepEqual(profile.get('appearance', 'device_owners'), {});
});
