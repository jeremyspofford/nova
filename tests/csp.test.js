// Every HTML page Nova serves goes with its Content-Security-Policy (src/core/csp.ts): the exact
// directives, no inline or eval script beyond the shipped page's own hashed scripts, and the
// shipped <style> elements' nonce fresh per response.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_PAGES, createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { SAFE_PAGE_HEADERS } from '../src/supervisor/supervisor.ts';

const root = new URL('..', import.meta.url).pathname;
let nova;
let base;

before(async () => {
  const config = loadConfig({
    NOVA_HOME: mkdtempSync(join(tmpdir(), 'nova-csp-')),
    NOVA_AGENT_CMD: `node ${join(root, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none',
  });
  nova = createNova(config);
  await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${nova.server.address().port}`;
});
after(() => nova.server.close());

const directives = (csp) => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
const hash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
// The inline scripts a shipped page carries, as the browser hashes them.
const inlineScripts = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(([, a]) => !/\ssrc=/.test(` ${a}`)).map(([, , body]) => body);

// Every page the server answers with HTML: each of the app page's paths, a conversation, the
// pairing page, the styleguide, and every .html file in ui/ by its own name.
const shell = [...APP_PAGES, '/c/abc123'];
const PAGES = [
  ...shell.map((p) => [p, 'index.html']),
  ['/pair', 'pair.html'], ['/styleguide', 'styleguide.html'],
  ...readdirSync(join(root, 'ui')).filter((f) => f.endsWith('.html')).map((f) => [`/${f}`, f]),
];

test('every HTML page Nova serves has the exact policy, nosniff and a same-origin referrer', async () => {
  assert.ok(PAGES.length >= 20);
  for (const [path, file] of PAGES) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /^text\/html/, path);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, `${path} has a Content-Security-Policy`);
    const body = await res.text();
    const shipped = readFileSync(join(root, 'ui', file), 'utf8');
    const d = directives(csp);
    const nonce = /<style nonce="([^"]+)"/.exec(body)?.[1] ?? null;
    assert.deepEqual([...d.keys()], ['default-src', 'script-src', 'style-src', 'style-src-attr', 'img-src', 'connect-src', 'font-src', 'manifest-src', 'worker-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors'], path);
    assert.deepEqual(d.get('default-src'), ["'self'"], path);
    assert.deepEqual(d.get('script-src'), ["'self'", ...new Set(inlineScripts(shipped).map(hash))], `${path}: its own inline scripts by hash, nothing else`);
    assert.deepEqual(d.get('style-src'), nonce ? ["'self'", `'nonce-${nonce}'`] : ["'self'"], path);
    assert.deepEqual(d.get('style-src-attr'), ["'unsafe-inline'"], path);
    assert.deepEqual(d.get('img-src'), ["'self'", 'data:'], path);
    for (const k of ['connect-src', 'font-src', 'manifest-src', 'worker-src', 'form-action']) assert.deepEqual(d.get(k), ["'self'"], `${path} ${k}`);
    for (const k of ['object-src', 'base-uri', 'frame-ancestors']) assert.deepEqual(d.get(k), ["'none'"], `${path} ${k}`);
    for (const word of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'strict-dynamic'", 'data:', 'blob:', '*', 'http:', 'https:']) {
      assert.ok(!d.get('script-src').includes(word), `${path}: script-src has no ${word}`);
    }
    assert.ok(!d.get('style-src').includes("'unsafe-inline'"), `${path}: no inline <style> beyond the nonce`);
    assert.ok(!/https?:\/\//.test(csp), `${path}: no other host`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('referrer-policy'), 'same-origin', path);
    // Every <style> the page ships carries the nonce, and nothing else does.
    assert.equal((body.match(/<style\b/g) ?? []).length, body.split(`<style nonce="${nonce}"`).length - 1, path);
  }
});

test('the app page’s inline scripts are allowed by hash, and they are the ones it ships', async () => {
  const shipped = readFileSync(join(root, 'ui/index.html'), 'utf8');
  const scripts = inlineScripts(shipped);
  assert.equal(scripts.length, 2, 'the status-bar picker and the never-blank timer');
  const d = directives((await fetch(`${base}/`)).headers.get('content-security-policy'));
  for (const s of scripts) assert.ok(d.get('script-src').includes(hash(s)));
  // pair.html and styleguide.html carry no inline script at all.
  for (const p of ['/pair', '/styleguide']) assert.deepEqual(directives((await fetch(base + p)).headers.get('content-security-policy')).get('script-src'), ["'self'"], p);
});

test('the style nonce is fresh for each response', async () => {
  const nonceOf = async (p) => /'nonce-([^']+)'/.exec((await fetch(base + p)).headers.get('content-security-policy'))?.[1];
  const [a, b] = [await nonceOf('/'), await nonceOf('/')];
  assert.ok(a && b && a !== b && a.length >= 24);
  assert.ok(await nonceOf('/styleguide'));
  assert.equal(await nonceOf('/pair'), undefined, 'a page with no <style> names no nonce');
});

test('non-HTML responses keep their own headers (no policy needed)', async () => {
  const res = await fetch(`${base}/js/app.js`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), null);
});

test('the supervisor’s safe-mode page loads nothing and runs nothing', () => {
  const d = directives(SAFE_PAGE_HEADERS['content-security-policy']);
  assert.deepEqual(d.get('default-src'), ["'none'"]);
  assert.equal(d.get('script-src'), undefined, 'falls back to none');
  assert.equal(d.get('style-src').length, 1);
  assert.match(d.get('style-src')[0], /^'sha256-/);
  assert.deepEqual(d.get('frame-ancestors'), ["'none'"]);
  assert.equal(SAFE_PAGE_HEADERS['x-content-type-options'], 'nosniff');
});
