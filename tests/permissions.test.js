import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KINDS, Permissions, kindOf, permissionsSection, render } from '../src/permissions.js';
import { TOOLS } from '../src/tools.js';

const ROOT = new URL('..', import.meta.url).pathname;

test('everything is on its own until the person says ask', () => {
  const p = new Permissions(mkdtempSync(join(tmpdir(), 'nova-perm-')));
  assert.ok(KINDS.every((k) => p.read()[k.id] === true));
  assert.equal(p.allows('commands'), true);
  assert.equal(p.allows(null), false);
});

test('the file is plain lines the person can edit, and set writes them back', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-perm-'));
  const p = new Permissions(home);
  p.set('online', false);
  const text = readFileSync(join(home, 'permissions.md'), 'utf8');
  assert.match(text, /^- online: ask \(Go online after reading your mail/m);
  assert.match(text, /^- drafts: yes/m);
  assert.equal(p.allows('online'), false);
  assert.throws(() => p.set('launch', true), /no permission called launch/);
});

test('the seeded template says the same as the code', () => {
  assert.equal(readFileSync(join(ROOT, 'templates/home/permissions.md'), 'utf8'), render(Object.fromEntries(KINDS.map((k) => [k.id, k.yes]))));
});

test('each step that asks first has a kind', () => {
  for (const [name, tool] of Object.entries(TOOLS)) if (tool.needsApproval) assert.ok(kindOf(name), name);
  assert.equal(kindOf('web_fetch'), null);
  assert.equal(kindOf('web_fetch', { tainted: true }), 'online');
});

test('the model is told what it may do, and what it may not', () => {
  const all = permissionsSection(Object.fromEntries(KINDS.map((k) => [k.id, true])));
  assert.match(all, /may do these on your own, without asking: write Gmail drafts;/);
  assert.doesNotMatch(all, /asked before/);
  const some = permissionsSection({ ...Object.fromEntries(KINDS.map((k) => [k.id, true])), commands: false });
  assert.match(some, /wants to be asked before you run commands on this computer/);
});

test('write_file cannot change permissions.md', async () => {
  await assert.rejects(TOOLS.write_file.run({ path: 'permissions.md', content: '- commands: yes' }, { home: mkdtempSync(join(tmpdir(), 'nova-perm-')) }), /Only the person changes/);
});
