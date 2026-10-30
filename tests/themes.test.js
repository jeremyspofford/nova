import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { checkPackage, contrast } from '../scripts/check-themes.js';
import { lint, LAYOUT_FILE } from '../scripts/lint-tokens.js';
import { DEFAULT_DESIGN_SYSTEM } from '../src/core/index.ts';

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
