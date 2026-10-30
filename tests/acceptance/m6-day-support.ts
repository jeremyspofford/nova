// The M6 gate's day in the life (M6 plan §3), shared by the stand-in run (m6-day.test.ts, CI) and
// the real-Ollama run (m6-day-real.test.ts, opt-in). One day, local-only from setup to night, on
// capture's test clock: setup by conversation, models recommended and accepted, capture through a
// Screenpipe-compatible source, triage by the local decision provider, chat and the M5 calc brief
// through the local reasoner, a captured fact promoted and later forgotten everywhere, a midday
// outage that waits and never reaches the cloud, and the evening retention sweep.
//
// What a real model decides (whether to propose a memory, how to triage, whether it fixes the bug)
// is checked strictly against the stand-in and recorded as it happened against a real model. What
// privacy promises (local-only, nothing leaves, nothing private kept, forgetting holds, the cloud
// never asked) is checked strictly in both. Neutral placeholders only; nothing real is captured.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, blank, sleep } from './support.ts';
import { calcTask, writeCalc } from '../support/providers.ts';

type Node = ReturnType<typeof blank>;
type Screenpipe = { base: string; add: (...items: Record<string, unknown>[]) => unknown };

// The day: a Tuesday, in UTC (the test servers run with TZ=UTC).
export const DAY = '2030-01-15';
export const YESTERDAY = '2030-01-14';
export const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00.000Z`;

// Words that must end up nowhere (private, forgotten, swept), so the whole home can be searched.
export const SENTINEL = { fact: 'BOILER-7731', private: 'PRIVATE-4410', yesterday: 'YESTERDAY-2208', outage: 'CHECKLIST-5512' };
export const FACT = `The boiler service is booked for 12 March, reference ${SENTINEL.fact}.`;
export const OUTAGE_FACT = `The release checklist is due on Friday, reference ${SENTINEL.outage}.`;

// What the person tells capture: which apps and hours mean which space. A chat app in working hours
// is both home (the app) and work (the hours), so it stays unclassified.
export const SETTINGS = {
  spaces: ['work', 'home'],
  retention_days: 1,
  signals: [
    { kind: 'app', app: 'Editor', space: 'work' },
    { kind: 'app', app: 'Recipes', space: 'home' },
    { kind: 'app', app: 'Notes', space: 'home' },
    { kind: 'app', app: 'Chat', space: 'home' },
    { kind: 'calendar', window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }, space: 'work' },
  ],
};

// What Screenpipe sees through the day (all made up). `expect` is the space the person's signals
// give it: null is unclassified, 'dropped' is never stored.
export const ITEMS = {
  yesterday: [{ at: at('16:00', YESTERDAY), app: 'Editor', window: 'notes.md', text: `Yesterday’s notes ${SENTINEL.yesterday}`, expect: 'work' }],
  morning: [
    { at: at('08:05'), app: 'Recipes', window: 'Porridge', text: 'Oat porridge: one cup of oats, two of milk.', expect: 'home' },
    { at: at('08:20'), app: 'Notes', window: 'Home admin', text: FACT, expect: 'home' },
    { at: at('08:40'), app: 'Browser', window: 'New Incognito Tab - Browser', text: `Searching gifts ${SENTINEL.private}`, expect: 'dropped' },
    { at: at('09:15'), app: 'Editor', window: 'plan.md', text: 'Quarterly plan draft: three goals.', expect: 'work' },
    { at: at('10:00'), type: 'audio', text: 'Standup: the demo moves to Thursday.', expect: 'work' },
  ],
  midday: [
    { at: at('12:10'), app: 'Editor', window: 'plan.md', text: 'Quarterly plan: the second goal is written.', expect: 'work' },
    { at: at('12:30'), app: 'Chat', window: 'Example Chat', text: 'Lunch at one?', expect: null },
  ],
  outage: [{ at: at('13:10'), app: 'Editor', window: 'release.md', text: OUTAGE_FACT, expect: 'work' }],
  evening: [{ at: at('19:00'), app: 'Recipes', window: 'Soup', text: 'Lentil soup for dinner.', expect: 'home' }],
};
const item = (i: Record<string, unknown>) => Object.fromEntries(Object.entries(i).filter(([k]) => k !== 'expect'));

// Every file under a folder that holds the words: database, write-ahead log, backups, MEMORY.md.
export function holding(dir: string, needle: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...holding(p, needle));
    else if (e.isFile() && readFileSync(p).includes(Buffer.from(needle))) out.push(p);
  }
  return out;
}

// A backup of a running node's database, as an upgrade leaves one.
function backup(home: string, name: string) {
  mkdirSync(join(home, 'backups'), { recursive: true });
  const db = new DatabaseSync(join(home, 'nova.db'));
  try { db.exec(`VACUUM INTO '${join(home, 'backups', name)}'`); } finally { db.close(); }
}

// Every receipt on a node, read from its database (the API lists the newest 200).
function receiptsOf(home: string): { provider: string; model: string; purpose: string; egress: string; privacy_mode: string }[] {
  const db = new DatabaseSync(join(home, 'nova.db'), { readOnly: true });
  try { return db.prepare('SELECT provider, model, purpose, egress, privacy_mode FROM receipt ORDER BY at').all() as never; } finally { db.close(); }
}

export interface DayOptions {
  hub: Node;
  standby: Node | null;
  sp: Screenpipe;
  cloud: { url: string; requests: unknown[] };
  // Stops and restarts the local reasoner's runtime, and says how, plainly.
  outage: { how: string; down: () => Promise<void>; up: () => Promise<void> };
  // true: what a model decides is asserted (the stand-in); false: it is recorded as it happened.
  strict: boolean;
  // How long to wait for one model-backed step.
  waitMs: number;
  title: string;
  intro: string[];
  // The transcript, filled as the day goes, so a run that stops part-way still has its record.
  lines: string[];
}

export interface DayResult { failures: string[] }

export async function day(o: DayOptions): Promise<DayResult> {
  const { hub, standby, sp, strict } = o;
  const api = (p: string) => `/api/v1${p}`;
  const get = (p: string) => hub.get(api(p));
  const send = (method: string, p: string, body?: unknown) => hub.send(method, api(p), body);
  const lines = o.lines;
  lines.push(`# ${o.title}`, '', ...o.intro, '');
  const failures: string[] = [];
  const say = (...l: string[]) => { lines.push(...l); };
  let stepStarted = Date.now();
  let stepName = '';
  const timings: string[] = [];
  const lap = () => { if (stepName) timings.push(`| ${stepName} | ${((Date.now() - stepStarted) / 1000).toFixed(1)} s |`); };
  const step = (clock: string, name: string) => {
    lap();
    stepStarted = Date.now();
    stepName = clock;
    say('', `## ${clock} — ${name}`, '');
  };
  const took = () => `${((Date.now() - stepStarted) / 1000).toFixed(1)} s`;
  // A model's decision: asserted against the stand-in, recorded honestly against a real model.
  const soft = (ok: boolean, what: string) => {
    if (strict) assert.ok(ok, what);
    else if (!ok) { failures.push(what); say(`- **Not as hoped (recorded, not faked):** ${what}`); }
    return ok;
  };
  const waitFor = async <T>(read: () => Promise<T>, done: (v: T) => boolean, ms = o.waitMs): Promise<T> => {
    const end = Date.now() + ms;
    let v = await read();
    while (!done(v) && Date.now() < end) {
      await sleep(strict ? 30 : 250);
      v = await read();
    }
    return v;
  };
  const tick = async (now: string) => {
    const r = await send('POST', '/capture/tick', { now });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as { pulled: Record<string, { kept?: number; dropped?: Record<string, number> }>; swept: number; proposed: number };
  };
  const chat = async (text: string) => {
    const { body } = await hub.send('POST', '/api/sessions', { text });
    const s = await waitFor<any>(() => hub.get(`/api/sessions/${body.id}`), (x) => x.live === null && x.session.turns[0]?.state !== 'open');
    const turn = s.session.turns[0];
    const words = (turn.items as { type?: string; text?: string; message?: string }[]).map((i) => i.text ?? i.message ?? '').join(' ').replace(/\s+/g, ' ').trim();
    return { id: body.id as string, turn, words };
  };
  // A brief to the local model, giving the OK each time Nova asks to run the test on what the model
  // wrote. Ends when the task does, or when it waits for anything else.
  const brief = async (over: Record<string, unknown> = {}) => {
    writeCalc(join(hub.home, 'workspace'));
    const created = await send('POST', '/tasks', calcTask('openai-compatible', { privacy_mode: 'local-only', ...over }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.id as string;
  };
  const settle = async (id: string, asked: string[] = []) => {
    for (;;) {
      const t = await waitFor<any>(() => get(`/tasks/${id}`), (x) => ['done', 'failed', 'cancelled'].includes(x.state) || (x.state === 'waiting' && /OK/.test(x.reason ?? '')));
      if (t.state !== 'waiting') return { t, asked };
      if (!/OK/.test(t.reason ?? '')) return { t, asked };
      const ask = await send('GET', `/providers/tasks/${id}/test-run`);
      assert.equal(ask.status, 200, `waiting, but not for the test run: ${t.reason}`);
      asked.push(`${ask.body.files.map((f: { path: string }) => f.path).join(', ') || 'no files'} — “${ask.body.words}”`);
      assert.equal((await send('POST', `/providers/tasks/${id}/test-run`, {})).status, 200);
      await waitFor<any>(() => get(`/tasks/${id}`), (x) => x.state !== 'waiting', 10_000);
    }
  };
  const outcome = (t: any) => `**${t.state}**${t.reason ? ` — ${String(t.reason).replace(/[.\s]+$/, '')}` : ''}`;
  const sum = () => readFileSync(join(hub.home, 'workspace', 'calc', 'sum.mjs'), 'utf8');
  const receiptLine = (r: { provider: string; model: string; egress: string; purpose?: string }) => `${r.provider} · ${r.model} · egress ${r.egress}${r.purpose ? ` · ${r.purpose}` : ''}`;
  const started = Date.now();

  // ---- 07:30 setup -------------------------------------------------------------------------------
  step('07:30', 'A fresh profile, set up as local-only by conversation');
  assert.equal((await get('/health')).setup.done, false, 'a fresh profile');
  const first = await get('/setup');
  say(`**Nova:** ${first.question}`, '');
  const answers = ["Hi! I'm Sam.", 'yes', 'keep', 'plainly, please', 'keep everything on this machine', 'yes'];
  let last: any = null;
  for (const text of answers) {
    const r = await send('POST', '/setup/messages', { text });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    last = r.body;
    say(`**Person:** ${text}`, '', `**Nova:** ${r.body.reply}`, '');
  }
  assert.equal(last.view.done, true);
  assert.equal((await get('/profile')).privacy.default, 'local-only', 'setup made the profile local-only');
  const welcome = await waitFor<any>(() => get(`/tasks/${last.task.id}`), (t) => ['done', 'failed'].includes(t.state), 20_000);
  assert.equal(welcome.state, 'done', welcome.reason);
  say(`- Profile privacy: **local-only**. Setup’s first task “${welcome.title}”: ${outcome(welcome)}.`);

  // Hardware, the recommendation, transcription said plainly.
  const view = await get('/models');
  say(`- Hardware read: ${view.devices[0].words}`);
  for (const r of view.roles) say(`- Recommended for ${r.role}: ${r.pick ? `\`${r.pick.model}\`${r.pick.installed ? ' (installed)' : ' (needs a download)'} — ${r.pick.why}${r.pick.tradeoff ? ` ${r.pick.tradeoff}` : ''}` : `nothing — ${r.words}`}`);
  const accepted = await send('POST', '/models/roles/accept', {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body.assigned, ['triage-text', 'reasoner', 'embedder'], 'every role with a runtime, from installed models');
  const transcriber = accepted.body.left.find((l: { role: string }) => l.role === 'transcriber');
  assert.ok(transcriber, 'transcription is left unassigned');
  assert.match(transcriber.why, /no transcription runtime/i);
  const roles: Record<string, string> = {};
  for (const r of accepted.body.view.roles) if (r.assigned) roles[r.role] = r.assigned.model;
  assert.equal(accepted.body.view.roles.find((r: { role: string }) => r.role === 'transcriber').assigned ?? null, null);
  say(`- Accepted: ${Object.entries(roles).map(([r, m]) => `${r} → \`${m}\``).join(', ')}. Transcription stays unassigned: “${transcriber.why}”`);

  // Chat by role: the local reasoner, through M5's openai-compatible provider.
  assert.equal((await send('PUT', '/providers/openai-compatible/config', { config: { role: 'reasoner' } })).status, 200);
  const enabled = await send('POST', '/providers/openai-compatible/enable', { approved: true });
  assert.equal(enabled.body.egress.coarse, 'local');
  assert.equal((await send('PUT', '/providers/choice', { for: 'chat', id: 'openai-compatible' })).body.chat.current, 'openai-compatible');
  // A cloud model and a budget are set (as a person might, for other modes); local-only never uses them.
  assert.equal((await send('PUT', '/models/cloud', { cloud: { name: 'Example cloud', base_url: o.cloud.url, model: 'cloud-model', usd_per_mtok_in: 1, usd_per_mtok_out: 2 }, confirm: true })).status, 200);
  assert.equal((await send('PUT', '/models/budget', { per_task_usd: 0.5, per_period_usd: 5, period: 'day' })).status, 200);
  say('- Chat uses the `openai-compatible` provider set to the **reasoner** role (egress local). A cloud model (a loopback stand-in) and a cloud budget of $0.50 a task, $5 a day are set, for the record; local-only must never use them.');

  // The event and heartbeat rules the day will fire.
  const unfiled = await send('POST', '/triggers/rules', { name: 'Unfiled capture', class: 'event', connector: 'capture', topic: 'unclassified', cooldown_s: 3600, action: { kind: 'message', text: 'Something from today isn’t filed under a space yet; the Capture view has it.' } });
  assert.equal(unfiled.status, 201, JSON.stringify(unfiled.body));
  const noon = await send('POST', '/triggers/rules', {
    name: 'Midday note', class: 'heartbeat', cron: '0 12 * * *',
    action: { kind: 'task', task: { title: 'Write the midday note', owner: 'workspace', goal: 'notes/midday.md is in the workspace.', evidence_required: [{ kind: 'read_back', target: 'workspace:notes/midday.md' }], inputs: { action: 'append', path: 'notes/midday.md', content: 'Midday: halfway.\n' } } },
  });
  assert.equal(noon.status, 201, JSON.stringify(noon.body));
  say(`- Rules: an event rule on capture’s \`unclassified\` topic (a message), and a heartbeat at 12:00 (a task). Step took ${took()}.`);

  // ---- 08:00 morning: capture on -------------------------------------------------------------------
  step('08:00–10:05', 'Morning: capture on, events through the day, classified by the person’s signals');
  await tick(at('07:55'));
  const settings = await send('PUT', '/capture/settings', SETTINGS);
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  const src = (await send('POST', '/capture/sources/screenpipe', { url: sp.base })).body;
  assert.equal(src.enabled, false, 'off until consent');
  sp.add(...ITEMS.yesterday.map(item));
  const on = await send('POST', `/capture/sources/${encodeURIComponent(src.id)}/enable`, { since: at('12:00', YESTERDAY) });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const status = await get('/capture/status');
  assert.equal(status.active, true, 'the indicator shows while capture is on');
  say(`- Screenpipe (stand-in) at ${sp.base} added off, then turned on at 08:00; the person asked for what it kept since yesterday noon. Indicator: **${status.active ? 'on' : 'off'}** (${status.capturing.map((c: { name: string }) => c.name).join(', ')}).`);
  say(`- Signals: Editor → work, Recipes/Notes/Chat → home, weekdays 09:00–17:00 → work. Retention: ${SETTINGS.retention_days} day.`);
  // Turning a source on pulls it at once; that first pull brings yesterday's item. It is let finish
  // before the morning's items exist, so the 10:05 pass is the one that brings them.
  const events = async () => (await get('/capture/events?limit=200')) as any[];
  await waitFor(events, (l) => l.length === 1, 20_000);
  sp.add(...ITEMS.morning.map(item));
  const t0 = Date.now();
  const morning = await tick(at('10:05'));
  const morningMs = Date.now() - t0;
  let evs = await events();
  const byText = (list: any[], text: string) => list.find((e) => e.text === text);
  for (const i of [...ITEMS.yesterday, ...ITEMS.morning]) {
    const e = byText(evs, i.text);
    if (i.expect === 'dropped') assert.equal(e, undefined, 'a private window is never stored');
    else {
      assert.ok(e, `captured: ${i.text}`);
      assert.equal(e.space, i.expect, `${i.text}: ${e.space_by}`);
    }
  }
  assert.deepEqual(holding(hub.home, SENTINEL.private), [], 'the private window is nowhere under the home');
  const counts = (await get('/capture')).sources[0].counts;
  say(`- Pulled at 10:05 (${(morningMs / 1000).toFixed(1)} s, including the local triage of each new event): kept ${evs.length}; dropped ${JSON.stringify(morning.pulled[src.id]?.dropped ?? {})}. Source counts: ${JSON.stringify(counts)}.`);
  for (const e of [...evs].reverse()) say(`  - ${e.at.startsWith(DAY) ? '' : 'yesterday '}${e.at.slice(11, 16)} ${e.kind} ${e.app ?? '(audio)'} → **${e.space ?? 'unclassified'}**${e.space_by ? ` (${e.space_by})` : ''}`);
  say(`- The incognito window (08:40) was never stored: its words are nowhere under Nova’s home.`);

  // ---- triage: the local decision provider proposes a memory -----------------------------------------
  step('10:05', 'Triage: the local decision provider looks at what was captured (Noul)');
  const proposals = (await get('/capture/proposals')) as any[];
  const factEvent = byText(evs, FACT);
  const proposal = proposals.find((p) => p.event.id === factEvent.id);
  for (const p of proposals) assert.equal(p.provider, 'local-model', 'proposals come from the local model');
  soft(!!proposal, 'the local model proposed keeping the boiler appointment as a memory');
  // A real model may well think the standup's news is worth keeping too; that is recorded, not judged.
  if (strict) assert.equal(proposals.length, 1, 'one proposal: the stand-in says yes to the fact only');
  const decisionReceipts = receiptsOf(hub.home).filter((r) => r.purpose.startsWith('decision: capture-promote'));
  assert.ok(decisionReceipts.length >= 1, 'each decision call has a receipt');
  for (const r of decisionReceipts) assert.deepEqual([r.provider, r.egress, r.privacy_mode], ['ollama', 'local', 'local-only']);
  say(`- ${decisionReceipts.length} decision calls (capture-promote@1, one Noul question), each with a receipt: ${receiptLine(decisionReceipts[0]!)}.`);
  say(`- Proposals: ${proposals.length ? proposals.map((p) => `“${p.event.text}” p=${p.p} by \`${p.provider}\``).join('; ') : 'none'}.`);
  say(`- The local model proposed ${proposals.length} of the ${decisionReceipts.length} events it was asked about. A proposal is never a memory: the person accepts only the boiler appointment below.`);

  // ---- chat ----------------------------------------------------------------------------------------
  step('10:10', 'Chat through the local reasoner');
  const hello = await chat('Good morning. What should I start with today? One sentence.');
  soft(hello.turn.state === 'done', `chat answered (${hello.turn.state}: ${hello.words.slice(0, 200)})`);
  const chatReceipts = await get(`/receipts?session_id=${hello.id}`);
  assert.equal(chatReceipts.length, 1, 'one receipt for the one call');
  assert.deepEqual([chatReceipts[0].provider, chatReceipts[0].model, chatReceipts[0].egress], ['ollama', roles.reasoner, 'local']);
  say(`- **Person:** Good morning. What should I start with today? One sentence.`, `- **Nova** (${took()}): ${hello.words.slice(0, 600) || '(nothing)'}`, `- Receipt: ${receiptLine(chatReceipts[0])}.`);

  // ---- delegated work --------------------------------------------------------------------------------
  step('10:30', 'Delegated work: the M5 calc brief through the local model, local-only');
  const calcId = await brief();
  const calc = await settle(calcId);
  say(`- Brief: “${calc.t.title}” (\`node --test calc/sum.test.mjs\`, evidence test_result + file_diff), local-only.`);
  say(`- Nova asked before running the model’s code: ${calc.asked.join('; ') || '(not asked)'}`);
  say(`- Outcome (${took()}): ${outcome(calc.t)}.`);
  for (const c of (calc.t.verification?.checks ?? []) as { ok: boolean; why: string; requirement: { kind: string } }[]) say(`  - ${c.requirement.kind}: ${c.ok ? 'passed' : 'failed'} — ${c.why}`);
  if (soft(calc.t.state === 'done', `the calc brief was done and verified (${calc.t.state}: ${calc.t.reason ?? ''})`)) {
    assert.ok(calc.asked.length >= 1, 'Nova asked before it ran the test on the model’s code');
    assert.ok(calc.t.verification.ok);
    assert.deepEqual(calc.t.verification.checks.map((c: { requirement: { kind: string } }) => c.requirement.kind).sort(), ['file_diff', 'test_result']);
    assert.equal(sum().replace(/\s+$/, '').includes('a + b'), true, `the fix is in: ${sum()}`);
  }
  const calcReceipts = await get(`/receipts?task_id=${calcId}`);
  assert.ok(calcReceipts.length >= 1 && calcReceipts.every((r: { egress: string }) => r.egress === 'local'), 'every call for the brief stayed local');
  say(`- Receipts: ${calcReceipts.map(receiptLine).join('; ')}.`);

  // ---- memory: the person promotes the captured fact ----------------------------------------------------
  step('10:45', 'Memory: the person promotes one captured fact, with provenance');
  const promoted = proposal
    ? await send('POST', `/capture/proposals/${proposal.id}/accept`, {})
    : await send('POST', '/capture/promote', { event_ids: [factEvent.id] });
  assert.equal(promoted.status, 201, JSON.stringify(promoted.body));
  const memory = promoted.body.memory;
  assert.equal(memory.content, FACT);
  assert.equal(memory.source, `capture:${factEvent.id}`);
  assert.equal(memory.recorded_by, 'person');
  assert.equal(memory.observed_at, factEvent.at);
  const provenance = await get(`/capture/memory/${memory.id}`);
  assert.equal(provenance.length, 1);
  assert.deepEqual([provenance[0].event_id, provenance[0].by, provenance[0].present], [factEvent.id, 'person', true]);
  if (proposal) assert.equal(provenance[0].proposal_id, proposal.id);
  say(`- ${proposal ? 'Accepted the local model’s proposal' : 'Promoted it directly (the model hadn’t proposed it)'}: memory “${memory.content}” (scope ${memory.scope}).`);
  say(`- Provenance: source \`capture:<event>\`, observed ${memory.observed_at}, recorded by ${memory.recorded_by}; GET /capture/memory/{id} → event captured ${provenance[0].event_at} on ${provenance[0].device_id === src.device.id ? 'the hub' : provenance[0].device_id}${provenance[0].proposal_id ? ', from the proposal' : ''}.`);
  await hub.get('/api/memory'); // MEMORY.md is rendered from it
  if (standby) {
    await waitFor(() => standby.get(api('/memory')), (l: any[]) => l.some((x) => x.id === memory.id), 20_000);
    await waitFor(() => standby.get(api('/capture/events?limit=200')), (l: any[]) => l.some((x) => x.id === factEvent.id), 20_000);
    say('- The standby has the memory and the event it came from.');
  }
  for (const n of [hub, ...(standby ? [standby] : [])]) {
    backup(n.home, 'nova-gate-v10.db');
    assert.ok(holding(join(n.home, 'backups'), SENTINEL.fact).length > 0, 'a backup holds the fact before it is forgotten');
  }
  say(`- Backups taken on ${standby ? 'both nodes' : 'the hub'} (as an upgrade leaves them); they hold the fact.`);

  // ---- midday: heartbeat and event triggers through the local provider --------------------------------
  step('12:00–12:40', 'Midday: a heartbeat and an event trigger, triaged by the local decision provider (Choice)');
  const beat = await send('POST', '/triggers/tick', { now: `${DAY}T12:00:30Z` });
  assert.equal(beat.status, 200, JSON.stringify(beat.body));
  // The test clock jumps from today to the day of the gate, so the heartbeat also records the runs
  // "missed" in between, once, as dropped; the run due at 12:00 is the one that is triaged.
  const beats = ((await get(`/triggers?rule=${noon.body.rule.id}`)) as any[]).filter((t) => t.triage.reason !== 'Missed while Nova was off.');
  assert.equal(beats.length, 1, 'one heartbeat run at 12:00');
  const beatRec = beats[0];
  assert.equal(beatRec.triage.model?.provider, 'local-model', `the heartbeat was triaged by the local model: ${JSON.stringify(beatRec.triage)}`);
  say(`- Heartbeat “Midday note” at 12:00: triage **${beatRec.triage.decision}** by \`${beatRec.triage.model.provider}\` (${beatRec.triage.model.template_id}@${beatRec.triage.model.version}) — ${beatRec.triage.reason}`);
  if (soft(!!beatRec.ledger_task_id, `the heartbeat made its task (triage said ${beatRec.triage.decision})`)) {
    const bt = await waitFor<any>(() => get(`/tasks/${beatRec.ledger_task_id}`), (t) => ['done', 'failed', 'waiting'].includes(t.state), 20_000);
    if (bt.state === 'waiting') say(`  - Its task waits: ${bt.reason}`);
    else {
      assert.equal(bt.state, 'done', bt.reason);
      say(`  - Its task “${bt.title}”: ${outcome(bt)}.`);
    }
  }
  sp.add(...ITEMS.midday.map(item));
  await tick(at('12:40'));
  evs = await events();
  for (const i of ITEMS.midday) assert.equal(byText(evs, i.text)?.space ?? null, i.expect, i.text);
  const chatty = byText(evs, ITEMS.midday[1]!.text);
  say(`- 12:30 “${chatty.text}” in Chat during working hours: home by the app, work by the hours, so **unclassified**, not guessed.`);
  const fired = await waitFor<any[]>(() => get(`/triggers?rule=${unfiled.body.rule.id}`), (l) => l.length >= 1 && l.every((t) => t.triage?.decision));
  assert.equal(fired.length, 1, 'the unclassified event fired the rule once');
  const ev = fired[0];
  assert.equal(ev.triage.model?.provider, 'local-model', `the event was triaged by the local model: ${JSON.stringify(ev.triage)}`);
  say(`- Event trigger “Unfiled capture”: triage **${ev.triage.decision}** by \`${ev.triage.model.provider}\` — ${ev.triage.reason}`);
  if (soft(!!ev.message_id, `the event trigger told the person (triage said ${ev.triage.decision})`)) {
    const msg = ((await get('/messages')) as any[]).find((x) => x.id === ev.message_id);
    say(`  - Message: “${msg.text}”${msg.delivered_at ? '' : ` (held: ${msg.hold})`}`);
  }
  const triageReceipts = receiptsOf(hub.home).filter((r) => r.purpose.startsWith('decision: triage'));
  assert.ok(triageReceipts.length >= 2, 'both triage decisions have receipts');
  for (const r of triageReceipts) assert.deepEqual([r.provider, r.egress, r.privacy_mode], ['ollama', 'local', 'local-only']);
  say(`- Triage receipts: ${triageReceipts.length}, each ${receiptLine(triageReceipts[0]!)} (model \`${roles['triage-text']}\`).`);

  // ---- the outage ---------------------------------------------------------------------------------------
  step('13:00–13:45', 'Midday outage: the local reasoner goes down');
  say(`- How: ${o.outage.how}`);
  const before = { cloud: o.cloud.requests.length };
  await o.outage.down();
  const refused = await send('POST', '/models/infer', { role: 'reasoner', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /^Waiting on local capacity: .*This is local-only, so it stays on your devices/);
  say(`- The inference API answers 409: “${refused.body.error}”`);
  const down = await chat('Are you there?');
  assert.equal(down.turn.state, 'error');
  assert.match(down.words, /Waiting on local capacity/);
  say(`- Chat: “${down.words.slice(0, 300)}”`);
  const waitingId = await brief({ title: 'Make the failing test in calc/ pass (during the outage)' });
  const waiting = await waitFor<any>(() => get(`/tasks/${waitingId}`), (t) => t.state === 'waiting', 30_000);
  assert.equal(waiting.state, 'waiting', `${waiting.state}: ${waiting.reason}`);
  assert.match(waiting.reason, /Waiting on local capacity: .*local-only, so it stays on your devices/);
  say(`- A local-only task waits: ${outcome(waiting)}.`);
  const told = await waitFor<any[]>(() => get('/messages'), (ms) => ms.some((x) => /is waiting\. Waiting on local capacity/.test(x.text)), 20_000);
  const notice = told.find((x) => /is waiting\. Waiting on local capacity/.test(x.text));
  assert.ok(notice, 'the person is told');
  say(`- The person is told, as a proactive message: “${notice.text}”`);
  // Something captured meanwhile can't be looked at by the local model now.
  sp.add(...ITEMS.outage.map(item));
  await tick(at('13:15'));
  assert.equal(o.cloud.requests.length, before.cloud, 'local-only never reached the cloud');
  assert.deepEqual(await get('/receipts?egress=remote'), [], 'no remote receipt');
  say(`- Meanwhile capture keeps working (13:10 captured). The cloud stand-in received **${o.cloud.requests.length - before.cloud}** requests; remote receipts: **0**.`);
  const asked = receiptsOf(hub.home).filter((r) => r.purpose.startsWith('decision: capture-promote')).length;
  const outageStarted = Date.now();
  await o.outage.up();
  say('- 13:30 the runtime is back.');
  const back = await settle(waitingId);
  const outageEvents = (await get(`/tasks/${waitingId}/events`)) as { kind: string; detail?: unknown }[];
  assert.ok(outageEvents.some((e) => e.kind === 'waiting_on_model'), 'Nova noted why it waited');
  assert.ok(outageEvents.some((e) => e.kind === 'retried'), 'and ran it again by itself when capacity returned');
  say(`- The waiting task reran by itself and ended (${((Date.now() - outageStarted) / 1000).toFixed(1)} s after the runtime returned): ${outcome(back.t)}.`);
  say(`  - Events: ${outageEvents.map((e) => e.kind).join(' → ')}.`);
  soft(back.t.state === 'done', `the task from the outage was done after capacity returned (${back.t.state}: ${back.t.reason ?? ''})`);
  await tick(at('13:45'));
  const outageEvent = byText(await events(), OUTAGE_FACT);
  assert.ok(outageEvent, 'the 13:10 event was kept');
  assert.ok(receiptsOf(hub.home).filter((r) => r.purpose.startsWith('decision: capture-promote')).length > asked, 'the local model was asked about it once it was back');
  const late = ((await get('/capture/proposals')) as any[]).find((p) => p.event.id === outageEvent.id);
  if (strict) assert.ok(late, 'the stand-in says yes to the outage fact once it is asked');
  say(`- The event captured during the outage was put to the local model once it was back: ${late ? `proposed (p=${late.p}, \`${late.provider}\`)` : 'looked at, not proposed'}.`);
  assert.equal(o.cloud.requests.length, 0, 'the cloud stand-in received nothing all day so far');

  // ---- afternoon: forgetting ----------------------------------------------------------------------------
  step('17:30', `The person forgets the promoted fact: gone from memory, capture, the database and WAL, backups${standby ? ' and the standby' : ''}`);
  assert.equal((await send('DELETE', `/memory/${memory.id}`)).status, 200);
  assert.equal(((await get('/memory')) as any[]).some((x) => x.id === memory.id), false, 'gone from memory');
  assert.equal(byText(await events(), FACT), undefined, 'gone from capture (the event held the same words)');
  assert.equal((await send('GET', `/capture/events/${factEvent.id}`)).status, 404);
  await hub.get('/api/memory');
  if (standby) {
    await waitFor(() => standby.get(api('/memory')), (l: any[]) => !l.some((x) => x.id === memory.id), 20_000);
    await waitFor(() => standby.get(api('/capture/events?limit=200')), (l: any[]) => !l.some((x) => x.id === factEvent.id), 20_000);
  }
  for (const n of [hub, ...(standby ? [standby] : [])]) {
    const left = await waitFor(async () => holding(n.home, SENTINEL.fact), (l) => l.length === 0, 20_000);
    assert.deepEqual(left, [], `the fact is nowhere under ${n.home}`);
  }
  say(`- DELETE /memory/{id}: not in memory, not in capture (GET the event → 404), and its words are in no file under ${standby ? 'either node’s' : 'the hub’s'} home: database, write-ahead log, backups, MEMORY.md.`);

  // ---- evening -------------------------------------------------------------------------------------------
  step('20:00', 'Evening: retention sweeps old capture');
  sp.add(...ITEMS.evening.map(item));
  const evening = await tick(at('20:00'));
  assert.ok(evening.swept >= 1, `swept ${evening.swept}`);
  evs = await events();
  assert.equal(byText(evs, ITEMS.yesterday[0]!.text), undefined, 'yesterday’s capture is gone');
  assert.ok(byText(evs, ITEMS.evening[0]!.text), 'this evening’s capture arrived');
  assert.ok(byText(evs, ITEMS.morning[0]!.text), 'this morning’s stays (less than a day old)');
  assert.deepEqual(holding(hub.home, SENTINEL.yesterday), [], 'swept for real');
  if (standby) {
    await waitFor(() => standby.get(api('/capture/events?limit=200')), (l: any[]) => !l.some((x) => x.text === ITEMS.yesterday[0]!.text), 20_000);
    assert.deepEqual(await waitFor(async () => holding(standby.home, SENTINEL.yesterday), (l) => l.length === 0, 20_000), [], 'swept on the standby too');
  }
  const cloudView = (await get('/models')).cloud;
  assert.equal(cloudView.spent_period, 0, 'nothing spent on the cloud');
  say(`- The 20:00 pass swept ${evening.swept} event(s) older than ${SETTINGS.retention_days} day (yesterday 16:00), here${standby ? ' and on the standby' : ''}; ${evs.length} events from today remain.`);
  say(`- The cloud budget: $${cloudView.budget.per_task_usd} a task, $${cloudView.budget.per_period_usd} a ${cloudView.budget.period}; spent $${cloudView.spent_period}. Settings › Models says: “${cloudView.words}” The cloud stand-in received **${o.cloud.requests.length}** requests all day.`);
  assert.equal(o.cloud.requests.length, 0);

  // ---- all day ----------------------------------------------------------------------------------------------
  step('Night', 'All day');
  const all = receiptsOf(hub.home);
  const remote = all.filter((r) => r.egress !== 'local');
  assert.deepEqual(remote, [], 'every receipt is local');
  const egress = readFileSync(hub.egress, 'utf8');
  assert.equal(egress, '', `nothing tried to leave this machine:\n${egress}`);
  if (standby) assert.equal(readFileSync(standby.egress, 'utf8'), '', 'nor the standby');
  const byPurpose = new Map<string, number>();
  for (const r of all) {
    const k = `${r.provider} · ${r.model} · ${r.purpose.replace(/^task: .*/, 'task (the calc brief)').replace(/^chat.*/, 'chat')}`;
    byPurpose.set(k, (byPurpose.get(k) ?? 0) + 1);
  }
  say(`- Receipts: **${all.length}**, every one egress local (local-only).`);
  for (const [k, n] of byPurpose) say(`  - ${n} × ${k}`);
  say(`- The egress tripwire (every TCP connect off loopback) logged **nothing**${standby ? ' on either node' : ''}.`);
  lap();
  say(`- Wall time for the day: ${((Date.now() - started) / 1000).toFixed(0)} s.`, '', '| Step (test clock) | Wall time |', '| --- | --- |', ...timings);
  if (failures.length) say('', '## What a model didn’t do as hoped', '', ...failures.map((f) => `- ${f}`));
  return { failures };
}

export function writeEvidence(lines: string[]): void {
  mkdirSync(join(ROOT, 'docs', 'evidence'), { recursive: true });
  writeFileSync(join(ROOT, 'docs', 'evidence', 'm6-day.md'), `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
}

