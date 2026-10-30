// M7a with a real model (not CI): the foundry asks the Ollama on this machine, through the model
// manager's reasoner role, local-only, for the daily wind-down reminder; whatever it writes goes
// through every gate. Free and local; skipped unless NOVA_REAL_OLLAMA=1. Model: NOVA_REAL_MODEL
// (default Qwen3:8b), at NOVA_REAL_OLLAMA_URL (default http://127.0.0.1:11434). Only reading and
// inference reach Ollama: the model must already be installed; nothing is pulled or removed.
// A real model may write something the gates stop; that is recorded as it happened. What must hold
// either way: nothing is live that didn't pass every gate, and nothing left this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blank, stop, until } from './support.ts';

const on = process.env.NOVA_REAL_OLLAMA === '1';

test('M7a evidence: the foundry on a real local model, through the pipeline', { skip: !on && 'set NOVA_REAL_OLLAMA=1 to run against the local Ollama', timeout: 900_000 }, async () => {
  const model = process.env.NOVA_REAL_MODEL ?? 'Qwen3:8b';
  const url = process.env.NOVA_REAL_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const m = blank('nova-m7a-ollama-');
  const nova = await m.start({ NOVA_OLLAMA_URL: url, NOVA_TEST_CLOCK: '1' });
  const api = (p: string) => `/api/v1${p}`;
  const started = Date.now();
  try {
    await m.send('PUT', api('/profile/user/timezone'), { value: 'UTC' });
    const role = await m.send('PUT', api('/models/roles/reasoner'), { model });
    assert.equal(role.status, 200, JSON.stringify(role.body));
    const asked = await m.send('POST', api('/foundry'), { need: 'Remind me to wind down at nine every evening', kind: 'trigger-rules' });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const authored = await until<any>(() => m.get(api(`/tasks/${asked.body.id}`)), (t) => ['done', 'failed', 'cancelled', 'waiting'].includes(t.state), 32_000);
    const lines = [`Model ${model} at ${url}, ${Math.round((Date.now() - started) / 1000)} s to write. Foundry task: ${authored.state}${authored.reason ? ` — ${String(authored.reason).replace(/[.\s]+$/, '')}` : ''}.`];
    const receipts = await m.get(api(`/receipts?task_id=${asked.body.id}`));
    assert.ok(receipts.every((r: { egress: string }) => r.egress === 'local'), 'local-only: the model on this machine');
    if (authored.state === 'done') {
      const c = (await m.get(api('/changes'))).changes.find((x: any) => x.proposed_by === 'foundry');
      assert.equal(c.tier, 3);
      const settled = await until<any>(() => m.get(api(`/changes/${c.id}`)), (x) => x.state !== 'checking', 2400);
      lines.push(`Change “${settled.title}” v${settled.version}: ${settled.state}${settled.reason ? ` — ${String(settled.reason).replace(/[.\s]+$/, '')}` : ''}.`);
      if (settled.state === 'waiting') {
        assert.equal((await m.send('POST', api(`/changes/${c.id}/ship`), { confirm: true })).status, 200);
        const live = await until<any>(() => m.get(api(`/changes/${c.id}`)), (x) => (!!x.canary?.started_at && x.canary.applied !== false) || x.state !== 'canary', 800);
        for (let i = 1; i <= 3 && live.state === 'canary'; i++) await m.send('POST', api('/changes/tick'), { now: new Date(Date.parse(live.canary.started_at) + i * 15 * 60_000).toISOString() });
        const end = await m.get(api(`/changes/${c.id}`));
        lines.push(`After its canary: ${end.state}.`);
      }
      // Nothing is live that didn't pass every gate.
      const rules = await m.get(api('/triggers/rules'));
      const live = (await m.get(api('/changes'))).changes.filter((x: any) => x.state === 'live');
      assert.ok(rules.length === 0 || live.length === 1, 'rules are live only through a promoted change');
    }
    console.log(lines.join('\n'));
    assert.equal(readFileSync(m.egress, 'utf8'), '', 'nothing tried to leave this machine');
  } finally {
    await stop(nova);
  }
});
