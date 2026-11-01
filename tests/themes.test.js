import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { checkPackage, contrast } from '../scripts/check-themes.js';
import { lint, LAYOUT_FILE } from '../scripts/lint-tokens.js';
import { DEFAULT_DESIGN_SYSTEM, IOS_STATUS_BAR_UNDECLARED, STATUS_BAR_TAG, iosStatusBar, statusBarTag, validatePackage } from '../src/core/index.ts';

const packages = readdirSync('design-systems').filter((f) => f.endsWith('.json'));

test('six design systems ship: Orb Teal, Companion Light, and Era 2’s four themes', () => {
  assert.deepEqual(packages.sort(), ['aurora.json', 'companion-light.json', 'nova.json', 'obsidian.json', 'orb-teal.json', 'paper.json']);
  assert.equal(existsSync('ui/themes'), false, 'the Era 2 theme files are now packages');
});

test('Orb Teal is the default, and pages load the applied design system, swappable in place', () => {
  assert.equal(DEFAULT_DESIGN_SYSTEM, 'orb-teal');
  for (const f of ['ui/index.html', 'ui/styleguide.html']) {
    const html = readFileSync(f, 'utf8');
    assert.match(html, /<link rel="stylesheet" id="ds-boot" href="\/design-system.css">/, f);
    assert.match(html, /<style id="ds"><\/style>/, f);
    assert.doesNotMatch(html, /\/themes\//, f);
  }
  const theme = readFileSync('ui/js/theme.js', 'utf8');
  assert.match(theme, /addEventListener\('design-system'/);
  assert.match(theme, /getElementById\('ds'\)\.textContent/);
});

for (const f of packages) {
  test(`${f} passes validation`, () => {
    const { problems } = checkPackage(JSON.parse(readFileSync(`design-systems/${f}`, 'utf8')));
    assert.deepEqual(problems, []);
  });
}

test('contrast math matches WCAG reference values', () => {
  assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(1), '21.0');
  assert.equal(contrast([119, 119, 119], [255, 255, 255]).toFixed(2), '4.48');
});

test('the lint catches each kind of hardcoded value', () => {
  const found = lint('ui/x.css', '.a{color:#fff;font:12px Georgia;border-radius:6px;box-shadow:0 1px red;transition:opacity 200ms ease;font-size:13px}');
  assert.equal(found.length >= 6, true);
  assert.equal(lint('ui/x.js', 'el.style.color = "red"; const c = "#C4502B";').length, 2);
});

test('new UI code may reference only schema tokens', () => {
  const ok = '.a{color:var(--text-primary);background:var(--surface-card);font:var(--type-weight-regular) var(--type-body)/var(--type-line-body) var(--font-body);border-radius:var(--radius-card);box-shadow:var(--shadow-card);padding:var(--space-3);transition:opacity var(--motion-duration-fast) var(--motion-ease)}';
  assert.deepEqual(lint('ui/x.css', ok), []);
  assert.match(lint('ui/x.css', '.a{color:var(--text-shiny)}')[0][1], /unknown token --text-shiny/);
  assert.match(lint('ui/x.css', '.a{color:var(--text)}')[0][1], /unknown token --text/, 'Era 2’s names are gone');
  assert.match(lint('ui/x.css', '.a{--bg-base:#000}').map((p) => p[1]).join(' '), /only a design system sets it/);
  assert.match(lint('ui/x.css', '.a{padding:12px}')[0][1], /spacing must be a space token/);
  assert.match(lint('ui/x.css', '@media (min-width: 600px){.a{display:none}}')[0][1], /breakpoints belong in/);
  assert.match(lint('ui/x.css', '@container main (min-width: 600px){.a{display:none}}')[0][1], /breakpoints belong in/);
  assert.deepEqual(lint(LAYOUT_FILE, '@media (min-width: 600px){.a{display:none}}'), []);
  assert.deepEqual(lint('ui/x.js', 'const x = `<span style="color: var(--status-ok)">`;'), []);
  assert.match(lint('ui/x.js', 'const x = `<span style="color: var(--nope)">`;')[0][1], /unknown token --nope/);
});

test('no file is exempt: the Era 2 aliases and the LEGACY list are gone', () => {
  const era2 = '.a{color:var(--text);padding:12px;font:var(--t-body)}';
  for (const f of ['ui/styles/views.css', 'ui/styles/base.css']) assert.equal(lint(f, era2).length, 3, f);
  assert.equal(lint('ui/index.html', '<p style="color: var(--text)">').length, 1);
  assert.equal(lint('ui/js/app.js', 'const x = `<p style="color: var(--text-2)">`;').length, 1);
});

// ---- the installed iPhone app's status bar (DESIGN-SYSTEM §5, owner decision 2026-10-31 C) -------

const pkgOf = (id) => JSON.parse(readFileSync(`design-systems/${id}.json`, 'utf8'));

test('each built-in declares its iPhone status bar by what it is: dark draws behind it, light keeps iOS’s strip', () => {
  const want = {
    'orb-teal': { light: 'translucent', dark: 'translucent' }, // dark only
    nova: { light: 'translucent', dark: 'translucent' }, // dark only
    obsidian: { light: 'translucent', dark: 'translucent' }, // "always dark"
    'companion-light': { light: 'default', dark: 'default' }, // light only
    aurora: { light: 'default', dark: 'translucent' }, // light, with a dark mode
    paper: { light: 'default', dark: 'translucent' }, // light, with a dark mode
  };
  for (const [id, bar] of Object.entries(want)) {
    const pkg = pkgOf(id);
    assert.notEqual(pkg.ios_status_bar, undefined, `${id} declares it`);
    const { declared, ...got } = iosStatusBar(pkg);
    assert.equal(declared, true, id);
    assert.deepEqual(got, bar, id);
    // Nothing the check would warn about: no dark look keeps the strip, no light look draws behind it.
    assert.deepEqual(validatePackage(pkg).warnings.filter((w) => w.startsWith('ios_status_bar')), [], id);
  }
});

// A package that leaves it out: the authoring gate (check-themes) fails it, so everything shipped
// says what it wants; Nova itself still applies it with iOS's own strip (an older or hand-made
// package keeps working, and the default is never white text on a light page).
test('a package without ios_status_bar fails the theme check, and Nova applies it with an explicit default', () => {
  const { ios_status_bar: _, ...bare } = pkgOf('orb-teal');
  const gate = checkPackage(bare);
  assert.equal(gate.ok, false);
  assert.ok(gate.problems.some((p) => /ios_status_bar must be declared/.test(p)), gate.problems.join(' | '));
  const runtime = validatePackage(bare);
  assert.equal(runtime.ok, true, 'still applies');
  assert.ok(runtime.warnings.some((w) => /ios_status_bar isn’t declared/.test(w)));
  assert.equal(IOS_STATUS_BAR_UNDECLARED, 'default');
  assert.deepEqual(iosStatusBar(bare), { light: 'default', dark: 'default', declared: false });
});

test('the status bar check refuses white status text over a light look, and anything but its two words', () => {
  const problems = (over) => validatePackage({ ...pkgOf('aurora'), ...over }).problems.filter((p) => p.startsWith('ios_status_bar'));
  assert.match(problems({ ios_status_bar: 'translucent' }).join(), /translucent over a light look/, 'Aurora’s light look');
  assert.match(problems({ ios_status_bar: { light: 'translucent', dark: 'translucent' } }).join(), /ios_status_bar\.light is translucent over a light look/);
  assert.deepEqual(problems({ ios_status_bar: { light: 'default', dark: 'translucent' } }), []);
  assert.match(problems({ ios_status_bar: 'black-translucent' }).join(), /must be translucent or default/, 'the iOS word is Nova’s to write');
  assert.match(problems({ ios_status_bar: { light: 'default' } }).join(), /must be/);
  assert.match(problems({ ios_status_bar: { light: 'default', dark: 'translucent', auto: 'default' } }).join(), /must be/);
  assert.equal(validatePackage({ ...pkgOf('companion-light'), ios_status_bar: 'translucent' }).ok, false);
  // A dark design that keeps iOS's strip is allowed, with a warning: nothing is unreadable.
  const dark = validatePackage({ ...pkgOf('obsidian'), ios_status_bar: 'default' });
  assert.equal(dark.ok, true);
  assert.equal(dark.warnings.filter((w) => /default over a dark look/.test(w)).length, 1, 'said once for a one-look design');
});

test('the app page carries the status bar tag the server fills in, and picks light or dark like the CSS', () => {
  const html = readFileSync('ui/index.html', 'utf8');
  assert.ok(html.includes(STATUS_BAR_TAG), 'the server replaces this exact tag');
  assert.equal(html.match(/name="apple-mobile-web-app-status-bar-style"/g).length, 1);
  const both = { light: 'default', dark: 'translucent' };
  const tag = (mode, bar) => statusBarTag({ mode, ios_status_bar: bar }).match(/content="([^"]+)"/)[1];
  assert.equal(tag('auto', { light: 'translucent', dark: 'translucent' }), 'black-translucent');
  assert.equal(tag('light', { light: 'default', dark: 'default' }), 'default');
  assert.equal(tag('dark', both), 'black-translucent');
  assert.equal(tag('light', both), 'default');
  assert.equal(tag('auto', both), 'default', 'the page’s script decides from the system’s preference');
  assert.match(statusBarTag({ mode: 'auto', ios_status_bar: both }), /data-light="default" data-dark="translucent" data-mode="auto"/);
  // Settings says plainly that iOS may need the app opened again.
  assert.match(readFileSync('ui/js/surfaces.js', 'utf8'), /may only change once you close Nova and open it again/);
});
