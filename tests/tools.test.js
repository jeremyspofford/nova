import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolTagFilter, extractMemory, parseToolCall, TOOLS, htmlToText, toolProtocol } from '../src/tools.js';
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

test('file tools stay inside home and protect the session logs and memory', async () => {
  const h = home();
  assert.match(await TOOLS.write_file.run({ path: 'workspace/plan.md', content: '- step' }, { home: h }), /Wrote 6 bytes/);
  assert.equal(readFileSync(join(h, 'workspace/plan.md'), 'utf8'), '- step');
  assert.equal(await TOOLS.read_file.run({ path: '~/workspace/plan.md' }, { home: h }), '- step');
  await assert.rejects(TOOLS.write_file.run({ path: 'MEMORY.md', content: '' }, { home: h }), /memory blocks|<remember>/);
  await assert.rejects(TOOLS.write_file.run({ path: 'memory/2026-10-21.md', content: '' }, { home: h }), /<remember>/);
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

test('memory blocks are taken out of the reply', () => {
  const raw = 'Noted, black it is.\n\n<remember kind="preference">Takes coffee black.</remember>\n<remember replaces="m1a2b3c4">Lives in Porto.</remember>\n<note>Bought beans.</note>\n<forget id="m0000aaaa"></forget>';
  const { text, ops } = extractMemory(raw);
  assert.equal(text.trim(), 'Noted, black it is.');
  assert.deepEqual(ops, [
    { op: 'remember', kind: 'preference', replaces: undefined, text: 'Takes coffee black.' },
    { op: 'remember', kind: undefined, replaces: 'm1a2b3c4', text: 'Lives in Porto.' },
    { op: 'note', text: 'Bought beans.' },
    { op: 'forget', id: 'm0000aaaa' },
  ]);
});

test('the stream filter hides memory blocks, even split across chunks, and keeps the text after them', () => {
  const f = new ToolTagFilter();
  const chunks = ['Sure. <rem', 'ember kind="fact">Has a ', 'dog.</remember> Anything', ' else? a < b'];
  assert.equal(chunks.map((c) => f.push(c)).join(''), 'Sure.  Anything else? a < b');
  const g = new ToolTagFilter();
  assert.equal(['Checking. <no', 'te>x</note>', '<tool_call name="read_file">{}</tool_call> never'].map((c) => g.push(c)).join(''), 'Checking. ');
});
