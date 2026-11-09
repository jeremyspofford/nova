// The status icon is served before pairing (src/core/mesh/access.ts PUBLIC_PATHS), on the owner's
// condition, verbatim (2026-11-08):
//   "ALLOWLIST status-icon.js for pre-auth serving, with this condition — it stays self-contained
//   (no imports, no network calls, no data access), and you add a guard test that fails if it ever
//   gains one. Any future change that needs more than drawing comes back as a new question, not an
//   edit to an allowlisted file."
// This is that guard. It reads ui/js/status-icon.js as text, strips its comments (so a comment can't
// trip it and code can't hide in one), and fails on anything that imports, reaches the network or
// touches stored data. If this fails, don't loosen it: take the change back to the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_PATHS } from '../src/core/mesh/access.ts';

const FILE = join(import.meta.dirname, '..', 'ui', 'js', 'status-icon.js');

// JavaScript with its comments removed. Strings, template literals and regex literals are kept as
// they are (a '//' or '/*' inside one is not a comment, and an '/api/' string still counts); a
// template's ${…} is kept with it, so code there is still checked. Anything it can't close throws.
function stripComments(src) {
  let out = '';
  let i = 0;
  let last = ''; // the last significant character outside a comment, to tell a regex from a division
  const regexCanStart = () => last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last);
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('an unclosed /* comment');
      out += ' ';
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') throw new Error(`an unclosed string at ${i}`);
        j++;
      }
      if (j >= src.length) throw new Error(`an unclosed string at ${i}`);
      out += src.slice(i, j + 1);
      last = c;
      i = j + 1;
      continue;
    }
    if (c === '/' && regexCanStart()) {
      let j = i + 1, inClass = false;
      while (j < src.length && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '\n') throw new Error(`an unclosed regex at ${i}`);
        j++;
      }
      if (j >= src.length) throw new Error(`an unclosed regex at ${i}`);
      out += src.slice(i, j + 1);
      last = 'r';
      i = j + 1;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}

// What the file may never contain, in its code (the owner's list, and a few more of the same kinds).
const FORBIDDEN = [
  // imports
  ['an import statement', /\bimport\b(?!\s*\()/],
  ['a dynamic import(', /\bimport\s*\(/],
  ['an export … from re-export', /\bexport\s*(\*|\{[^}]*\})\s*(as\s+[\w$]+\s*)?from\b/],
  ['importScripts', /\bimportScripts\b/],
  // network
  ['fetch', /\bfetch\b/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['navigator.sendBeacon', /\bsendBeacon\b/],
  ['postMessage', /\bpostMessage\b/],
  ['an /api/ path', /\/api\//],
  ['a worker', /\b(Shared)?Worker\b|\bserviceWorker\b/],
  ['RTCPeerConnection', /\bRTCPeerConnection\b/],
  ['an image or script load (new Image, .src =)', /\bnew\s+Image\b|\.src\s*=/],
  // stored data
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['caches.', /\bcaches\s*\./],
  ['document.cookie', /\bcookie(Store)?\b/],
];

const violations = (code) => FORBIDDEN.filter(([, re]) => re.test(code)).map(([name]) => name);

test('the comment stripper: comments go, strings and regexes stay, code after a comment is still code', () => {
  assert.equal(violations(stripComments('// fetch("/api/x")\n/* localStorage */ const a = 1;')).length, 0, 'a comment can’t trip it');
  assert.deepEqual(violations(stripComments('/* x */ fetch(u)')), ['fetch'], 'code after a block comment is checked');
  assert.deepEqual(violations(stripComments('const u = "http://h/api/v1"; // fine')), ['an /api/ path'], 'a // inside a string is not a comment');
  assert.deepEqual(violations(stripComments('const r = /\\/\\*/g; localStorage.x')), ['localStorage'], 'a /* inside a regex is not a comment');
  assert.deepEqual(violations(stripComments('const s = `a ${fetch(u)} b`;')), ['fetch'], 'a template’s ${…} is checked');
  assert.deepEqual(violations(stripComments("import x from './y.js';")), ['an import statement']);
  assert.deepEqual(violations(stripComments("const m = await import('./y.js');")), ['a dynamic import(']);
  assert.deepEqual(violations(stripComments("export { a } from './y.js';")), ['an export … from re-export']);
  assert.deepEqual(violations(stripComments('export * as b from "./y.js";')), ['an export … from re-export']);
  assert.deepEqual(violations(stripComments('caches.open("x"); document.cookie')), ['caches.', 'document.cookie']);
  assert.deepEqual(violations(stripComments('const k = 4 / 2 / 1; export const z = k;')), [], 'division is not a regex; a plain export is fine');
  assert.throws(() => stripComments('/* never closed'), /unclosed/);
  assert.throws(() => stripComments('const s = "never closed\n'), /unclosed/);
});

test('ui/js/status-icon.js is self-contained: no imports, no network calls, no data access (owner, 2026-11-08)', () => {
  const code = stripComments(readFileSync(FILE, 'utf8'));
  assert.deepEqual(violations(code), [], 'status-icon.js is served before pairing on the owner’s condition that it only draws; take this change back to the owner instead of editing it in');
});

test('the allowlist and this guard stay linked: status-icon.js is public, and nothing else of its kind came with it', () => {
  assert.ok(PUBLIC_PATHS.has('/js/status-icon.js'), 'PUBLIC_PATHS serves /js/status-icon.js before pairing; this guard is what makes that safe');
  // The pairing page's own scripts, and no more: a new public script needs its own decision.
  assert.deepEqual([...PUBLIC_PATHS].filter((p) => p.endsWith('.js')).sort(), ['/js/device-key.js', '/js/pair.js', '/js/status-icon.js']);
});
