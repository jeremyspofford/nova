import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { checkTheme, contrast } from '../scripts/check-themes.js';
import { lint } from '../scripts/lint-tokens.js';

const themes = readdirSync('ui/themes').filter((f) => f.endsWith('.css'));

test('three themes ship, Paper among them', () => {
  assert.deepEqual(themes.sort(), ['aurora.css', 'obsidian.css', 'paper.css']);
});

for (const f of themes) {
  test(`${f} passes the theme contract`, () => {
    const { problems } = checkTheme(readFileSync(`ui/themes/${f}`, 'utf8'));
    assert.deepEqual(problems, []);
  });
}

test('contrast math matches WCAG reference values', () => {
  assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(1), '21.0');
  assert.equal(contrast([119, 119, 119], [255, 255, 255]).toFixed(2), '4.48');
});

test('the lint catches each kind of hardcoded value', () => {
  const found = lint('x.css', '.a{color:#fff;font:12px Georgia;border-radius:6px;box-shadow:0 1px red;transition:opacity 200ms ease;font-size:13px}');
  assert.equal(found.length >= 6, true);
  assert.deepEqual(lint('x.css', '.a{color:var(--text);font:var(--t-body);border-radius:var(--r-card);transition:opacity var(--m-fast) var(--ease)}'), []);
  assert.equal(lint('x.js', 'el.style.color = "red"; const c = "#C4502B";').length, 2);
});
