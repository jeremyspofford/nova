// The Automations rule editor, design-first (2026-11-09): compositions for the owner's reaction,
// before any wiring. Styleguide only: the app never loads this file, nothing here is sent anywhere,
// and every control is a specimen (a switch flips, Copy copies nothing).
//
// Drawn from the real model, src/core/triggers.ts: a rule is {name, class, source, cron, schedule,
// hook_path, action, dedup_window_s, cooldown_s, paused}; class heartbeat (a cron schedule), event
// (a webhook, or a connector's topic) or proactive (only when run); action {kind: 'task', task} or
// {kind: 'message', text}. A run is a trigger record: {triage: {decision, reason}, ledger_task_id,
// message_id, at}. There are no conditions. The webhook token is minted once at creation and only
// its hash is kept; there is no rotate route and no stored hint (the token-after and token-rotate
// frames are proposals that need the backend, and say so).
// Its CSS is ui/styles/compositions.css (.au-*); the narrow layout is in ui/styles/layout.css.
import { ICONS } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows]. The first two are also drawn at phone and Duo-cover sizes.
export const AU_FRAMES = [
  ['list', 'The list: each rule’s trigger in plain words, on or off, its last run and the result'],
  ['empty', 'No automations yet'],
  ['create', 'Create: a schedule that starts a task, two things to fix, and the sentence it will run as'],
  ['edit', 'Edit: turned off, and its message reworded'],
  ['run', 'Run now: it ran, and started a task'],
  ['run-failed', 'Run now: it ran, but couldn’t start its task'],
  ['token-once', 'A new webhook: its token, shown this once'],
  ['token-after', 'Afterwards: a hint, never the token, and Rotate (proposed: needs the backend)'],
  ['token-rotate', 'Rotate: the old token stops working at once (proposed: needs the backend)'],
];

// A fixed "now", so the words (and the screenshots) never drift: Monday 9 November 2026, 15:20 UTC.
const NOW = Date.parse('2026-11-09T15:20:00Z');
const before = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const ago = (at) => {
  const m = Math.round((NOW - Date.parse(at)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

// A demo token, the shape the backend mints (32 random bytes, base64url: 43 characters). Not real.
const DEMO_TOKEN = 'Zq4mW8nT2vX7kP1rB6sD9fH3jL5cY0gA-eU7oI2k8Wd';

const WORKERS = { relay: { name: 'Relay', where: 'on this hub', evidence: ['confirmation', 'read_back', 'file_diff', 'test_result'] } };
const EVIDENCE = { confirmation: 'It says it’s done', read_back: 'Nova reads the result back', file_diff: 'The files it changed', test_result: 'A test that passed', screenshot: 'A screenshot', url: 'A link to the result' };
const CONNECTORS = { 'home-assistant': 'Home Assistant', gmail: 'Gmail' };

// Rules, as GET /triggers/rules returns them (schedule is describeCron's own words for the cron).
const task = (title, goal, evidence) => ({ kind: 'task', task: { title, goal, owner: 'relay', evidence_required: evidence } });
const RULES = [
  { id: 'r-brief', name: 'Morning brief', class: 'heartbeat', source: 'cron', cron: '0 9 * * 1-5', schedule: 'Weekdays at 9:00 AM', hook_path: null, action: task('Write the morning brief', 'Read today’s calendar and open tasks, and write a five-line brief.', [{ kind: 'confirmation' }]), dedup_window_s: 600, cooldown_s: 0, paused: false, created_at: '2026-11-02T14:00:00Z' },
  { id: 'r-timesheet', name: 'Timesheet reminder', class: 'heartbeat', source: 'cron', cron: '0 16 * * 5', schedule: 'Fridays at 4:00 PM', hook_path: null, action: { kind: 'message', text: 'Time to send your timesheet.' }, dedup_window_s: 600, cooldown_s: 0, paused: false, created_at: '2026-10-30T10:00:00Z' },
  { id: 'r-backup', name: 'Weekly backup check', class: 'heartbeat', source: 'cron', cron: '0 8 * * 1', schedule: 'Mondays at 8:00 AM', hook_path: null, action: task('Check last week’s backups', 'Open each backup from last week and confirm it restores.', [{ kind: 'read_back', target: 'the restore drill report' }]), dedup_window_s: 600, cooldown_s: 0, paused: false, created_at: '2026-10-20T09:00:00Z' },
  { id: 'r-build', name: 'Build finished', class: 'event', source: 'webhook:ci-build', cron: null, schedule: null, hook_path: '/api/v1/hooks/ci-build', action: task('Read the build report', 'Read the report the build sent and say what failed, if anything.', [{ kind: 'read_back', target: 'the build report' }]), dedup_window_s: 600, cooldown_s: 0, paused: false, created_at: '2026-11-09T15:20:00Z' },
  { id: 'r-door', name: 'Front door left open', class: 'event', source: 'connector:home-assistant/binary_sensor.front_door', cron: null, schedule: null, hook_path: null, action: { kind: 'message', text: 'The front door has been open for ten minutes.' }, dedup_window_s: 600, cooldown_s: 1800, paused: true, created_at: '2026-10-25T18:00:00Z' },
];
const rule = (id) => RULES.find((r) => r.id === id);

// The newest run of each rule, as GET /triggers?rule= returns it, and the task each run started.
const TASKS = { 'k-100': { title: 'Write the morning brief', state: 'done' }, 'k-101': { title: 'Write the morning brief', state: 'done' }, 'k-102': { title: 'Read the build report', state: 'active' }, 'k-103': { title: 'Write the morning brief', state: 'active' } };
const RUNS = {
  'r-brief': [
    { trigger_id: 't-11', triage: { decision: 'act', reason: 'Nothing in your settings holds it back.' }, ledger_task_id: 'k-101', message_id: null, at: before(380) },
    { trigger_id: 't-10', triage: { decision: 'act', reason: 'Nothing in your settings holds it back.' }, ledger_task_id: 'k-100', message_id: null, at: before(3260) },
    { trigger_id: 't-09', triage: { decision: 'drop', reason: 'Missed while Nova was off.' }, ledger_task_id: null, message_id: null, at: before(4700) },
  ],
  'r-timesheet': [{ trigger_id: 't-21', triage: { decision: 'act', reason: 'Nothing in your settings holds it back.' }, ledger_task_id: null, message_id: 'm-21', at: before(4280) }],
  'r-backup': [{ trigger_id: 't-31', triage: { decision: 'drop', reason: 'Nova couldn\'t start the task for "Weekly backup check": There is no worker called "relay".' }, ledger_task_id: null, message_id: null, at: before(440) }],
  'r-build': [{ trigger_id: 't-41', triage: { decision: 'act', reason: 'Nothing in your settings holds it back.' }, ledger_task_id: 'k-102', message_id: null, at: before(4) }],
  'r-door': [{ trigger_id: 't-51', triage: { decision: 'drop', reason: 'The rule is paused, so nothing was done.' }, ledger_task_id: null, message_id: null, at: before(2900) }],
};

// ---- the words: the model in plain language ------------------------------------------------------

export function whenWords(r) {
  if (r.class === 'heartbeat') return r.schedule ?? `On a custom schedule (${r.cron})`;
  if (r.hook_path) return `When the ${r.source.slice('webhook:'.length)} webhook is called`;
  const c = /^connector:([^/]+)\/(.+)$/.exec(r.source);
  if (c) return `When ${CONNECTORS[c[1]] ?? c[1]} reports ${c[2]}`;
  return 'Only when you run it';
}
const doesWords = (r) => (r.action.kind === 'task' ? `starts a task, “${r.action.task.title}”, with ${WORKERS[r.action.task.owner]?.name ?? r.action.task.owner}` : `tells you “${r.action.text}”`);
// The sentence a rule runs as: “Weekdays at 9:00 AM, Nova starts a task, …”.
export const sentence = (r) => `${whenWords(r)}, Nova ${doesWords(r)}.`;

const failed = (run) => run.triage.decision === 'drop' && /^Nova couldn['’]t start/.test(run.triage.reason);
// A run's result, from its triage and the task or message it led to.
function result(r, run) {
  if (!run) return 'Hasn’t run yet';
  const { decision, reason } = run.triage;
  const t = run.ledger_task_id ? TASKS[run.ledger_task_id] : null;
  if (failed(run)) return `Couldn’t start its task, ${ago(run.at)}`;
  if (decision === 'drop') return reason.startsWith('The rule is paused') ? `Skipped while off, ${ago(run.at)}` : reason.startsWith('Missed') ? `Missed while Nova was off, ${ago(run.at)}` : `Skipped as a repeat, ${ago(run.at)}`;
  if (decision === 'silent') return `Held back while it rests, ${ago(run.at)}`;
  if (decision === 'queue') return run.message_id ? `Held for quiet hours, ${ago(run.at)}` : `Waiting for your OK, ${ago(run.at)}`;
  if (t?.state === 'active') return `Running now, started ${ago(run.at)}`;
  if (t?.state === 'failed') return `Ran ${ago(run.at)}; its task failed`;
  if (t) return `Ran ${ago(run.at)}; task done`;
  return `Ran ${ago(run.at)}; told you`;
}
// The status icon for a rule's row: its own state, never per message (DESIGN-SYSTEM §1).
function iconOf(r, run) {
  if (r.paused) return 'paused';
  if (!run) return 'idle';
  if (failed(run)) return 'needs-you';
  const t = run.ledger_task_id ? TASKS[run.ledger_task_id] : null;
  if (t?.state === 'active') return 'working';
  if (t?.state === 'failed') return 'stopped';
  return 'idle';
}

// ---- pieces ----------------------------------------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-au-icon="${state}" data-au-size="${size}" aria-hidden="true"></span>`;
const sw = (id, on, labelledby) => `<button type="button" class="switch" role="switch" aria-checked="${on}" aria-labelledby="${labelledby}" data-au-switch="${id}"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span></button>`;

function ruleRow(id, rule0, { current = false, runs = RUNS, off = [] } = {}) {
  const r = off.includes(rule0.id) ? { ...rule0, paused: true } : rule0;
  const run = runs[r.id]?.[0];
  return `<li class="au-rule${r.paused ? ' is-off' : ''}"><a class="uc-row au-open${current ? ' is-on' : ''}" href="#${id}-${r.id}"${current ? ' aria-current="true"' : ''}>${slot(iconOf(r, run), 16)}<span class="au-text"><span class="au-name">${esc(r.name)}</span><span class="au-meta">${esc(whenWords(r))}</span><span class="au-meta">${esc(result(r, run))}</span></span><span class="au-state">${r.paused ? 'Off' : 'On'}</span></a></li>`;
}

const GROUPS = [['On a schedule', (r) => r.class === 'heartbeat'], ['When something happens', (r) => r.class === 'event'], ['When you run it', (r) => r.class === 'proactive']];

function listPane(id, { current = '', creating = false, runs = RUNS, off = [] } = {}) {
  const groups = GROUPS.map(([name, test], i) => {
    const rules = RULES.filter(test);
    return rules.length ? `<h3 class="uc-group" id="${id}-g${i}">${name}</h3><ul class="au-rules" aria-labelledby="${id}-g${i}">${rules.map((r) => ruleRow(id, r, { current: r.id === current, runs, off })).join('')}</ul>` : '';
  }).join('');
  return `<div class="au-list"><p class="au-intro">What Nova does on its own. Nothing runs that isn’t listed here.</p>
<a class="uc-row au-new${creating ? ' is-on' : ''}" href="#${id}-new"${creating ? ' aria-current="true"' : ''}><span class="uc-ic" aria-hidden="true">${icon('plus')}</span><span class="uc-label">New automation</span></a>${groups}</div>`;
}

const back = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Automations</span></a>`;

function runRows(id, r, extra = []) {
  const runs = [...extra, ...(RUNS[r.id] ?? [])];
  if (!runs.length) return '<p class="uc-faint">It hasn’t run yet. Its runs show here, newest first, with what each led to.</p>';
  return `<ul class="au-runs">${runs.map((run, i) => {
    const t = run.ledger_task_id ? TASKS[run.ledger_task_id] : null;
    const to = t ? 'Open in Tasks' : run.message_id ? 'Open the message' : 'See why';
    return `<li><a class="uc-row au-run" href="#${id}-run${i}" aria-label="${esc(`${result(r, run)}. ${to}`)}"><span class="au-text"><span class="au-name">${esc(result(r, run))}</span><span class="au-meta">${esc(t ? `${t.title}: ${t.state === 'done' ? 'done, checked' : 'running'}` : run.triage.reason)}</span></span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a></li>`;
  }).join('')}</ul>`;
}

const seconds = (s) => (s === 0 ? 'None' : s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`);
function facts(r) {
  const rows = [['Repeats ignored within', seconds(r.dedup_window_s)], ['Rests after a run', seconds(r.cooldown_s)], ['Made', `${r.created_at === '2026-11-09T15:20:00Z' ? 'Just now' : 'Earlier'}, by you`]];
  return `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

// The webhook's token, by stage: once (just created), after (a hint only), rotate (confirming).
function tokenBlock(id, r, stage) {
  const path = `<span class="uc-mono">POST ${esc(r.hook_path)}</span>`;
  if (stage === 'once') {
    return `<section class="au-token" aria-labelledby="${id}-tok-h"><h4 class="au-block-head" id="${id}-tok-h">Copy the token now</h4>
<p class="au-note">This is the only time Nova shows it. Nova keeps only a fingerprint of it, so it can’t show it again; if it’s lost, you make a new one.</p>
<label class="au-label" for="${id}-tok">Webhook token <span class="uc-faint">(demo, not a real token)</span></label>
<div class="au-token-row"><input class="uc-input uc-mono au-token-value" id="${id}-tok" readonly value="${DEMO_TOKEN}" spellcheck="false" autocomplete="off"><button type="button" class="btn primary" data-au-copy>Copy</button></div>
<p class="au-note">Send it in the <span class="uc-mono">x-nova-hook-token</span> header with ${path}.</p>
<button type="button" class="btn">I’ve saved it</button></section>`;
  }
  const row = `<div class="uc-set"><div class="uc-set-text"><p class="uc-set-name">Webhook token</p><p class="uc-set-note">Set just now. Ends in <span class="uc-mono">…${DEMO_TOKEN.slice(-4)}</span>. Nova can’t show it again.</p></div><div class="uc-set-ctl"><button type="button" class="btn"${stage === 'rotate' ? ' aria-expanded="true"' : ''}>Rotate</button></div></div>`;
  const confirm = stage === 'rotate' ? `<div class="au-confirm" role="group" aria-labelledby="${id}-rot-h"><h4 class="au-block-head" id="${id}-rot-h">Make a new token?</h4>
<p class="au-note">The old one stops working at once. Anything still sending it is refused until you give it the new one, which Nova shows once.</p>
<div class="au-actions"><button type="button" class="btn primary">Make a new token</button><button type="button" class="btn quiet">Cancel</button></div></div>` : '';
  return `${row}${confirm}<div class="uc-set"><div class="uc-set-text"><p class="uc-set-name">Address</p><p class="uc-set-note">${path}</p></div></div>`;
}

function detail(id, r, { result: res = '', token = '', on = !r.paused, extraRuns = [] } = {}) {
  const runnable = r.class === 'heartbeat' || r.class === 'proactive';
  const actions = runnable
    ? `<div class="au-actions"><button type="button" class="btn">Run now</button><button type="button" class="btn">Edit</button></div>`
    : `<div class="au-actions"><button type="button" class="btn">Edit</button></div><p class="au-note">${r.hook_path ? 'It runs when its webhook is called; to try it, call the webhook.' : 'It runs when the connection reports it.'} Run now is only for schedules.</p>`;
  return `${back(id)}<h3 class="uc-h" id="${id}-name">${esc(r.name)}</h3><p class="au-sentence">${esc(sentence(r))}</p>${res}
<div class="uc-set au-onoff"><div class="uc-set-text"><p class="uc-set-name" id="${id}-on">${on ? 'On' : 'Off'}</p><p class="uc-set-note">${on ? (r.class === 'heartbeat' ? 'Runs on its schedule.' : 'Runs each time it’s called.') : 'It won’t run. Anything that arrives while it’s off is recorded and skipped.'}</p></div><div class="uc-set-ctl">${sw(`${id}-on`, on, `${id}-name ${id}-on`)}</div></div>
${actions}${token ? tokenBlock(id, r, token) : ''}
<h4 class="uc-group au-group-head">Recent runs</h4>${runRows(id, r, extraRuns)}
<h4 class="uc-group au-group-head">Limits</h4>${facts(r)}
<div class="au-danger"><button type="button" class="btn quiet">Delete automation</button><p class="au-note">Its past runs stay in the record.</p></div>`;
}

// ---- the editor ------------------------------------------------------------------------------------

const err = (id, key, text) => `<p class="au-error" id="${id}-${key}-err">${esc(text)}</p>`;
const invalid = (id, key) => ` aria-invalid="true" aria-describedby="${id}-${key}-err"`;
const choice = (name, value, words, on, note = '') => `<label class="uc-choice au-choice"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}><span>${words}${note ? ` <span class="uc-faint">${note}</span>` : ''}</span></label>`;
const options = (list, on) => list.map(([v, w]) => `<option value="${v}"${v === on ? ' selected' : ''}>${w}</option>`).join('');
const REPEAT = [['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Once a week'], ['hours', 'Every few hours'], ['custom', 'Custom (cron)']];
const DAYS = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']];

function scheduleFields(id, { repeat, day = '1', time }) {
  return `<div class="au-pair"><div class="au-field"><label class="au-label" for="${id}-repeat">Repeats</label><select class="uc-input" id="${id}-repeat">${options(REPEAT, repeat)}</select></div>
${repeat === 'weekly' ? `<div class="au-field"><label class="au-label" for="${id}-day">On</label><select class="uc-input" id="${id}-day">${options(DAYS, day)}</select></div>` : ''}<div class="au-field"><label class="au-label" for="${id}-time">At</label><input class="uc-input" id="${id}-time" type="time" value="${time}"></div></div>`;
}

function createForm(id) {
  const w = WORKERS.relay;
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><h3 class="uc-h" id="${id}-title">New automation</h3>
<p class="au-alert" role="alert">Two things to fix before Nova can save this.</p>
<div class="au-field"><label class="au-label" for="${id}-name">Name</label><input class="uc-input" id="${id}-name" value=""${invalid(id, 'name')}>${err(id, 'name', 'A rule needs a name, in plain words.')}</div>
<fieldset class="au-group"><legend class="uc-group">When</legend>
${choice(`${id}-when`, 'heartbeat', 'On a schedule', true)}${choice(`${id}-when`, 'webhook', 'When a webhook is called')}${choice(`${id}-when`, 'connector', 'When a connection reports something')}${choice(`${id}-when`, 'proactive', 'Only when you run it')}
${scheduleFields(id, { repeat: 'weekdays', time: '09:00' })}</fieldset>
<fieldset class="au-group"><legend class="uc-group">Then</legend>
${choice(`${id}-then`, 'message', 'Tell you something')}${choice(`${id}-then`, 'task', 'Start a task', true)}
<div class="au-field"><label class="au-label" for="${id}-title-in">Task</label><input class="uc-input" id="${id}-title-in" value="Write the morning brief"></div>
<div class="au-field"><label class="au-label" for="${id}-goal">What it should do</label><textarea class="uc-input au-area" id="${id}-goal" rows="2">Read today’s calendar and open tasks, and write a five-line brief.</textarea></div>
<div class="au-field"><label class="au-label" for="${id}-owner">Who does it</label><select class="uc-input" id="${id}-owner">${options([['relay', `${w.name}, ${w.where}`]], 'relay')}</select></div>
<fieldset class="au-checks"${invalid(id, 'evidence')}><legend class="au-label">How Nova checks it’s done</legend>${w.evidence.map((k) => `<label class="uc-choice au-choice"><input type="checkbox" name="${id}-ev" value="${k}"><span>${EVIDENCE[k]}</span></label>`).join('')}${err(id, 'evidence', 'A task action must say what evidence will prove it done.')}</fieldset>
</fieldset>
<details class="au-more"><summary class="uc-row">Repeats and rest <span class="uc-faint">ignore repeats within 10 min, no rest</span></summary>
<div class="au-pair"><div class="au-field"><label class="au-label" for="${id}-dedup">Ignore repeats within (minutes)</label><input class="uc-input" id="${id}-dedup" type="number" min="0" step="1" value="10"></div><div class="au-field"><label class="au-label" for="${id}-rest">Rest after a run (minutes)</label><input class="uc-input" id="${id}-rest" type="number" min="0" step="1" value="0"></div></div></details>
<section class="au-preview" aria-labelledby="${id}-say"><h4 class="uc-group au-group-head" id="${id}-say">It will run as</h4><p class="au-sentence">Weekdays at 9:00 AM, Nova starts a task, “Write the morning brief”, with Relay.</p><p class="au-note">First run tomorrow at 9:00 AM. Quiet hours and what you’ve turned off in Settings can still hold it.</p></section>
<div class="au-actions"><button type="submit" class="btn primary">Create automation</button><button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function editForm(id) {
  const r = rule('r-timesheet');
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><h3 class="uc-h" id="${id}-title">${esc(r.name)}</h3>
<div class="uc-set au-onoff"><div class="uc-set-text"><p class="uc-set-name" id="${id}-on">Off</p><p class="uc-set-note">Turned off just now; that took effect at once. It won’t run until you turn it on, and then it starts from that moment, without catching up.</p></div><div class="uc-set-ctl">${sw(`${id}-on`, false, `${id}-title ${id}-on`)}</div></div>
<div class="au-field"><label class="au-label" for="${id}-name">Name</label><input class="uc-input" id="${id}-name" value="${esc(r.name)}"></div>
<fieldset class="au-group"><legend class="uc-group">When</legend><p class="au-locked">On a schedule <span class="uc-faint">· How it starts stays as it was made; for another kind, make a new automation.</span></p>
${scheduleFields(id, { repeat: 'weekly', day: '5', time: '16:00' })}</fieldset>
<fieldset class="au-group"><legend class="uc-group">Then</legend><p class="au-locked">Tell you something</p>
<div class="au-field"><label class="au-label" for="${id}-msg">Message</label><textarea class="uc-input au-area" id="${id}-msg" rows="2">Time to send your timesheet. It’s due by 5.</textarea><p class="au-note">Changed: was “${esc(r.action.text)}”</p></div></fieldset>
<section class="au-preview" aria-labelledby="${id}-say"><h4 class="uc-group au-group-head" id="${id}-say">When it’s on, it runs as</h4><p class="au-sentence">Fridays at 4:00 PM, Nova tells you “Time to send your timesheet. It’s due by 5.”</p></section>
<div class="au-actions"><button type="submit" class="btn primary">Save changes</button><button type="button" class="btn quiet">Cancel</button></div>
<div class="au-danger"><button type="button" class="btn quiet">Delete automation</button><p class="au-note">Its past runs stay in the record.</p></div></form>`;
}

// ---- Run now ---------------------------------------------------------------------------------------

const RAN = { trigger_id: 't-12', triage: { decision: 'act', reason: 'You ran it.' }, ledger_task_id: 'k-103', message_id: null, at: before(0) };
const RAN_FAILED = { trigger_id: 't-32', triage: { decision: 'drop', reason: 'Nova couldn\'t start the task for "Weekly backup check": There is no worker called "relay".' }, ledger_task_id: null, message_id: null, at: before(0) };

function ranBlock(id) {
  return `<div class="au-result" role="status">${slot('working', 16)}<div class="au-result-text"><p class="au-block-head">It ran just now and started a task.</p><p class="au-note">“Write the morning brief” is running with Relay. Its result will be in Tasks, checked before it counts as done.</p></div><a class="btn" href="#${id}-task">Open in Tasks</a></div>`;
}
function failedBlock(id) {
  return `<div class="au-result" role="alert" data-tone="warn">${slot('needs-you', 16)}<div class="au-result-text"><p class="au-block-head">It ran just now, but couldn’t start its task.</p><p class="au-note">${esc(RAN_FAILED.triage.reason)} Nothing else happened. Choose who does it, then run it again.</p></div><div class="au-actions"><a class="btn" href="#${id}-edit">Edit</a><button type="button" class="btn">Run again</button></div></div>`;
}

// ---- frames ----------------------------------------------------------------------------------------

function screen(state, panes, pane) {
  const id = `au-${state}`;
  return `<div class="uc-screen au" data-au-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">Automations</h2>${slot(state === 'run-failed' ? 'needs-you' : 'idle', 24)}</header>
<div class="au-panes" data-au-pane="${pane}">${panes(id)}</div></div></div>`;
}

const pair = (list, right) => (id) => `${list(id)}<div class="au-detail">${right(id)}</div>`;
const emptyDetail = (id) => `<h3 class="uc-h" id="${id}-none">No automations yet</h3><p class="au-sentence">An automation runs on a schedule, when a webhook is called, or when a connection reports something, and either tells you something or starts a task.</p><p class="au-note">Everything Nova does on its own will be listed here, with when it last ran and what happened. Nothing runs that isn’t.</p><div class="au-actions"><a class="btn primary" href="#${id}-new">New automation</a></div>`;
const emptyList = (id) => `<div class="au-list"><p class="au-intro">What Nova does on its own. Nothing runs that isn’t listed here.</p><a class="uc-row au-new" href="#${id}-new"><span class="uc-ic" aria-hidden="true">${icon('plus')}</span><span class="uc-label">New automation</span></a><p class="au-intro au-none">None yet.</p></div>`;

// The list frame with the build webhook selected, for the token frames.
const withBuild = (stage) => pair((id) => listPane(id, { current: 'r-build' }), (id) => detail(id, rule('r-build'), { token: stage }));

export function auFrame(state) {
  if (state === 'empty') return screen(state, (id) => `${emptyList(id)}<div class="au-detail">${emptyDetail(id)}</div>`, 'detail');
  if (state === 'create') return screen(state, pair((id) => listPane(id, { creating: true }), createForm), 'detail');
  if (state === 'edit') return screen(state, pair((id) => listPane(id, { current: 'r-timesheet', off: ['r-timesheet'] }), editForm), 'detail');
  if (state === 'run') return screen(state, pair((id) => listPane(id, { current: 'r-brief', runs: { ...RUNS, 'r-brief': [RAN, ...RUNS['r-brief']] } }), (id) => detail(id, rule('r-brief'), { result: ranBlock(id), extraRuns: [RAN] })), 'detail');
  if (state === 'run-failed') return screen(state, pair((id) => listPane(id, { current: 'r-backup', runs: { ...RUNS, 'r-backup': [RAN_FAILED, ...RUNS['r-backup']] } }), (id) => detail(id, rule('r-backup'), { result: failedBlock(id), extraRuns: [RAN_FAILED] })), 'detail');
  if (state === 'token-once') return screen(state, withBuild('once'), 'detail');
  if (state === 'token-after') return screen(state, withBuild('after'), 'detail');
  if (state === 'token-rotate') return screen(state, withBuild('rotate'), 'detail');
  return screen('list', pair((id) => listPane(id, { current: 'r-brief' }), (id) => detail(id, rule('r-brief'))), 'list');
}

// The styleguide entry: every frame, each with its full-screen address.
export function auEntry(wrap) {
  return AU_FRAMES.map(([s, said]) => wrap(`${said} · <a class="link" href="?entry=automations-editor&amp;frame=${s}">Full screen</a>`, auFrame(s))).join('');
}
export const isAuFrame = (s) => AU_FRAMES.some(([k]) => k === s);

// Fills the status icon slots and makes the specimens move a little: a switch flips, Copy says so.
export function bindAutomations(root) {
  for (const el of root.querySelectorAll('[data-au-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.auIcon, size: Number(el.dataset.auSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-au-frame]')) {
    if (frame.dataset.auBound) continue;
    frame.dataset.auBound = '1';
    frame.addEventListener('click', (e) => {
      const s = e.target.closest('[data-au-switch]');
      if (s) s.setAttribute('aria-checked', String(s.getAttribute('aria-checked') !== 'true'));
      const copy = e.target.closest('[data-au-copy]');
      if (copy) copy.textContent = 'Copied (demo: nothing was copied)';
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
  }
}
