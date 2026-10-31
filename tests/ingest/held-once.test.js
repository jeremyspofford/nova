// UX review 1, F4: the review saw "waiting for your OK: this came after reading something from
// outside" twice in a row. Did the event fire twice? No: a reply that read outside content and
// asked to keep two things records ONE memory event holding two candidates, each its own entry
// waiting in Memory. The chat now says that in one line ("2 things waiting for your OK").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTurn } from '../../ui/js/view.js';
import { call, scripted, startNova } from './support.js';

test('a tainted reply that keeps two things records one memory event with two held candidates, shown as one line', async () => {
  let base = '';
  const m = scripted((step) => [
    call('web_fetch', { url: `${base}/plain` }),
    'Bread needs time.\n<remember kind="fact">Bakes bread on Saturdays.</remember>\n<note>Read about bread.</note>',
  ][step] ?? 'Done.');
  const h = await startNova({ agent: m.agent, yes: ['online'] });
  base = h.web.base;
  try {
    const { id, s } = await h.run(`Read ${base}/plain and tell me about bread.`, () => 'allow');
    const events = readFileSync(join(h.home, 'sessions', `${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const memory = events.filter((e) => e.type === 'memory');
    assert.equal(memory.length, 1, 'one memory event, not two');
    assert.deepEqual(memory[0].ops.map((o) => [o.op, o.held]), [['remember', true], ['note', true]], 'holding two candidates');
    assert.equal(new Set(memory[0].ops.map((o) => o.id)).size, 2, 'each its own candidate');
    assert.equal(h.nova.core.ingest.candidates().length, 2, 'two entries wait in Memory');

    const html = renderTurn(s.session.turns[0]);
    assert.equal((html.match(/waiting for your OK/g) ?? []).length, 1, 'the chat says it once');
    assert.match(html, /2 things waiting for your OK<\/a>: they came after reading something from outside/);
  } finally {
    await h.close();
  }
});
