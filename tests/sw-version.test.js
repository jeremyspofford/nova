// The service worker's cache name is worked out, never bumped by hand (src/sw-version.js): a hash of
// the worker and its SHELL files. It must change whenever the served shell does, so an installed
// worker is replaced and its old cache deleted, and stay the same otherwise, so a restart of the
// same build reinstalls nothing. Neutral placeholders only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { SHELL_HASH, shellHash, shellPaths, withShellHash } from '../src/sw-version.js';

const root = new URL('..', import.meta.url).pathname;
const ui = join(root, 'ui');
const source = readFileSync(join(ui, 'sw.js'), 'utf8');

// A copy of ui/ to change files in.
const copy = () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-swv-'));
  cpSync(ui, join(dir, 'ui'), { recursive: true });
  return join(dir, 'ui');
};

test('ui/sw.js carries the placeholder once, and the shell it lists is real', () => {
  assert.equal(source.split(SHELL_HASH).length - 1, 1, 'one placeholder');
  assert.match(source, new RegExp(`const VERSION = 'nova-shell-${SHELL_HASH}';`));
  assert.doesNotMatch(source, /nova-shell-v\d+'/, 'no hand-numbered version is left to bump');
  const paths = shellPaths(source);
  assert.ok(paths.includes('/') && paths.includes('/js/app.js') && paths.includes('/styles/base.css') && paths.includes('/icons/icon-192.png'));
});

test('the hash is 12 hex characters, the same on every call and for an identical copy', () => {
  const h = shellHash(ui);
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.equal(shellHash(ui), h);
  const c = copy();
  try { assert.equal(shellHash(c), h, 'a copy of the same build: the same name'); } finally { rmSync(join(c, '..'), { recursive: true, force: true }); }
});

test('the hash changes when any SHELL file changes, and comes back when it is restored', () => {
  const c = copy();
  try {
    const original = shellHash(c);
    // The app page ('/' is index.html), a module, a stylesheet, a binary icon, the manifest, the last listed.
    const paths = shellPaths(source);
    for (const path of ['/', '/js/app.js', '/styles/base.css', '/icons/icon-192.png', '/manifest.webmanifest', paths.at(-1)]) {
      const file = join(c, path === '/' ? 'index.html' : path.slice(1));
      const before = readFileSync(file);
      appendFileSync(file, '\n');
      assert.notEqual(shellHash(c), original, `${path} changed`);
      writeFileSync(file, before);
      assert.equal(shellHash(c), original, `${path} restored`);
    }
    // Every listed file counts, not only the ones above.
    for (const path of paths) {
      const file = join(c, path === '/' ? 'index.html' : path.slice(1));
      const before = readFileSync(file);
      writeFileSync(file, Buffer.concat([before, Buffer.from(' ')]));
      assert.notEqual(shellHash(c), original, `${path} is in the hash`);
      writeFileSync(file, before);
    }
    assert.equal(shellHash(c), original);
  } finally { rmSync(join(c, '..'), { recursive: true, force: true }); }
});

test('the worker itself is in the hash: a change to what it never caches retires the old cache', () => {
  const c = copy();
  try {
    const original = shellHash(c);
    writeFileSync(join(c, 'sw.js'), source.replace('v1\\/security', 'v1\\/security|v1\\/example'));
    assert.notEqual(shellHash(c), original);
  } finally { rmSync(join(c, '..'), { recursive: true, force: true }); }
});

test('files not in SHELL do not change the hash', () => {
  const c = copy();
  try {
    const original = shellHash(c);
    appendFileSync(join(c, 'styleguide.html'), '\n<!-- example -->');
    writeFileSync(join(c, 'js', 'example-not-in-shell.js'), 'export const example = 1;\n');
    assert.ok(!shellPaths(source).includes('/styleguide.html'));
    assert.equal(shellHash(c), original);
  } finally { rmSync(join(c, '..'), { recursive: true, force: true }); }
});

test('a missing SHELL file still gives a name, a different one', () => {
  const c = copy();
  try {
    const original = shellHash(c);
    rmSync(join(c, 'icons', 'icon-512.png'));
    const h = shellHash(c);
    assert.match(h, /^[0-9a-f]{12}$/);
    assert.notEqual(h, original);
  } finally { rmSync(join(c, '..'), { recursive: true, force: true }); }
});

test('the old-cache cleanup takes hash names and the hand-numbered ones, never another cache', () => {
  const ours = new RegExp(/const OURS = \/(.+)\/;/.exec(source)[1]);
  for (const k of ['nova-shell-v70', 'nova-shell-v3', 'nova-shell-v14', 'nova-shell-0123456789ab', `nova-shell-${shellHash(ui)}`]) assert.ok(ours.test(k), k);
  for (const k of ['other-app-public-example', 'nova-test', 'nova-shell-', 'nova-shell-vx', 'nova-shell-0123456789AB', 'nova-shell-0123456789abc', `nova-shell-${SHELL_HASH}`, 'x-nova-shell-v70']) assert.ok(!ours.test(k), k);
  assert.match(source, /keys\.filter\(\(k\) => OURS\.test\(k\) && k !== VERSION\)/, 'activate deletes ours but the current one');
});

// GET /sw.js on the real server.
let nova;
let base;
before(async () => {
  nova = createNova(loadConfig({ NOVA_HOME: mkdtempSync(join(tmpdir(), 'nova-swv-s-')), NOVA_AGENT_CMD: 'unused-example-agent', NOVA_AGENT_EGRESS: 'none' }));
  await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${nova.server.address().port}`;
});
after(() => nova.server.close());

test('GET /sw.js is the worker with its cache name filled in from the current shell', async () => {
  const res = await fetch(`${base}/sw.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-cache', 'the browser checks for a new worker every time');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const body = await res.text();
  const hash = shellHash(ui);
  assert.equal(body, withShellHash(source, hash), 'only the placeholder differs from ui/sw.js');
  assert.ok(!body.includes(SHELL_HASH));
  assert.equal(/const VERSION = '([^']+)'/.exec(body)[1], `nova-shell-${hash}`);
  // Stable: asked again, and from a second server on the same files, the same name.
  assert.equal(await (await fetch(`${base}/sw.js`)).text(), body);
  const second = createNova(loadConfig({ NOVA_HOME: mkdtempSync(join(tmpdir(), 'nova-swv-s2-')), NOVA_AGENT_CMD: 'unused-example-agent', NOVA_AGENT_EGRESS: 'none' }));
  await new Promise((r) => second.server.listen(0, '127.0.0.1', r));
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${second.server.address().port}/sw.js`)).text(), body, 'a restart of the same build: the same worker');
  } finally { second.server.close(); }
});
