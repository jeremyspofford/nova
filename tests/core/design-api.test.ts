import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/design-system.json', import.meta.url), 'utf8'));

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'nova-ds-'));
  const config = { ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC' }), port: 0 };
  const nova = createNova(config);
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}`;
  const base = `${root}/api/v1`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-nova': '1' }) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const text = async (url: string) => {
    const res = await fetch(url);
    return { status: res.status, type: res.headers.get('content-type') ?? '', cache: res.headers.get('cache-control') ?? '', body: await res.text() };
  };
  // Collects `design-system` events from the core's stream.
  const listen = () => {
    const seen: Record<string, unknown>[] = [];
    const ac = new AbortController();
    const ready = fetch(`${base}/events`, { signal: ac.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (const m of buf.matchAll(/event: design-system\ndata: (.*)\n\n/g)) seen.push(JSON.parse(m[1]!));
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      }
    }).catch(() => {});
    return { seen, stop: () => { ac.abort(); return ready; } };
  };
  const stop = async () => { nova.server.close(); await nova.core.close(); };
  return { nova, root, base, call, text, listen, stop };
}

const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };

test('list, one, and the schema the UI reads instead of keeping a copy', async () => {
  const { call, stop } = await boot();
  const list = await call('GET', '/design-systems');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((d: { id: string }) => d.id).sort(), ['aurora', 'companion-light', 'nova', 'obsidian', 'orb-teal', 'paper']);
  assert.ok(list.body.every((d: { valid: boolean; problems: string[] }) => d.valid && d.problems.length === 0));
  assert.equal(list.body.find((d: { active: boolean }) => d.active).id, 'orb-teal');
  const one = await call('GET', '/design-systems/companion-light');
  assert.equal(one.body.name, 'Companion Light');
  assert.equal(one.body.manifest.tokens['font/display'].includes('serif'), true);
  assert.equal((await call('GET', '/design-systems/nope')).status, 404);
  const schema = await call('GET', '/design-systems/schema');
  assert.ok(schema.body.tokens.some((t: { name: string; css: string }) => t.name === 'bg/base' && t.css === '--bg-base'));
  assert.equal(schema.body.era2_aliases, undefined, 'the Era 2 aliases are gone');
  await stop();
});

test('GET /design-system.css serves the active package as CSS, with no caching', async () => {
  const { root, text, stop } = await boot();
  const css = await text(`${root}/design-system.css`);
  assert.equal(css.status, 200);
  assert.match(css.type, /^text\/css/);
  assert.match(css.cache, /no-store/);
  assert.match(css.body, /Orb Teal/);
  assert.match(css.body, /--bg-base: #062a30;/);
  assert.match((await text(`${root}/design-system.css?device=device-aaaa1111`)).body, /Orb Teal/);
  await stop();
});

test('apply for the user and per device, then roll back; every change is on the event stream', async () => {
  const { root, call, text, listen, stop } = await boot();
  const events = listen();
  await new Promise((r) => setTimeout(r, 50));
  const applied = await call('POST', '/design-systems/companion-light/apply', { scope: 'user' });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.active.id, 'companion-light');
  assert.match((await text(`${root}/design-system.css`)).body, /Companion Light/);

  const device = await call('POST', '/design-systems/obsidian/apply', { scope: 'device', device_id: 'device-aaaa1111' });
  assert.equal(device.body.active.id, 'obsidian');
  assert.match((await text(`${root}/design-system.css?device=device-aaaa1111`)).body, /Obsidian/);
  assert.match((await text(`${root}/design-system.css?device=device-bbbb2222`)).body, /Companion Light/);
  assert.equal((await call('GET', '/design-systems/active?device=device-aaaa1111')).body.id, 'obsidian');

  const back = await call('POST', '/design-systems/rollback', { scope: 'device', device_id: 'device-aaaa1111' });
  assert.equal(back.body.active.id, 'companion-light');
  const userBack = await call('POST', '/design-systems/rollback', { scope: 'user' });
  assert.equal(userBack.body.active.id, 'orb-teal');
  assert.match((await text(`${root}/design-system.css`)).body, /Orb Teal/);

  await until(() => events.seen.length >= 4);
  await events.stop();
  assert.deepEqual(events.seen.map((e) => [e.action, e.id, e.scope]), [
    ['apply', 'companion-light', 'user'], ['apply', 'obsidian', 'device'], ['rollback', 'companion-light', 'device'], ['rollback', 'orb-teal', 'user'],
  ]);
  await stop();
});

test('preview CSS renders a package for a sandboxed frame without applying it', async () => {
  const { base, call, text, stop } = await boot();
  const preview = await text(`${base}/design-systems/paper/preview.css?mode=dark`);
  assert.equal(preview.status, 200);
  assert.match(preview.type, /^text\/css/);
  assert.match(preview.body, /--bg-base: #171512;/);
  assert.equal((await call('GET', '/design-systems/active')).body.id, 'orb-teal');
  assert.equal((await text(`${base}/design-systems/paper/preview.css?mode=sepia`)).status, 400);
  await stop();
});

test('a third-party package installs over the API, validates, applies, and is removed through the extension host', async () => {
  const { root, call, text, stop } = await boot();
  const installed = await call('POST', '/design-systems', { manifest: fixture() });
  assert.equal(installed.status, 201);
  assert.equal(installed.body.design_system.id, 'example.slate');
  assert.deepEqual(installed.body.review, ['Asks for no permissions.']);
  // A package made before M9 (the fixture's motion is 120/320 ms) is valid; its motion is a warning, clamped in the CSS.
  const checked = (await call('POST', '/design-systems/example.slate/validate')).body;
  assert.deepEqual({ ok: checked.ok, problems: checked.problems }, { ok: true, problems: [] });
  // Made before DESIGN-SYSTEM §5's status bar too: it applies with iOS's own strip, and says so.
  assert.equal(checked.warnings.length, 3);
  assert.equal(checked.warnings.filter((w: string) => /ios_status_bar isn’t declared/.test(w)).length, 1);
  await call('POST', '/design-systems/example.slate/apply', { scope: 'user' });
  assert.match((await text(`${root}/design-system.css`)).body, /Example Slate/);
  assert.equal((await call('DELETE', '/extensions/example.slate')).status, 200);
  assert.match((await text(`${root}/design-system.css`)).body, /Orb Teal/);
  assert.equal((await call('DELETE', '/extensions/nova')).status, 409, 'built-ins stay');
  await stop();
});

test('an invalid package is listed with its problems and refused when applied', async () => {
  const { call, stop } = await boot();
  const bad = fixture();
  bad.id = 'example.faded';
  bad.tokens['text/primary'] = '#eeeeee';
  await call('POST', '/design-systems', { manifest: bad });
  const listed = (await call('GET', '/design-systems')).body.find((d: { id: string }) => d.id === 'example.faded');
  assert.equal(listed.valid, false);
  const validated = await call('POST', '/design-systems/example.faded/validate');
  assert.equal(validated.body.ok, false);
  assert.match(validated.body.problems.join(' '), /text\/primary on bg\/base/);
  const refused = await call('POST', '/design-systems/example.faded/apply', { scope: 'user' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /can’t be applied/);
  assert.ok(refused.body.details.length);
  assert.equal((await call('POST', '/design-systems', { manifest: { ...fixture(), kind: 'connector' } })).status, 400);
  await stop();
});

test('the mode is set through the profile route and emits the event; other appearance keys go through apply', async () => {
  const { root, call, text, listen, stop } = await boot();
  await call('POST', '/design-systems/paper/apply', { scope: 'user' });
  const events = listen();
  await new Promise((r) => setTimeout(r, 50));
  const set = await call('PUT', '/profile/appearance/mode', { value: 'dark' });
  assert.equal(set.status, 200);
  assert.equal(set.body.mode, 'dark');
  assert.match((await text(`${root}/design-system.css`)).body, /--bg-base: #171512;/);
  assert.equal((await call('PUT', '/profile/appearance/mode', { value: 'sepia' })).status, 400);
  const direct = await call('PUT', '/profile/appearance/design_system', { value: 'aurora' });
  assert.equal(direct.status, 400);
  assert.match(direct.body.error, /apply/);
  await until(() => events.seen.length >= 1);
  await events.stop();
  assert.equal(events.seen[0]!.action, 'mode');
  assert.equal((await call('GET', '/profile')).body.appearance.mode, 'dark');
  await stop();
});

test('changes to design systems need Nova’s own header', async () => {
  const { call, stop } = await boot();
  assert.equal((await call('POST', '/design-systems/paper/apply', { scope: 'user' }, {})).status, 403);
  assert.equal((await call('POST', '/design-systems/rollback', { scope: 'user' }, {})).status, 403);
  assert.equal((await call('POST', '/design-systems', { manifest: fixture() }, {})).status, 403);
  await stop();
});

test('the contrast fix over the API: one device, its CSS, the event, and undo', async () => {
  const { root, call, text, listen, stop } = await boot();
  const mist = fixture();
  Object.assign(mist, { id: 'example.mist', name: 'Example Mist' });
  Object.assign(mist.tokens, { 'border/strong': '#d3d7dc', 'bg/raised': '#d9dde3', 'accent/primary': '#234a8c', 'text/secondary': '#5f6872' });
  assert.equal((await call('POST', '/design-systems', { manifest: mist })).status, 201);
  assert.equal((await call('POST', '/extensions/example.mist/enable')).status, 200);
  const listed = (await call('GET', '/design-systems')).body.find((d: { id: string }) => d.id === 'example.mist');
  assert.equal(listed.looks.default.ok, false, 'the list says it fails the live check');
  await call('POST', '/design-systems/example.mist/apply', { scope: 'user' });
  const before = (await text(`${root}/design-system.css?device=device-aaaa1111`)).body;
  const events = listen();
  await new Promise((r) => setTimeout(r, 50));
  const fixed = await call('POST', '/design-systems/contrast-fix', { device_id: 'device-aaaa1111' });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.deepEqual(fixed.body.fixed.sort(), ['border/strong', 'text/secondary']);
  const after = (await text(`${root}/design-system.css?device=device-aaaa1111`)).body;
  assert.notEqual(after, before);
  assert.equal((await text(`${root}/design-system.css?device=device-bbbb2222`)).body, before);
  assert.equal((await call('GET', '/design-systems/active?device=device-aaaa1111')).body.fix['border/strong'] > 0, true);
  assert.equal((await call('POST', '/design-systems/contrast-fix/undo', { device_id: 'device-aaaa1111' })).status, 200);
  assert.equal((await text(`${root}/design-system.css?device=device-aaaa1111`)).body, before);
  assert.equal((await call('POST', '/design-systems/contrast-fix/undo', { device_id: 'device-aaaa1111' })).status, 409);
  assert.equal((await call('POST', '/design-systems/contrast-fix', {}, {})).status, 403, 'needs Nova’s own header');
  await until(() => events.seen.length >= 2);
  await events.stop();
  assert.deepEqual(events.seen.map((e) => e.action), ['contrast-fix', 'contrast-fix']);
  await stop();
});
