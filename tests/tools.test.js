import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolTagFilter, parseToolCall, TOOLS, htmlToText, toolProtocol } from '../src/tools.js';
import { seedHome } from '../src/home.js';

const home = () => { const h = mkdtempSync(join(tmpdir(), 'nova-t-')); seedHome(h, new URL('../templates/home', import.meta.url).pathname); return h; };

test('the filter never lets tool markup reach the screen', () => {
  const f = new ToolTagFilter();
  const chunks = ['Let me check.', ' <tool', '_call name="read_file">', '{"path":"USER.md"}</tool_call>'];
  assert.equal(chunks.map((c) => f.push(c)).join(''), 'Let me check. ');
});

test('the filter releases a held-back "<" that turns out to be text', () => {
  const f = new ToolTagFilter();
  assert.equal(f.push('a <'), 'a ');
  assert.equal(f.push('b'), '<b');
});

test('parseToolCall splits prose from the call', () => {
  const r = parseToolCall('Checking.\n\n<tool_call name="exec">{"command": "ls"}</tool_call>');
  assert.equal(r.visible, 'Checking.');
  assert.deepEqual(r.call, { name: 'exec', args: { command: 'ls' } });
  assert.equal(r.error, null);
  assert.equal(parseToolCall('Just text.').call, null);
});

test('parseToolCall reports bad calls instead of throwing', () => {
  assert.match(parseToolCall('<tool_call name="exec">{nope</tool_call>').error, /not a JSON object/);
  assert.match(parseToolCall('<tool_call name="launch">{}</tool_call>').error, /no tool named launch/);
  assert.match(parseToolCall('<tool_call name="exec">{"a":1}').error, /not closed/);
});

test('file tools stay inside home and protect the session logs', async () => {
  const h = home();
  assert.match(await TOOLS.write_file.run({ path: 'memory/2026-10-21.md', content: '- note' }, { home: h }), /Wrote 6 bytes/);
  assert.equal(readFileSync(join(h, 'memory/2026-10-21.md'), 'utf8'), '- note');
  assert.equal(await TOOLS.read_file.run({ path: '~/memory/2026-10-21.md' }, { home: h }), '- note');
  await assert.rejects(TOOLS.read_file.run({ path: '../../etc/passwd' }, { home: h }), /outside Nova's home/);
  await assert.rejects(TOOLS.write_file.run({ path: '/etc/x', content: '' }, { home: h }), /outside Nova's home/);
  await assert.rejects(TOOLS.write_file.run({ path: 'sessions/x.jsonl', content: '' }, { home: h }), /audit trail/);
});

test('exec runs in the workspace, needs approval, and reports exit codes', async () => {
  const h = home();
  assert.equal(TOOLS.exec.needsApproval, true);
  const out = await TOOLS.exec.run({ command: 'pwd; exit 3' }, { home: h, timeoutMs: 5000 });
  assert.match(out, /workspace/);
  assert.match(out, /\[exit 3\]/);
});

test('exec stops at its timeout', async () => {
  const out = await TOOLS.exec.run({ command: 'sleep 5' }, { home: home(), timeoutMs: 200 });
  assert.match(out, /stopped after 0s|stopped after/);
});

test('htmlToText keeps the words and drops the markup', () => {
  assert.equal(htmlToText('<html><head><title>x</title></head><body><script>bad()</script><p>Hello &amp; <b>welcome</b></p><li>one</li></body></html>'), 'Hello & welcome\n- one');
});

test('the protocol lists every tool', () => {
  const p = toolProtocol();
  for (const name of Object.keys(TOOLS)) assert.ok(p.includes(name));
});
