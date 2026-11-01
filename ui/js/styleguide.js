// The living styleguide (DESIGN-SYSTEM §0 and §7; OPERATING-RULES, design-first): every component
// in every state, drawn by the app's own code from realistic Nova content (neutral placeholders,
// never a real person's data). A component that isn't here doesn't ship. Each entry has its own
// anchor (#sg-<entry>) and its own address (/styleguide?entry=<entry>), so it can be looked at and
// approved alone. The schema and the designed scales come from the core (src/core/design.ts).
const schema = await fetch('/api/v1/design-systems/schema').then((r) => r.json());
const tokensOf = (test) => schema.tokens.filter(test).map((t) => t.css);
import { MODES, apply, current, previewCss } from './theme.js';
import { icons, memoryIndex, renderActivity, renderEmpty, renderGmail, renderHandoff, renderMemory, renderPermissions, renderSchedules, renderSkills, renderToc, renderToday, renderTurn, renderWorkNote } from './view.js';
import { ICONS, ORB_SIZES, addDeviceSheet, allowApproveSheet, approvalSheet, briefCard, chatBubble, codingSheet, coldPromotionSheet, deviceMeshCard, deviceRow, emptyState, evidenceViewer, handlingCard, healthCard, infraSheet, joinRequestSheet, lookingIntoItCard, memoryHighlightCard, networkSheet, orb, proactiveBanner, promoteSheet, promotionActionSheet, promotionSheet, revokeSheet, rolesReviewSheet, rolesSheet, settingsRow, status, takeoverPanel, taskRow, triggerRow, verifiedResultCard, voiceState } from './components.js';
import { waitingLine } from './wait.js';
import { ORB_STATES } from './status.js';
import { renderTopology } from './topology-view.js';

const sg = document.getElementById('sg');
const value = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const css = (name) => `--${name.replace(/\//g, '-')}`;
const only = new URLSearchParams(location.search).get('entry');

// ---- sample content: what Nova really shows, with neutral names ------------------------------

const t0 = new Date();
const at = (h) => new Date(t0.getTime() + h * 3600_000).toISOString();

const sample = `Here's the plan for **Friday**, with one decision left for you.

- Ship the endpoint migration (*two hours*)
- Pay the card: \`$41\` minimum
- Book the car service

\`\`\`bash
terraform plan -out=tfplan
\`\`\`

| Item | When |
| --- | --- |
| Migration | Friday |
| Card | Today |

> Quoted context reads quieter than Nova's own words.

More detail is in the [provider docs](https://registry.terraform.io).`;

const turnDone = {
  id: 'a', text: 'What does Friday look like?', ts: t0.toISOString(), attempt: 0, state: 'done',
  items: [
    { kind: 'recall', notes: [{ source: 'memory/2026-10-20.md', text: 'The client migration is the only outside work this week.' }] },
    { kind: 'text', id: 't1', text: sample },
  ],
};
const skillSample = {
  installed: [{ id: 'email-summary', name: 'Email summary', about: 'Tells you what in your inbox needs you, without opening Gmail.', needs: ['gmail'], try: 'What in my inbox needs me today?', body: '## Choose the window\n\n- With no window given, cover the inbox since yesterday.' }],
  available: [{ id: 'shopping', name: 'Shopping research', about: 'Finds and compares things to buy, and recommends one. It researches; you buy.', needs: [], body: '## Search\n\n- Search results are leads.' }],
  connectors: { gmail: { client: true, connected: true, account: 'you@example.com', since: '2026-10-21T09:00:00Z' } },
};
const usedSkill = {
  id: 'sg3', text: 'What in my inbox needs me today?', ts: Date.now(), attempt: 0, state: 'done',
  items: [
    { kind: 'skill', id: 'email-summary', name: 'Email summary', how: 'matched' },
    { kind: 'tool', id: 'g1', name: 'gmail_search', args: { query: 'in:inbox newer_than:1d' }, result: { ok: true, output: '5 messages in 5 conversations, newest first.', summary: '5 messages' } },
    { kind: 'tool', id: 'g2', name: 'gmail_read', args: { id: '19a0c1d2e3f4a501' }, result: { ok: true, output: 'From: Sam Rivera', summary: 'Contract for the spring project' } },
    { kind: 'text', id: 'g3', text: 'One thing needs you: **Sam Rivera** needs the contract signed by Thursday.' },
  ],
};
const memorySample = {
  titles: { '2026-10-21-aaaaaa': 'Morning plan' },
  sections: [
    { title: 'Facts', entries: [{ id: 'm00000001', text: 'The spring project starts on the first Monday of March.', from: '2026-10-21-aaaaaa/a', at: t0.toISOString(), by: 'nova' }] },
    { title: 'Preferences', entries: [{ id: 'm00000002', text: 'Takes coffee with oat milk.', from: '2026-10-21-aaaaaa/a', at: t0.toISOString(), updated: t0.toISOString(), by: 'nova' }, { id: 'h00000003', text: 'Short replies before 9am.', by: 'hand' }] },
    { title: 'Decisions', entries: [] },
    { title: 'Commitments', entries: [{ id: 'm00000004', text: 'Nova drafts the migration PR description on Thursday.', at: t0.toISOString(), updated: t0.toISOString(), by: 'you' }] },
  ],
  days: [{ day: t0.toISOString().slice(0, 10), entries: [{ id: 'n00000005', time: '08:12', text: 'Comparing train times for the March trip.', from: '2026-10-21-aaaaaa/a', by: 'nova' }] }],
};
const kept = {
  id: 'k', text: 'I take my coffee with oat milk now.', ts: t0.toISOString(), attempt: 0, state: 'done',
  items: [{ kind: 'text', id: 'k1', text: 'Got it, oat milk from now on.' }, { kind: 'memory', ops: [{ op: 'remember', ok: true, id: 'm00000002', replaced: true }, { op: 'note', ok: true, id: 'n00000005' }] }],
};
const tools = {
  id: 'b', text: 'Check the repo before standup.', ts: t0.toISOString(), attempt: 0, state: 'done',
  items: [
    { kind: 'tool', id: 'x1', name: 'read_file', args: { path: 'USER.md' }, result: { ok: true, output: '# USER.md\n…' } },
    { kind: 'tool', id: 'x2', name: 'exec', args: { command: 'git status --short' }, needsApproval: true, approval: { decision: 'allow', ts: t0.toISOString() }, result: { ok: true, output: '## main...origin/main\n[exit 0]' } },
    { kind: 'tool', id: 'x3', name: 'exec', args: { command: 'rm -rf build/' }, needsApproval: true, approval: { decision: 'deny', ts: t0.toISOString() }, result: null },
    { kind: 'tool', id: 'x4', name: 'web_fetch', args: { url: 'https://status.example.com' }, result: { ok: false, output: 'HTTP 503' } },
    { kind: 'text', id: 't2', text: 'The tree is clean. I left `build/` alone, as you asked.' },
  ],
};
const waiting = {
  id: 'c', text: 'Run the tests.', ts: t0.toISOString(), attempt: 0, state: 'open',
  items: [
    { kind: 'text', id: 't3', text: 'I’ll run the suite so we know where things stand.' },
    { kind: 'tool', id: 'x5', name: 'exec', args: { command: 'npm test' }, needsApproval: true, approval: null, result: null },
  ],
};
const failed = { id: 'd', text: 'Summarize my inbox.', ts: t0.toISOString(), attempt: 0, state: 'error', items: [{ kind: 'error', message: 'The model ran into a problem and stopped.', detail: 'connection refused' }] };
const streaming = { id: 'e', text: 'And the weekend?', ts: t0.toISOString(), attempt: 0, state: 'open', items: [] };

const task = (id, title, state, more = {}) => ({ id, title, state, reason: null, owner: 'workspace', approval_tier: 1, approved_at: null, user_visibility: 'handling', privacy_mode: 'local-only', brief: { goal: 'A short note is in the workspace, read back and checked.' }, report: null, verification: null, created_at: at(-1), updated_at: at(-0.5), ...more });
const doneTask = task('v1', 'Write a welcome note', 'done', {
  completed_at: at(-0.2),
  report: { summary: 'Wrote welcome.md (242 bytes).', evidence: [] },
  verification: { ok: true, at: at(-0.2), checks: [{ requirement: { kind: 'read_back', target: 'workspace:welcome.md' }, evidence: { kind: 'read_back', target: 'workspace:welcome.md', sha256: '9ffb9f4f9e55aa0b', bytes: 242 }, ok: true, why: 'Nova read it back itself; it matches what was reported.' }] },
});
const workTasks = [
  task('t1', 'Summarize the week’s notes', 'active'),
  task('t2', 'Send the draft reply', 'waiting', { approval_tier: 2 }),
  task('t3', 'Index the photo folder', 'queued'),
  task('t4', 'Fetch the release notes', 'waiting', { reason: 'Waiting on local capacity.' }),
  doneTask,
  task('t5', 'Check the backup', 'failed', { reason: 'The disk wasn’t mounted.' }),
  task('t6', 'Rename the old drafts', 'cancelled', { reason: 'Cancelled by you.' }),
];
const hub = { id: 'h', name: 'Hub', kind: 'computer', role: 'hub', trust: 'trusted', online: true, this: true };
const phone = { id: 'p', name: 'Phone', kind: 'phone', role: 'client', trust: 'trusted', online: false, last_seen: at(-3) };
const desk = { id: 'd', name: 'Study desktop', kind: 'computer', role: 'member', trust: 'trusted', online: true, purposes: ['compute', 'hub-candidate'], fingerprint: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789' };
const sched = (id, name, when, more = {}) => ({ id, name, when, cron: '0 7 * * *', deliver: 'main', prompt: 'Write the morning digest.', next: at(20), last: null, ...more });
const scheduleSample = {
  set: [
    sched('morning-digest', 'Morning digest', 'Every day at 7:00 AM', { last: { ok: true, finished: at(-1), delivered: 'main', handoff: 'h1', summary: 'One thing matters today: the contract, due Thursday.' } }),
    sched('inbox', 'Inbox sweep', 'Every 2 hours', { running: { started: at(0) } }),
    sched('weekly', 'Weekly review', 'Fridays at 4:00 PM', { paused: true, next: null }),
    sched('plants', 'Water the plants', 'Mondays at 8:00 AM', { last: { missed: true, due: at(-26) } }),
    sched('bills', 'Bills check', 'On the 1st of every month at 9:00 AM', { last: { ok: false, finished: at(-2), delivered: 'main', handoff: 'h3', error: 'Nova couldn’t reach the model.' } }),
  ],
  available: [{ id: 'evening', name: 'Evening wrap-up', about: 'What got done today, and what is waiting for tomorrow.', cron: '0 18 * * *', prompt: 'Wrap up the day.' }],
};
const tool = (name, args, more = {}) => ({ kind: 'tool', id: name, name, args, ts: at(-1), result: { ok: true }, ...more });
const entry = (kind, title, state, more = {}) => ({ id: `${kind}-${title}`, kind, title, state, session: '2026-10-21-aaaaaa', turn: 't1', started: at(-1), ended: at(-0.99), steps: [], ...more });
const activitySample = {
  now: [
    entry('helper', 'Read the lease', 'working', { brief: 'Read the lease in workspace/flat and list anything unusual.', parent: 'main', parentTitle: 'Main conversation', steps: [tool('read_file', { path: 'workspace/flat/lease.md' })] }),
    entry('reply', 'Main conversation', 'waiting', { text: 'Run git status in my workspace', session: 'main', approval: 'exec', steps: [{ kind: 'tool', id: 'exec', name: 'exec', args: { command: 'git status' }, needsApproval: true, approval: null, result: null }] }),
  ],
  days: [{
    day: t0.toISOString().slice(0, 10),
    summary: { replies: 2, schedules: 1, helpers: 1, missed: 1, asked: 2, allowed: 1, declined: 1, onOwn: 0, notAsked: 0, kept: 1 },
    entries: [
      entry('schedule', 'Morning digest', 'done', { report: { to: 'main', handoff: 'h1' }, steps: [{ kind: 'skill', id: 'email-summary', name: 'Email summary' }, tool('gmail_search', {}, { result: { ok: true, summary: '5 messages' } })] }),
      entry('helper', 'Check the bus times', 'stopped', { parent: 'main', parentTitle: 'Main conversation', steps: [] }),
      entry('schedule', 'Water the plants', 'missed', { missed: true, session: null, ended: null, steps: [] }),
    ],
  }],
  more: false,
};
const coding = (step) => ({
  id: 'r1', agent_name: 'the coding agent', repo: 'notes-app', branch: 'main', nova_branch: 'nova/fix-date-parsing', scope: 'src/dates and its tests',
  test_command: 'npm test', preview_command: step === 'merge' ? 'npm run preview' : null, merge: 'Merging puts these three files on main.',
  changes: [{ path: 'src/dates/parse.js', kind: 'modified', added: 14, removed: 6 }, { path: 'src/dates/parse.test.js', kind: 'modified', added: 22, removed: 0 }, { path: 'src/dates/zones.js', kind: 'added', added: 31, removed: 0 }],
  diff: '--- a/src/dates/parse.js\n+++ b/src/dates/parse.js\n@@ -12,6 +12,14 @@\n-  return new Date(s);\n+  return parseWithZone(s, zone);',
  test: step === 'merge' ? { command: 'npm test', commit: '4f2a9c1e7b', passed: true, exit: 0, ms: 8400, output: '42 passing' } : null,
  preview: step === 'merge' ? { running: true, url: 'http://localhost:5173' } : null,
});
const codingTask = (step) => task(`c-${step}`, 'Fix the date parsing in notes-app', 'waiting', { approval_tier: step === 'merge' ? 3 : 2, brief: { goal: 'Dates with a time zone parse correctly.', inputs: { step } } });
const infraRun = { id: 'i1', project: { name: 'Static site' }, folder: 'infra/site', apply: 'Applying creates the bucket and its CDN.', plan_text: '+ bucket.site\n+ cdn.site', changes: [{ address: 'bucket.site', action: 'create', delta_usd: 0.5 }, { address: 'cdn.site', action: 'create', delta_usd: 1.2 }], budget: { level: 'ok', words: '$1.70 of a $20.00 monthly budget' } };
const netChange = (step) => ({ id: 'n1', title: 'Open port 8443 for the hub', target: { name: 'the home router', kind: 'router' }, window_s: 300, diff: '+ allow tcp 8443 from lan', snapshot: { sha256: '0f3c9a7b2e1d4c5b6a79', at: at(-0.1) }, counts: ['your phone', 'the study desktop'], step });
const takeover = (mode, holder = null) => ({ live: true, mode, url: 'https://shop.example.com/checkout', step: { n: 3, of: 5, what: 'fill in the delivery address' }, asked: mode === 'needs_person' ? 'type the code your bank sent' : null, holder, blocked: [{ host: 'ads.example.net', count: 4 }] });

// M10i: illustrative presentation fixtures, not the user's machines or a cluster backend.
const topologyStates = [
  ['overview', 'Overview'], ['attention', 'Attention / stale'], ['attention-service', 'Stale service detail'], ['machine', 'Machine services'],
  ['service', 'Service versions / actions'], ['capture', 'Capture versions / actions'],
  ['empty', 'Empty'], ['loading', 'Loading'], ['failed', 'Failed refresh'], ['long-names', 'Long names'],
  ['approval-service', 'Promote service / tier 2'], ['approval-capture', 'Promote capture / tier 3'],
  ['rollback-service', 'Roll back service / tier 2'], ['rollback-capture', 'Roll back capture / tier 2'],
];
const topologyVersions = [
  { name: '2.4.1', role: 'Current', detail: 'Serving on this machine' },
  { name: '2.5.0', role: 'Candidate', detail: 'Available for review; not serving' },
  { name: '2.4.0', role: 'Previous', detail: 'Retained for rollback' },
];
const topologyMachines = [
  { id: 'home', name: 'Home hub', roles: ['Hub', 'Storage'], stale: false, status: 'quiet', age: 'Observed 1 minute ago', observations: [], services: [
    { id: 'notes', name: 'Notes index', status: 'quiet', placement: 'Home hub', capture: false, versions: topologyVersions },
    { id: 'archive', name: 'Archive helper', status: 'quiet', placement: 'Home hub', capture: false, versions: topologyVersions },
  ] },
  { id: 'study', name: 'Study desktop', roles: ['Compute'], stale: false, status: 'quiet', age: 'Observed 2 minutes ago', observations: [], services: [
    { id: 'capture', name: 'Desktop capture', status: 'quiet', placement: 'Native workload on Study desktop', capture: true, versions: topologyVersions },
  ] },
  { id: 'travel', name: 'Travel notebook', roles: ['Client'], stale: false, status: 'quiet', age: 'Observed 3 minutes ago', observations: [], services: [] },
];
const topologyStale = { ...topologyMachines[1], stale: true, status: 'needs-you', age: 'Last observation is 18 minutes old', observations: [
  { source: 'Cluster', reason: 'worker is ready', age: 'Observation is 2 minutes old' },
  { source: 'Heartbeat', reason: 'no response', age: 'Observation is 18 minutes old' },
] };
let topologyState = new URLSearchParams(location.search).get('state') ?? 'overview';
if (!topologyStates.some(([id]) => id === topologyState)) topologyState = 'overview';
let topologyMachine = null;
let topologyService = null;
let topologyApproval = null;
let topologyReturnFocus = null;
function selectTopologyState(next) {
  topologyState = next;
  topologyMachine = ['attention', 'attention-service', 'capture'].includes(next) || next.includes('capture') ? 'study' : ['machine', 'service'].includes(next) || next.includes('service') ? 'home' : null;
  topologyService = next === 'attention-service' || next === 'capture' || next.includes('-capture') ? 'capture' : next === 'service' || next.includes('-service') ? 'notes' : null;
  topologyApproval = next.startsWith('approval-') ? 'promote' : next.startsWith('rollback-') ? 'rollback' : null;
}
selectTopologyState(topologyState);
function topologyFixture() {
  if (topologyState === 'empty') return [];
  if (topologyState === 'failed') return [topologyStale];
  if (['attention', 'attention-service'].includes(topologyState)) return topologyMachines.map((m) => m.id === 'study' ? topologyStale : m);
  if (topologyState === 'long-names') return topologyMachines.map((m) => ({ ...m, name: `${m.name} for shared research and the extended household archive`, roles: [...m.roles, 'LongRunningLocalWorkloadCoordinatorWithoutWordBreaks'], services: m.services.map((s) => ({ ...s, name: `${s.name} for the shared reference library and research annotations` })) }));
  return topologyMachines;
}
function topologyBody() {
  const machines = topologyFixture();
  const m = machines.find((x) => x.id === topologyMachine);
  const s = m?.services.find((x) => x.id === topologyService);
  if (topologyApproval && s) {
    const verb = topologyApproval === 'promote' ? 'Promote' : 'Roll back';
    return `<section class="topology" aria-label="Approval specimen" data-topology-state="${topologyState}"><button type="button" class="btn quiet topology-back" data-topology-back>Back to versions</button><div class="sheet-inner panel">${approvalSheet({ id: 'topology-specimen', title: `${verb} ${s.name}`, owner: m.name, approval_tier: topologyApproval === 'promote' && s.capture ? 3 : 2, privacy_mode: 'local-only', brief: { goal: `${verb} ${s.name} ${topologyApproval === 'promote' ? 'from 2.4.1 to 2.5.0' : 'from 2.4.1 to 2.4.0'}. ${s.capture ? 'This changes the capture process on Study desktop.' : 'This changes which version serves on Home hub.'}` } })}<p class="topology-meta" data-topology-notice role="status">Illustrative approval. No change will be made.</p></div></section>`;
  }
  return renderTopology({ machines, selectedMachine: topologyMachine, selectedService: topologyService, state: topologyState });
}
function topologyEntry() {
  return `<div class="topology-demo-controls"><label for="topology-state">Specimen state</label><select class="input" id="topology-state">${topologyStates.map(([id, name]) => `<option value="${id}"${id === topologyState ? ' selected' : ''}>${name}</option>`).join('')}</select></div><p class="topology-fixture-note">Illustrative machines and observations. No devices are connected; actions open specimens only.</p><div data-topology-content>${topologyBody()}</div>`;
}
function bindTopology() {
  const entry = sg.querySelector('#sg-topology');
  if (!entry) return;
  const paint = (focus = true) => {
    entry.querySelector('[data-topology-content]').innerHTML = topologyBody();
    // Freeze the existing waiting component as an explicitly labelled specimen: no clock,
    // simulated phase changes or progress. The pure renderer owns no elapsed-time logic.
    const waitingSlot = entry.querySelector('[data-topology-wait]');
    if (waitingSlot) {
      waitingSlot.innerHTML = waitingLine('Receiving machine observations', { since: Date.now() - 2000 });
      waitingSlot.querySelector('[data-since]')?.removeAttribute('data-since');
    }
    if (focus) (entry.querySelector('[data-topology-heading]') ?? entry.querySelector('[data-topology-back]'))?.focus();
  };
  paint(false);
  entry.addEventListener('change', (e) => {
    if (e.target.id === 'topology-state') { selectTopologyState(e.target.value); paint(false); }
    if (e.target.matches('[name="confirm"]')) entry.querySelector('[data-action="approve"]').disabled = !e.target.checked;
  });
  entry.addEventListener('submit', (e) => {
    e.preventDefault();
    entry.querySelector('[data-topology-notice]').textContent = 'Specimen complete. No change was made.';
  });
  entry.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-topology-machine')) {
      topologyMachine = button.dataset.topologyMachine; topologyService = null; paint();
    } else if (button.hasAttribute('data-topology-service')) {
      topologyService = button.dataset.topologyService; paint();
    } else if (button.hasAttribute('data-topology-action')) {
      topologyReturnFocus = button.dataset.topologyAction; topologyApproval = button.dataset.topologyAction; paint();
    } else if (button.hasAttribute('data-topology-back') || ['close-sheet', 'cancel-task'].includes(button.dataset.action)) {
      let selector;
      if (topologyApproval) { topologyApproval = null; selector = `[data-topology-action="${topologyReturnFocus ?? 'promote'}"]`; }
      else if (topologyService) { selector = `[data-topology-service="${topologyService}"]`; topologyService = null; }
      else { selector = `[data-topology-machine="${topologyMachine}"]`; topologyMachine = null; }
      paint(false); entry.querySelector(selector)?.focus();
    } else if (button.hasAttribute('data-topology-return')) {
      selectTopologyState('attention'); entry.querySelector('#topology-state').value = 'attention'; paint();
    }
  });
}

// ---- how an entry is drawn -----------------------------------------------------------------------

const state = (label, html, cls = '') => `<figure class="sg-state${cls ? ` ${cls}` : ''}"><figcaption class="sg-label">${label}</figcaption><div class="sg-specimen">${html}</div></figure>`;
const sheet = (html) => `<div class="sheet-inner panel">${html}</div>`;
const tokenList = (names) => names.map((n) => `<code>${n}</code>`).join(' ');
const draw = (fn) => { try { return fn(); } catch (e) { return `<p class="sg-broken">This entry didn’t draw: ${String(e.message).replace(/[<>&]/g, '')}</p>`; } };

// Each entry: [id, name, what it is and which states it has, () => its states].
function entries() {
  const scales = schema.scales ?? {};
  const typeSteps = (scales.type?.steps ?? []).map((s) => s.token);
  const px = (n) => Number.parseFloat(value(css(n))) * (value(css(n)).endsWith('rem') ? 16 : 1);
  const ratio = typeSteps.length ? (px(typeSteps.at(-1)) / px(typeSteps[0])) ** (1 / (typeSteps.length - 1)) : null;
  return [
    ['Foundations', [
      ['color', 'Colour', `The ${tokensOf((t) => t.group === 'color').length} colour tokens every design system defines. Components use nothing else.`,
        () => `<div class="sg-grid">${tokensOf((t) => t.group === 'color').map((n) => `<div class="sg-swatch"><div class="sg-chip" style="background: var(${n})"></div><span class="sg-name">${n}</span><span class="sg-value">${value(n)}</span></div>`).join('')}</div>`],
      ['type', 'Type scale', `Six steps on one ratio${ratio ? ` (here ${ratio.toFixed(3)})` : ''}, from a ${px('type/body')}px body: real hierarchy from size, weight and colour together. Families: ${tokenList(tokensOf((t) => t.syntax === 'font'))}.`,
        () => `${typeSteps.slice().reverse().map((n) => `<div class="sg-row"><span class="sg-name">${css(n)} · ${px(n)}px</span><span class="sg-type" style="font-size: var(${css(n)})">${n === 'type/caption' ? 'Done and checked' : n === 'type/small' ? 'Wrote lists/reading.md · just now' : n === 'type/body' ? 'Nothing is done until Nova has checked the evidence.' : n === 'type/h3' ? 'Nova is handling' : n === 'type/h2' ? 'Waiting for your OK' : 'Tasks'}</span></div>`).join('')}
${state('In use: a view title, a group label, a row, its meta', `<div class="sg-hierarchy"><p class="view-title">Tasks</p><p class="sg-kicker-demo">Done and checked</p><p class="task-title">Save the reading list</p><p class="task-meta">Wrote lists/reading.md · just now</p></div>`)}`],
      ['spacing', 'Spacing', 'A 4pt scale with a name for each step. It is the system’s, the same in every design: spacing is layout. Nothing off it ships (lint:tokens).',
        () => (scales.space ?? []).map((s) => `<div class="sg-row"><span class="sg-name">${css(s.token)} · ${s.name} · ${value(css(s.token))}</span><div class="sg-bar" style="width: var(${css(s.token)})"></div></div>`).join('')],
      ['elevation', 'Elevation', 'Two levels, no more: a card sits on the page; a sheet, a popover or a toast is raised above it.',
        () => `<div class="sg-pair">${state('Level 1 · card · <code>--shadow-card</code>', '<div class="sg-box" style="box-shadow: var(--shadow-card)">A card</div>')}${state('Level 2 · raised · <code>--shadow-raised</code>', '<div class="sg-box" style="box-shadow: var(--shadow-raised)">A sheet</div>')}</div>`],
      ['radius', 'Radius by size class', 'Bound to what a thing is, never to how tall it renders: a container takes the card radius, a control the input radius (the composer too, at any height), and only a token whose height is fixed takes the pill.',
        () => `<div class="sg-pair">${state(`Container · <code>--radius-card</code> · ${value('--radius-card')}`, '<div class="sg-box" style="border-radius: var(--radius-card)">Card, sheet, bubble</div>')}${state(`Control · <code>--radius-input</code> · ${value('--radius-input')}`, '<div class="sg-demo-row"><button class="btn">Not now</button><input class="input" value="Alex" aria-label="Sample field"></div>')}${state('Token · <code>--radius-pill</code>', `<div class="sg-demo-row">${status('working')}${status('verified')}<span class="pill is-on">Online</span></div>`)}</div>`],
      ['motion', 'Motion', `One family: fast, standard and slow transitions, and the loops as whole multiples of slow; one curve, <code>${value('--motion-ease')}</code>. Click a track to play. Under reduced motion the loops stop and transitions are near-instant.`,
        () => `<div class="sg-motion">${tokensOf((t) => t.syntax === 'duration').map((n) => `<div class="sg-row"><span class="sg-name">${n} · ${value(n)}</span><div class="sg-track"><span class="sg-dot" style="transition: translate var(${n}) var(--motion-ease)"></span></div></div>`).join('')}</div>`],
      ['icons', 'Icons', `Nova’s one icon set: line drawings on a 24-unit grid, all at one stroke weight (${scales.icon_stroke ?? ''}), in the colour of their text. No emoji, no second set.`,
        () => `<div class="sg-icons">${Object.entries(ICONS).map(([k, svg]) => `<div class="sg-icon">${svg}<span class="sg-name">${k}</span></div>`).join('')}</div>`],
    ]],
    ['Components', [
      ['topology', 'Topology', 'Machines, their services, and versions in three layers. The hub leads the diagram; on a phone the same machines form an ordered list.', topologyEntry],
      ['orb', 'Orb', 'Nova’s presence: abstract light, no face, once per view. Seven fixed states; the hero on Home, the rail size everywhere else.',
        () => `<div class="sg-grid">${ORB_STATES.map((s) => `<div class="sg-swatch">${orb({ state: s, size: 'rail' })}<span class="sg-name">${s}</span></div>`).join('')}</div>${state('Sizes', `<div class="sg-demo-row sg-orb-sizes">${ORB_SIZES.map((s) => `<div class="sg-swatch">${orb({ state: 'idle', size: s })}<span class="sg-name">${s}</span></div>`).join('')}</div>`)}`],
      ['status', 'Status', 'One vocabulary everywhere, each with a fixed colour. Verified always opens its evidence.',
        () => `<div class="sg-demo-row">${['quiet', 'working', 'waiting', 'needs-you', 'failed'].map((s) => status(s)).join('')}${status('verified', { task: 'v1' })}</div>`],
      ['buttons', 'Buttons', 'One standout per view: the primary action. The rest are plain or quiet.',
        () => `${state('Primary, plain, quiet, small, unavailable', '<div class="sg-demo-row"><button class="btn primary">Approve</button><button class="btn">Not now</button><button class="btn quiet">Cancel</button><button class="btn small">Pause</button><button class="btn" disabled>Unavailable</button></div>')}${state('Icon buttons: send, stop, close', `<div class="sg-demo-row"><button class="send" aria-label="Send">${icons.send}</button><button class="send is-stop" aria-label="Stop">${icons.stop}</button><button class="icon-btn" aria-label="Close">${ICONS.close}</button></div>`)}${state('Links', '<div class="sg-demo-row"><a class="link" href="#sg-buttons">All tasks</a><a class="set-link" href="#sg-buttons">Styleguide</a></div>')}`],
      ['fields', 'Fields and choices', 'A field, a set of choices (one of), and a switch for what Nova may do without asking.',
        () => `${state('Field, empty and filled', '<div class="sg-demo-row"><input class="input" placeholder="Search settings" aria-label="Sample search"><input class="input" value="Alex" aria-label="Sample name"></div>')}${state('Choices', '<div class="choices"><label class="choice"><input type="radio" name="sg-c" checked><span class="choice-name">This device</span></label><label class="choice"><input type="radio" name="sg-c"><span class="choice-name">All my devices</span></label></div>')}${state('Switches, off and on', renderPermissions([{ id: 'sg-a', label: 'Send email', note: 'Sends from your connected account', yes: false }, { id: 'sg-b', label: 'Write files in the workspace', note: 'Inside the workspace folder only', yes: true }]))}`],
      ['brief-card', 'BriefCard', 'The day at a glance. Until a brief is set up, it says so plainly.',
        () => `<div class="sg-cards">${state('With a brief', briefCard({ brief: { headline: 'One thing matters today: the contract, due Thursday.', lines: ['Two tasks are waiting on other people.', 'The backup ran at 3:00 AM and was checked.'] } }))}${state('Not set up yet', briefCard())}</div>`],
      ['handling-card', 'HandlingCard', '“Nova is handling”: background work, up to three rows, then a way to the ledger.',
        () => `<div class="sg-cards">${state('Working', handlingCard({ tasks: workTasks, now: t0 }))}${state('Nothing in progress', handlingCard({ tasks: [], now: t0 }))}</div>`],
      ['task-row', 'TaskRow', 'Every ledger state, mapped once onto the status vocabulary.',
        () => `<div class="panel"><ul class="task-list">${workTasks.map((x) => taskRow(x, { now: t0 })).join('')}</ul></div>`],
      ['verified-result', 'VerifiedResultCard and evidence', 'A finished task with what proved it; the evidence one tap away.',
        () => `<div class="sg-cards">${state('The card', verifiedResultCard(doneTask, { now: t0 }))}${state('The evidence', sheet(evidenceViewer(doneTask)))}</div>`],
      ['looking-into-it', 'LookingIntoItCard', 'Work under way, inline in the conversation.',
        () => `<div class="sg-cards">${state('Working', lookingIntoItCard(workTasks[0]))}${state('Waiting, with its reason', lookingIntoItCard(workTasks[3]))}</div>`],
      ['devices', 'DeviceRow and DeviceMeshCard', 'Each device in plain words; online, offline, revoked.',
        () => `<div class="sg-cards">${state('Rows', `<div class="panel"><ul class="device-list">${deviceRow(hub, { now: t0 })}${deviceRow(desk, { now: t0, roles: true })}${deviceRow(phone, { now: t0 })}${deviceRow({ ...phone, id: 'old', name: 'Old tablet', trust: 'revoked', revoked_at: at(-48) }, { now: t0 })}</ul></div>`)}${state('The card', deviceMeshCard({ devices: [hub, desk, phone], now: t0 }))}${state('Only this device', deviceMeshCard({ devices: [hub], now: t0 }))}</div>`],
      ['health-card', 'HealthCard', 'Fine, or what isn’t, in human terms; the detail is on the Health page, never a path or an error here.',
        () => `<div class="sg-cards">${state('All normal', healthCard({ health: { ok: true, checks: { database: { ok: true }, workers: { ok: true, workers: [{}, {}, {}] } } } }))}${state('Needs you (amber)', healthCard({ health: { ok: true, checks: {} }, problems: [{ id: 1, source: 'backups', message: 'raw detail stays in Health' }] }))}${state('Stopped (red)', healthCard({ health: { ok: true, checks: {} }, problems: [{ id: 2, source: 'ledger', stops: true }] }))}${state('Nova isn’t answering', healthCard({ reachable: false }))}</div>`],
      ['memory-card', 'MemoryHighlightCard', 'One thing Nova kept, or that nothing is kept yet.',
        () => `<div class="sg-cards">${state('Kept', memoryHighlightCard({ records: [{ active: true, user_state: 'active', kind: 'preference', content: 'Prefers short answers before nine.', created_at: at(-2) }] }))}${state('Nothing yet', memoryHighlightCard())}</div>`],
      ['approval-sheet', 'ApprovalSheet', 'Tiered: tier 2 asks; tier 3 needs an explicit confirmation every time.',
        () => `<div class="sg-cards">${state('Tier 2', sheet(approvalSheet(task('a2', 'Send the draft reply', 'waiting', { approval_tier: 2 }))))}${state('Tier 3', sheet(approvalSheet(task('a3', 'Delete the old backups', 'waiting', { approval_tier: 3 }))))}</div>`],
      ['device-sheets', 'Device sheets', 'Adding, changing and revoking devices: what it means, said before the confirmation.',
        () => `<div class="sg-cards">${state('A device asks to join', sheet(joinRequestSheet({ id: 'j1', name: 'Phone', kind: 'phone', platform: 'Android', capabilities: [], fingerprint: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789', confirmation: '042917' })))}${state('Add a device', sheet(addDeviceSheet({ pairing_id: 'p1', code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), hub_url: 'https://hub.example:4320', url: 'https://hub.example:4320/pair#c=ABCD-EFGH&h=ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789', command: 'curl -fsS https://hub.example:4320/join.sh | sh -s -- ABCD-EFGH' })))}${state('The code expired', sheet(addDeviceSheet({ pairing_id: 'p2', expires_at: at(-1) })))}${state('Roles', sheet(rolesSheet(desk, { allowed: ['thin-client', 'compute', 'storage', 'hub-candidate'], fixed: [] })))}${state('Confirming new roles', sheet(rolesReviewSheet(desk, ['compute', 'storage', 'hub-candidate'], { added: ['storage'], removed: [] })))}${state('Revoke', sheet(revokeSheet(phone)))}${state('Let it approve devices', sheet(allowApproveSheet(phone, true)))}</div>`],
      ['hub-sheets', 'Hub sheets', 'Making another computer the hub: what changes and each pre-check, said first.',
        () => {
          const ok = { ok: true, sheet: [{ label: 'What happens', text: 'Study desktop becomes the hub; this computer becomes its standby.' }, { label: 'Devices', text: 'They move over on their own.' }], checks: [{ ok: true, said: 'It has a recent copy of everything.' }, { ok: true, said: 'It is online and answering.' }] };
          return `<div class="sg-cards">${state('Pre-checks passed', sheet(promotionSheet(desk, ok)))}${state('A pre-check failed', sheet(promotionSheet(desk, { ok: false, checks: [{ ok: true, said: 'It is online and answering.' }, { ok: false, said: 'Its copy is two days old.' }] })))}${state('On the standby', sheet(promoteSheet({ hub: { name: 'Hub' }, sync: { last_ok_at: at(-0.2) } })))}${state('From a backup', sheet(coldPromotionSheet({ eligible: true, sheet: [{ label: 'Backup', text: 'Taken 3 h ago.' }, { label: 'Lost', text: 'Anything since then.' }], facts: { backup: { id: 'b1' } } })))}${state('Cancel the hand-over', sheet(promotionActionSheet('cancel', { to_name: 'Study desktop' })))}</div>`;
        }],
      ['change-sheets', 'Change sheets', 'Code, infrastructure and network changes: the change in full, then the confirmation.',
        () => `<div class="sg-cards">${state('Coding: run the tests', sheet(codingSheet(codingTask('check'), coding('check'))))}${state('Coding: merge', sheet(codingSheet(codingTask('merge'), coding('merge'))))}${state('Infrastructure', sheet(infraSheet(task('i', 'Set up the static site', 'waiting', { approval_tier: 3 }), infraRun)))}${state('Network: apply', sheet(networkSheet(task('n', 'Open port 8443 for the hub', 'waiting', { brief: { inputs: { step: 'apply' } } }), netChange('apply'))))}${state('Network: put it back', sheet(networkSheet(task('n2', 'Put the router back', 'waiting', { brief: { inputs: { step: 'revert' } } }), netChange('revert'))))}</div>`],
      ['takeover', 'Browser takeover', 'Nova’s browser, live, with one standout action: Take over, or Hand back.',
        () => `<div class="sg-cards">${state('Working', sheet(takeoverPanel(task('b1', 'Order the printer paper', 'active'), takeover('working'))))}${state('Needs you', sheet(takeoverPanel(task('b2', 'Order the printer paper', 'waiting'), takeover('needs_person'))))}${state('You have control', sheet(takeoverPanel(task('b3', 'Order the printer paper', 'waiting'), takeover('working', { key: 'console', label: 'You' }))))}</div>`],
      ['trigger-row', 'TriggerRow', 'Automations: what starts it, what it does, pause and delete.',
        () => `<div class="panel"><ul class="trigger-list">${triggerRow({ id: 'r1', name: 'Weekly review', class: 'heartbeat', schedule: 'Mondays at 9:00', action: { kind: 'message', text: 'Time for the weekly review.' }, paused: false })}${triggerRow({ id: 'r2', name: 'New invoice', class: 'event', hook_path: '/api/v1/hooks/invoice', action: { kind: 'task', task: { title: 'File the invoice' } }, paused: true })}${triggerRow({ id: 'r3', name: 'Front door left open', class: 'event', source: 'connector:home-assistant/door_open', action: { kind: 'message', text: 'The front door has been open for ten minutes.' } })}</ul></div>`],
      ['chat-bubbles', 'ChatBubble set', 'Your words in a tinted bubble with no tail; Nova’s on the page, full width, with no avatar.',
        () => `<div class="sg-bubbles">${chatBubble({ from: 'person', text: 'What’s on today?' })}${chatBubble({ from: 'nova', text: 'Two small things: the contract is due Thursday, and the car service is booked for Friday at 9.' })}${chatBubble({ from: 'person', text: 'Move the car service to the afternoon if they can.\nAnd remind me about the contract tomorrow morning.' })}</div>`],
      ['composer', 'Composer', 'A control, so it keeps the control radius at every height (UX review F0). It grows to about a quarter of the screen, then scrolls inside.',
        () => `${state('Empty, voice off in local-only', `<div class="dock"><form class="composer" onsubmit="return false"><textarea rows="1" placeholder="Ask Nova anything…" aria-label="Sample composer"></textarea><button type="button" class="mic" aria-label="Talk to Nova" disabled>${ICONS.mic}</button><button class="send" aria-label="Send">${icons.send}</button></form><p class="voice-note">${voiceState({ privacy: 'local-only' }).reason}</p></div>`)}
${state('Grown: a long message', `<div class="dock"><form class="composer is-grown" onsubmit="return false"><textarea rows="5" aria-label="Sample long message">Draft a reply to the landlord:\n- the boiler service is booked for the 14th\n- I'll be home from 9 to 12\n- the hallway light still flickers\nKeep it short and friendly.</textarea><button type="button" class="mic" aria-label="Talk to Nova" disabled>${ICONS.mic}</button><button class="send" aria-label="Send">${icons.send}</button></form></div>`)}
${state('While Nova replies: Stop', `<div class="dock"><form class="composer" onsubmit="return false"><textarea rows="1" placeholder="Ask Nova anything…" aria-label="Sample composer while replying"></textarea><button class="send is-stop" aria-label="Stop">${icons.stop}</button></form></div>`)}`],
      ['notices', 'Toast, ProactiveBanner and banner', 'A toast says what just happened, with Undo where it can; a proactive message is one line and one action; the banner says what holds for the whole app.',
        () => `${state('Toasts', '<div class="sg-frame sg-toasts"><div class="toast">Forgotten.<button type="button" class="toast-btn">Undo</button></div><div class="toast" data-tone="alert">The heartbeat couldn’t check the schedules.<button type="button" class="toast-btn">See Health</button></div><div class="toast" data-tone="attention">Saved on this device. Syncing when the hub is back.</div></div>')}${state('Proactive messages', `${proactiveBanner({ id: 'm1', text: 'The weekly review is ready when you are.' })}${proactiveBanner({ id: 'm2', text: 'I held this one because I wasn’t sure it should go out now.', hold: 'needs_ok' })}`)}${state('Banner', '<div class="banner">You’re offline. What you see was saved earlier; nothing new can arrive or be sent until you’re back.</div>')}`],
      ['settings-row', 'SettingsRow', 'A setting: its name, what it does in a line, and its control.',
        () => `<ul class="settings-list">${settingsRow({ title: 'Your name', note: 'What Nova calls you.', control: '<input class="input" value="Alex" aria-label="Your name"><button type="button" class="btn small">Save</button>' })}${settingsRow({ title: 'Appearance id', note: 'It lets this browser keep its own appearance.' })}</ul>`],
      ['empty-state', 'EmptyState', '“Nothing needs you” is a designed state: what is true now, and what will appear here. Never a blank or a placeholder.',
        () => `<div class="sg-cards">${state('Nothing needs you', emptyState({ line: 'Approvals, failed tasks and anything Nova is unsure about show here.' }))}${state('No tasks yet, with the one next step', emptyState({ title: 'No tasks yet', line: 'Ask Nova for something in Chat; what it takes on shows here until it is checked.', action: '<a class="btn primary" href="#sg-empty-state">Open Chat</a>' }))}</div>`],
      ['waiting', 'Waiting and progress', 'The real phase in plain words; past ten seconds, real units and a rough estimate. Never a fake percentage.',
        () => `<div class="sg-demo">${waitingLine('Checking Nova’s health')}${waitingLine('Copying files to the standby', { done: 120, total: 480, noun: 'file' })}</div>`],
    ]],
    ['Conversation', [
      ['turns', 'Turns', 'Nova speaks without an avatar; the orb shows once per view, not per message.',
        () => `${state('A reply, with a margin note from memory', `<div class="thread">${renderTurn(turnDone, { isLast: true })}</div>`)}
${state('Records, including decided approvals', `<div class="thread">${renderTurn(tools)}</div>`)}
${state('A tool approval waiting for you', `<div class="thread">${renderTurn(waiting, { live: { phase: 'approval', text: '' } })}</div>`)}
${state('Thinking, then streaming', `<div class="thread">${renderTurn(streaming, { live: { phase: 'thinking', text: '' } })}${renderTurn(streaming, { live: { phase: 'streaming', text: 'The weekend is mostly open. Saturday morning has' } })}</div>`)}
${state('Errors and interruptions', `<div class="thread">${renderTurn(failed, { isLast: true })}</div>`)}
${state('What Nova kept, in the margin', `<div class="thread">${renderTurn(kept, { memory: memoryIndex(memorySample) })}</div>`)}
${state('A reply that followed a skill', `<div class="thread">${renderTurn(usedSkill, { skills: new Set(['email-summary']) })}</div>`)}`],
      ['reports', 'Reports and helpers', 'What a schedule or a helper delivered, on time or not, and a helper’s own read-only log.',
        () => `${state('On time, and one that didn’t finish', `<div class="thread">${renderHandoff({ id: 'h1', name: 'Morning digest', schedule: 'morning-digest', ok: true, ts: t0.toISOString(), due: t0.toISOString(), text: 'One thing matters today: the contract, due Thursday.' })}${renderHandoff({ id: 'h3', name: 'Bills check', schedule: 'bills', ok: false, ts: t0.toISOString(), text: 'Bills check didn’t finish. Nova couldn’t reach the model.' })}${renderToday(t0)}</div>`)}${state('A helper’s log', `<div class="thread">${renderWorkNote({ kind: 'helper', title: 'Compare e-bikes', parent: 'main', delivered: { to: 'main', handoff: 'h9' } }, 'the main conversation')}</div>`)}`],
      ['conversations', 'Conversations list and an empty conversation', 'The list of conversations, and what a new one says.',
        () => `${state('Conversations', `<div class="sg-frame"><nav class="toc">${renderToc([{ id: '2026-10-21-aaaaaa', title: 'Morning plan', created: t0.toISOString() }, { id: '2026-10-21-bbbbbb', title: 'Timecard for Monday and Tuesday', created: t0.toISOString() }], '2026-10-21-aaaaaa')}</nav></div>`)}${state('An empty conversation', `<div class="thread">${renderEmpty()}</div>`)}`],
    ]],
    ['Views', [
      ['memory', 'Memory', 'What Nova keeps, by kind, and the day’s notes.', () => `<div class="thread memory">${renderMemory(memorySample)}</div>`],
      ['gmail', 'Gmail connection', 'The production connection card: not connected, connected, and reconnecting, with either sign-in method. Remote clients do not offer local OAuth actions.',
        () => `<div class="sg-cards">${state('Not connected', renderGmail({}))}${state('Connected with an app password', renderGmail({ connected: true, method: 'password', account: 'you@example.com', since: at(-48) }))}${state('Connected with a Google client', renderGmail({ connected: true, method: 'oauth', client: true, account: 'you@example.com' }))}${state('App password needs replacing', renderGmail({ broken: true, method: 'password', account: 'you@example.com' }))}${state('Google sign-in needs reconnecting', renderGmail({ broken: true, method: 'oauth', client: true }))}${state('Remote client', renderGmail({ broken: true, method: 'oauth', client: true }, { local: false }))}</div>`],
      ['skills', 'Skills', 'Installed and available skills, with a connection.', () => `<div class="thread memory skills">${renderSkills(skillSample)}</div>`],
      ['schedules', 'Schedules', 'Every schedule state: on time, running, paused, missed, failed.', () => `<div class="thread memory skills schedules">${renderSchedules(scheduleSample, t0)}</div>`],
      ['activity', 'Activity', 'What is happening now, and each day in a sentence and its entries.', () => `<div class="thread memory activity">${renderActivity(activitySample, t0)}</div>`],
    ]],
  ];
}

function render() {
  const groups = entries();
  const all = groups.flatMap(([, list]) => list);
  const shown = only ? all.filter(([id]) => id === only) : null;
  const one = ([id, name, about, body]) => `<article class="sg-entry" id="sg-${id}" aria-labelledby="sg-${id}-name"><header class="sg-entry-head"><h3 class="sg-entry-name" id="sg-${id}-name">${name}</h3><a class="sg-alone" href="?entry=${id}">Open alone</a></header><p class="sg-about">${about}</p>${draw(body)}</article>`;
  if (shown) {
    sg.innerHTML = shown.length ? `<p class="sg-back"><a class="link" href="/styleguide#sg-${only}">The whole styleguide</a></p>${shown.map(one).join('')}` : `<p class="sg-about">No entry is called “${only.replace(/[<>&"]/g, '')}”. <a class="link" href="/styleguide">The whole styleguide</a></p>`;
  } else {
    const index = `<nav class="sg-index" aria-label="Entries">${groups.map(([g, list]) => `<div><p class="sg-label">${g}</p><ul>${list.map(([id, name]) => `<li><a href="#sg-${id}">${name}</a></li>`).join('')}</ul></div>`).join('')}</nav>`;
    sg.innerHTML = index + groups.map(([g, list]) => `<section class="sg-section" aria-label="${g}"><h2>${g}</h2>${list.map(one).join('')}</section>`).join('');
  }
  bindTopology();
  sg.querySelector('.sg-motion')?.addEventListener('click', () => sg.querySelectorAll('.sg-dot').forEach((d) => d.classList.toggle('is-moved')));
  if (!only && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

// The switch previews another design system on this page only; nothing is applied. Designs not yet
// at Nova's design bar say so (DESIGN-SYSTEM §0).
async function renderSwitch() {
  const cur = current();
  const usable = cur.list.filter((d) => d.valid && d.state !== 'disabled');
  document.getElementById('switch').innerHTML = `<label class="sg-pick">Design system <select class="input" id="sg-ds">${usable.map((d) => `<option value="${d.id}"${d.id === shown ? ' selected' : ''}>${d.name}${d.at_bar === false ? ' (not yet at the bar)' : ''}</option>`).join('')}</select></label>
<label class="sg-pick">Mode <select class="input" id="sg-mode">${MODES.map((m) => `<option value="${m}"${m === shownMode ? ' selected' : ''}>${m[0].toUpperCase()}${m.slice(1)}</option>`).join('')}</select></label>`;
}

let shown = null;
let shownMode = 'auto';
async function preview() {
  const res = await fetch(previewCss(shown, shownMode), { cache: 'no-store' });
  if (!res.ok) return;
  document.getElementById('ds').textContent = await res.text();
  document.getElementById('ds-boot')?.remove();
  requestAnimationFrame(render);
}

document.getElementById('switch').addEventListener('change', (e) => {
  if (e.target.id === 'sg-ds') shown = e.target.value;
  if (e.target.id === 'sg-mode') shownMode = e.target.value;
  preview();
});
window.addEventListener('nova:appearance', () => {
  const cur = current();
  if (!shown) { shown = cur.theme; shownMode = cur.mode; }
  renderSwitch();
  requestAnimationFrame(render);
});

apply();
render();
