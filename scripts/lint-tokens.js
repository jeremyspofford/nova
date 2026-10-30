#!/usr/bin/env node
// Components consume design tokens only (DESIGN-SYSTEM §2, ADR-12). Fails on a raw colour, font
// name, radius, shadow, motion value or raw spacing anywhere in ui/, and on any var(--x) that
// isn't a token of the schema in src/core/design.ts (or a custom property ui/ itself declares).
// Breakpoints live only in the layout file (DESIGN-SYSTEM §5).
// Usage: node scripts/lint-tokens.js [files...]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { TOKEN_NAMES, cssVar } from '../src/core/index.ts';

const UI = 'ui';
export const LAYOUT_FILE = 'ui/styles/layout.css';
const SCHEMA = new Set(TOKEN_NAMES.map(cssVar));

const COLOR_PROPS = /^(color|background|background-color|border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|fill|stroke|text-decoration|text-decoration-color|caret-color|accent-color|column-rule|box-shadow|text-shadow)$/;
const NAMED = /\b(white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/i;
const FONT_NAMES = /\b(serif|sans-serif|monospace|system-ui|ui-serif|ui-monospace|-apple-system|Georgia|Inter|Helvetica|Arial|Menlo|Consolas|Times|"SF [^"]+"|"New York"|"Iowan Old Style")\b/;
const SPACING = /^(padding|margin|gap|row-gap|column-gap|inset)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const ONLY_VARS = /^(?:\s*(?:var\(--[\w-]+\)|italic|\/)\s*)+$/;

// Custom properties ui/ declares itself (in CSS, or with style.setProperty), e.g. --gutter.
function declared(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)) out.add(m[1]);
  for (const m of text.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) out.add(m[1]);
  return out;
}

function varProblems(text, lineOf, ctx) {
  const out = [];
  for (const m of text.matchAll(/var\((--[\w-]+)/g)) {
    const name = m[1];
    if (SCHEMA.has(name) || ctx.local.has(name)) continue;
    out.push([lineOf(m.index), `unknown token ${name}: components use only schema tokens (GET /api/v1/design-systems/schema)`]);
  }
  for (const m of text.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)) {
    if (SCHEMA.has(m[1])) out.push([lineOf(m.index), `${m[1]} is a design token; only a design system sets it`]);
  }
  return out;
}

function cssProblems(css, ctx) {
  const out = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lineOf = (i) => body.slice(0, i).split('\n').length;
  out.push(...varProblems(body, lineOf, ctx));
  for (const m of body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) out.push([lineOf(m.index), `raw color ${m[0]}`]);
  for (const m of body.matchAll(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g)) out.push([lineOf(m.index), `raw color ${m[1]}()`]);
  for (const m of body.matchAll(/cubic-bezier\(|steps\(/g)) out.push([lineOf(m.index), 'raw easing curve']);
  if (ctx.path !== LAYOUT_FILE) {
    for (const m of body.matchAll(/@(?:media|container)[^{]*\((?:min-|max-)?(?:width|height|inline-size)\s*[:<>]/g)) out.push([lineOf(m.index), `breakpoints belong in ${LAYOUT_FILE} (DESIGN-SYSTEM §5)`]);
  }
  for (const m of body.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) {
    const [, prop, value] = m;
    const line = lineOf(m.index);
    const v = value.trim();
    if (COLOR_PROPS.test(prop) && NAMED.test(v.replace(/var\([^)]*\)/g, ''))) out.push([line, `named color in ${prop}: ${v}`]);
    if (prop === 'font-family' && !/^(var\(--font[\w-]*\)|inherit)$/.test(v)) out.push([line, `font-family must be a token: ${v}`]);
    if (prop === 'font' && !(ONLY_VARS.test(v) || v === 'inherit')) out.push([line, `font must be built from type tokens: ${v}`]);
    if (/^(font-size|line-height)$/.test(prop) && !/^(inherit|var\(--[\w-]+\))$/.test(v)) out.push([line, `${prop} outside the type scale: ${v}`]);
    if (FONT_NAMES.test(v) && /^font/.test(prop)) out.push([line, `font name in ${prop}`]);
    if (/^border(-[a-z]+)*-radius$/.test(prop) && !/var\(--(r|radius)-/.test(v) && !/^(0|50%|inherit)$/.test(v)) out.push([line, `radius must be a token: ${v}`]);
    if (prop === 'box-shadow' && !/^(var\(--shadow-[\w-]+\)|none)$/.test(v)) out.push([line, `shadow must be a token: ${v}`]);
    if (/^(transition|animation)(-duration|-delay)?$/.test(prop)) {
      const raw = v.replace(/var\([^)]*\)/g, '').replace(/calc\([^)]*\)/g, '').match(/\b(?!0m?s\b)\d*\.?\d+m?s\b/);
      if (raw) out.push([line, `motion duration must be a token: ${raw[0]}`]);
    }
    if (/^(transition|animation)(-timing-function)?$/.test(prop) && /\b(ease|ease-in|ease-out|ease-in-out)\b/.test(v.replace(/var\([^)]*\)/g, ''))) {
      out.push([line, `easing must be a token (var(--motion-ease)): ${v}`]);
    }
    if (SPACING.test(prop)) {
      const raw = v.replace(/var\([^)]*\)/g, '').replace(/calc\([^)]*\)/g, '').match(/(?<![\w-])(?!0(?:px)?\b|1px\b)\d*\.?\d+(px|rem|em)\b/);
      if (raw) out.push([line, `spacing must be a space token: ${prop}: ${v}`]);
    }
  }
  return out;
}

function jsProblems(js, ctx) {
  const out = [];
  const lineOf = (i) => js.slice(0, i).split('\n').length;
  out.push(...varProblems(js, lineOf, ctx).filter(([, msg]) => !msg.includes('only a design system sets it')));
  for (const m of js.matchAll(/['"`]#[0-9a-fA-F]{3,8}['"`]|\b(rgba?|hsla?)\(\s*\d/g)) out.push([lineOf(m.index), `raw color in script: ${m[0]}`]);
  for (const m of js.matchAll(/cubic-bezier\(/g)) out.push([lineOf(m.index), 'raw easing curve in script']);
  for (const m of js.matchAll(/(fill|stroke)="(?!currentColor|none)[^"]+"/g)) out.push([lineOf(m.index), `inline SVG color: ${m[0]}`]);
  for (const m of js.matchAll(/\.style\.(color|background|fontFamily|font|borderRadius|boxShadow|transition|animation)\s*=/g)) out.push([lineOf(m.index), `inline style.${m[1]} bypasses tokens`]);
  return out;
}

function htmlProblems(html, ctx) {
  const out = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) out.push(...cssProblems(m[1], ctx));
  for (const m of html.matchAll(/style="([^"]*)"/g)) out.push(...cssProblems(`x{${m[1]}}`, ctx));
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) out.push(...jsProblems(m[1], ctx));
  return out;
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return ['.css', '.js', '.html'].includes(extname(p)) ? [p] : [];
  });
}

// `local` is every custom property ui/ declares; pass it when linting one file on its own.
export function lint(path, text = readFileSync(path, 'utf8'), local = declared(text)) {
  const rel = relative('.', path);
  const ctx = { path: rel, local };
  const ext = extname(path);
  return ext === '.css' ? cssProblems(text, ctx) : ext === '.js' ? jsProblems(text, ctx) : htmlProblems(text, ctx);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : files(UI);
  const local = new Set(files(UI).flatMap((f) => [...declared(readFileSync(f, 'utf8'))]).filter((n) => !SCHEMA.has(n)));
  let count = 0;
  for (const f of targets) {
    for (const [line, msg] of lint(f, readFileSync(f, 'utf8'), local)) { console.log(`${relative('.', f)}:${line}  ${msg}`); count++; }
  }
  if (count) { console.log(`\n✗ ${count} problem${count === 1 ? '' : 's'}. Use a token from the design-system schema (GET /api/v1/design-systems/schema).`); process.exit(1); }
  console.log(`✓ token lint: ${targets.length} files reference only schema tokens; no hardcoded colors, fonts, radii, shadows or motion values`);
}
