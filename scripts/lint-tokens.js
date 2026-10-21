#!/usr/bin/env node
// THEMING.md rule 2: components consume tokens only. Fails on a raw color,
// font name, radius, shadow or motion value anywhere outside ui/themes/.
// Usage: node scripts/lint-tokens.js [files...]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const UI = 'ui';
const SKIP_DIRS = new Set(['themes']);

const COLOR_PROPS = /^(color|background|background-color|border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|fill|stroke|text-decoration|text-decoration-color|caret-color|accent-color|column-rule|box-shadow|text-shadow)$/;
const NAMED = /\b(white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i;
const FONT_NAMES = /\b(serif|sans-serif|monospace|system-ui|ui-serif|ui-monospace|-apple-system|Georgia|Inter|Helvetica|Arial|Menlo|Consolas|Times|"SF [^"]+"|"New York"|"Iowan Old Style")\b/;

function cssProblems(css) {
  const out = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lineOf = (i) => body.slice(0, i).split('\n').length;
  for (const m of body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) out.push([lineOf(m.index), `raw color ${m[0]}`]);
  for (const m of body.matchAll(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g)) out.push([lineOf(m.index), `raw color ${m[1]}()`]);
  for (const m of body.matchAll(/cubic-bezier\(|steps\(/g)) out.push([lineOf(m.index), 'raw easing curve']);
  for (const m of body.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) {
    const [, prop, value] = m;
    const line = lineOf(m.index);
    const v = value.trim();
    if (COLOR_PROPS.test(prop) && NAMED.test(v.replace(/var\([^)]*\)/g, ''))) out.push([line, `named color in ${prop}: ${v}`]);
    if (prop === 'font-family' && !/^(var\(--font[\w-]*\)|inherit)$/.test(v)) out.push([line, `font-family must be a token: ${v}`]);
    if (prop === 'font' && !/^(var\(--t-[\w-]+\)|inherit)$/.test(v)) out.push([line, `font must be a type token: ${v}`]);
    if (/^(font-size|line-height)$/.test(prop) && !/^(inherit|var\(--[\w-]+\))$/.test(v)) out.push([line, `${prop} outside the type scale: ${v}`]);
    if (FONT_NAMES.test(v) && /^font/.test(prop)) out.push([line, `font name in ${prop}`]);
    if (/^border(-[a-z]+)*-radius$/.test(prop) && !/var\(--r-/.test(v) && !/^(0|50%|inherit)$/.test(v)) out.push([line, `radius must be a token: ${v}`]);
    if (prop === 'box-shadow' && !/^(var\(--shadow-[\w-]+\)|none)$/.test(v)) out.push([line, `shadow must be a token: ${v}`]);
    if (/^(transition|animation)(-duration|-delay)?$/.test(prop)) {
      const raw = v.replace(/var\([^)]*\)/g, '').replace(/calc\([^)]*\)/g, '').match(/\b(?!0m?s\b)\d*\.?\d+m?s\b/);
      if (raw) out.push([line, `motion duration must be a token: ${raw[0]}`]);
    }
    if (/^(transition|animation)(-timing-function)?$/.test(prop) && /\b(ease|ease-in|ease-out|ease-in-out)\b/.test(v.replace(/var\([^)]*\)/g, ''))) {
      out.push([line, `easing must be var(--ease): ${v}`]);
    }
  }
  return out;
}

function jsProblems(js) {
  const out = [];
  const lineOf = (i) => js.slice(0, i).split('\n').length;
  for (const m of js.matchAll(/['"`]#[0-9a-fA-F]{3,8}['"`]|\b(rgba?|hsla?)\(\s*\d/g)) out.push([lineOf(m.index), `raw color in script: ${m[0]}`]);
  for (const m of js.matchAll(/cubic-bezier\(/g)) out.push([lineOf(m.index), 'raw easing curve in script']);
  for (const m of js.matchAll(/(fill|stroke)="(?!currentColor|none)[^"]+"/g)) out.push([lineOf(m.index), `inline SVG color: ${m[0]}`]);
  for (const m of js.matchAll(/\.style\.(color|background|fontFamily|font|borderRadius|boxShadow|transition|animation)\s*=/g)) out.push([lineOf(m.index), `inline style.${m[1]} bypasses tokens`]);
  return out;
}

function htmlProblems(html) {
  const out = [];
  for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) out.push(...cssProblems(m[1]));
  for (const m of html.matchAll(/style="([^"]*)"/g)) out.push(...cssProblems(`x{${m[1]}}`));
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) out.push(...jsProblems(m[1]));
  return out;
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : files(p);
    return ['.css', '.js', '.html'].includes(extname(p)) ? [p] : [];
  });
}

export function lint(path, text = readFileSync(path, 'utf8')) {
  const ext = extname(path);
  return ext === '.css' ? cssProblems(text) : ext === '.js' ? jsProblems(text) : htmlProblems(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : files(UI);
  let count = 0;
  for (const f of targets) {
    for (const [line, msg] of lint(f)) { console.log(`${relative('.', f)}:${line}  ${msg}`); count++; }
  }
  if (count) { console.log(`\n✗ ${count} hardcoded visual value${count === 1 ? '' : 's'}. Use a token from ui/themes/ (see THEMING.md).`); process.exit(1); }
  console.log(`✓ token lint: ${targets.length} files, no hardcoded colors, fonts, radii, shadows or motion values`);
}
