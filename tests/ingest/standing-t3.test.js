// Insertion #3 T3: standing files load into every future prompt, so a run that has seen any tool
// output asks before changing them, tainted or not; and Nova's status tools, which can relay outside
// text, are screened like any other tool output. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, scripted, startNova } from './support.js';

const YES = ['commands', 'gmail-drafts', 'gmail-tidy', 'schedules'];
const toolsOf = (s, n = 0) => s.session.turns[n].items.filter((i) => i.kind === 'tool');

test('T3: after any tool output, even in an untainted run, changing a standing file asks', async () => {
  const m = scripted((step) => [call('exec', { command: 'echo placeholder' }), call('write_file', { path: 'AGENTS.md', content: '# a line from a command\n' })][step] ?? 'Done.');
  const h = await startNova({ agent: m.agent, yes: YES });
  try {
    const before = readFileSync(join(h.home, 'AGENTS.md'), 'utf8');
    const { asked } = await h.run('Run the placeholder command.', () => 'deny');
    assert.deepEqual(asked.map((t) => [t.name, t.guard?.what]), [['write_file', 'change your standing files']]);
    assert.equal(readFileSync(join(h.home, 'AGENTS.md'), 'utf8'), before, 'denied: unchanged');
  } finally { await h.close(); }
});

test('T3: a standing-file change before any tool output still goes on its own', async () => {
  const m = scripted((step) => [call('write_file', { path: 'USER.md', content: '# Prefers short answers\n' })][step] ?? 'Done.');
  const h = await startNova({ agent: m.agent, yes: YES });
  try {
    const { asked } = await h.run('Note that I prefer short answers.', () => 'deny');
    assert.deepEqual(asked, [], 'nothing outside has reached this run yet');
    assert.equal(readFileSync(join(h.home, 'USER.md'), 'utf8'), '# Prefers short answers\n');
  } finally { await h.close(); }
});

test('T3: Nova’s status tools are screened like any tool output', async () => {
  const names = ['nova_settings', 'nova_instance', 'nova_schedules'];
  const m = scripted((step) => [...names.map((n) => call(n, {}))][step] ?? 'Done.');
  const h = await startNova({ agent: m.agent, yes: YES });
  try {
    const { s } = await h.run('How are things set up?', () => 'deny');
    const tools = toolsOf(s);
    assert.deepEqual(tools.map((t) => t.name), names);
    for (const t of tools) assert.ok(t.result?.screen, `${t.name} was screened`);
  } finally { await h.close(); }
});
