// Infrastructure, networking and accounts through chat and the ingest gate (M10d): infra_plan,
// network_change and account_change are guarded steps. After a run read something from outside,
// each asks the person first, naming the source, and a "no" starts nothing. A run that read nothing
// from outside starts them on its own (each then asks in Tasks, at tier 3, before anything changes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, scripted, startNova } from './support.js';
import { makeProject, PRICES } from '../support/infra.ts';

const SITE = '127.0.0.1:5099';
const account = () => call('account_change', {
  change: 'password', site: SITE,
  steps: [{ do: 'navigate', url: `http://${SITE}/password` }, { do: 'new_password', current: '#current', password: '#new', confirm: '#again', submit: '#save', done_when: '#changed' }],
  verify: { url: `http://${SITE}/status`, expect: ['Password changes: 1'] },
});

for (const [name, what, step] of [
  ['infra_plan', 'plan infrastructure', () => call('infra_plan', { project: 'Example' })],
  ['network_change', 'change your network', () => call('network_change', { target: 'Example router', patch: { firewall: { allow: ['web'] } } })],
  ['account_change', 'change an account', account],
]) {
  test(`after reading a web page, ${name} asks first and names the source; declined, nothing starts`, async () => {
    let base = '';
    const h = await startNova({ agent: scripted((i) => [call('web_fetch', { url: `${base}/plain` }), step()][i] ?? 'Done.').agent });
    base = h.web.base;
    try {
      h.nova.core.infra.createProject({ name: 'Example', folder: makeProject().folder, budget_usd_month: 10, prices: PRICES });
      const tasks = h.nova.core.ledger.list().length;
      const { asked } = await h.run('Read the page, then do it.', () => 'deny');
      assert.deepEqual(asked.map((t) => [t.name, t.guard?.what]), [[name, what]]);
      assert.equal(asked[0].guard.sources.length, 1, 'the request names the outside source');
      assert.equal(h.nova.core.ledger.list().length, tasks, 'declined: no task was made');
      assert.deepEqual(h.nova.core.infra.list().runs, []);
      assert.deepEqual(h.nova.core.network.list().changes, []);
    } finally { await h.close(); }
  });
}

test('a run that read nothing from outside starts the account step on its own; it then asks in Tasks at tier 3', async () => {
  const h = await startNova({ agent: scripted((i) => [account()][i] ?? 'Asked.').agent });
  try {
    const { asked, s } = await h.run('Change my password there.');
    assert.deepEqual(asked, []);
    const tool = s.session.turns[0].items.find((i) => i.kind === 'tool' && i.name === 'account_change');
    assert.equal(tool.result.ok, true, tool.result.output);
    assert.equal(tool.result.link, '/tasks');
    assert.match(tool.result.output, /No password goes through this conversation/);
    const t = h.nova.core.ledger.list().find((x) => x.owner === 'browser');
    assert.equal(t.approval_tier, 3);
    assert.equal(t.state, 'waiting');
  } finally { await h.close(); }
});
