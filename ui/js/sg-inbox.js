// Messages and quiet hours, design-first (2026-11-09): compositions for the owner's reaction,
// before any wiring. Styleguide only: the app never loads this file, nothing here is sent anywhere,
// and every control is a specimen (a checkbox ticks, Save and the passkey say they are a demo).
//
// Drawn from the real model, src/core/triggers.ts. A message is {id, at, text, trigger_id,
// delivered_at, read_at, hold}; hold is quiet (quiet hours), needs_ok (Nova wasn't sure; only the
// person releases it) or withdrawn. Every message traces to one trigger record {rule_id, source,
// class, triage: {decision, reason}}: its source is an automation (the rule's name) or one of Nova's
// own parts, which fire with no rule: coding, infra, network, models. GET /messages lists delivered
// messages, newest by `at`; ?state=held lists quiet and needs_ok ones. POST /messages/{id}/read and
// /approve are the only actions: no delete, archive, unread or decline. There is no digest: when
// quiet hours end, the heartbeat (every 30 s) sends each held message on its own, oldest first, if
// its rule still exists, isn't paused and isn't turned off; otherwise it is withdrawn, listed
// nowhere. A message from one of Nova's own parts has no rule, so today it is withdrawn too (the
// released frame shows that, and the entry flags it). Quiet hours are policy.quiet_hours
// {start, end} (HH:MM, every day, in user.timezone, may run past midnight; start = end refused;
// none by default); policy is tier 3, so saving goes through the passkey. They hold messages
// only: tasks still start. Delivered means listed in Nova; there is no push to a phone.
// Its CSS is ui/styles/compositions.css (.ib-*, and the .au-* panes it shares with the Automations
// compositions); the narrow layout is layout.css's .au-panes rule.
import { ICONS, configDiff, passkeyAction, passkeyConfirm } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows, which pane a phone shows].
export const IB_FRAMES = [
  ['list', 'The list: one waiting for your OK, unread and read, each with where it came from', 'list'],
  ['empty', 'No messages yet', 'detail'],
  ['open', 'A message opened: read now, where it came from, and why it went out when it did', 'detail'],
  ['held', 'In quiet hours (03:10): what is held, and the one that still waits for your OK', 'list'],
  ['released', 'Quiet hours ended (07:01): each held message from an automation that still stands, sent on its own at 07:00. The Coding message held overnight is not here: today the core withdraws a held message no automation sent (flagged for the owner)', 'list'],
  ['quiet-edit', 'Editing quiet hours: two times, every day, in your timezone', 'detail'],
  ['quiet-invalid', 'Editing quiet hours: the same start and end, refused before saving', 'detail'],
  ['quiet-confirm', 'Saving quiet hours: the change, then your passkey (policy is tier 3)', 'detail'],
];
const paneOf = (s) => IB_FRAMES.find(([k]) => k === s)?.[2] ?? 'list';

// The rules that sent messages here, as GET /triggers/rules returns them (only what's drawn).
const RULES = {
  'r-door': { name: 'Front door left open', class: 'event', paused: false },
  'r-closet': { name: 'Closet too warm', class: 'event', paused: false },
  'r-timesheet': { name: 'Timesheet reminder', class: 'heartbeat', paused: false },
};
// Nova's own parts that tell you things (src/core/index.ts: the name each fires with).
const PARTS = { coding: 'Coding', infra: 'Infrastructure', network: 'Network', models: 'Local models' };
const UNSURE = 'Not sure this should happen on its own, so it waits for you.';
const ACTED = 'Nothing in your settings holds it back.';
const QUIET = 'Quiet hours: the message waits until they end.';

// Trigger records, as GET /triggers/{id} returns them (the fields drawn here).
const TRIGGERS = {
  't-ok': { rule_id: 'r-door', source: 'connector:home-assistant/binary_sensor.front_door', triage: { decision: 'queue', reason: UNSURE } },
  't-net': { rule_id: null, source: 'network', triage: { decision: 'act', reason: ACTED } },
  't-infra': { rule_id: null, source: 'infra', triage: { decision: 'act', reason: ACTED } },
  't-time': { rule_id: 'r-timesheet', source: 'cron', triage: { decision: 'act', reason: ACTED } },
  't-merge': { rule_id: null, source: 'coding', triage: { decision: 'act', reason: ACTED } },
  't-stop': { rule_id: null, source: 'coding', triage: { decision: 'queue', reason: QUIET } },
  't-door': { rule_id: 'r-door', source: 'connector:home-assistant/binary_sensor.front_door', triage: { decision: 'queue', reason: QUIET } },
  't-closet': { rule_id: 'r-closet', source: 'webhook:closet-temp', triage: { decision: 'queue', reason: QUIET } },
};

// Messages, as GET /messages and GET /messages?state=held return them. Times are the person's
// wall clock (Europe/London), written out so the words never drift. `when` is how the row says it.
const OK = { id: 'm-ok', when: 'Sat 21:40', text: 'The front door has been open for ten minutes.', trigger_id: 't-ok', delivered_at: null, read_at: null, hold: 'needs_ok' };
const NET = { id: 'm-net', when: '14:58', text: 'The change “Guest network name” to Home router is ready for you to review (ssid). Nova applies it only when you confirm, in Tasks.', trigger_id: 't-net', delivered_at: '14:58', read_at: null, hold: null };
const INFRA = { id: 'm-infra', when: '11:05', text: 'Applied the plan for “Home lab”: 1 added, 1 changed. It now costs $14.00 a month. A checkpoint from just before is in Settings › Checkpoints.', trigger_id: 't-infra', delivered_at: '11:05', read_at: null, hold: null };
const TIME = { id: 'm-time', when: 'Fri 16:00', text: 'Time to send your timesheet.', trigger_id: 't-time', delivered_at: 'Fri 16:00', read_at: 'Fri 16:12', hold: null };
const MERGE = { id: 'm-merge', when: 'Thu 10:31', text: 'Merged “Tidy the import script” into main in notes-app: it is at 3f2a9c1, exactly the reviewed change. Nothing was pushed.', trigger_id: 't-merge', delivered_at: 'Thu 10:31', read_at: 'Thu 11:02', hold: null };
const STOP = { id: 'm-stop', when: '22:41', text: 'The change “Speed up the search index” stopped: the tests failed. Nothing was merged.', trigger_id: 't-stop', delivered_at: null, read_at: null, hold: 'quiet' };
const DOOR = { id: 'm-door', when: '23:12', text: 'The front door has been open for ten minutes.', trigger_id: 't-door', delivered_at: null, read_at: null, hold: 'quiet' };
const CLOSET = { id: 'm-closet', when: '01:15', text: 'The closet is above 30 °C.', trigger_id: 't-closet', delivered_at: null, read_at: null, hold: 'quiet' };
const sent = (m, at = '07:00') => ({ ...m, delivered_at: at, hold: null });

const QUIET_HOURS = { start: '22:00', end: '07:00' };
const TZ = 'Europe/London';

// ---- the words: the model in plain language ------------------------------------------------------

function from(m) {
  const t = TRIGGERS[m.trigger_id];
  const rule = t.rule_id ? RULES[t.rule_id] : null;
  return rule ? { name: rule.name, kind: 'An automation', rule: t.rule_id } : { name: PARTS[t.source] ?? t.source, kind: 'Nova’s own work', rule: null };
}
const unread = (m) => m.delivered_at && !m.read_at;
function stateWords(m) {
  if (m.hold === 'needs_ok') return 'Needs your OK';
  if (m.hold === 'quiet') return 'Held';
  return unread(m) ? 'Unread' : '';
}
const clip = (t, n = 110) => (t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t);

// ---- pieces ----------------------------------------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-ib-icon="${state}" data-ib-size="${size}" aria-hidden="true"></span>`;

function row(id, m, { current = false } = {}) {
  const f = from(m);
  const s = stateWords(m);
  const meta = m.hold === 'quiet' ? `${f.name} · held since ${m.when}` : `${f.name} · ${m.when}`;
  return `<li class="ib-msg${unread(m) || m.hold === 'needs_ok' ? ' is-new' : ''}"><a class="uc-row au-open${current ? ' is-on' : ''}" href="#${id}-${m.id}"${current ? ' aria-current="true"' : ''}><span class="ib-mark" aria-hidden="true"></span><span class="au-text"><span class="au-name ib-line">${esc(clip(m.text))}</span><span class="au-meta">${esc(meta)}</span></span>${s ? `<span class="au-state">${s}</span>` : ''}</a></li>`;
}

function group(id, key, name, list, current) {
  return list.length ? `<h3 class="uc-group" id="${id}-${key}">${name}</h3><ul class="ib-msgs" aria-labelledby="${id}-${key}">${list.map((m) => row(id, m, { current: m.id === current })).join('')}</ul>` : '';
}

// The quiet-hours line at the top of the list: what they are, or that they're on now.
function quietRow(id, { now = false, current = false } = {}) {
  const name = now ? `Quiet hours, until ${QUIET_HOURS.end}` : 'Quiet hours';
  const meta = now ? 'Messages Nova starts now wait until then.' : `${QUIET_HOURS.start}–${QUIET_HOURS.end}, every day`;
  return `<a class="uc-row au-open ib-quiet${now ? ' is-quiet' : ''}${current ? ' is-on' : ''}" href="#${id}-quiet"${current ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${name}</span><span class="au-meta">${meta}</span></span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a>`;
}

const INTRO = '<p class="au-intro">What Nova tells you on its own: from your automations, and from its own work.</p>';

function listPane(id, { held = [], fresh = [], earlier = [], current = '', quietNow = false, quietCurrent = false } = {}) {
  return `<div class="au-list">${INTRO}${quietRow(id, { now: quietNow, current: quietCurrent })}
${group(id, 'ok', 'Waiting for your OK', [OK], current)}${group(id, 'held', `Held until ${QUIET_HOURS.end}`, held, current)}${group(id, 'new', 'Unread', fresh, current)}${group(id, 'old', 'Earlier', earlier, current)}</div>`;
}

const back = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Messages</span></a>`;
const facts = (rows) => `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

// One message, opened. Opening it marks it read (POST /messages/{id}/read).
function detail(id, m, { readNow = false, held = null } = {}) {
  const f = from(m);
  const t = TRIGGERS[m.trigger_id];
  const head = `${back(id)}<p class="ib-from">${esc(f.kind)}</p><h3 class="uc-h" id="${id}-name">${esc(f.name)}</h3><p class="ib-body">${esc(m.text)}</p>`;
  if (m.hold === 'needs_ok') {
    return `${head}<div class="au-result" role="group" aria-labelledby="${id}-ok-h"><div class="au-result-text"><p class="au-block-head" id="${id}-ok-h">It waits for your OK</p><p class="au-note">${esc(UNSURE)} It stays here, unsent, until you let it through.</p></div><div class="au-actions"><button type="button" class="btn primary" data-ib-demo>Let it through</button></div></div>
${facts([['From', `${esc(f.name)}, an automation`], ['Written', m.when]])}${ruleLink(id, f)}`;
  }
  if (m.hold === 'quiet') {
    const goes = f.rule
      ? `It goes out after they end, if “${esc(f.name)}” is still on then. If it was turned off or removed meanwhile, it isn’t sent.`
      : 'Today, when they end, a held message from Nova’s own work is withdrawn rather than sent. (Flagged for the owner: the core releases only messages an automation sent.)';
    return `${head}<div class="au-result" role="group" aria-labelledby="${id}-q-h"><div class="au-result-text"><p class="au-block-head" id="${id}-q-h">Held for quiet hours</p><p class="au-note">Written at ${m.when}, during quiet hours (${QUIET_HOURS.start}–${QUIET_HOURS.end}). ${goes}</p></div><a class="btn" href="#${id}-quiet">Change quiet hours</a></div>
${facts([['From', `${esc(f.name)}, ${f.rule ? 'an automation' : 'Nova’s own work'}`], ['Written', m.when], ['Why it waits', esc(t.triage.reason)]])}${ruleLink(id, f)}`;
  }
  const rows = [['From', `${esc(f.name)}, ${f.rule ? 'an automation' : 'Nova’s own work'}`], ['Written', held ? `${held}, during quiet hours` : m.when]];
  if (held) rows.push(['Sent', `${m.delivered_at}, when quiet hours ended`]);
  else rows.push(['Why then', esc(t.triage.reason)]);
  rows.push(['Read', readNow ? 'Just now, when you opened it' : m.read_at]);
  const tasks = /in Tasks\.$/.test(m.text) ? `<div class="au-actions"><a class="btn" href="#${id}-tasks">Go to Tasks</a></div>` : '';
  return `${head}${tasks}${facts(rows)}${ruleLink(id, f)}`;
}
const ruleLink = (id, f) => (f.rule ? `<a class="uc-row ib-link" href="#${id}-rule"><span class="uc-label">See the automation “${esc(f.name)}”</span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a>` : '');

// ---- quiet hours ---------------------------------------------------------------------------------

const err = (id, key, text) => `<p class="au-error" id="${id}-${key}-err">${esc(text)}</p>`;
const invalid = (id, key) => ` aria-invalid="true" aria-describedby="${id}-${key}-err"`;

function quietForm(id, { start, end, bad = false }) {
  const said = bad ? 'The start and the end are the same time. Choose two different times, or No quiet hours.' : `Every day from ${start} to ${end}, Nova holds the messages it starts until they end.`;
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><h3 class="uc-h" id="${id}-title">Quiet hours</h3>
${bad ? '<p class="au-alert" role="alert">One thing to fix before Nova can save this.</p>' : `<p class="au-sentence">${said}</p>`}
<div class="au-pair"><div class="au-field"><label class="au-label" for="${id}-start">From</label><input class="uc-input" id="${id}-start" type="time" value="${start}"${bad ? invalid(id, 'end') : ''}></div><div class="au-field"><label class="au-label" for="${id}-end">Until</label><input class="uc-input" id="${id}-end" type="time" value="${end}"${bad ? invalid(id, 'end') : ''}></div></div>
${bad ? err(id, 'end', said) : ''}
<p class="au-note">In your timezone, ${TZ}. The end can be the next morning.</p>
<p class="au-note">They hold messages only: tasks still start, and a message that waits for your OK still waits for it. Messages show in Nova itself; Nova has no phone notifications.</p>
<div class="au-actions"><button type="submit" class="btn primary" data-ib-demo>Save quiet hours</button><button type="button" class="btn quiet">Cancel</button></div>
<div class="au-danger"><button type="button" class="btn quiet">No quiet hours</button><p class="au-note">Goes back to Nova’s default: none, so no hours hold messages.</p></div></form>`;
}

function quietConfirm(id) {
  const change = { key: 'policy.quiet_hours', label: 'Quiet hours', from: `${QUIET_HOURS.start}–${QUIET_HOURS.end}`, to: '22:30–06:30', layer: 'pack' };
  return `${back(id)}<form class="au-form ib-confirm" data-sg-inert novalidate aria-labelledby="${id}-title"><h3 class="uc-h" id="${id}-title">Save quiet hours?</h3>
<p class="au-sentence">Every day from 22:30 to 06:30, Nova holds the messages it starts until they end.</p>
${configDiff([change])}
<p class="au-note">Quiet hours are part of your policy, like what asks first, so changing them is confirmed with your passkey. Until then nothing changes.</p>
${passkeyConfirm({ state: 'ready' })}
<div class="au-actions">${passkeyAction({ state: 'ready' })}<button type="button" class="btn quiet">Cancel</button></div></form>`;
}

// ---- frames ----------------------------------------------------------------------------------------

function screen(state, panes, live) {
  const id = `ib-${state}`;
  return `<div class="uc-screen ib" data-ib-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">Messages</h2>${slot(live, 24)}</header>
<div class="au-panes" data-au-pane="${paneOf(state)}">${panes(id)}</div></div></div>`;
}
const pair = (list, right) => (id) => `${list(id)}<div class="au-detail">${right(id)}</div>`;

const LIST = { fresh: [NET, INFRA], earlier: [TIME, MERGE] };
const emptyDetail = (id) => `<h3 class="uc-h" id="${id}-none">No messages yet</h3><p class="au-sentence">When an automation tells you something, or Nova’s own work has news (a change ready to review, a run that stopped), it shows here, newest first.</p><p class="au-note">Each one says where it came from. During quiet hours they wait until the hours end.</p><div class="au-actions"><a class="btn" href="#${id}-automations">Make an automation</a></div>`;
const emptyList = (id) => `<div class="au-list">${INTRO}${quietRow(id)}<p class="au-intro au-none">None yet.</p></div>`;

export function ibFrame(state) {
  // A waiting OK counts in Needs you, so the live icon is amber wherever one is waiting.
  if (state === 'empty') return screen(state, (id) => `${emptyList(id)}<div class="au-detail">${emptyDetail(id)}</div>`, 'idle');
  if (state === 'open') return screen(state, pair((id) => listPane(id, { fresh: [INFRA], earlier: [{ ...NET, read_at: 'just now' }, TIME, MERGE], current: NET.id }), (id) => detail(id, NET, { readNow: true })), 'needs-you');
  if (state === 'held') return screen(state, pair((id) => listPane(id, { held: [CLOSET, DOOR, STOP], ...LIST, current: DOOR.id, quietNow: true }), (id) => detail(id, DOOR)), 'needs-you');
  if (state === 'released') {
    const door = { ...sent(DOOR), read_at: 'just now' };
    return screen(state, pair((id) => listPane(id, { fresh: [sent(CLOSET), ...LIST.fresh], earlier: [door, ...LIST.earlier], current: DOOR.id }), (id) => detail(id, door, { readNow: true, held: DOOR.when })), 'needs-you');
  }
  const editing = (right) => screen(state, pair((id) => listPane(id, { ...LIST, quietCurrent: true }), right), 'needs-you');
  if (state === 'quiet-edit') return editing((id) => quietForm(id, { start: '22:30', end: '06:30' }));
  if (state === 'quiet-invalid') return editing((id) => quietForm(id, { start: '22:00', end: '22:00', bad: true }));
  if (state === 'quiet-confirm') return editing(quietConfirm);
  return screen('list', pair((id) => listPane(id, { ...LIST, current: OK.id }), (id) => detail(id, OK)), 'needs-you');
}

// The styleguide entry: every frame, each with its full-screen address.
export function ibEntry(wrap) {
  return IB_FRAMES.map(([s, said]) => wrap(`${esc(said)} · <a class="link" href="?entry=inbox&amp;frame=${s}">Full screen</a>`, ibFrame(s))).join('');
}
export const isIbFrame = (s) => IB_FRAMES.some(([k]) => k === s);

// Fills the status icon slots and makes the specimens move a little: the passkey checkbox enables
// its button, and the demo buttons say they are a demo.
export function bindInbox(root) {
  for (const el of root.querySelectorAll('[data-ib-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.ibIcon, size: Number(el.dataset.ibSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-ib-frame]')) {
    if (frame.dataset.ibBound) continue;
    frame.dataset.ibBound = '1';
    frame.addEventListener('change', (e) => {
      if (e.target.name !== 'confirm') return;
      const b = e.target.closest('form')?.querySelector('[data-action="passkey-confirm"]');
      if (b) b.disabled = !e.target.checked;
    });
    frame.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ib-demo], [data-action^="passkey"]');
      if (b) { e.preventDefault(); b.textContent = 'Demo: nothing was sent'; }
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
  }
}
