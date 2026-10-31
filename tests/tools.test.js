import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ToolTagFilter, extractMemory, parseToolCall, TOOLS, htmlToText, toolProtocol, availableTools } from '../src/tools.js';
import { seedHome } from '../src/home.js';

const home = () => { const h = mkdtempSync(join(tmpdir(), 'nova-t-')); seedHome(h, new URL('../templates/home', import.meta.url).pathname); return h; };

test('no file tool reads or writes the vault, the mesh keys, or Era 2’s connection secrets', async () => {
  const h = home();
  for (const path of ['vault/key', 'vault/secrets.json', 'mesh/identity.json', 'connectors/gmail/token.json', '~/mesh/x']) {
    await assert.rejects(TOOLS.read_file.run({ path }, { home: h }), /can't be read/, path);
    await assert.rejects(TOOLS.write_file.run({ path, content: 'x' }, { home: h }), /can't be written/, path);
  }
});

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

test('the protocol lists every tool on offer', () => {
  const p = toolProtocol(availableTools({ gmail: true, skills: 1, delegate: true, self: true, coding: true }));
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

test('web_fetch fails when the page answers with an error, and reads it when it answers', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url === '/busy') { res.writeHead(429, { 'content-type': 'text/html' }); res.end('<p>Slow down</p>'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>E-bikes</h1><p>Three to compare.</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // A local stand-in for a public site: only a test may let web_fetch reach this machine.
    const ctx = { fetchAllow: () => true };
    await assert.rejects(TOOLS.web_fetch.run({ url: `${base}/busy` }, ctx), /HTTP 429/);
    assert.match(await TOOLS.web_fetch.run({ url: `${base}/` }, ctx), /^HTTP 200 OK[\s\S]*Three to compare/);
  } finally { server.close(); }
});

// A hole older than the M7 amendment, closed with it: the agent's write_file could write Nova's own
// state (nova.db, the pre-upgrade copies a rollback restores from, .git/hooks, a factory reset's
// marker). It writes only inside workspace/ and to the standing files it is meant to edit; read_file
// never reads Nova's database, checkpoints, backups, history, the reset marker, the vault or keys.
test('write_file writes only the workspace and the standing files; everything else of Nova’s is refused', async () => {
  const h = home();
  for (const path of ['workspace/notes/a.md', 'USER.md', 'SOUL.md', 'AGENTS.md', 'IDENTITY.md']) {
    assert.match(await TOOLS.write_file.run({ path, content: 'ok' }, { home: h }), /Wrote 2 bytes/, path);
  }
  for (const path of [
    'nova.db', 'nova.db-wal', 'nova.db-shm', 'backups/nova-2026-10-29.db', '.git/hooks/post-commit', '.git/config', '.gitignore',
    'checkpoints/.seal', 'checkpoints/.restore/marker.json', 'checkpoints/000001-x/manifest.json', 'factory-reset.json', 'reset-report.json',
    'changes/x.json', 'extensions/x/manifest.json', 'logs/nova.log', 'workers/x', 'kept/x', 'exports/x', 'nova.pid', 'skills/x/SKILL.md',
    'notes-at-the-top.md', '.nova-home',
  ]) {
    await assert.rejects(TOOLS.write_file.run({ path, content: 'x' }, { home: h }), /can't be written/, path);
  }
  await assert.rejects(TOOLS.write_file.run({ path: '.git/hooks/post-commit', content: '#!/bin/sh\necho planted\n' }, { home: h }), /only in workspace\/ and its standing files/);
  assert.ok(!existsSync(join(h, '.git', 'hooks', 'post-commit')));
});

test('read_file never reads Nova’s database, checkpoints, backups, history, the reset marker, the vault or keys', async () => {
  const h = home();
  for (const [f, text] of [['nova.db', 'db'], ['checkpoints/.seal', 'seal'], ['factory-reset.json', '{}'], ['memory/2026-10-30.md', '- a note']]) {
    mkdirSync(dirname(join(h, f)), { recursive: true });
    writeFileSync(join(h, f), text);
  }
  for (const path of ['nova.db', 'nova.db-wal', 'checkpoints/.seal', 'checkpoints/000001-x/files/mesh/identity.json', 'backups/x.db', '.git/config', 'factory-reset.json', 'vault/key', 'mesh/identity.json']) {
    await assert.rejects(TOOLS.read_file.run({ path }, { home: h }), /can't be read/, path);
  }
  assert.equal(await TOOLS.read_file.run({ path: 'memory/2026-10-30.md' }, { home: h }), '- a note');
  assert.match(await TOOLS.read_file.run({ path: 'USER.md' }, { home: h }), /\S/);
});

test('a link inside the workspace can’t carry a write or a read out to Nova’s own files', async () => {
  const h = home();
  writeFileSync(join(h, 'nova.db'), 'db');
  symlinkSync(join(h, 'nova.db'), join(h, 'workspace', 'link'));
  symlinkSync(h, join(h, 'workspace', 'up'));
  await assert.rejects(TOOLS.write_file.run({ path: 'workspace/link', content: 'x' }, { home: h }), /can't be written/);
  await assert.rejects(TOOLS.write_file.run({ path: 'workspace/up/factory-reset.json', content: 'x' }, { home: h }), /can't be written/);
  await assert.rejects(TOOLS.read_file.run({ path: 'workspace/link' }, { home: h }), /can't be read/);
  assert.equal(readFileSync(join(h, 'nova.db'), 'utf8'), 'db');
  assert.ok(!existsSync(join(h, 'factory-reset.json')));
});

// Re-review findings 2 and 3: a link that leads nowhere yet is still a link, and names are compared
// the way a case-insensitive disk (macOS, Windows) would see them.
test('write_file never goes through a link, even one that leads nowhere yet', async () => {
  const h = home();
  mkdirSync(join(h, '.git', 'hooks'), { recursive: true });
  symlinkSync('../factory-reset.json', join(h, 'workspace', 'marker'));
  symlinkSync('../.git/hooks/post-commit', join(h, 'workspace', 'hook'));
  const out = mkdtempSync(join(tmpdir(), 'nova-t-out-'));
  symlinkSync(join(out, 'planted.txt'), join(h, 'workspace', 'away'));
  for (const path of ['workspace/marker', 'workspace/hook', 'workspace/away']) {
    await assert.rejects(TOOLS.write_file.run({ path, content: 'x' }, { home: h }), /can't be written/, path);
  }
  assert.ok(!existsSync(join(h, 'factory-reset.json')));
  assert.ok(!existsSync(join(h, '.git', 'hooks', 'post-commit')));
  assert.ok(!existsSync(join(out, 'planted.txt')));
});

test('the file tools compare names whatever their case or Unicode form', async () => {
  const h = home();
  for (const [f, text] of [['NOVA.db', 'db'], ['Checkpoints/.seal', 'seal'], ['.NOVA-HOME', 'mark'], ['Vault/key', 'key'], ['MESH/identity.json', '{}'], ['Backups/x.db', 'db']]) {
    mkdirSync(dirname(join(h, f)), { recursive: true });
    writeFileSync(join(h, f), text);
  }
  for (const path of ['NOVA.db', 'Checkpoints/.seal', '.NOVA-HOME', 'Vault/key', 'MESH/identity.json', 'Backups/x.db', 'Nova.DB-wal']) {
    await assert.rejects(TOOLS.read_file.run({ path }, { home: h }), /can't be read/, path);
  }
  for (const path of ['Factory-Reset.json', 'NOVA.db', 'Memory.md', 'SESSIONS/x.jsonl', 'Permissions.md']) {
    await assert.rejects(TOOLS.write_file.run({ path, content: 'x' }, { home: h }), /can't be written|Memory is kept|audit trail|Only the person/, path);
  }
  // Writing needs the name exactly as allowed, as well as folded: folding must never widen it.
  for (const path of ['WORKSPACE/x.md', 'user.md', 'User.md', 'Workspace/notes.md']) {
    await assert.rejects(TOOLS.write_file.run({ path, content: 'x' }, { home: h }), /can't be written/, path);
  }
  assert.match(await TOOLS.write_file.run({ path: 'USER.md', content: 'ok' }, { home: h }), /Wrote 2 bytes/);
});
