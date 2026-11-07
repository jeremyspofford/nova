// Drives the live cases through Nova's real chat path (POST /api/sessions, as the app does) and
// keeps, per case: the session log, the skill and interstitial steps, every tool call, the final
// answer, the Decision Service records (seat, model, egress, trust), the corpus requests, tokens and
// elapsed time. Approvals that come up are answered as a cautious person would: web reads of the
// fixture corpus allowed, anything else denied; each answer is logged.
//
//   node tests/ingest/interstitial-eval/corpus/drive.js --base http://127.0.0.1:4331 \
//     --ctl http://127.0.0.1:4342 --home <NOVA_HOME> --out <dir> --arm on G1 CONTROL T2 …
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CASES } from './cases.js';
import { PAGES } from './pages.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('base', 'http://127.0.0.1:4331');
const ctl = arg('ctl', 'http://127.0.0.1:4342');
const home = arg('home');
const out = arg('out');
const arm = arg('arm', 'on');
const ids = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
const H = { 'content-type': 'application/json', 'x-nova': '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
const events = (id) => { try { return readFileSync(join(home, 'sessions', `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const ROLE = Object.fromEntries(PAGES.map((p) => [p.slug, p.role]));

function spend(sessionId) {
  const dir = join(home, 'workers', 'spend');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((l) => l.session_id === sessionId);
}

function decisions(since) {
  const db = new DatabaseSync(join(home, 'nova.db'), { readOnly: true });
  try {
    return db.prepare('SELECT id, at, subsystem, template_id, version, seat, model_asked, model, privacy_mode, egress, opt_in, outcome, trust, shadows, failures, verdict_ref, why FROM decision_record WHERE at >= ? ORDER BY at').all(since)
      .map((r) => ({ ...r, shadows: JSON.parse(r.shadows).map((s) => ({ seat: s.seat, model: s.model, answers: s.answers })), failures: JSON.parse(r.failures) }));
  } finally { db.close(); }
}

async function runCase(id) {
  const c = CASES[id];
  if (!c) throw new Error(`no case ${id}`);
  await fetch(`${ctl}/set/${c.set}`, { method: 'POST' });
  const since = new Date().toISOString();
  const t0 = Date.now();
  const created = await api('POST', '/api/sessions', { text: c.text });
  if (created.status !== 201) throw new Error(`${id}: ${created.status} ${JSON.stringify(created.body)}`);
  const sid = created.body.id;
  const approvals = [];
  let ev = [];
  for (let i = 0; i < 1800; i++) {
    await sleep(2000);
    ev = events(sid);
    const snap = await api('GET', `/api/sessions/${sid}`);
    const live = snap.body?.live;
    const waiting = live?.approval;
    if (waiting) {
      const call = ev.find((e) => e.type === 'tool_call' && e.id === waiting);
      const corpusHost = (u) => { try { return new URL(String(u)).hostname === '127.0.0.77'; } catch { return false; } };
      const allow = call && (call.name === 'web_search' || (call.name === 'web_fetch' && corpusHost(call.args?.url)));
      const decision = allow ? 'allow' : 'deny';
      const r = await api('POST', `/api/sessions/${sid}/approvals/${waiting}`, { decision });
      approvals.push({ id: waiting, name: call?.name ?? null, args: call?.args ?? null, guard: call?.guard ?? null, decision, status: r.status });
      continue;
    }
    const end = ev.find((e) => ['done', 'error', 'stopped'].includes(e.type));
    if (end && !live) break;
  }
  const elapsed = Date.now() - t0;
  ev = events(sid);
  const assistant = ev.filter((e) => e.type === 'assistant').map((e) => e.text);
  const final = assistant.at(-1) ?? '';
  const calls = ev.filter((e) => e.type === 'tool_call');
  const results = Object.fromEntries(ev.filter((e) => e.type === 'tool_result').map((e) => [e.id, e]));
  const searches = calls.filter((e) => e.name === 'web_search').map((e) => ({ query: e.args?.query, ok: results[e.id]?.ok ?? null, not_sent: /^Not sent/.test(results[e.id]?.output ?? '') }));
  const fetches = calls.filter((e) => e.name === 'web_fetch').map((e) => ({ url: e.args?.url, ok: results[e.id]?.ok ?? null, screen: results[e.id]?.screen ?? null }));
  const cited = [...new Set([...final.matchAll(/\/p\/([a-z0-9-]+)/g)].map((m) => m[1]))];
  const sp = spend(sid);
  const tok = sp.filter((l) => l.kind === 'model').reduce((a, l) => ({ in: a.in + l.tokens_in, out: a.out + l.tokens_out, estimated: a.estimated || l.estimated }), { in: 0, out: 0, estimated: false });
  const corpus = (await (await fetch(`${ctl}/log`)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.at >= since);
  const ds = decisions(since);
  const rec = {
    case: id, arm, set: c.set, text: c.text, expect: c.expect, session: sid, started: since, elapsed_ms: elapsed,
    end: ev.find((e) => ['done', 'error', 'stopped'].includes(e.type)) ?? null,
    skills: ev.filter((e) => e.type === 'skill').map(({ skill, how }) => ({ skill, how })),
    interstitial: ev.filter((e) => e.type === 'interstitial'),
    tool_calls: calls.map((e) => ({ name: e.name, args: e.args, needs_approval: e.needs_approval, guard: e.guard ?? null, ok: results[e.id]?.ok ?? null, output: String(results[e.id]?.output ?? '').slice(0, 400) })),
    searches, fetches, approvals,
    answer: final, answers: assistant,
    cited: cited.map((s) => ({ slug: s, role: ROLE[s] ?? 'unknown' })),
    tokens: { in: tok.in, out: tok.out, total: tok.in + tok.out, estimated: tok.estimated, model_calls: sp.filter((l) => l.kind === 'model').length },
    decision_records: ds,
    corpus,
    events: ev,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${id}-${arm}.json`), `${JSON.stringify(rec, null, 1)}\n`);
  const ir = rec.interstitial.find((x) => x.phase === 'record');
  console.log(`${id}/${arm}: ${rec.end?.type ?? 'unfinished'} in ${Math.round(elapsed / 1000)}s; skills ${rec.skills.map((s) => `${s.skill}(${s.how})`).join(',') || 'none'}; depth ${ir?.depth ?? '-'}; searches ${searches.length} (not sent ${searches.filter((s) => s.not_sent).length}); fetches ${fetches.length}; cited ${cited.join(',') || 'none'}; tokens ${rec.tokens.total}${tok.estimated ? ' (est)' : ''}; DS ${ds.length} [${[...new Set(ds.map((d) => `${d.template_id}@${d.seat}/${d.egress}/${d.trust}`))].join(' ')}]`);
}

for (const id of ids) {
  try { await runCase(id); } catch (e) { console.log(`${id}/${arm}: FAILED ${e.message}`); }
}
