// Releases in Health: the supervisor's deploy and rollback, design-first (2026-11-09): compositions
// for the owner's reaction, before any wiring. Styleguide only: the app never loads this file,
// nothing here is sent anywhere, every version, commit and time is made up, and every control is a
// specimen (the passkey box enables its button; pressing any button says it is a demo).
//
// Drawn from the real model. The supervisor (src/supervisor/supervisor.ts, releases.ts) runs Nova as
// its child and writes its state (core resilience/link.ts SupervisorState); Health reads it through
// GET /api/v1/resilience (the last 5 of the history) and GET /api/v1/supervisor (all of it, up to 50).
// A release is a git tag; its slot is a worktree of the tag's commit, and `current` points at the one
// running ("base" is the code the supervisor started from). A deploy (POST /supervisor/deploy,
// {version, confirm: true}) goes through fixed gates, in order: prepare (the slot), tests (npm test
// unless the supervisor was given another command), sandbox (a start on a copy of the home, with no
// work, no peers and no secrets), smoke (five probes: health, setup, ledger, memory, problems), switch
// (a checkpoint of the stopped home, then the new release on it; Nova restarts here), canary (health
// every 5 s for 2 minutes by default; a failure goes back by itself), promote (live; the one before is
// kept to go back to). A failed gate before the switch leaves Nova running what it had ("stopped").
// Going back (POST /supervisor/rollback, {confirm: true}) is to the one kept, only; across a database
// upgrade it restores the backup from before only when nothing was written since, and is refused,
// with the count, otherwise. After going back nothing is kept to go back to.
// Both routes answer on the hub's own screen only, and its {confirm: true} needs a passkey there
// (core index.ts approval: tier 3). A paired device sees releases but can't deploy or go back.
// What the backend doesn't have, so these frames don't draw it as working: no route lists the tags a
// deploy could take (the tag is typed); nothing says before going back whether it would be refused;
// while Nova restarts (the switch, going back) Health can't read the supervisor, so the page says it
// is reconnecting; safe mode is the supervisor's own page, not Health, and recover is a command.
// Its CSS is ui/styles/compositions.css (.sv-*); one column at every width, like Health itself.
import { ICONS, passkeyAction, passkeyConfirm } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows].
const SV_FRAMES = [
  ['running', 'At rest on Nova’s own screen: the release that is live, what is running, the one kept to go back to, and the history'],
  ['deploy-form', 'Deploying a release: its tag typed (nothing lists the tags yet), every gate it goes through, and the passkey (tier 3)'],
  ['deploying', 'A deploy in progress: five gates passed, the canary window running on your home, and how it goes back by itself'],
  ['switching', 'The switch: Nova restarts on the new release, so Health can’t read the supervisor until it answers again'],
  ['promoted', 'A deploy that passed every gate: each one with what it found; the release before is kept to go back to'],
  ['stopped-tests', 'A deploy that stopped at a named gate, its tests: Nova kept running what it had, and the problem says so'],
  ['rolled-back', 'A deploy whose canary failed: Nova went back by itself, gate by gate, and the problem names the probe'],
  ['rollback-confirm', 'Going back by hand: to the one release kept, what happens to your data, and the passkey (tier 3)'],
  ['rolling-back', 'Going back in progress: Nova restarts on the older release, so Health reconnects'],
  ['went-back', 'Gone back: the older release is live again, and nothing is kept to go back to'],
  ['rollback-refused', 'Going back refused: it would lose what was written since a database upgrade, so the newer release kept running'],
  ['history', 'The history: the last five releases Health shows, with what happened to each'],
  ['unsupervised', 'Nova not running under the supervisor: no releases, and the command that changes that'],
  ['paired-running', 'On a paired device (a phone, a Duo’s cover screen): the same facts, deploying and going back on Nova’s own screen only'],
  ['paired-deploying', 'On a paired device: a deploy in progress, read-only'],
  ['paired-stopped', 'On a paired device: a deploy stopped at its tests, read-only'],
  ['paired-rolled-back', 'On a paired device: rolled back by itself, read-only'],
];

// ---- the sample state: what GET /resilience, /supervisor and /version would say -----------------

const LIVE = 'v0.1.0-alpha.3';
const KEPT = 'v0.1.0-alpha.2';
const NEXT = 'v0.1.0-alpha.4';
const COMMIT = { [LIVE]: '4e1c9a07b3d2', [KEPT]: 'b81f02c6e9a4', [NEXT]: '9b20e6f18c4a' };
const PKG = { [LIVE]: '0.1.0-alpha.3', [KEPT]: '0.1.0-alpha.2', [NEXT]: '0.1.0-alpha.4' };
const GATES = ['prepare', 'tests', 'sandbox', 'smoke', 'switch', 'canary', 'promote'];
const GATE_NAME = { prepare: 'Its slot', tests: 'Its tests', sandbox: 'Sandbox start', smoke: 'Smoke probes', switch: 'The switch', canary: 'Canary window', promote: 'Promoted', rollback: 'Going back' };
// What each gate does, in the supervisor's terms (supervisor.ts deploy()).
const GATE_DOES = {
  prepare: 'Its slot is made from the tag’s commit. A release from before Nova could run one in a sandbox stops here.',
  tests: 'Its own tests run (npm test, unless the supervisor was started with another command), for up to 30 minutes.',
  sandbox: 'It starts on a copy of your home, with no work, no network peers and no secrets.',
  smoke: 'Five probes must answer on that copy: health, setup, the Work Ledger, memory and problems.',
  switch: 'Nova takes a checkpoint of your home, stops, and starts the new release on it. Nova restarts here.',
  canary: 'Health is checked on your home every 5 seconds for 2 minutes. If it fails, Nova goes back by itself.',
  promote: `It is live, and ${LIVE} is kept to go back to.`,
};
// The stages a deploy wrote, by how far it got (state.deploy.stages: {stage, ok, at, said}).
const PASSED = [
  ['prepare', true, '14:28', `Release ${NEXT} is commit ${COMMIT[NEXT]}.`],
  ['tests', true, '14:31', '412 tests passed (npm test).'],
  ['sandbox', true, '14:31', 'It started on a copy of your home, with no work, no network peers and no secrets.'],
  ['smoke', true, '14:32', '5 probes passed: health, setup, ledger, memory, problems.'],
  ['switch', true, '14:32', `Running ${NEXT} on your home.`],
];
const TESTS_FAILED = 'npm test failed (3 of 412 tests):';
const TESTS_TAIL = 'not ok 118 - backups: the drill restores into a scratch home\n  ---\n  error: Expected values to be strictly equal: 3 !== 4\n  ...\n# tests 412\n# pass 409\n# fail 3';
const CANARY_FAILED = 'Health failed: database: no answer within 5 s';
const STAGES = {
  deploying: PASSED,
  promoted: [...PASSED, ['canary', true, '14:34', '24 probes over 120 s, all healthy.'], ['promote', true, '14:34', `${NEXT} is live; ${LIVE} is kept to go back to.`]],
  'stopped-tests': [PASSED[0], ['tests', false, '14:31', TESTS_FAILED]],
  'rolled-back': [...PASSED, ['canary', false, '14:33', CANARY_FAILED], ['rollback', true, '14:33', `${LIVE} is running again.`]],
  // What Health last read before Nova stopped for the switch.
  switching: PASSED.slice(0, 4),
};
// The history (newest first): {version, from, at, outcome, said}.
const HISTORY = [
  [LIVE, KEPT, 'Nov 6, 10:02', 'promoted', 'Passed its tests, the sandbox, the smoke probes and the canary.'],
  [LIVE, KEPT, 'Nov 5, 17:40', 'stopped', 'npm test failed (2 of 405 tests).'],
  [KEPT, 'base', 'Oct 30, 09:15', 'promoted', 'Passed its tests, the sandbox, the smoke probes and the canary.'],
  ['v0.1.0-alpha.1', 'base', 'Oct 28, 21:03', 'rolled back', 'Health failed: setup: Setup didn’t answer (500).'],
];
const NOW = {
  'stopped-tests': [NEXT, LIVE, 'today, 14:31', 'stopped', TESTS_FAILED],
  'rolled-back': [NEXT, LIVE, 'today, 14:33', 'rolled back', CANARY_FAILED],
  promoted: [NEXT, LIVE, 'today, 14:34', 'promoted', 'Passed its tests, the sandbox, the smoke probes and the canary.'],
  'went-back': [LIVE, KEPT, 'today, 15:06', 'went back', 'You asked to go back.'],
  'rollback-refused': [LIVE, KEPT, 'today, 15:06', 'rollback refused', `Going back to ${KEPT} would lose 14 changes written since ${LIVE} upgraded the database (9 in memory, 5 in task).`],
};
const OUTCOME = { promoted: 'Promoted', stopped: 'Stopped at a gate', 'rolled back': 'Rolled back by itself', 'went back': 'Went back, as you asked', 'rollback refused': 'Going back refused' };

// The open problem each outcome leaves (supervisor.ts #problem, playbooks.ts steps), or none.
const PROBLEM = {
  'stopped-tests': {
    title: 'A release didn’t pass its checks', said: `Release ${NEXT} didn’t pass its tests, so Nova kept running ${LIVE}.`, detail: `${TESTS_FAILED}\n${TESTS_TAIL}`,
    steps: ['Nothing changed: Nova kept running the release it had.', 'The technical detail says which check failed (its tests, the sandbox start or a smoke probe). Fix that in a new release, then deploy it.'],
  },
  'rolled-back': {
    title: 'A release was rolled back', said: `Release ${NEXT} was rolled back by itself: its health failed in the canary window. ${LIVE} is running again, with your data as it was.`, detail: CANARY_FAILED,
    steps: ['Nova went back to the release before it by itself, because its health failed in the canary window. Your data is as it was.', 'The technical detail names the probe that failed. Fix it in a new release before deploying again.'],
  },
  'rollback-refused': {
    title: 'Nova couldn’t go back to the older release', said: `Nova couldn’t go back to ${KEPT}: ${NOW['rollback-refused'][4]} It kept ${LIVE} running.`, detail: 'You asked to go back.',
    steps: ['The newer release changed the database, and things were written since. Going back would lose them, so Nova kept the newer release running.', 'Fix the problem forward in a new release, or, if losing what was written since is acceptable, restore the pre-upgrade backup yourself with Nova stopped.'],
  },
};

// ---- the words -------------------------------------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state) => `<span class="sv-icon" data-sv-icon="${state}" aria-hidden="true"></span>`;
const mono = (t) => `<span class="uc-mono">${esc(t)}</span>`;
const name = (v) => (v === 'base' ? 'the code the supervisor started from' : v);
const facts = (rows) => `<dl class="uc-facts sv-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const ABOUT = 'A release is a tagged version of Nova. Each goes through its tests, a sandbox start on a copy of your home, smoke probes, the switch and a canary window before it stays. If its health fails in the canary window, Nova goes back by itself.';
const HUB_ONLY = 'Deploying a release and going back happen on Nova’s own screen, confirmed with its passkey. Here you can follow them.';
const RECONNECT = 'Nova isn’t answering. This page reconnects when it’s back.';

// The state after each frame's story: what is live, what is kept, the supervisor's mode.
function after(state) {
  const base = state.replace(/^paired-/, '');
  if (base === 'promoted') return { live: NEXT, kept: LIVE, mode: 'Running' };
  if (base === 'went-back') return { live: KEPT, kept: null, mode: 'Running' };
  if (base === 'rolled-back') return { live: LIVE, kept: null, mode: 'Running' };
  if (base === 'deploying') return { live: NEXT, kept: KEPT, mode: 'Deploying a release', canary: true };
  return { live: LIVE, kept: KEPT, mode: 'Running' };
}

// One gate's row: its shape and word first, colour second; a gate not reached yet is drawn from the
// supervisor's fixed order, not from the state.
function gateRow(gate, g, tail) {
  const [, ok, at, said] = g ?? [];
  const mark = !g ? (tail === gate ? 'now' : 'none') : ok ? 'pass' : 'fail';
  const word = { pass: 'Passed', fail: 'Didn’t pass', now: 'Running now', none: 'Not reached' }[mark];
  const line = g ? said : tail === gate ? '' : GATE_DOES[gate];
  return `<li class="sv-gate" data-g="${mark}"><span class="sv-mark" aria-hidden="true"></span><span class="au-text"><span class="au-name">${GATE_NAME[gate]}</span>${line ? `<span class="au-meta">${esc(line)}</span>` : ''}</span><span class="au-state">${word}${at ? ` · ${at}` : ''}</span></li>`;
}

const NEVER = (gate) => `<li class="sv-gate" data-g="none"><span class="sv-mark" aria-hidden="true"></span><span class="au-text"><span class="au-name">${GATE_NAME[gate]}</span><span class="au-meta">Never ran: an earlier gate didn’t pass.</span></span><span class="au-state">Not reached</span></li>`;

// `tail`: the gate running now (the canary, while a deploy is in it), or null.
function gates(state, tail = null) {
  const done = STAGES[state] ?? [];
  const rows = [];
  // Going back is a stage of its own, after the gate that failed; the gates after it never ran.
  if (done.some(([s]) => s === 'rollback')) {
    for (const g of done) rows.push(gateRow(g[0], g, null));
    rows.push(NEVER('promote'));
  } else {
    const stoppedAt = done.find(([, ok]) => !ok)?.[0];
    for (const gate of GATES) {
      const g = done.find(([s]) => s === gate);
      rows.push(stoppedAt && !g && GATES.indexOf(gate) > GATES.indexOf(stoppedAt) ? NEVER(gate) : gateRow(gate, g, tail));
    }
  }
  return `<ol class="sv-gates">${rows.join('')}</ol>`;
}

// The deploy the supervisor is on, or the last one it did (state.deploy).
function deploy(id, state, paired) {
  const base = state.replace(/^paired-/, '');
  if (!STAGES[base]) return '';
  const head = {
    deploying: `Deploying ${NEXT}, from ${LIVE}`,
    promoted: `${NEXT} passed every gate and is live`,
    'stopped-tests': `${NEXT} stopped at its tests`,
    'rolled-back': `${NEXT} was rolled back by itself`,
  }[base];
  const note = {
    deploying: `The canary window: 14 probes so far, the last: Healthy. It rolls back by itself if health fails before 14:34.${paired ? '' : ' Going back by hand waits until it ends: a deploy is running, and it rolls back by itself if its canary fails.'}`,
    promoted: `Started 14:28, live at 14:34. ${LIVE} is kept to go back to.`,
    'stopped-tests': `Nothing changed: Nova kept running ${LIVE}. The gates after it never ran.`,
    'rolled-back': `Its health failed in the canary window, so Nova went back to ${LIVE}. Your data is as it was. Nothing is kept to go back to now.`,
  }[base];
  const raw = base === 'stopped-tests' ? `<details class="sv-raw"><summary>What the tests said</summary><pre class="sv-pre" tabindex="0">${esc(TESTS_TAIL)}</pre></details>` : '';
  return `<section class="sv-deploy" aria-labelledby="${id}-dep-h"><h4 class="au-block-head" id="${id}-dep-h">${esc(head)}</h4><p class="au-note">${esc(note)}</p>${gates(base, base === 'deploying' ? 'canary' : null)}${raw}</section>`;
}

// Every outcome the history can hold, for the history frame.
const HISTORY_ALL = [NOW['rollback-refused'], [LIVE, KEPT, 'Nov 8, 11:20', 'went back', 'You asked to go back.'], ...HISTORY.slice(0, 3)];

function historyList(id, state) {
  const now = NOW[state.replace(/^paired-/, '')];
  const rows = (state === 'history' ? HISTORY_ALL : [...(now ? [now] : []), ...HISTORY]).slice(0, 5);
  return `<h4 class="uc-group sv-sub" id="${id}-hist">History</h4><ul class="sv-hist" aria-labelledby="${id}-hist">${rows.map(([v, from, at, outcome, said]) => `<li class="sv-hrow"><span class="au-text"><span class="au-name">${esc(v)} <span class="sv-from">from ${esc(name(from))}</span></span><span class="au-meta">${esc(OUTCOME[outcome])}. ${esc(said)}</span></span><span class="au-state">${esc(at)}</span></li>`).join('')}</ul>`;
}

// What is running: the release, Nova's build (GET /version), the server, and the one kept.
function running(id, state) {
  const a = after(state);
  const rows = [
    ['Release', `${mono(a.live)}, commit ${mono(COMMIT[a.live])}`],
    ['Nova', `${esc(PKG[a.live])}. Running ${mono(COMMIT[a.live].slice(0, 8))}; Nova doesn’t know the latest merged build.`],
    ['Supervisor', `${esc(a.mode)}. Server on port 8420 since ${a.live === LIVE ? '09:12' : a.canary ? '14:32' : '15:07'}, restarted 0 times.`],
    ['Health checks', a.canary ? 'Every 5 seconds in the canary window.' : 'Last 14:20: Healthy.'],
    ['Kept to go back to', a.canary ? `${mono(LIVE)}, by itself, if the canary fails. ${KEPT} stays kept until ${NEXT} is promoted.` : a.kept ? `${mono(a.kept)}` : 'Nothing. Going back keeps nothing to go back to again; deploy the newer release through its gates instead.'],
  ];
  return `<p class="sv-now"><span class="sv-ver">${esc(a.live)}</span> <span class="sv-live">is live</span></p>${facts(rows)}`;
}

function actions(id, state) {
  const a = after(state);
  if (state.startsWith('paired-')) return `<p class="au-note sv-hub">${esc(HUB_ONLY)}</p>`;
  if (state === 'deploying') return '';
  const back = a.kept ? `<a class="btn" href="#${id}-back">Go back to ${esc(a.kept)}</a>` : '';
  const again = state === 'rollback-refused' ? `<p class="au-note">Going back again is refused the same way while those changes are there.</p>` : '';
  return `<div class="au-actions"><a class="btn" href="#${id}-deploy">Deploy a release</a>${back}</div>${again}`;
}

function problem(id, state) {
  const p = PROBLEM[state.replace(/^paired-/, '')];
  if (!p) return `<p class="au-note">No problems are open.</p>`;
  return `<ul class="sv-probs"><li class="sv-prob"><p class="au-block-head">${esc(p.title)}</p><p class="sv-said">${esc(p.said)}</p><p class="sv-who"><span class="sv-tag">Needs you</span> supervisor · today</p>
<p class="au-note"><b>What you can do</b></p><ol class="sv-steps">${p.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
<div class="au-actions"><button type="button" class="btn" data-sv-demo>Mark as dealt with</button></div>
<details class="sv-raw"><summary>Technical detail</summary><pre class="sv-pre" tabindex="0">${esc(p.detail)}</pre></details></li></ul>`;
}

// Health, as it is today (ui/js/surfaces.js renderHealth), with the release grown in Keeping Nova
// running. The sections below it are unchanged and only named.
function health(id, state, body) {
  const open = !!PROBLEM[state.replace(/^paired-/, '')];
  const lede = open ? 'Something went wrong. Each problem says what happened; the detail is one tap away.' : 'Everything Nova runs on, and anything that went wrong.';
  return `<p class="uc-lede sv-lede">${lede}</p>
<section class="sv-sec" aria-labelledby="${id}-probs"><h3 class="sv-h" id="${id}-probs">Problems</h3>${problem(id, state)}</section>
<section class="sv-sec" aria-labelledby="${id}-keep"><h3 class="sv-h" id="${id}-keep">Keeping Nova running</h3>
<h4 class="uc-group sv-sub" id="${id}-rel">Release</h4>${body}
${facts([['Backups', 'Last backup 03:00, to /mnt/backup/nova. 7 kept (up to 7).'], ['Restore drill', 'Passed Nov 3: 9 of 9 checks.']])}</section>
<p class="au-note sv-rest">Work costs, Diagnostics and Checks follow here, unchanged.</p>`;
}

function atRest(id, state) {
  return health(id, state, `${running(id, state)}${actions(id, state)}${deploy(id, state, state.startsWith('paired-'))}<p class="au-note">${esc(ABOUT)}</p>${historyList(id, state)}`);
}

// ---- asking: deploy and go back, on Nova's own screen ---------------------------------------------

function deployForm(id) {
  const steps = GATES.map((g) => `<li><b>${GATE_NAME[g]}.</b> ${esc(GATE_DOES[g])}</li>`).join('');
  return `<form class="au-form sv-ask" data-sg-inert novalidate aria-labelledby="${id}-title"><p class="sv-kind">Asks every time</p><h3 class="uc-h" id="${id}-title">Deploy a release</h3>
<div class="au-field"><label class="au-label" for="${id}-tag">Release tag</label><input class="uc-input sv-tagin" id="${id}-tag" value="${NEXT}" spellcheck="false" autocapitalize="off"><p class="au-note">The tag of a release in Nova’s repository. Nova doesn’t list the tags yet: type the one you want. A tag that isn’t there is refused before anything starts.</p></div>
<section class="au-preview" aria-labelledby="${id}-what"><h4 class="uc-group au-group-head" id="${id}-what">It goes through, in order</h4><ol class="sv-steps">${steps}</ol>
<p class="au-note">If its tests, the sandbox or a probe fails, nothing changes: Nova keeps running ${LIVE}. If your database is upgraded at the switch, the backup from before is kept.</p></section>
${passkeyConfirm({ state: 'ready' })}
<div class="au-actions">${passkeyAction({ state: 'ready' })}<button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function backForm(id) {
  return `<form class="au-form sv-ask" data-sg-inert novalidate aria-labelledby="${id}-title"><p class="sv-kind">Asks every time</p><h3 class="uc-h" id="${id}-title">Go back to ${KEPT}?</h3>
<p class="au-sentence">Nova stops ${LIVE} and starts ${KEPT}, the release kept to go back to. Nova restarts.</p>
${facts([['From', `${mono(LIVE)}, live since Nov 6`], ['To', `${mono(KEPT)}, the only release kept to go back to`], ['Your data', `${LIVE} upgraded the database (from 23 to 24). Going back restores the backup from before only if nothing was written since; if anything was, it is refused, ${LIVE} keeps running, and the problem says how many changes. Nova can’t tell you which before you ask.`], ['After', `${LIVE} is kept as a release you can deploy again through its gates. Nothing is kept to go back to.`]])}
${passkeyConfirm({ state: 'ready' })}
<div class="au-actions">${passkeyAction({ state: 'ready' })}<button type="button" class="btn quiet">Cancel</button></div></form>`;
}

// While Nova restarts, Health can't read the supervisor: the page says what it last knew.
function away(id, state) {
  const said = state === 'switching'
    ? `Switching to ${NEXT}: its tests, the sandbox and the smoke probes passed at 14:32, and Nova is restarting on it. When Nova answers again, the canary window shows here.`
    : `Going back to ${KEPT}. Nova restarts. When Nova answers again, this shows whether it went back or was refused.`;
  return `<p class="uc-lede sv-lede">${RECONNECT}</p>
<div class="au-result sv-away" role="status" aria-labelledby="${id}-away-h"><div class="au-result-text"><p class="au-block-head" id="${id}-away-h">${state === 'switching' ? 'Restarting for the switch' : 'Restarting to go back'}</p><p class="au-note">${esc(said)}</p></div></div>
${state === 'switching' ? `<section class="sv-sec" aria-labelledby="${id}-last"><h3 class="sv-h" id="${id}-last">Last known</h3>${gates('switching', 'switch')}</section>` : ''}`;
}

function unsupervised(id) {
  return health(id, 'unsupervised', `${facts([['Supervisor', 'Not running under the supervisor. node src/supervisor/main.ts run keeps Nova running and takes releases.'], ['Nova', `${esc(PKG[LIVE])}. Running ${mono(COMMIT[LIVE].slice(0, 8))}; Nova doesn’t know the latest merged build.`], ['Releases', 'None: this Nova runs from its checkout, so there is nothing to deploy or go back to here.']])}<div class="sv-cmd"><p class="au-block-head">On this computer</p><p class="sv-said">${mono('node src/supervisor/main.ts run')}</p></div>`);
}

// ---- frames ------------------------------------------------------------------------------------------

const LIVE_ICON = { deploying: 'working', 'paired-deploying': 'working', switching: 'offline', 'rolling-back': 'offline', 'deploy-form': 'needs-you', 'rollback-confirm': 'needs-you', 'stopped-tests': 'needs-you', 'paired-stopped': 'needs-you', 'rolled-back': 'needs-you', 'paired-rolled-back': 'needs-you', 'rollback-refused': 'needs-you', promoted: 'success' };

function body(id, state) {
  if (state === 'deploy-form') return deployForm(id);
  if (state === 'rollback-confirm') return backForm(id);
  if (state === 'switching' || state === 'rolling-back') return away(id, state);
  if (state === 'unsupervised') return unsupervised(id);
  if (state === 'history') return health(id, state, `${running(id, state)}${actions(id, state)}${historyList(id, state)}<p class="au-note">Health shows the last five. The supervisor keeps fifty, at GET /api/v1/supervisor.</p>`);
  return atRest(id, state.replace(/^paired-stopped$/, 'paired-stopped-tests'));
}

export function svFrame(state) {
  const id = `sv-${state}`;
  const title = state === 'deploy-form' ? 'Deploy a release' : state === 'rollback-confirm' ? 'Go back' : 'Health';
  return `<div class="uc-screen sv" data-sv-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">${title}</h2>${slot(LIVE_ICON[state] ?? 'idle')}</header>
<div class="sv-col"><div class="sv-page">${body(id, state)}</div></div></div></div>`;
}
// The styleguide entry: every frame, each with its full-screen address.
export function svEntry(wrap) {
  return SV_FRAMES.map(([s, said]) => wrap(`${esc(said)} · <a class="link" href="?entry=supervisor&amp;frame=${s}">Full screen</a>`, svFrame(s))).join('');
}
export const isSvFrame = (s) => SV_FRAMES.some(([k]) => k === s);

// Fills the status icon slots and makes the specimens move a little: the passkey box enables its
// button, and the demo buttons say they are a demo.
export function bindSupervisor(root) {
  for (const el of root.querySelectorAll('[data-sv-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.svIcon, size: 24, decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-sv-frame]')) {
    if (frame.dataset.svBound) continue;
    frame.dataset.svBound = '1';
    frame.addEventListener('change', (e) => {
      if (e.target.name !== 'confirm') return;
      const b = e.target.closest('form')?.querySelector('[data-action="passkey-confirm"]');
      if (b) b.disabled = !e.target.checked;
    });
    frame.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sv-demo], [data-action^="passkey"]');
      if (b) { e.preventDefault(); b.textContent = 'Demo: nothing was sent'; }
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
  }
}
