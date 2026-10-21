import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Permissions, permissionFor, permissionList, permissionsSection } from '../src/permissions.js';
import { TOOLS } from '../src/tools.js';

const home = () => mkdtempSync(join(tmpdir(), 'nova-perm-'));

test('every permission comes from a tool, and starts as ask', () => {
  const p = new Permissions(home(), () => TOOLS);
  assert.deepEqual(p.list().map((x) => x.id), ['commands', 'online', 'gmail-drafts', 'gmail-tidy', 'schedules']);
  assert.ok(p.list().every((x) => x.yes === false));
  assert.equal(p.allows('commands'), false);
});

test('a tool added later brings its own permission, named after it if it declares none', () => {
  const tools = { ...TOOLS, calendar_add: { needsApproval: true, permission: { id: 'calendar', label: 'Add calendar events' } }, mcp_jira_create: { needsApproval: true } };
  const ids = permissionList(tools).map((x) => x.id);
  assert.deepEqual(ids.slice(-2), ['calendar', 'mcp_jira_create']);
  assert.equal(permissionList(tools).at(-1).label, 'Use mcp_jira_create');
  assert.equal(permissionFor('mcp_jira_create', tools.mcp_jira_create), 'mcp_jira_create');
});

test('each step that asks first maps to its permission; going online only after mail', () => {
  assert.equal(permissionFor('exec', TOOLS.exec), 'commands');
  assert.equal(permissionFor('schedule_remove', TOOLS.schedule_remove), 'schedules');
  assert.equal(permissionFor('web_fetch', TOOLS.web_fetch), null);
  assert.equal(permissionFor('web_fetch', TOOLS.web_fetch, { tainted: true }), 'online');
});

test('set writes plain lines, and keeps lines for permissions no tool declares now', () => {
  const h = home();
  writeFileSync(join(h, 'permissions.md'), '- old-plugin: yes\n');
  const p = new Permissions(h, () => TOOLS);
  p.set('gmail-drafts', true);
  const text = readFileSync(join(h, 'permissions.md'), 'utf8');
  assert.match(text, /^- gmail-drafts: yes \(Save Gmail drafts\. Nova has no way to send email\)$/m);
  assert.match(text, /^- commands: ask /m);
  assert.match(text, /^- old-plugin: yes$/m);
  assert.equal(p.allows('gmail-drafts'), true);
  assert.throws(() => p.set('launch', true), /no permission called launch/);
});

test('the model is told what it may do without asking, and that the rest waits', () => {
  const list = new Permissions(home(), () => TOOLS).list().map((x) => ({ ...x, yes: x.id === 'gmail-drafts' }));
  const text = permissionsSection(list);
  assert.match(text, /lets you do these without asking: save Gmail drafts\./);
  assert.match(text, /These need the person's OK: run commands on this computer;/);
  assert.match(text, /the work waits until they answer/);
});

test('write_file cannot change permissions.md', async () => {
  await assert.rejects(TOOLS.write_file.run({ path: 'permissions.md', content: '- commands: yes' }, { home: home() }), /Only the person changes/);
});
