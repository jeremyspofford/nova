// The final adversarial pass on #229, through the runner. X1: the address the guard judges is the
// address that is fetched, and it must be a known link exactly. X2: the free link-follow caps hold
// for the whole conversation (its turns, the helpers and scheduled runs it starts, its follow-ups),
// counted from the session log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MEMORY_CANARY, call, scripted, startNova, sleep } from './support.js';
import { Runner } from '../../src/runner.js';

const toolsOf = (s, n = 0) => s.session.turns[n].items.filter((i) => i.kind === 'tool');

async function site(links = 30) {
  const hits = [];
  const s = createServer((req, res) => {
    hits.push(req.url);
    const a = ['<a href="/p">next</a>', ...Array.from({ length: links }, (_, i) => `<a href="/p/${i}">${i}</a>`)].join('');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><p>Index</p>${a}</body></html>`);
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${s.address().port}`, hits, close: () => new Promise((r) => s.close(r)) };
}

// ---- X1 ---------------------------------------------------------------------------------------

test('X1: only a known link exactly is free; trailing punctuation, case, encoding, ?, # and a trailing slash all ask', async () => {
  const s = await site(0);
  const enc = (str) => [...Buffer.from(str)].map((b) => b.toString(6).padStart(4, '0')).join('').replace(/[0-5]/g, (d) => '.,;:!?'[d]);
  const variants = [`/p${enc(MEMORY_CANARY)}`, '/p.', '/p,;', '/P', '/%70', '/p?', '/p#x', '/p/', '/p?x=1'];
  const m = scripted((step) => {
    const list = ['/', ...variants, '/p'];
    return list[step] !== undefined ? call('web_fetch', { url: `${s.base}${list[step]}` }) : 'Done.';
  });
  const h = await startNova({ agent: m.agent });
  try {
    const { s: sess } = await h.run(`Read ${s.base}/`, () => 'deny');
    const tools = toolsOf(sess).slice(1);
    assert.deepEqual(tools.map((t) => t.needsApproval), [...variants.map(() => true), false], JSON.stringify(tools.map((t) => [t.args.url, t.needsApproval])));
    // The server saw the index and the one exact link, nothing else.
    assert.deepEqual(s.hits, ['/', '/p']);
    // What was judged is what was fetched: the canonical address, recorded as the call's argument.
    assert.equal(tools.at(-1).args.url, `${s.base}/p`);
  } finally { await h.close(); await s.close(); }
});

test('X1: the address is fetched exactly as judged (its canonical form)', async () => {
  const s = await site(0);
  const m = scripted((step) => [call('web_fetch', { url: `${s.base}/` }), call('web_fetch', { url: `${s.base.replace('http', 'HTTP')}/p` })][step] ?? 'Done.');
  const h = await startNova({ agent: m.agent });
  try {
    const { s: sess } = await h.run(`Read ${s.base}/`);
    const [, follow] = toolsOf(sess);
    assert.equal(follow.args.url, `${s.base}/p`, 'canonical');
    assert.equal(follow.needsApproval, false);
    assert.deepEqual(s.hits, ['/', '/p']);
  } finally { await h.close(); await s.close(); }
});

// ---- X2 ---------------------------------------------------------------------------------------

test('X2: the caps count across the turns of a conversation, from its log (a new runner sees the same count)', async () => {
  const s = await site();
  let n = 0;
  const m = scripted((step, c) => (/^Read/.test(c.user)
    ? [call('web_fetch', { url: `${s.base}/` }), ...[1, 2, 3, 4, 5].map((i) => call('web_fetch', { url: `${s.base}/p/${i}` }))][step] ?? 'Done.'
    : [6, 7, 8, 9].map((i) => call('web_fetch', { url: `${s.base}/p/${i + n}` }))[step] ?? 'Done.'));
  const h = await startNova({ agent: m.agent });
  try {
    const first = await h.run(`Read ${s.base}/ and some pages.`, () => 'deny');
    assert.ok(toolsOf(first.s).slice(1).every((t) => !t.needsApproval), 'five free follows');
    const fresh = new Runner(h.nova.config, h.nova.store, { ingest: h.nova.core.ingest });
    assert.equal(fresh.follows(first.id).total, 5, 'rebuilt from the log');
    const second = await h.run('More pages.', () => 'deny', first.id);
    assert.deepEqual(toolsOf(second.s, 1).map((t) => t.needsApproval), [false, false, false, true], 'the 9th on the host, across turns, asks');
    assert.equal(fresh.follows(first.id).hosts['127.0.0.1'], 8);
  } finally { await h.close(); await s.close(); }
});

test('X2: helpers started from a conversation, and its follow-ups, share its caps', async () => {
  const s = await site();
  const m = scripted((step, c) => {
    if (c.helper) {
      const k = Number(/Part (\d)/.exec(c.user)?.[1] ?? 0);
      return [call('web_fetch', { url: `${s.base}/` }), ...[0, 1, 2].map((i) => call('web_fetch', { url: `${s.base}/p/${10 + k * 3 + i}` }))][step] ?? `Part ${k} done.`;
    }
    if (c.followup) return [call('web_fetch', { url: `${s.base}/p/29` })][step] ?? 'Noted.';
    return [call('web_fetch', { url: `${s.base}/` }), call('web_fetch', { url: `${s.base}/p/1` }), call('web_fetch', { url: `${s.base}/p/2` }),
      ...[1, 2, 3].map((k) => call('delegate', { title: `Part ${k}`, task: `Part ${k}: read ${s.base}/ and three of its pages.` }))][step] ?? 'Helpers are on it.';
  });
  const h = await startNova({ agent: m.agent });
  const asked = [];
  try {
    const { id } = await (await h.post('/api/sessions', { text: `Read ${s.base}/ and hand the rest to helpers.` })).json();
    // Every run in the conversation: the index a helper opens is allowed (it was given it), any
    // other ask is declined.
    for (let i = 0; i < 1500; i++) {
      for (const [sid] of h.nova.runner.active) {
        const live = h.nova.runner.liveState(sid);
        if (!live?.approval) continue;
        const tool = (await h.session(sid)).session.turns.flatMap((t) => t.items).find((x) => x.id === live.approval);
        if (!tool || asked.some((x) => x.id === tool.id)) continue;
        asked.push(tool);
        await h.post(`/api/sessions/${sid}/approvals/${tool.id}`, { decision: tool.args.url === `${s.base}/` ? 'allow' : 'deny' });
      }
      const conv = (await h.session(id)).session;
      if (conv.turns.filter((t) => t.followup && t.state !== 'open').length === 3 && !h.nova.runner.active.size && !h.nova.helpers.running.size && !h.nova.helpers.queue.length) break;
      await sleep(15);
    }
    // The site was asked for each index, and for at most 8 pages: the conversation's cap.
    const pages = s.hits.filter((u) => u.startsWith('/p/'));
    assert.equal(pages.length, 8, JSON.stringify(s.hits));
    const capped = asked.filter((t) => /follow more links/.test(t.guard?.what ?? ''));
    assert.ok(capped.length >= 6, `the rest asked: ${JSON.stringify(asked.map((t) => [t.args.url, t.guard?.what]))}`);
    assert.ok(capped.some((t) => t.args.url.endsWith('/p/29')), 'a follow-up after a handoff counts too');
    assert.equal(h.nova.runner.follows(id).hosts['127.0.0.1'], 8);
  } finally { await h.idle().catch(() => {}); await h.close(); await s.close(); }
});
