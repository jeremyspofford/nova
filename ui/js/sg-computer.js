// Nova Computer's door, design-first (2026-11-09): compositions for the owner's reaction, before
// any wiring. Styleguide only: the app never loads this file, nothing here is sent anywhere, and
// every control is a specimen (a checkbox ticks; Run, Stop and the passkey say they are a demo).
//
// Drawn from the real model (src/core/computer/, docs/plans/M10a.md). Nova's computer is Docker on
// this machine, nothing else: a workspace is one container per project, made from one pinned image
// (Node 26, git and a shell), with one folder mounted at /workspace (a folder of the person's, or an
// empty one Nova keeps), its .git read-only inside unless the person chose otherwise, --network none
// always (a workspace that declares registries or hosts reaches only those, through Nova's proxy,
// one command at a time), running as the person's own uid, never root, capped at 2 CPUs, 2 GB, 512
// processes. There is no terminal, no screen and no file browser: a command is a list of words, run
// as a Work Ledger task in that workspace's one lane; its output is kept when it ends and screened
// by the ingest gate before it is shown. There is no start or stop of the computer: GET /computer
// checks Docker and the image (at most every 30 s); a workspace is creating, ready, broken or
// destroyed, and its machine stays up between commands. "Working" is a computer task running.
// Tiers (policy.ts tierFor): a read runs without asking (0); a write runs without asking with a
// checkpoint first (1); a folder of the person's, or a writable .git, asks first (2); anything in a
// workspace that may reach outside, and deleting one, asks every time (3, with a passkey). While the
// person's privacy is local-only, a workspace that may reach outside runs nothing. No agent tool
// drives it yet: chat can't use it, so commands are asked for here (or through the API).
// The door proposed: a category in Settings › What Nova works with, not a new place in the rail.
// Its CSS is ui/styles/compositions.css (.nc-*, and the .au-* panes it shares with the Automations
// compositions); the narrow layout is layout.css's .au-panes rule.
import { ICONS, passkeyAction, passkeyConfirm } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { statusIcon } from './status-icon.js';

// Every frame: [state, what it shows, which pane a phone shows].
export const NC_FRAMES = [
  ['door-empty', 'The door at rest, nothing made yet: Settings › What Nova works with › Nova’s computer, ready, no workspaces', 'detail'],
  ['door-idle', 'The door at rest, idle: two workspaces, nothing running; the Settings row says so', 'list'],
  ['door-working', 'The door while Nova’s computer works: a command running in “notes-app”, said by the row and the top bar', 'detail'],
  ['workspace', 'Inside a workspace while it works: the command running and how to stop it, what it can reach, its checkpoints and recent commands', 'detail'],
  ['run', 'Running a command: what it may change, its time limit, and whether it asks first', 'detail'],
  ['create', 'Making a workspace: its folder, its network and its .git, and what it will ask', 'detail'],
  ['create-approve', 'A folder of yours asks first (tier 2): exactly which folder will be mounted', 'detail'],
  ['outside-confirm', 'A command in a workspace that may reach outside asks every time (tier 3), with your passkey', 'detail'],
  ['delete-confirm', 'Deleting a workspace (tier 3): its machine and checkpoints go, your folder stays', 'detail'],
  ['local-only', 'Your Nova is local-only: a workspace that may reach outside runs nothing', 'detail'],
  ['broken', 'A workspace whose machine couldn’t be made, in the backend’s words', 'detail'],
  ['no-docker', 'Can’t run here: Docker isn’t installed (the backend’s words)', 'detail'],
  ['not-answering', 'Can’t run now: Docker isn’t answering (the backend’s words, with Docker’s)', 'detail'],
  ['no-image', 'Docker is here, the image isn’t yet: the one command that gets it', 'detail'],
  ['remote-docker', 'DOCKER_HOST points at another machine: refused, not followed', 'detail'],
];
const paneOf = (s) => NC_FRAMES.find(([k]) => k === s)?.[2] ?? 'list';
const DOOR = new Set(['door-empty', 'door-idle', 'door-working', 'no-docker', 'not-answering', 'no-image', 'remote-docker']);

// What GET /computer says (policy.ts IMAGE and IMAGE_ABOUT, docker.ts available()).
const IMAGE = 'node:26-trixie@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617';
const ABOUT = 'Node 26, git and a shell (Docker’s official node:26-trixie image, pinned by digest)';
const DOCKER = '28.5.1';
const DETAIL = {
  ok: `Docker ${DOCKER}, with Nova’s computer image.`,
  'no-docker': 'Docker isn’t installed on this machine, so Nova’s computer can’t run.',
  'not-answering': 'Docker isn’t answering on this machine: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
  'no-image': `Docker ${DOCKER} is here, but Nova’s computer image isn’t yet. Get it once with: docker pull ${IMAGE}`,
  'remote-docker': 'DOCKER_HOST is tcp://192.168.1.20:2375: Nova’s computer runs only on this machine’s own Docker (a unix socket).',
};
const REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'index.crates.io', 'static.crates.io'];
const MAX_WS = 20;

// Workspaces, as GET /computer and GET /computer/workspaces/{id} return them (only what's drawn).
const NOTES = { id: 'w3c9a1e07b2', name: 'notes-app', state: 'ready', folder: '/home/sam/code/notes-app', own_folder: false, git: true, git_writable: false, egress: 'none', made: 'Nov 2', checkpoints: 6 };
const SCRATCH = { id: 'w81f40d6c2a', name: 'scratch', state: 'ready', folder: '/home/sam/.nova/workers/computer/w81f40d6c2a/project', own_folder: true, git: false, git_writable: false, egress: 'registries', made: 'Nov 5', checkpoints: 3 };
const SITE = { id: 'w5be2079f14', name: 'site-builder', state: 'broken', folder: '/home/sam/code/site-builder', own_folder: false, git: true, git_writable: false, egress: 'none', made: 'today, 09:12', checkpoints: 0,
  detail: 'Docker couldn’t start the workspace: Error response from daemon: error while creating mount source path \'…\': mkdir …: read-only file system' };
// The workspace asked for and waiting for its OK: a task, not a workspace yet (no row in GET /computer
// until it runs), drawn in the list so the person sees where it will be.
const NOTES_WAITING = { ...NOTES, waiting: true };
// The command running now: a ledger task in notes-app's lane (GET /tasks, owner computer, active).
const RUNNING = { argv: 'npm test', task: '3f9c2a1e', at: '14:02', limit: '2 minutes', checkpoint: 'c7d41e09a2' };
// Its recent commands (the view's runs) and checkpoints, newest first.
const RUNS = [
  { argv: 'npm run build', access: 'write', at: '13:40', outcome: 'Exited 0', verdict: 'pass', undo: true },
  { argv: 'cat README.md', access: 'read', at: '13:38', outcome: 'Exited 0, changed nothing', verdict: 'quarantine', undo: false },
  { argv: 'npm test', access: 'write', at: '13:31', outcome: 'Exited 1', verdict: 'pass', undo: true },
];
const CHECKPOINTS = [
  ['c7d41e09a2', 'Before task 3f9c2a1e: npm test', 'Automatic', '14:02'],
  ['c0a93f2b5e', 'Before the refactor', 'Named', 'Nov 7'],
  ['c4e1b7a0d3', 'Its clean state, when it was made', 'Clean', 'Nov 2'],
];

// ---- the words: the model in plain language ------------------------------------------------------

const icon = (name) => ICONS[name] ?? '';
const slot = (state, size) => `<span class="au-icon" data-nc-icon="${state}" data-nc-size="${size}" aria-hidden="true"></span>`;
const home = (p) => p.replace(/^\/home\/sam/, '~');
const reach = (w) => (w.egress === 'none' ? 'no network' : 'package registries');
const where = (w) => (w.own_folder ? 'an empty folder Nova keeps' : `your folder ${home(w.folder)}`);
const facts = (rows) => `<dl class="uc-facts au-facts">${rows.map(([k, v]) => `<div class="uc-fact"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const mono = (t) => `<span class="uc-mono">${esc(t)}</span>`;

function stateOf(w, running, held = false) {
  if (held) return 'Can’t run now';
  if (w.waiting) return 'Waiting for your OK';
  if (w.state === 'broken') return 'Broken';
  if (running && w.id === NOTES.id) return `Running ${RUNNING.argv}`;
  return 'Ready';
}

// ---- the door: a category in Settings --------------------------------------------------------------

// Settings' categories (settings-ia.js), with Nova's computer proposed under What Nova works with.
const GROUPS = [
  ['You', [['You and Nova', 'Names and how Nova talks to you'], ['Appearance', 'Theme, light and dark, contrast'], ['Privacy and permissions', 'What stays here and what asks first']]],
  ['What Nova works with', [['Connections', 'Accounts and services Nova can reach'], ['Models and providers', 'Local models and outside help'], ['Devices', 'Phones and computers paired with Nova'], ['Capture', 'Sources, consent, and what Nova remembers'], ['Services', 'How Nova runs its services here'], ['computer', '']]],
  ['About', [['About Nova', 'Its version and build, what’s new, where it stands']]],
  ['Keeping Nova safe', [['Security', 'Passkeys that confirm tier-3 actions here'], ['Backups and changes', 'Backup folders, checkpoints, restores and changes'], ['Configuration', 'Every setting of yours, a few questions, or a file'], ['Start over', 'Export everything, or erase Nova here']]],
];

// What the Settings row says under its name: the door's resting state, from GET /computer.
function doorMeta(o) {
  if (o.fault === 'no-docker' || o.fault === 'remote-docker') return 'Can’t run on this machine';
  if (o.fault === 'not-answering') return 'Can’t run now: Docker isn’t answering';
  if (o.fault === 'no-image') return 'Needs its image first';
  if (o.running) return `Running ${RUNNING.argv} in “${NOTES.name}”`;
  return o.list.length ? `Ready · ${o.list.length} workspaces, nothing running` : 'Ready · no workspaces yet';
}

function categories(id, o) {
  const row = ([name, note], i) => {
    const mine = name === 'computer';
    const href = mine ? `#${id}-computer` : `#${id}-cat-${i}`;
    const label = mine ? 'Nova’s computer' : name;
    const meta = mine ? doorMeta(o) : note;
    return `<li class="nc-cat"><a class="uc-row au-open${mine ? ' is-on' : ''}" href="${href}"${mine ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(label)}</span><span class="au-meta${mine && (o.running || o.fault) ? ' nc-live' : ''}">${esc(meta)}</span></span><span class="uc-ic" aria-hidden="true">${icon('chevron')}</span></a></li>`;
  };
  let n = 0;
  const groups = GROUPS.map(([g, cats], gi) => `<h3 class="uc-group" id="${id}-g${gi}">${g}</h3><ul class="nc-list" aria-labelledby="${id}-g${gi}">${cats.map((c) => row(c, n++)).join('')}</ul>`).join('');
  return `<nav class="au-list" aria-label="Settings categories">${groups}</nav>`;
}

// One workspace as a row: in the door's pane and in the inside list.
function wsRow(id, w, { running = false, current = false, held = false } = {}) {
  const meta = w.state === 'broken' ? `${where(w)} · its machine couldn’t be made` : `${where(w)} · ${reach(w)}`;
  return `<li class="nc-ws"><a class="uc-row au-open${current ? ' is-on' : ''}" href="#${id}-${w.id}"${current ? ' aria-current="true"' : ''}><span class="au-text"><span class="au-name">${esc(w.name)}</span><span class="au-meta">${esc(meta)}</span></span><span class="au-state">${esc(stateOf(w, running, held))}</span></a></li>`;
}

const LEDE = 'Machines Nova makes on this computer to run commands in, one per project. Each sees only its project’s folder, and has no network unless you say.';
const NOT_CHAT = 'Nova’s chat can’t use it yet: you ask for each command here, and each one is a task in Tasks.';

function readiness(fault) {
  if (!fault) return `<p class="uc-state is-ok"><span class="uc-dot" aria-hidden="true"></span><span>Ready. ${esc(DETAIL.ok)}</span></p>`;
  const tone = fault === 'not-answering' || fault === 'no-image' ? 'is-pending' : 'is-unknown';
  return `<p class="uc-state ${tone}"><span class="uc-dot" aria-hidden="true"></span><span>${fault === 'not-answering' ? 'Can’t run now' : fault === 'no-image' ? 'Needs its image first' : 'Can’t run on this machine'}</span></p>`;
}

// What to do about each fault: Nova's own words first, exactly as GET /computer gives them.
function fault(id, f) {
  const said = `<div class="nc-said" role="group" aria-labelledby="${id}-said-h"><p class="au-block-head" id="${id}-said-h">What Nova found</p><p class="nc-quote">${esc(DETAIL[f])}</p></div>`;
  const check = '<button type="button" class="btn" data-nc-demo>Check again</button>';
  if (f === 'no-docker') {
    return `${said}<p class="au-note">Nova doesn’t install Docker. Once it is on this machine, Check again finds it: Nova looks again at most every 30 seconds.</p><div class="au-actions">${check}</div>`;
  }
  if (f === 'not-answering') {
    return `${said}<p class="au-note">Your workspaces are kept as they were, and nothing runs in them until Docker answers. A command asked for meanwhile fails with these words.</p><div class="au-actions">${check}</div>`;
  }
  if (f === 'no-image') {
    return `${said}<div class="nc-cmd" role="group" aria-labelledby="${id}-cmd-h"><p class="au-block-head" id="${id}-cmd-h">Run this once, on this machine</p><p class="nc-quote">${mono(`docker pull ${IMAGE}`)}</p><div class="au-actions"><button type="button" class="btn" data-nc-demo>Copy the command</button>${check}</div></div>
<p class="au-note">Nova doesn’t download it by itself. It is ${esc(ABOUT)}; every workspace starts from it.</p>`;
  }
  return `${said}<p class="au-note">Nova doesn’t follow DOCKER_HOST to another machine. Point it at this machine’s Docker socket, or unset it, and start Nova again.</p><div class="au-actions">${check}</div>`;
}

function doorPane(id, o) {
  const back = `<a class="uc-row uc-back" href="#${id}-settings"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Settings</span></a>`;
  const head = `${back}<h3 class="uc-h" id="${id}-name">Nova’s computer</h3><p class="uc-lede">${LEDE}</p>${readiness(o.fault)}`;
  if (o.fault) {
    const kept = o.list.length ? `<h4 class="uc-group au-group-head" id="${id}-ws">Workspaces</h4><ul class="nc-list" aria-labelledby="${id}-ws">${o.list.map((w) => wsRow(id, w, { held: true })).join('')}</ul>` : '';
    return `${head}${fault(id, o.fault)}${kept}`;
  }
  if (!o.list.length) {
    return `${head}<h4 class="uc-group au-group-head">Workspaces</h4><p class="au-sentence">No workspaces yet.</p>
<p class="au-note">Make one for a project, and it shows here with what it can reach. Each starts from ${esc(ABOUT)}.</p><p class="au-note">${NOT_CHAT}</p>
<div class="au-actions"><a class="btn primary" href="#${id}-make">Make a workspace</a></div>`;
  }
  const working = o.running ? `<div class="au-result" role="group" aria-labelledby="${id}-run-h"><div class="au-result-text"><p class="au-block-head" id="${id}-run-h">Running ${esc(RUNNING.argv)} in “${esc(NOTES.name)}”</p><p class="au-note">Since ${RUNNING.at}, for up to ${RUNNING.limit}. Its output is kept when it ends.</p></div><div class="au-actions"><a class="btn" href="#${id}-${NOTES.id}">Open “${esc(NOTES.name)}”</a></div></div>` : '';
  return `${head}${working}<h4 class="uc-group au-group-head" id="${id}-ws">Workspaces · ${o.list.length} of ${MAX_WS}</h4><ul class="nc-list" aria-labelledby="${id}-ws">${o.list.map((w) => wsRow(id, w, { running: o.running })).join('')}</ul>
<p class="au-note">${NOT_CHAT}</p><div class="au-actions"><a class="btn" href="#${id}-make">Make a workspace</a></div>`;
}

// ---- inside: the workspaces beside the one open --------------------------------------------------

function insideList(id, { list = [NOTES, SCRATCH], current = '', running = false, making = false } = {}) {
  const rows = list.map((w) => wsRow(id, w, { running, current: w.id === current })).join('');
  return `<div class="au-list"><p class="au-intro">${esc(DETAIL.ok)}</p><h3 class="uc-group" id="${id}-ws">Workspaces · ${list.length} of ${MAX_WS}</h3><ul class="nc-list" aria-labelledby="${id}-ws">${rows}</ul>
<a class="uc-row au-new${making ? ' is-on' : ''}" href="#${id}-make"${making ? ' aria-current="true"' : ''}><span class="uc-ic" aria-hidden="true">${icon('plus')}</span><span class="uc-label">Make a workspace</span></a></div>`;
}

const back = (id) => `<a class="uc-row uc-back" href="#${id}-list"><span class="uc-ic" aria-hidden="true">${icon('back')}</span><span>Nova’s computer</span></a>`;

// What a workspace can reach: its folder, its .git, the network, who it runs as, its limits.
function access(id, w) {
  const net = w.egress === 'none'
    ? 'None. Its machine has no network at all.'
    : `Package registries only, through Nova, one command at a time: ${REGISTRIES.map(esc).join(', ')}. Each command asks every time.`;
  const rows = [
    ['Folder', `${mono(w.folder)}, at ${mono('/workspace')} inside. ${w.own_folder ? 'An empty folder Nova made for it.' : 'No other folder of yours is mounted.'}`],
    ...(w.git ? [['Its .git', w.git_writable ? 'Writable inside, as you chose. Git on this computer runs what commands put there.' : 'Read-only inside: commands can’t change it.']] : []),
    ['Network', net],
    ['Runs as', 'Your own user, not root, with no extra privileges.'],
    ['Limits', '2 CPUs, 2 GB of memory, 512 processes. The folder up to 4 GiB, its checkpoints up to 16 GiB.'],
    ['Made from', esc(ABOUT)],
  ];
  return `<h4 class="uc-group au-group-head" id="${id}-reach">What it can reach</h4>${facts(rows)}`;
}

function checkpoints(id) {
  const rows = CHECKPOINTS.map(([cid, reason, kind, at]) => `<li class="nc-cp"><a class="uc-row au-open" href="#${id}-${cid}"><span class="au-text"><span class="au-name">${esc(reason)}</span><span class="au-meta">${kind} · ${mono(cid)}</span></span><span class="au-state">${at}</span></a></li>`).join('');
  return `<h4 class="uc-group au-group-head" id="${id}-cps">Checkpoints · ${NOTES.checkpoints}</h4><ul class="nc-list" aria-labelledby="${id}-cps">${rows}</ul>
<p class="au-note">Opening one offers a reset to it. A reset keeps what is there now as a checkpoint first, so it can be undone too.</p><div class="au-actions"><button type="button" class="btn quiet" data-nc-demo>Take a checkpoint</button></div>`;
}

function runs(id) {
  const rows = RUNS.map((r, i) => {
    const out = r.verdict === 'pass' ? 'Output screened: pass' : `Output held back: screened ${r.verdict}`;
    return `<li class="nc-run"><div class="nc-run-row"><span class="au-text"><span class="au-name">${mono(r.argv)}</span><span class="au-meta">${esc(r.outcome)} · ${r.access === 'read' ? 'a read' : 'a change'} · ${out}</span></span><span class="au-state">${r.at}</span></div>
<div class="nc-run-acts"><a class="btn quiet" href="#${id}-out-${i}">See the record</a>${r.undo ? '<button type="button" class="btn quiet" data-nc-demo>Undo</button>' : ''}</div></li>`;
  }).join('');
  return `<h4 class="uc-group au-group-head" id="${id}-runs">Recent commands</h4><ul class="nc-list" aria-labelledby="${id}-runs">${rows}</ul>`;
}

function workspace(id, w, { running = false } = {}) {
  const head = `${back(id)}<p class="nc-kind">Workspace · made ${w.made}</p><h3 class="uc-h" id="${id}-name">${esc(w.name)}</h3>`;
  const now = running
    ? `<div class="au-result" role="group" aria-labelledby="${id}-now-h"><div class="au-result-text"><p class="au-block-head" id="${id}-now-h">Running now: ${esc(RUNNING.argv)}</p><p class="au-note">Asked for at ${RUNNING.at} (task ${RUNNING.task}), for up to ${RUNNING.limit}. Nova took checkpoint ${RUNNING.checkpoint} just before, so it can be undone. Its output is kept and screened when it ends; a command asked for meanwhile waits its turn.</p></div><div class="au-actions"><button type="button" class="btn" data-nc-demo>Stop it</button><a class="btn quiet" href="#${id}-tasks">Open in Tasks</a></div></div>`
    : '';
  return `${head}${now}<div class="au-actions nc-top-acts"><a class="btn${running ? '' : ' primary'}" href="#${id}-run">Run a command</a></div>
${access(id, w)}${checkpoints(id)}${runs(id)}
<div class="au-danger"><a class="btn quiet" href="#${id}-delete">Delete the workspace</a><p class="au-note">Asks every time, with your passkey. Its machine and checkpoints go; your folder stays as it is.</p></div>`;
}

// ---- asking for work -------------------------------------------------------------------------------

const choice = (name, value, words, on, note = '') => `<label class="uc-choice au-choice"><input type="radio" name="${name}" value="${value}"${on ? ' checked' : ''}><span>${words}${note ? ` <span class="uc-faint">${note}</span>` : ''}</span></label>`;

function runForm(id) {
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><h3 class="uc-h" id="${id}-title">Run a command in “${esc(NOTES.name)}”</h3>
<div class="au-field"><label class="au-label" for="${id}-argv">Command</label><input class="uc-input nc-argv" id="${id}-argv" value="npm run lint" spellcheck="false" autocapitalize="off"><p class="au-note">Run as a list of words, not through a shell. To use a shell, start with sh -c.</p></div>
<fieldset class="au-group"><legend class="uc-group">It may</legend>${choice(`${id}-access`, 'write', 'Change files', true, '· a checkpoint first, so you can undo it')}${choice(`${id}-access`, 'read', 'Only read', false, '· Nova checks it changed nothing')}</fieldset>
<div class="au-field"><label class="au-label" for="${id}-limit">Time limit</label><select class="uc-input" id="${id}-limit"><option>30 seconds</option><option selected>2 minutes</option><option>10 minutes</option><option>1 hour</option></select></div>
<section class="au-preview" aria-labelledby="${id}-say"><h4 class="uc-group au-group-head" id="${id}-say">It will run as</h4><p class="au-sentence">Nova runs npm run lint in “${esc(NOTES.name)}”, with no network, for up to 2 minutes.</p><p class="au-note">It doesn’t wait for your OK: Nova takes a checkpoint first, so you can undo it. It shows in Tasks, and its output here when it ends.</p></section>
<div class="au-actions"><button type="submit" class="btn primary" data-nc-demo>Run it</button><button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function createForm(id) {
  return `${back(id)}<form class="au-form" data-sg-inert novalidate aria-labelledby="${id}-title"><h3 class="uc-h" id="${id}-title">Make a workspace</h3>
<div class="au-field"><label class="au-label" for="${id}-wsname">Name</label><input class="uc-input" id="${id}-wsname" value="notes-app"></div>
<fieldset class="au-group"><legend class="uc-group">Its folder</legend>${choice(`${id}-folder`, 'own', 'A new, empty folder Nova keeps', false, '· doesn’t ask')}${choice(`${id}-folder`, 'yours', 'A folder of yours', true, '· asks first')}
<div class="au-field"><label class="au-label" for="${id}-path">Folder</label><input class="uc-input nc-argv" id="${id}-path" value="/home/sam/code/notes-app" spellcheck="false" autocapitalize="off"><p class="au-note">One project’s folder, up to 4 GiB: not your home folder, a hidden folder of yours, a system folder, Nova’s own, or one another workspace uses.</p></div></fieldset>
<fieldset class="au-group"><legend class="uc-group">Network</legend>${choice(`${id}-net`, 'none', 'None', true, '· recommended')}${choice(`${id}-net`, 'registries', 'Package registries', false, '· npm, PyPI and crates.io; asks every time')}${choice(`${id}-net`, 'hosts', 'Hosts you name', false, '· asks every time')}</fieldset>
<fieldset class="au-checks"><legend class="au-label">Its .git</legend><label class="uc-choice au-choice"><input type="checkbox" name="${id}-git"><span>Let commands change it <span class="uc-faint">· asks first: git on this computer would then run what they put there</span></span></label></fieldset>
<section class="au-preview" aria-labelledby="${id}-say"><h4 class="uc-group au-group-head" id="${id}-say">It will be</h4><p class="au-sentence">“notes-app” on ~/code/notes-app, with no network, its .git read-only inside.</p><p class="au-note">This asks first, because it is a folder of yours. Nova names the exact folder in the request, and uses only that one.</p></section>
<div class="au-actions"><button type="submit" class="btn primary" data-nc-demo>Make it</button><button type="button" class="btn quiet">Cancel</button></div></form>`;
}

// A tier-2 task waiting in the ledger, shown at the door it was asked from (the same one is in Tasks).
function approve(id) {
  return `${back(id)}<p class="nc-kind">Waiting for your OK</p><h3 class="uc-h" id="${id}-title">Make the workspace “notes-app” on /home/sam/code/notes-app</h3>
<p class="au-sentence">Only this folder of yours is mounted, at /workspace inside, with no network. Its .git is read-only inside.</p>
${facts([['Folder', mono('/home/sam/code/notes-app')], ['Which folder', `Device ${mono('2049')}, inode ${mono('1835203')}, made ${mono('1730540112')}. If another folder is at that path when it runs, nothing is made.`], ['Asks', 'First (tier 2): a folder of yours'], ['Task', `${mono('a81d3c55')} in Tasks`]])}
<div class="au-actions"><button type="button" class="btn primary" data-nc-demo>Approve</button><button type="button" class="btn">Cancel the task</button><button type="button" class="btn quiet">Not now</button></div>`;
}

function outside(id) {
  return `${back(id)}<form class="au-form nc-confirm" data-sg-inert novalidate aria-labelledby="${id}-title"><p class="nc-kind">Asks every time</p><h3 class="uc-h" id="${id}-title">Run npm install in “scratch”?</h3>
<p class="au-sentence">This workspace may reach package registries, so each command in it asks, every time.</p>
${facts([['Command', mono('npm install')], ['May reach', `${REGISTRIES.map(esc).join(', ')}, through Nova, for the length of this command`], ['Changes', 'Files in its folder. A checkpoint comes first, so it can be undone.'], ['Task', `${mono('5e07b9d1')} in Tasks`]])}
${passkeyConfirm({ state: 'ready' })}
<div class="au-actions">${passkeyAction({ state: 'ready' })}<button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function remove(id) {
  return `${back(id)}<form class="au-form nc-confirm" data-sg-inert novalidate aria-labelledby="${id}-title"><p class="nc-kind">Asks every time</p><h3 class="uc-h" id="${id}-title">Delete the workspace “notes-app”?</h3>
<p class="au-sentence">Its machine and its ${NOTES.checkpoints} checkpoints are deleted, and can’t be brought back.</p>
<p class="au-note">Your folder ${mono(NOTES.folder)} stays as it is. The record of its commands stays in Tasks.</p>
${passkeyConfirm({ state: 'ready' })}
<div class="au-actions">${passkeyAction({ state: 'ready' })}<button type="button" class="btn quiet">Cancel</button></div></form>`;
}

function localOnly(id) {
  const head = `${back(id)}<p class="nc-kind">Workspace · made ${SCRATCH.made}</p><h3 class="uc-h" id="${id}-name">${esc(SCRATCH.name)}</h3>`;
  return `${head}<div class="au-result" data-tone="warn" role="group" aria-labelledby="${id}-lo-h"><div class="au-result-text"><p class="au-block-head" id="${id}-lo-h">Runs nothing while your Nova is local-only</p><p class="au-note">This workspace may reach package registries, and your privacy setting is local-only, so Nova won’t start a command in it. Workspaces with no network still run.</p></div><div class="au-actions"><a class="btn" href="#${id}-privacy">Privacy settings</a></div></div>
${access(id, SCRATCH)}
<div class="au-danger"><a class="btn quiet" href="#${id}-delete">Delete the workspace</a><p class="au-note">Asks every time, with your passkey. Its machine and checkpoints go.</p></div>`;
}

function broken(id) {
  return `${back(id)}<p class="nc-kind">Workspace · asked for ${SITE.made}</p><h3 class="uc-h" id="${id}-name">${esc(SITE.name)}</h3>
<div class="au-result" data-tone="warn" role="group" aria-labelledby="${id}-b-h"><div class="au-result-text"><p class="au-block-head" id="${id}-b-h">Its machine couldn’t be made</p><p class="nc-quote">${esc(SITE.detail)}</p><p class="au-note">It has no clean state to go back to, so it runs nothing. Delete it, then make it again once Docker can mount the folder.</p></div><div class="au-actions"><a class="btn primary" href="#${id}-delete">Delete the workspace</a></div></div>
${facts([['Folder', `${mono(SITE.folder)}`], ['Task', `${mono('c2f8e610')}, failed, in Tasks`]])}`;
}

// ---- frames ----------------------------------------------------------------------------------------

function screen(state, title, panes, live) {
  const id = `nc-${state}`;
  return `<div class="uc-screen nc" data-nc-frame="${state}"><div class="uc-main"><header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">${title}</h2>${slot(live, 24)}</header>
<div class="au-panes" data-au-pane="${paneOf(state)}">${panes(id)}</div></div></div>`;
}
const pair = (list, right) => (id) => `${list(id)}<div class="au-detail">${right(id)}</div>`;

function door(state) {
  const o = {
    list: state === 'door-empty' || state === 'no-docker' || state === 'remote-docker' || state === 'no-image' ? [] : [NOTES, SCRATCH],
    running: state === 'door-working',
    fault: DOOR.has(state) && !state.startsWith('door-') ? state : null,
  };
  return screen(state, 'Settings', pair((id) => categories(id, o), (id) => doorPane(id, o)), o.running ? 'working' : 'idle');
}

export function ncFrame(state) {
  if (DOOR.has(state)) return door(state);
  const inside = (right, live, list = {}) => screen(state, 'Nova’s computer', pair((id) => insideList(id, list), right), live);
  if (state === 'workspace') return inside((id) => workspace(id, NOTES, { running: true }), 'working', { current: NOTES.id, running: true });
  if (state === 'run') return inside(runForm, 'idle', { current: NOTES.id });
  if (state === 'create') return inside(createForm, 'idle', { making: true });
  if (state === 'create-approve') return inside(approve, 'needs-you', { list: [NOTES_WAITING, SCRATCH], current: NOTES.id });
  if (state === 'outside-confirm') return inside(outside, 'needs-you', { current: SCRATCH.id });
  if (state === 'delete-confirm') return inside(remove, 'needs-you', { current: NOTES.id });
  if (state === 'local-only') return inside(localOnly, 'idle', { current: SCRATCH.id });
  if (state === 'broken') return inside(broken, 'stopped', { list: [NOTES, SCRATCH, SITE], current: SITE.id });
  return door('door-idle');
}
// The styleguide entry: every frame, each with its full-screen address.
export function ncEntry(wrap) {
  return NC_FRAMES.map(([s, said]) => wrap(`${esc(said)} · <a class="link" href="?entry=computer-door&amp;frame=${s}">Full screen</a>`, ncFrame(s))).join('');
}
export const isNcFrame = (s) => NC_FRAMES.some(([k]) => k === s);

// Fills the status icon slots and makes the specimens move a little: the passkey checkbox enables
// its button, and the demo buttons say they are a demo.
export function bindComputer(root) {
  for (const el of root.querySelectorAll('[data-nc-icon]')) {
    el.replaceChildren(statusIcon({ status: el.dataset.ncIcon, size: Number(el.dataset.ncSize), decorative: true }));
  }
  for (const frame of root.querySelectorAll('[data-nc-frame]')) {
    if (frame.dataset.ncBound) continue;
    frame.dataset.ncBound = '1';
    frame.addEventListener('change', (e) => {
      if (e.target.name !== 'confirm') return;
      const b = e.target.closest('form')?.querySelector('[data-action="passkey-confirm"]');
      if (b) b.disabled = !e.target.checked;
    });
    frame.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nc-demo], [data-action^="passkey"]');
      if (b) { e.preventDefault(); b.textContent = 'Demo: nothing was sent'; }
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
  }
}
