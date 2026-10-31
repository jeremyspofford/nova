// Coding through chat and the ingest gate (M10c): code_change is a guarded step. After a run read
// something from outside, starting a coding run asks the person first, naming the source, and a
// "no" starts nothing. A run that read nothing from outside starts it on its own (tier 1: Nova's own
// worktree; the tests and the merge ask in Tasks anyway).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { call, scripted, startNova } from './support.js';
import { FAKE_CLAUDE, agentScript, makeRepos } from '../support/coding.ts';

const start = (repos) => call('code_change', { repo: repos.person, goal: 'Make greet() say hello.', test_command: 'node --test' });

async function boot(plan) {
  const m = scripted(plan);
  const h = await startNova({ agent: m.agent });
  return h;
}

test('after reading a web page, code_change asks first and names the source; declined, no run starts', async () => {
  const repos = makeRepos('nova-coding-guard-');
  let base = '';
  const h = await boot((step) => [call('web_fetch', { url: `${base}/plain` }), start(repos)][step] ?? 'Done.');
  base = h.web.base;
  try {
    h.nova.core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${agentScript('fix', join(repos.dir, 'scripts'))}` });
    h.nova.core.providers.enable('claude-code', { approved: true });
    const { asked } = await h.run('Read the page, then fix the code.', () => 'deny');
    assert.deepEqual(asked.map((t) => [t.name, t.guard?.what]), [['code_change', 'change code in a repository']]);
    assert.equal(asked[0].guard.sources.length, 1, 'the request names the outside source');
    assert.deepEqual(h.nova.core.coding.list(), [], 'declined: nothing started');
  } finally { await h.close(); }
});

test('a run that read nothing from outside starts the coding run on its own', async () => {
  const repos = makeRepos('nova-coding-guard-');
  const h = await boot((step) => [start(repos)][step] ?? 'Started.');
  try {
    h.nova.core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${agentScript('fix', join(repos.dir, 'scripts'))}` });
    h.nova.core.providers.enable('claude-code', { approved: true });
    const { asked, s } = await h.run('Fix the code.');
    assert.deepEqual(asked, []);
    const tool = s.session.turns[0].items.find((i) => i.kind === 'tool' && i.name === 'code_change');
    assert.equal(tool.result.ok, true, tool.result.output);
    assert.equal(tool.result.link, '/tasks');
    assert.equal(h.nova.core.coding.list().length, 1);
    await h.nova.core.ledger.idle();
  } finally { await h.close(); }
});
