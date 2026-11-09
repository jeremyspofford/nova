// The living styleguide (DESIGN-SYSTEM §0 and §7; OPERATING-RULES, design-first): every component
// in every state, drawn by the app's own code from realistic Nova content (neutral placeholders,
// never a real person's data). A component that isn't here doesn't ship. Each entry has its own
// anchor (#sg-<entry>) and its own address (/styleguide?entry=<entry>), so it can be looked at and
// approved alone. The schema and the designed scales come from the core (src/core/design.ts).
const schema = await fetch('/api/v1/design-systems/schema').then((r) => r.json());
const tokensOf = (test) => schema.tokens.filter(test).map((t) => t.css);
import { MODES, apply, current, installCss, previewCss } from './theme.js';
import { icons, memoryIndex, renderActivity, renderBackupsSettings, renderEmpty, renderGmail, renderHandoff, renderMemory, renderPermissions, renderSchedules, renderSkills, renderToc, renderToday, renderTurn, renderWorkNote } from './view.js';
import { ICONS, ORB_SIZES, addDeviceSheet, allowApproveSheet, approvalSheet, briefCard, chatBubble, codingSheet, coldPromotionSheet, deviceMeshCard, deviceRow, emptyState, evidenceViewer, handlingCard, healthCard, infraSheet, joinRequestSheet, lookingIntoItCard, memoryHighlightCard, networkSheet, orb, proactiveBanner, promoteSheet, promotionActionSheet, promotionSheet, revokeSheet, rolesReviewSheet, rolesSheet, settingsRow, status, takeoverPanel, taskRow, triggerRow, verifiedResultCard, voiceState } from './components.js';
import { waitingLine } from './wait.js';
import { ORB_STATES } from './status.js';
import { renderTopology } from './topology-view.js';
import { escapeHtml as esc } from './markdown.js';
import { workCosts, diagnosticsDownload, configImport, configSetup, configProposal, passkeySetup, PASSKEY_STATES, PASSKEY_SETUP_STATES, deviceModels } from './components.js';
import { aboutCard, changelogEntry, pipelineRow, versionStamp } from './components.js';
import * as fitEngine from './fit-engine.js';
import { UC_FRAMES, entryOf, ucEntry, ucFrame } from './sg-compositions.js';
import { bindStatusIcons, statusIconEntry, statusIconSheet } from './sg-status-icons.js';
import { bindJarvis, jarvisEntry } from './sg-jarvis.js';
import { auEntry, auFrame, bindAutomations, isAuFrame } from './sg-automations.js';
import { bindReceipts, isRcFrame, rcEntry, rcFrame } from './sg-receipts.js';
import { bindInbox, ibEntry, ibFrame, isIbFrame } from './sg-inbox.js';
import { bindComputer, isNcFrame, ncEntry, ncFrame } from './sg-computer.js';
import { bindInfraForms, ifEntry, ifFrame, isIfFrame } from './sg-infra-forms.js';
import { bindMemory, isMmFrame, mmEntry, mmFrame } from './sg-memory.js';
import { bindVault, isVtFrame, vtEntry, vtFrame } from './sg-vault.js';

const sg = document.getElementById('sg');
const value = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const css = (name) => `--${name.replace(/\//g, '-')}`;
const params = new URLSearchParams(location.search);
const only = params.get('entry');
// One composition frame at the size of the window (?entry=ui-…&frame=<kind>-<state>), for the owner's screenshots.
const frame = UC_FRAMES.find(([k, s]) => `${k}-${s}` === params.get('frame') && entryOf(k) === only);
// The same for the Automations rule editor's frames (?entry=automations-editor&frame=<state>).
const automationsFrame = only === 'automations-editor' && isAuFrame(params.get('frame')) ? params.get('frame') : null;
// And for the receipts viewer's frames (?entry=receipts&frame=<state>).
const receiptsFrame = only === 'receipts' && isRcFrame(params.get('frame')) ? params.get('frame') : null;
// And for messages and quiet hours (?entry=inbox&frame=<state>).
const inboxFrame = only === 'inbox' && isIbFrame(params.get('frame')) ? params.get('frame') : null;
// And for Nova Computer's door (?entry=computer-door&frame=<state>).
const computerFrame = only === 'computer-door' && isNcFrame(params.get('frame')) ? params.get('frame') : null;
// And for infrastructure projects and network targets (?entry=infra-forms&frame=<state>).
const infraFrame = only === 'infra-forms' && isIfFrame(params.get('frame')) ? params.get('frame') : null;
// And for core memory: search, confirm, correct, export (?entry=memory-surface&frame=<state>).
const memoryFrame = only === 'memory-surface' && isMmFrame(params.get('frame')) ? params.get('frame') : null;
// And for the vault: names, delete and reset (?entry=vault&frame=<state>).
const vaultFrame = only === 'vault' && isVtFrame(params.get('frame')) ? params.get('frame') : null;

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

// Backups uses only public dummy geometry, never a real recovery key or folder.
const backupDemoKey = '01234567-89abcdef-01234567-89abcdef-01234567-89abcdef-01234567-89abcdef';
const backupStates = [
  ['loading', 'Loading'], ['empty', 'No folders'], ['configured', 'Configured'], ['saving', 'Saving'],
  ['error', 'Failed save and field errors'], ['first-key', 'First key shown'], ['confirm', 'Console confirmation'],
  ['shown', 'Console key shown'], ['paired-viewer', 'Paired viewer'], ['paired-approver', 'Paired approver'],
  ['paired-first-key', 'Paired approver: first key once'], ['standby', 'Standby / read-only'],
  ['unavailable', 'Source unavailable / unknown permissions'], ['long-paths', 'Long folder paths'],
];
let backupState = 'configured';
function backupModel() {
  const model = { settings: { target: '/srv/backup-copies', keep: 7, encrypted_target: '/media/encrypted-copies' }, permissions: { canEdit: true, console: true }, state: 'ready', errors: {}, recovery: { state: 'hidden' } };
  if (backupState === 'loading') Object.assign(model, { state: 'loading', loadingSince: t0.getTime() - 1500 });
  if (backupState === 'empty') model.settings = { target: null, keep: 7, encrypted_target: null };
  if (backupState === 'saving') model.state = 'saving';
  if (backupState === 'error') Object.assign(model, { settings: { ...model.settings, keep: 0 }, state: 'error', notice: 'Could not save. The encrypted copy folder is not writable. Your entries are still here.', errors: { target: 'Choose a private folder outside Nova’s home.', keep: 'Enter a whole number from 1 to 365.', encrypted_target: 'Choose a different folder you can write to.' } });
  if (['first-key', 'paired-first-key'].includes(backupState)) model.recovery = { state: 'first-shown', key: backupDemoKey };
  if (backupState === 'shown') model.recovery = { state: 'shown', key: backupDemoKey };
  if (backupState === 'confirm') model.recovery = { state: 'confirm', confirmed: false };
  if (backupState.startsWith('paired')) model.permissions = { canEdit: backupState !== 'paired-viewer', console: false, ...(backupState === 'paired-viewer' ? { readOnlyReason: 'This paired device can view backup settings. Ask an approver to make changes.' } : {}) };
  if (backupState === 'standby') model.permissions = { canEdit: false, console: false, readOnlyReason: 'This is a standby. Change backup settings on the active Nova.' };
  if (backupState === 'unavailable') Object.assign(model, { state: 'error', notice: 'Backup settings could not be loaded. Check the connection before making changes.', permissions: { canEdit: false, console: false, readOnlyReason: 'Device permissions are unavailable. Backup settings are read-only.' }, recovery: { state: 'unavailable', error: 'The recovery key is unavailable while Nova cannot be reached.' } });
  if (backupState === 'long-paths') model.settings = { target: '/srv/backups/shared-reference-library/monthly-archive-with-a-long-neutral-folder-name/backup-copies', keep: 365, encrypted_target: '/media/archive/' + 'long-neutral-folder-name-'.repeat(8) };
  return model;
}
function backupSpecimen(model = backupModel()) {
  return `<div data-backups-specimen="${backupState}">${renderBackupsSettings(model, { id: `sg-backups-${backupState}` })}</div>`;
}
function backupsEntry() {
  return `<label class="sg-pick" for="backups-state">Specimen state <select class="input" id="backups-state">${backupStates.map(([id, name]) => `<option value="${id}"${id === backupState ? ' selected' : ''}>${name}</option>`).join('')}</select></label><p class="sg-about">Demo controls only. Folders and keys below are public examples; no backup settings or clipboard are changed.</p><div data-backups-content>${backupSpecimen()}</div><p class="settings-note" role="status" data-backups-demo-notice></p>`;
}
// Config onboarding specimens (proposed, 2026-11-04): one layered store, three doors. Demo only:
// nothing is read, applied or exported.
const CONFIG_SPECIMENS = ['import-choose', 'import-review', 'import-refused', 'import-applied', 'form-step', 'form-review', 'chat-asking', 'chat-asking-tier-3', 'chat-applied', 'chat-declined'];
let configState = 'import-review';
const configChanges = [
  { key: 'user.timezone', label: 'Timezone', from: 'UTC', to: 'America/New_York', layer: 'pack' },
  { key: 'notifications.quiet_hours', label: 'Quiet hours', from: '22:00–07:00', to: '21:30–08:00', layer: 'pack' },
  { key: 'board.morning', label: 'Morning board', from: 'Day brief, inbox, held items', to: 'Standup draft, inbox, calendar, held items', layer: 'pack' },
  { key: 'hub.port', label: 'Console port', from: '4317', to: '4318', layer: 'hub' },
  { key: 'connectors.mail.key', label: 'Mail key', refused: 'This line had a key in it. Secrets never go in a configuration file, so it was left out. Add the key in Settings › Connections, where it goes to the vault.' },
];
const configFields = [
  { key: 'user.timezone', label: 'Timezone', help: 'Times and quiet hours follow it.', value: 'America/New_York', options: ['UTC', 'America/New_York', 'Asia/Tokyo'], layer: 'pack' },
  { key: 'notifications.quiet_hours', label: 'Quiet hours', help: 'Nova holds anything that can wait.', value: '22:00–07:00', layer: 'default' },
  { key: 'hub.home', label: 'Where Nova keeps your things', help: 'One folder of plain files on this hub.', value: '~/Nova', layer: 'hub' },
];
function configSpecimen() {
  const [door, ...rest] = configState.split('-');
  const s = rest.join('-');
  const html = door === 'import' ? configImport({ state: s, changes: configChanges, problems: ['“port” must be a number from 1 to 65535; the file says “forty-three”.', 'There is no setting called “mornin_board”. Did you mean “morning_board”?'] })
    : door === 'form' ? configSetup({ state: s, title: 'Where and when', fields: configFields, changes: configChanges.slice(0, 2) })
    : configProposal({ state: s === 'asking-tier-3' ? 'asking' : s, tier: s === 'asking-tier-3' ? 3 : 2, changes: s === 'asking-tier-3' ? [{ key: 'privacy.posture', label: 'Privacy', from: 'Local only', to: 'Balanced: outside help when it must', layer: 'pack' }] : [configChanges[2]] });
  return `<div data-config-specimen="${esc(configState)}">${html}</div>`;
}
function configEntry() {
  return `<label class="sg-pick" for="config-state">Door and state <select class="input" id="config-state">${CONFIG_SPECIMENS.map((s) => `<option value="${s}"${s === configState ? ' selected' : ''}>${s.replaceAll('-', ' ')}</option>`).join('')}</select></label>
<p class="sg-about">Three doors into one layered store: a file, the form, a chat with Nova. Each shows the same diff before applying. Demo only: nothing is read, applied or exported.</p><div data-config-content>${configSpecimen()}</div><p class="settings-note" role="status" data-config-demo-notice></p>`;
}
function bindConfig() {
  const entry = sg.querySelector('#sg-config-doors');
  if (!entry) return;
  const note = (text) => { entry.querySelector('[data-config-demo-notice]').textContent = text; };
  entry.addEventListener('change', (e) => {
    if (e.target.id === 'config-state') { configState = e.target.value; entry.querySelector('[data-config-content]').innerHTML = configSpecimen(); note(''); }
    if (e.target.matches('[data-config-file]')) { e.target.value = ''; note('Demo only. No file was read.'); }
  });
  entry.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action^="config-"]');
    if (b && entry.contains(b)) { e.preventDefault(); note('Demo only. Nothing was applied.'); }
  });
}

// Passkey confirmation specimens (T2, approved in #291). Never calls navigator.credentials.
let passkeyState = 'ready';
let passkeySetupState = 'start';
const passkeyTask = () => task('pk3', 'Delete the old backups', 'waiting', { approval_tier: 3 });
function passkeySpecimen() {
  return `<div data-passkey-specimen="${passkeyState}">${state('Tier 3 on Nova’s own screen', sheet(approvalSheet(passkeyTask(), { passkey: { state: passkeyState } })))}${state('Tier 2: unchanged, no passkey', sheet(approvalSheet(task('pk2', 'Send the draft reply', 'waiting', { approval_tier: 2 })).replace('id="sheet-title"', 'id="sheet-title-tier2"')))}</div>`;
}
function passkeyEntry() {
  const pick = (id, label, list, chosen) => `<label class="sg-pick" for="${id}">${label} <select class="input" id="${id}">${list.map((s) => `<option value="${s}"${s === chosen ? ' selected' : ''}>${s.replaceAll('-', ' ')}</option>`).join('')}</select></label>`;
  return `${pick('passkey-state', 'Confirmation state', PASSKEY_STATES, passkeyState)}<div class="sg-cards" data-passkey-content>${passkeySpecimen()}</div>${pick('passkey-setup-state', 'Setup state', PASSKEY_SETUP_STATES, passkeySetupState)}<div class="panel" data-passkey-setup-content>${passkeySetup({ state: passkeySetupState })}</div><p class="settings-note" role="status" data-passkey-demo-notice></p>`;
}
function bindPasskey() {
  const entry = sg.querySelector('#sg-passkey-approval');
  if (!entry) return;
  const note = (text) => { entry.querySelector('[data-passkey-demo-notice]').textContent = text; };
  entry.addEventListener('change', (e) => {
    if (e.target.id === 'passkey-state') { passkeyState = e.target.value; entry.querySelector('[data-passkey-content]').innerHTML = passkeySpecimen(); note(''); }
    if (e.target.id === 'passkey-setup-state') { passkeySetupState = e.target.value; entry.querySelector('[data-passkey-setup-content]').innerHTML = passkeySetup({ state: passkeySetupState }); note(''); }
    if (e.target.name === 'confirm') { const b = e.target.closest('form')?.querySelector('[data-action="passkey-confirm"]'); if (b && passkeyState !== 'rate') b.disabled = !e.target.checked; }
  });
  entry.addEventListener('submit', (e) => { e.preventDefault(); note('Demo only. No passkey was requested and nothing was approved.'); });
  entry.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b || !entry.contains(b)) return;
    if (b.dataset.action.startsWith('passkey') || ['cancel-task', 'close-sheet'].includes(b.dataset.action)) { e.preventDefault(); note('Demo only. No passkey was requested and nothing was approved.'); }
  });
}

function bindBackups() {
  const entry = sg.querySelector('#sg-backups-settings');
  if (!entry) return;
  const note = (text) => { entry.querySelector('[data-backups-demo-notice]').textContent = text; };
  const paint = (model) => { entry.querySelector('[data-backups-content]').innerHTML = backupSpecimen(model); };
  entry.addEventListener('submit', (e) => { e.preventDefault(); note('Demo only. Your draft is unchanged; no backup settings were saved.'); });
  entry.addEventListener('change', (e) => {
    if (e.target.id === 'backups-state') { backupState = e.target.value; paint(); note(''); }
    if (e.target.name === 'confirm') entry.querySelector('[data-action="backups-confirm"]').disabled = !e.target.checked;
  });
  entry.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action?.startsWith('backups-')) return;
    if (action === 'backups-copy') { note('Demo only. The clipboard is unchanged.'); return; }
    if (action === 'backups-clear-target' || action === 'backups-clear-encrypted') { note('Demo only. Removing a folder needs an explicit save in Settings; no saved folder was removed.'); return; }
    const model = backupModel();
    if (action === 'backups-reveal') model.recovery = { state: 'confirm', confirmed: false };
    if (action === 'backups-confirm') {
      if (!entry.querySelector('[name="confirm"]')?.checked) return;
      model.recovery = { state: 'shown', key: backupDemoKey };
    }
    if (['backups-hide', 'backups-cancel'].includes(action)) model.recovery = { state: 'hidden' };
    if (['backups-reveal', 'backups-confirm', 'backups-hide', 'backups-cancel'].includes(action)) {
      paint(model);
      entry.querySelector('.backups-recovery button')?.focus();
      note('Demo only. No recovery key was requested.');
    }
  });
}

// Health specimens are local examples, never a second source of configuration. The browser test
// compares these public example limits to Caps.DEFAULT_LIMITS; Core is never bundled here.
const costStates = ['loading', 'unavailable', 'zero', 'mixed', 'configured', 'unlimited', 'invalid', 'saving', 'save-error', 'success', 'adversarial'];
let costState = 'mixed';
let diagnosticState = 'available';
function costFixture() {
  const empty = { iterations: 0, tokens_in: 0, tokens_out: 0, estimated_tokens: 0, unpriced_tokens: 0, usd: 0 };
  const limits = { task: { iterations: 24, tokens: 150000, usd: 0.5 }, day: { iterations: 300, tokens: 1500000, usd: 5 } };
  const accounting = { scope: 'this-node-runner', provider_reports_included: false, words: 'Nova runner usage on this machine; provider-managed tasks are not included. Autonomous runner work is live capped; your own conversations are metered without caps. Provider-owned loops are not live capped. Spend on other nodes is not included. Estimated tokens and tokens without a price are labeled separately; this is not complete monthly billing.' };
  // Direct model calls recorded by Nova's runner, not reports from provider-managed tasks.
  const providers = costState === 'zero' ? [] : [
    { ...empty, provider: 'Cloud provider', model: 'Standard model', tokens_in: 12000, tokens_out: 5000, estimated_tokens: 4000, usd: 0.12 },
    { ...empty, provider: 'Other provider', model: 'Unlisted model', tokens_in: 5000, tokens_out: 1000, unpriced_tokens: 6000 },
  ];
  if (costState === 'configured') { limits.task.usd = 0.75; limits.day.tokens = 2000000; }
  if (costState === 'unlimited') { limits.task.usd = null; limits.day.iterations = null; }
  if (costState === 'invalid') limits.task.usd = 0;
  if (costState === 'adversarial') {
    providers[0].provider = '<img src=x onerror="alert(1)">';
    providers[0].model = 'LongModelNameWithoutSpaces'.repeat(6);
  }
  return { state: costState, view: ['loading', 'unavailable'].includes(costState) ? null : { accounting, limits, month: { month: '2026-11', providers, total: providers.reduce((sum, p) => Object.fromEntries(Object.keys(sum).map((k) => [k, sum[k] + p[k]])), empty) } }, invalid: costState === 'invalid' ? { 'task.usd': 'Enter a finite number greater than zero, or choose Unlimited.' } : {} };
}
// About Nova, What's new, Where Nova stands and the version stamp (the app's /about, /changelog,
// /pipeline and the rail's foot), from sample builds and entries in the shapes the core returns.
const aboutRunning = 'b66f2c51'.padEnd(40, '0');
const aboutLatest = '8001cd2a'.padEnd(40, '0');
const aboutBuilds = {
  current: { version: '0.1.0-alpha.2', commit: aboutRunning, commit_short: 'b66f2c51', built_at: '2026-11-08T21:02:00.000Z', latest: { commit: aboutRunning, merged_at: '2026-11-08T20:58:00.000Z' }, behind: false, words: 'Running b66f2c51, the latest merged build.' },
  pending: { version: '0.1.0-alpha.2', commit: aboutRunning, commit_short: 'b66f2c51', built_at: '2026-11-08T21:02:00.000Z', latest: { commit: aboutLatest, merged_at: '2026-11-08T22:40:00.000Z' }, behind: true, words: 'Running b66f2c51, latest merged 8001cd2a — redeploy pending.' },
  unknown: { version: '0.1.0-alpha.2', commit: aboutRunning, commit_short: 'b66f2c51', started_at: '2026-11-08T21:05:00.000Z', latest: null, behind: null, words: 'Running b66f2c51; Nova doesn’t know the latest merged build.' },
};
const aboutRelease = { version: '0.1.0-alpha.2', date: '2026-11-08', sections: [{ name: 'Added', items: ['About Nova says which build is running and whether a newer merged one is waiting to be deployed.', 'What’s new lists every change in plain words, newest first.'] }, { name: 'Fixed', items: ['The version at the foot of the navigation opens About.'] }] };
const aboutWaiting = { waiting: true, sections: [{ name: 'Changed', items: ['Where Nova stands shows each piece of work with the record behind its state.'] }] };
const aboutItems = [
  { id: 'm9', name: 'M9 · Feel and polish', state: 'merged', why: 'Its gate evidence is filed.', evidence: { kind: 'gate', path: 'docs/evidence/m9-gate.md', title: 'M9 gate: evidence' } },
  { id: 'm10', name: 'M10 · Execution Plane', state: 'progress', why: '9 of its 11 phases are merged; M10j, M10k not yet.', evidence: { kind: 'plan', path: 'docs/plans/M10.md', title: 'M10 plan: the Execution Plane' } },
  { id: 'ui-design', name: 'A proposed calmer look, shown on the real app', state: 'designed', why: 'A design merged; the ledger has no build for it in this entry.', evidence: { kind: 'ledger', path: 'docs/ledger/2026-11-06-sample.md', title: 'A proposed calmer look, shown on the real app', date: '2026-11-06', changed: 'Nothing in the app yet: the styleguide shows the proposal.', now: 'React to the proposal.', unfinished: 'All of the building.' } },
  { id: 'm10k', name: 'M10k · A phase the roadmap names', state: 'none', why: 'The roadmap names it; it has no plan or evidence yet.', evidence: { kind: 'roadmap', path: 'docs/builder-packet/ROADMAP-AND-GATES.md', title: 'M10k, named in the roadmap' } },
];
function aboutEntry() {
  const card = (label, html) => state(label, `<div class="view about sg-about-view">${html}</div>`);
  const stamp = (label, v, open) => state(label, `<div class="sg-stamp${open ? ' sg-stamp-open' : ''}">${versionStamp(v)}</div>`);
  return `<div class="sg-pair">${card('About: the latest merged build', aboutCard({ build: aboutBuilds.current }))}${card('About: redeploy pending', aboutCard({ build: aboutBuilds.pending }))}</div>
<div class="sg-pair">${card('About: latest merged build unknown, start time only', aboutCard({ build: aboutBuilds.unknown }))}${card('About: reading', aboutCard({ state: 'loading' }))}${card('About: the server didn’t answer', aboutCard({ state: 'failed' }))}</div>
<div class="sg-pair">${stamp('Stamp, open rail and drawer', aboutBuilds.current, true)}${stamp('Stamp, redeploy pending', aboutBuilds.pending, true)}${stamp('Stamp, slim rail', aboutBuilds.current, false)}${stamp('Stamp, slim rail, pending', aboutBuilds.pending, false)}</div>
${state('Changelog entry: merged, not yet in a version', `<div class="view about sg-about-view">${changelogEntry(aboutWaiting)}</div>`)}
${state('Changelog entry: the version running', `<div class="view about sg-about-view">${changelogEntry({ ...aboutRelease, running: true })}</div>`)}
${state('Pipeline rows: merged, in progress, designed, not started (open one for its evidence)', `<div class="view about sg-about-view"><ul class="pipeline-list">${aboutItems.map((it) => pipelineRow(it)).join('')}</ul></div>`)}`;
}

function healthEntry(kind) {
  const costs = kind === 'work-costs';
  const selected = costs ? costState : diagnosticState;
  return `<div class="sg-demo-row"><label for="${kind}-state">Specimen state</label><select class="input" id="${kind}-state">${(costs ? costStates : ['available', 'unavailable']).map((s) => `<option value="${s}"${s === selected ? ' selected' : ''}>${s.replaceAll('-', ' ')}</option>`).join('')}</select></div><p class="sg-about">Illustrative data only. ${costs ? 'Saving makes no changes.' : 'The download action is intercepted; no file or live data is requested.'}</p><div class="panel health-specimen" data-health-specimen="${kind}">${costs ? workCosts(costFixture()) : diagnosticsDownload({ available: diagnosticState === 'available' })}</div>${costs ? '' : '<p class="card-line" role="status" data-diagnostics-notice></p>'}`;
}
function bindHealthSpecimens() {
  for (const kind of ['work-costs', 'diagnostics']) {
    const entry = sg.querySelector(`#sg-${kind}`);
    if (!entry) continue;
    // A copied/opened specimen link must also stay local, not just ordinary clicks. The shared
    // component retains its native attachment URL for Health; only this catalogue changes it.
    const localDownload = () => entry.querySelector('[data-download-diagnostics]')?.setAttribute('href', '#sg-diagnostics');
    localDownload();
    entry.addEventListener('change', (e) => {
      if (e.target.id === `${kind}-state`) {
        if (kind === 'work-costs') costState = e.target.value;
        else diagnosticState = e.target.value;
        entry.querySelector('[data-health-specimen]').innerHTML = kind === 'work-costs' ? workCosts(costFixture()) : diagnosticsDownload({ available: diagnosticState === 'available' });
        localDownload();
        const notice = entry.querySelector('[data-diagnostics-notice]');
        if (notice) notice.textContent = '';
      } else if (e.target.name?.endsWith('.unlimited')) {
        const input = entry.querySelector(`[name="${e.target.name.replace('.unlimited', '')}"]`);
        input.disabled = e.target.checked;
        clearInvalid(entry);
      }
    });
    entry.addEventListener('input', (e) => { if (e.target.matches('.work-limit')) clearInvalid(entry); });
    entry.addEventListener('submit', (e) => {
      e.preventDefault();
      if (entry.querySelector('[data-save-work-limits]')?.disabled) return;
      const invalid = [...entry.querySelectorAll('.work-limit')].filter((input) => !input.disabled && (!input.value.trim() || !Number.isFinite(Number(input.value)) || Number(input.value) <= 0));
      for (const input of invalid) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'work-specimen-error'); }
      const notice = entry.querySelector('[data-work-costs-notice]');
      notice.id = 'work-specimen-error';
      notice.textContent = invalid.length ? 'Enter a finite number greater than zero, or choose Unlimited.' : 'Specimen complete. No limits were saved.';
      invalid[0]?.focus();
    });
    const interceptDownload = (e) => {
      if (e.target.closest('[data-download-diagnostics]')) {
        e.preventDefault();
        entry.querySelector('[data-diagnostics-notice]').textContent = 'Specimen complete. No file was downloaded.';
      }
    };
    entry.addEventListener('click', interceptDownload);
    entry.addEventListener('auxclick', interceptDownload);
  }
}
function clearInvalid(entry) {
  for (const input of entry.querySelectorAll('.work-limit')) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
  for (const error of entry.querySelectorAll('.work-limit-error')) error.remove();
  entry.querySelector('[data-work-costs-notice]').textContent = '';
  entry.querySelector('[data-save-work-limits]').disabled = false;
}

// ---- how an entry is drawn -----------------------------------------------------------------------

// The per-device Models screen (proposed, 2026-11-04): the real fit engine (ui/js/fit-engine.js is
// src/core/models/fit.ts with its types erased) computes every verdict and number here, and again
// on every change to a quant, a context or the plan. Demo only: nothing is installed or assigned,
// and nothing is sent anywhere. The hardware is sample hardware. The catalog is the ADR's golden set
// (its 8B, 14B and 32B shapes), plus an embedder and a vision model; the hub also has a 4B.
const GiB = fitEngine.GiB;
const MODEL_CONTEXTS = [2048, 4096, 8192, 16384, 32768];
const shape = (layers, kv_heads, head_dim) => ({ layers, kv_heads, head_dim });
const MODEL_CATALOG = {
  'qwen3:8b': { params: 8_200_000_000, capabilities: ['completion'], arch: shape(36, 8, 128) },
  'qwen3:14b': { params: 14_800_000_000, capabilities: ['completion'], arch: shape(40, 8, 128) },
  'qwen3:32b': { params: 32_800_000_000, capabilities: ['completion'], arch: shape(64, 8, 128) },
  'qwen2.5vl:7b': { params: 8_300_000_000, capabilities: ['vision'], arch: shape(28, 4, 128) },
  'nomic-embed-text': { params: 137_000_000, capabilities: ['embedding'], arch: shape(12, 12, 64), max_context: 2048, quants: ['Q8_0', 'F16'], contexts: [2048] },
};
const gpu = (name, vram, used = 0) => ({ vendor: 'nvidia', name, vram_bytes: vram * GiB, vram_free_bytes: Math.round((vram - used) * GiB), unified: false });
const hardware = (gpus, ram) => ({ at: t0.toISOString(), platform: 'linux', arch: 'x64', hostname: 'sample', cpu: { model: 'sample', threads: 8 }, ram_bytes: ram * GiB, ram_free_bytes: ram * GiB, gpus, disk: null, network: [], whisper: null, sources: [] });
const embedderFile = { quant: 'F16', weights_bytes: 274_302_450 };
const tunedFile = { quant: 'Q4_K_M', weights_bytes: 7_480_000_000 };
const MODEL_DEVICES = {
  study: { name: 'Study desktop', words: 'NVIDIA GeForce RTX 3090 · 24.0 GB video memory', hw: hardware([gpu('NVIDIA GeForce RTX 3090', 24, 0.45)], 64), learned: { bytes: Math.round(1.12 * GiB), n: 3, last_observed: null, updated_at: null }, installed: { 'nomic-embed-text': embedderFile } },
  tower: { name: 'Small tower', words: 'NVIDIA GeForce RTX 3060 Ti · 8.0 GB video memory', hw: hardware([gpu('NVIDIA GeForce RTX 3060 Ti', 8)], 32) },
  laptop: { name: 'Laptop', words: 'Apple M2 · 16.0 GB unified memory', hw: { ...hardware([{ vendor: 'apple', name: 'Apple M2', vram_bytes: 12 * GiB, vram_free_bytes: null, unified: true }], 16), platform: 'darwin', arch: 'arm64' } },
  // Added 2026-11-06: a Mac whose GPU memory limit was raised (sysctl iogpu.wired_limit_mb=57344).
  studio: { name: 'Studio Mac', words: 'Apple M2 Max · 64.0 GB unified memory', hw: { ...hardware([{ vendor: 'apple', name: 'Apple M2 Max', vram_bytes: 48 * GiB, vram_free_bytes: null, unified: true }], 64), platform: 'darwin', arch: 'arm64', gpu_wired_limit_bytes: 56 * GiB } },
  workshop: { name: 'Workshop PC', words: 'NVIDIA GeForce RTX 4070 · 12.0 GB video memory', hw: hardware([gpu('NVIDIA GeForce RTX 4070', 12, 0.3)], 32), installed: { 'tuned-assistant:12b': tunedFile }, extra: { 'tuned-assistant:12b': { params: 12_200_000_000, capabilities: ['completion'], arch: null } } },
  // The owner's Dell, woken by the always-on mini-PC hub (WoL ADR's golden case); sample GPU.
  dell: { name: 'Dell desktop', words: 'NVIDIA GeForce RTX 3090 · 24.0 GB video memory', hw: hardware([gpu('NVIDIA GeForce RTX 3090', 24, 0.45)], 64), learned: { bytes: Math.round(1.12 * GiB), n: 3, last_observed: null, updated_at: null } },
  mini: { name: 'Mini PC (the hub)', words: 'No GPU · 32.0 GB memory · this is the hub', hw: hardware([], 32), hub: true, extra: { 'qwen3:4b': { params: 4_000_000_000, capabilities: ['completion'], arch: shape(36, 8, 128) } } },
};
// Each state: the device, its privacy mode, and the plan as [model, quant, context, loaded?].
const MODEL_STATES = {
  '3090-one-model': { label: '24 GB RTX 3090, one model', device: 'study', privacy: 'local-only', plan: [['qwen3:14b', 'Q8_0', 16384]] },
  '3090-two-models': { label: '24 GB RTX 3090, two models (one tight)', device: 'study', privacy: 'local-only', plan: [['qwen3:32b', 'Q4_K_M', 4096], ['nomic-embed-text', 'F16', 2048, true]] },
  '8gb-nothing-at-16k': { label: '8 GB card: nothing fits at 16k', device: 'tower', privacy: 'local-only', plan: [['qwen3:8b', 'Q4_K_M', 16384]] },
  'mac-16gb-unified': { label: '16 GB Mac, unified memory (local first)', device: 'laptop', privacy: 'local-preferred', plan: [['qwen3:8b', 'Q4_K_M', 16384]] },
  'mac-limit-set': { label: '64 GB Mac with its GPU memory limit set', device: 'studio', privacy: 'local-only', plan: [['qwen3:32b', 'Q8_0', 16384]] },
  'unknown-shape': { label: 'A model of unknown shape: an estimate', device: 'workshop', privacy: 'local-only', plan: [['tuned-assistant:12b', 'Q4_K_M', 8192, true]] },
  'no-gpu': { label: 'No GPU found', device: 'mini', privacy: 'local-only', plan: [['qwen3:4b', 'Q4_K_M', 4096]] },
  // Added with the app build (2026-11-05): a device asleep shows what it last reported, with its age;
  // Install and assign asks before anything downloads.
  'asleep': { label: 'Asleep: what it last reported, with its age', device: 'tower', privacy: 'local-only', plan: [['qwen3:8b', 'Q4_K_M', 4096]], seen: 'Last seen 3 h ago. What shows here is what it last reported: its hardware 3 h ago, its models 3 h ago.' },
  'install-confirm': { label: 'Install and assign, asking first', device: 'study', privacy: 'local-only', plan: [['qwen3:14b', 'Q8_0', 16384]], confirm: {
    title: 'Download this model and assign?', ok: 'Download and assign',
    lines: ['qwen3:14b at Q8_0, about 14.6 GB, downloads to Study desktop, then serves thinking and writing.', 'Ollama downloads from its library on the internet; nothing of yours is sent. A role is given only once Nova has checked the download arrived.'],
  } },
  // Added 2026-11-06 (the owner: a Tight fit is never picked for you): a tight plan shows the
  // acknowledgement next to Install, which stays off until it is ticked, for this plan only.
  'tight-ack': { label: 'A tight plan: Install waits for your acknowledgement', device: 'study', privacy: 'local-only', plan: [['qwen3:32b', 'Q4_K_M', 4096]] },
  // Proposed with the Wake-on-LAN ADR (2026-11-06): asleep but wakeable, waking, woke and loading,
  // three ways a wake fails and what Nova does then, and the sleep policy. `waiting` is how long ago
  // the wait began; the specimen's waiting line is frozen (no clock).
  ...wakeStates(),
};
function wakeStates() {
  const SEEN_2H = 'Last seen 2 h ago. What shows here is what it last reported: its hardware 2 h ago, its models 2 h ago.';
  const SLEEP_NOTES = ['Dell desktop’s own device agent puts it to sleep once nothing of Nova’s has run there for that long and no one is using it. Nova keeps it awake while work runs.', 'Mini PC (the hub) wakes it with a signal on their shared network, and only there: never across the internet or over your mesh.'];
  const dell = (label, privacy, wake, seen = SEEN_2H) => ({ label, device: 'dell', privacy, plan: [['qwen3:14b', 'Q8_0', 16384]], seen, wake: { ...wake, policy: { idle: '30', demand: 'wake', notes: SLEEP_NOTES, ...wake.policy } } });
  const task = '“Summarize the lease”';
  return {
    'asleep-wakeable': dell('Asleep, wakeable', 'local-only', { state: 'asleep', pill: 'Asleep, wakeable', lines: ['Nova wakes it when work needs it: Mini PC (the hub) sends the wake signal on their shared network. Waking took 38 s last time.'] }),
    'waking': dell('Waking, for a task', 'local-only', { state: 'waking', pill: 'Waking', waiting: { text: `Waking Dell desktop for ${task}`, ms: 23_000 }, lines: ['Mini PC (the hub) sent the wake signal at 14:02. Waking took 38 s last time, so Nova waits up to 59 s before it says what it will do instead.', 'This is local only: the task waits on your devices, and nothing goes to the cloud.'] }),
    'woke-loading': dell('Woke, loading the model', 'local-only', { state: 'awake', pill: 'Awake', waiting: { text: `Loading qwen3:14b for ${task}`, ms: 4000 }, lines: ['Woke after 41 s (38 s last time). Its hardware is fresh again, and qwen3:14b at Q8_0 with 16k context still fits.'] }, null),
    'couldnt-wake': dell('Couldn’t wake: no answer', 'local-only', { state: 'failed', pill: 'Couldn’t wake', lines: ['Mini PC (the hub) sent the wake signal at 14:02 and waited 59 s, half again what waking took last time (38 s). Dell desktop didn’t answer.', `Nothing else that is awake fits qwen3:14b at 16k context. This is local only, so ${task} waits on your devices and runs once Dell desktop checks in. Nova won’t keep waking it.`], actions: [{ action: 'models-wake-again', label: 'Try waking it again' }] }),
    'couldnt-wake-no-sender': dell('Couldn’t wake: nothing on its network can', 'local-preferred', { state: 'failed', pill: 'Couldn’t wake', lines: ['None of your always-on devices is on its network, so nothing can send the wake signal. Nova doesn’t send wake signals across networks or over your mesh.', `This is local first, so Nova asks before anything goes to the cloud: ${task} waits until Dell desktop is on, unless you send it to your cloud model this once.`], actions: [{ action: 'models-cloud-once', label: 'Use the cloud model this once' }], policy: { notes: [SLEEP_NOTES[0], 'Nova can wake it only from an always-on device of yours on the same network, like the hub at home.'] } }, 'Last seen 2 days ago. What shows here is what it last reported: its hardware 2 days ago, its models 2 days ago.'),
    'couldnt-wake-unhealthy': dell('Couldn’t wake: woke, but its models didn’t answer', 'local-only', { state: 'failed', pill: 'Couldn’t wake', lines: ['Dell desktop woke after 40 s and its device agent checked in, but Ollama didn’t answer in the minute after.', `Nova opened a problem with what to check. ${task} waits on your devices and runs when Ollama answers; Nova won’t wake it again for this task.`] }, null),
    'sleep-policy': dell('Sleep policy, while it’s on', 'local-only', { state: 'awake', pill: 'Online', lines: ['Nothing of Nova’s is running here now.'] }, null),
  };
}
const MODEL_SPECIMENS = Object.keys(MODEL_STATES);
let modelsState = '3090-two-models';
let modelsPlan = null;
let modelsAcked = false;
const modelInfo = (d, name) => d.extra?.[name] ?? MODEL_CATALOG[name];
function modelsDevice(d) { return fitEngine.deviceBudget(d.hw, { overhead: d.learned ?? null }); }
function planEntry(d, [name, quant, context, loaded = false]) {
  const info = modelInfo(d, name);
  return { name, quant, context, loaded, installed: Boolean(d.installed?.[name]) && d.installed[name].quant === quant, quants: info.quants ?? [...fitEngine.QUANTS], contexts: info.contexts ?? MODEL_CONTEXTS, estimate: info.arch === null };
}
function fitModel(d, m) {
  const info = modelInfo(d, m.name);
  const file = d.installed?.[m.name];
  return { name: m.name, params: info.params, weights_bytes: file && file.quant === m.quant ? file.weights_bytes : null, quant: m.quant, context: m.context, arch: info.arch, arch_source: info.arch ? (file ? 'backend' : 'catalog') : null, kv_type: 'f16' };
}
function modelsView() {
  const s = MODEL_STATES[modelsState];
  const d = MODEL_DEVICES[s.device];
  const device = modelsDevice(d);
  modelsPlan ??= s.plan.map((p) => planEntry(d, p));
  const plan = modelsPlan.map((m) => ({ ...m, installed: Boolean(d.installed?.[m.name]) && d.installed[m.name].quant === m.quant, result: fitEngine.fit({ device, models: [fitModel(d, m)] }) }));
  const total = plan.length ? fitEngine.fit({ device, models: plan.map((m) => fitModel(d, m)) }) : null;
  const candidates = [...Object.entries(MODEL_CATALOG), ...Object.entries(d.extra ?? {})].map(([name, info]) => ({ name, params: info.params, capabilities: info.capabilities, where: 'local', installed: d.installed?.[name] ?? null, arch: info.arch, arch_source: info.arch ? 'catalog' : null, max_context: info.max_context ?? null }));
  candidates.push({ name: 'A cloud model, through your provider', params: 0, capabilities: ['completion'], where: 'cloud', installed: null, arch: null, arch_source: null });
  const advice = fitEngine.TASK_CLASSES.map((task) => fitEngine.recommendFit({ device, privacy: s.privacy, task, hub: Boolean(d.hub), candidates }));
  return {
    id: `dm-${s.device}`, privacy: s.privacy, plan, total, advice, confirm: s.confirm ?? null, acked: modelsAcked,
    catalog: [...Object.keys(MODEL_CATALOG), ...Object.keys(d.extra ?? {})],
    device: { name: d.name, hardware: d.words, memory: device.memory, budget_bytes: device.budget_bytes, budget_source: device.budget_source, ram_bytes: d.hw.ram_bytes, overhead_source: device.overhead_source, overhead_loads: d.learned?.n ?? 0, seen: s.seen ?? null,
      wake: s.wake ? { ...s.wake, waiting: s.wake.waiting ? { text: s.wake.waiting.text, since: Date.now() - s.wake.waiting.ms } : null } : null },
  };
}
function modelsSpecimen() {
  // A waiting line here is a frozen specimen: without its start time the page's clock leaves it alone.
  return `<div data-models-specimen="${esc(modelsState)}">${deviceModels(modelsView()).replace(/ data-since="\d+"/g, '')}</div>`;
}
function modelsEntry() {
  return `<label class="sg-pick" for="models-state">State <select class="input" id="models-state">${MODEL_SPECIMENS.map((s) => `<option value="${s}"${s === modelsState ? ' selected' : ''}>${esc(MODEL_STATES[s].label)}</option>`).join('')}</select></label>
<p class="sg-about">Settings › Devices › a device › Models, and the same component in device setup. Every verdict and number comes from the real fit engine, and recomputes as you change a quant, a context or the plan. Demo only: nothing is installed or assigned.</p><div class="dm-specimen" data-models-content>${modelsSpecimen()}</div><p class="settings-note" role="status" data-models-demo-notice></p>`;
}
function bindModels() {
  const entry = sg.querySelector('#sg-models-screen');
  if (!entry) return;
  const content = entry.querySelector('[data-models-content]');
  const note = (text) => { entry.querySelector('[data-models-demo-notice]').textContent = text; };
  const redraw = (focusId = null, said = null) => {
    content.innerHTML = modelsSpecimen();
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    const v = modelsView();
    note(said ?? (v.total ? `Recomputed by the fit engine: ${v.total.words}` : 'Nothing is planned on this device.'));
  };
  entry.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'models-state') { modelsState = t.value; modelsPlan = null; modelsAcked = false; content.innerHTML = modelsSpecimen(); note(''); return; }
    if (t.dataset.modelsAck !== undefined) { modelsAcked = t.checked; redraw(t.id, modelsAcked ? 'Acknowledged for this plan. Demo only: nothing is installed.' : null); return; }
    if (t.dataset.modelsSleep !== undefined) return note('Demo only. Nothing was changed.');
    // Any change to the plan clears the acknowledgement: it was for the plan as it was.
    if (t.dataset.modelsQuant !== undefined) { modelsAcked = false; modelsPlan[Number(t.dataset.modelsQuant)].quant = t.value; redraw(t.id); }
    if (t.dataset.modelsContext !== undefined) { modelsAcked = false; const m = modelsPlan[Number(t.dataset.modelsContext)]; m.context = m.contexts[Number(t.value)] ?? m.context; redraw(t.id); }
  });
  entry.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action^="models-"]');
    if (!b || !entry.contains(b) || b.disabled) return;
    e.preventDefault();
    const d = MODEL_DEVICES[MODEL_STATES[modelsState].device];
    const act = b.dataset.action;
    if (act === 'models-install' || act === 'models-confirm' || act === 'models-not-now') return note('Demo only. Nothing was installed or assigned.');
    if (act === 'models-wake-again' || act === 'models-cloud-once') return note('Demo only. Nothing was woken or sent.');
    modelsAcked = false;
    if (act === 'models-remove') { modelsPlan.splice(Number(b.dataset.index), 1); return redraw(entry.querySelector('[data-device-models] select[id$="-add"]')?.id); }
    const name = act === 'models-add' ? b.closest('.dm-add').querySelector('select').value : b.dataset.name;
    const info = modelInfo(d, name);
    const quant = b.dataset.quant ?? (info.quants ? info.quants.at(-1) : 'Q4_K_M');
    const context = Number(b.dataset.context) || (info.contexts ? info.contexts[0] : 4096);
    modelsPlan.push(planEntry(d, [name, quant, context]));
    redraw(`dm-${MODEL_STATES[modelsState].device}-m${modelsPlan.length - 1}-quant`);
  });
}

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
      ['nebula-match', 'Nebula with the status icons', 'The acceptance page for the theme match (2026-11-08): Nebula’s neutral surfaces and real components beside the status icons, whose mark is the owner’s artwork, its states tinted by the same material tokens as the orb. Use the switch above for light and dark.',
        () => {
          const chips = (names) => `<div class="sg-grid">${names.map((t) => `<div class="sg-swatch"><div class="sg-chip" style="background: var(${css(t)})"></div><span class="sg-name">${t}</span><span class="sg-value">${value(css(t))}</span></div>`).join('')}</div>`;
          return `${state('Surfaces, text and lines', chips(['bg/base', 'bg/raised', 'bg/overlay', 'surface/card', 'surface/card-hover', 'border/subtle', 'border/strong', 'text/primary', 'text/secondary', 'text/faint']))}
${state('The material: the orb, the status icons and state accents only', chips(['orb/core', 'accent/secondary', 'orb/listening', 'orb/attention', 'status/error']))}
${state('The orb and the status icons, one material', `<div class="sg-demo-row">${orb({ state: 'idle', size: 'rail' })}<span class="si-tile" data-si-cell="idle-48"></span></div>`)}
<div class="sg-cards">${state('A card', briefCard({ brief: { headline: 'One thing matters today: the contract, due Thursday.', lines: ['Two tasks are waiting on other people.', 'The backup ran at 3:00 AM and was checked.'] } }))}${state('Stopped (red)', healthCard({ health: { ok: true, checks: {} }, problems: [{ id: 2, source: 'ledger', stops: true }] }))}${state('Rows', `<div class="panel"><ul class="task-list">${workTasks.slice(0, 3).map((x) => taskRow(x, { now: t0 })).join('')}</ul></div>`)}</div>
${state('Status and actions', `<div class="sg-demo-row">${['quiet', 'working', 'waiting', 'needs-you', 'failed'].map((x) => status(x)).join('')}</div><div class="sg-demo-row"><button class="btn primary">Approve</button><button class="btn">Not now</button><a class="link" href="#sg-nebula-match">All tasks</a></div>`)}
${state('Every state at 16, 24 and 48 px', statusIconSheet())}`;
        }],
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
      ['status-icon', 'Status icon', 'Nova’s one mark, the owner’s artwork, never redrawn: each state is a treatment of it (palette, brightness and motion), changing over 800 ms. Success is a one-second sweep that settles to idle. Red only for stopped, amber only for needs-you. Rail, header and task rows only, never per message.',
        statusIconEntry],
      ['status', 'Status','One vocabulary everywhere, each with a fixed colour. Verified always opens its evidence.',
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
      ['work-costs', 'Work costs', 'Month-to-date usage and six limits for Nova runner work on this machine.', () => healthEntry('work-costs')],
      ['diagnostics', 'Diagnostics', 'A native download, its privacy limits, and an unavailable state.', () => healthEntry('diagnostics')],
      ['memory-card', 'MemoryHighlightCard', 'One thing Nova kept, or that nothing is kept yet.',
        () => `<div class="sg-cards">${state('Kept', memoryHighlightCard({ records: [{ active: true, user_state: 'active', kind: 'preference', content: 'Prefers short answers before nine.', created_at: at(-2) }] }))}${state('Nothing yet', memoryHighlightCard())}</div>`],
      ['config-doors', 'Configuration: three doors (proposed)', 'A file, the form or a chat with Nova: one layered store, the same diff before anything applies, a layer on every setting. Demo only.', () => configEntry()],
      ['about-nova', 'About Nova, What’s new, Where Nova stands and the version stamp', 'The running build said honestly: up to date, redeploy pending, or not known, with when it was built (or started). A changelog entry in plain words, the version running marked. A pipeline row: name, state, and the record behind the state one tap away. The stamp at the foot of the rail (and of a phone’s navigation drawer), a link to About.', aboutEntry],
      ['models-screen', 'Models on a device (proposed)', 'A device’s memory budget as one labelled bar, each planned model with its quant, context and verdict, whether several stay loaded together, and picks per task with privacy first; proposed: waking a sleeping device, and its sleep policy. Real fit-engine numbers; demo only.', () => modelsEntry()],
      ['passkey-approval', 'Passkey confirmation', 'Tier 3 on Nova’s own screen, confirmed with a passkey so a program on this computer can’t approve itself. Tiers 0–2 are unchanged. Demo only: no passkey is requested.', () => passkeyEntry()],
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
      ['composer', 'Composer', 'A control, so it keeps the control radius at every height (UX review F0). Two rows: the field, then a bar with the privacy chip, the microphone and Send or Stop. It grows to about a quarter of the screen, then scrolls inside.',
        () => `${state('Empty, voice off in local-only', `<div class="dock"><form class="composer composer-rows" data-sg-inert><textarea rows="1" placeholder="Ask Nova anything…" aria-label="Sample composer"></textarea><div class="composer-bar"><a class="privacy-chip" href="/settings#privacy" aria-label="Privacy: Local only. Change in Settings">Local only</a><button type="button" class="mic" aria-label="Talk to Nova" disabled>${ICONS.mic}</button><button class="send" aria-label="Send">${icons.send}</button></div></form><p class="voice-note">${voiceState({ privacy: 'local-only' }).reason}</p></div>`)}
${state('Grown: a long message', `<div class="dock"><form class="composer composer-rows is-grown" data-sg-inert><textarea rows="5" aria-label="Sample long message">Draft a reply to the landlord:\n- the boiler service is booked for the 14th\n- I'll be home from 9 to 12\n- the hallway light still flickers\nKeep it short and friendly.</textarea><div class="composer-bar"><a class="privacy-chip" href="/settings#privacy" aria-label="Privacy: Local only. Change in Settings">Local only</a><button type="button" class="mic" aria-label="Talk to Nova" disabled>${ICONS.mic}</button><button class="send" aria-label="Send">${icons.send}</button></div></form></div>`)}
${state('While Nova replies: Stop', `<div class="dock"><form class="composer composer-rows" data-sg-inert><textarea rows="1" placeholder="Ask Nova anything…" aria-label="Sample composer while replying"></textarea><div class="composer-bar"><a class="privacy-chip" href="/settings#privacy" aria-label="Privacy: Local only. Change in Settings">Local only</a><button type="button" class="mic" aria-label="Talk to Nova" disabled>${ICONS.mic}</button><button class="send is-stop" aria-label="Stop">${icons.stop}</button></div></form></div>`)}`],
      ['notices', 'Toast, ProactiveBanner and banner', 'A toast says what just happened, with Undo where it can; a proactive message is one line and one action; the banner says what holds for the whole app.',
        () => `${state('Toasts', '<div class="sg-frame sg-toasts"><div class="toast">Forgotten.<button type="button" class="toast-btn">Undo</button></div><div class="toast" data-tone="alert">The heartbeat couldn’t check the schedules.<button type="button" class="toast-btn">See Health</button></div><div class="toast" data-tone="attention">Saved on this device. Syncing when the hub is back.</div></div>')}${state('Proactive messages', `${proactiveBanner({ id: 'm1', text: 'The weekly review is ready when you are.' })}${proactiveBanner({ id: 'm2', text: 'I held this one because I wasn’t sure it should go out now.', hold: 'needs_ok' })}`)}${state('Banner', '<div class="banner">You’re offline. What you see was saved earlier; nothing new can arrive or be sent until you’re back.</div>')}`],
      ['backups-settings', 'Backups settings', 'Folder settings, retention and the encrypted-copy recovery key, including first setup and console-only repeated reveal.',
        () => backupsEntry()],
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
    ['UI rebuild (compositions for the owner’s reaction)', [
      ['ui-shell-chat', 'Shell and chat (proposed)', 'Linear’s structure for the shell, Claude.ai’s chat, Arc’s spaces at the foot of the rail, Raycast’s palette. The orb is the one standout. Static compositions: nothing is sent.', () => ucEntry(['shell-chat'], (l, h) => state(l, h))],
      ['ui-settings', 'Settings (proposed)', 'Raycast’s clarity: search first, a category list and a detail pane, no decoration. Top level, and Privacy with a search active.', () => ucEntry(['settings'], (l, h) => state(l, h))],
      ['ui-about', 'About, changelog and pipeline (proposed)', 'The running build said honestly, what changed in plain words, and where Nova stands, each item with its evidence. The dashboard’s data is sample data.', () => ucEntry(['about', 'changelog', 'pipeline'], (l, h) => state(l, h))],
      ['ui-orb', 'Nebula orb and theme (proposed)', 'The swirl from the owner’s icon, drawn at any size from the palette tokens; seven states by motion and light, still and distinct under reduced motion. Use the switch above for Nebula light and dark.', () => ucEntry(['orb'], (l, h) => state(l, h))],
      ['automations-editor', 'Automations rule editor (for the owner’s reaction)', 'Design first, nothing wired: the list, create, edit and turning off, Run now and what it led to, and the webhook token shown once. Drawn from the real rule model (src/core/triggers.ts): schedules, webhooks and connection events; a task or a message; no conditions. Rotating a token and its hint need the backend: today Nova keeps only the token’s hash and has no rotate route.', () => auEntry((l, h) => state(l, h))],
      ['receipts', 'Receipts: what Nova sent out, to whom and why (for the owner’s reaction)', 'Design first, nothing wired, every receipt made up: the list by day with filters, one receipt with every field Nova keeps, the empty and Local-only states, and what receipts cover. Drawn from the real model (src/core/receipts.ts, GET /api/v1/receipts): references and hashes, never the text; no size, tokens or cost. Receipts cover model calls and tasks handed to workers, not every way Nova reaches out. The route filters only local or remote, task and conversation, so the destination and privacy-setting filters would work over what was fetched.', () => rcEntry((l, h) => state(l, h))],
      ['inbox', 'Messages and quiet hours (for the owner’s reaction)', 'Design first, nothing wired: what Nova tells you on its own, unread and read, each with where it came from; one opened; what quiet hours hold and what happens when they end; and editing them. Drawn from the real model (src/core/triggers.ts): a message traces to a trigger, from an automation or one of Nova’s own parts; read and Let it through are the only actions; held messages go out one by one after quiet hours end, with no digest. A held message no automation sent is withdrawn today, not sent: flagged for the owner.', () => ibEntry((l, h) => state(l, h))],
      ['computer-door', 'Nova’s computer: the door (for the owner’s reaction)', 'Design first, nothing wired: where you meet Nova’s computer and what is inside. Proposed as a category in Settings › What Nova works with, not a new place in the rail (a question for the owner). Drawn from the real model (src/core/computer/, GET /api/v1/computer): Docker on this machine, a workspace per project with one folder, no network unless declared, each command a task with a checkpoint before any change. There is no terminal, screen or file browser, and no on or off: Nova checks Docker and its image, and a workspace is ready, broken or being made. Chat can’t use it yet. Failures are the backend’s own words.', () => ncEntry((l, h) => state(l, h))],
      ['infra-forms', 'Infrastructure projects and network targets (for the owner’s reaction)', 'Design first, nothing wired, every project, target and host made up, no secret value drawn: both lists and their empty state, adding a project and a target with in-place validation in the core’s words, the credential step (the value goes into Nova’s vault and isn’t shown again), a failed first use, and editing. Drawn from the real model (src/core/infra, src/core/network; /api/v1/infra and /network): a project changes only its budget and price sheet, a target only its token. The backend has no remove, rename or readdress route and no connection test on save (the first plan, or a change’s snapshot, is the first use); adding, editing and saving a secret need no passkey; only applies are tier 3, confirmed in Tasks. Those gaps are flagged, not drawn as working.', () => ifEntry((l, h) => state(l, h))],
      ['memory-surface', 'Memory: search, confirm, correct and export (for the owner’s reaction)', 'Design first, nothing wired, every memory made up: the list by kind, search with results and with none, one memory and where it came from, what Nova kept on its own to confirm, what waits for your OK with the memory gate off (the default) and on, correcting (the old wording is kept, marked corrected), exporting to plain files, and the failures in the backend’s words. Drawn from the real model (src/core/memory.ts, /api/v1/memory; the Memory view’s /api/memory): search matches whole words, not meaning; Nova reads a memory whether or not it is confirmed; export writes memory.json and memory.md on the computer Nova runs on, with no download. The gate has no switch in Settings. Those gaps are flagged, not drawn as working.', () => mmEntry((l, h) => state(l, h))],
      ['vault', 'The vault: secret names, deleting one, starting over (for the owner’s reaction)', 'Design first, nothing wired, every secret made up and no value ever drawn: the names grouped by the part of Nova that uses each, a provider’s secret with replacing and deleting it (what stops, said first), a connection’s secret removed where it is used, one of Nova’s own keys, starting a new vault (tier 3) with a passkey, with none added, and from a paired phone, and a vault that can’t open (the backend’s words). Drawn from the real model (src/core/vault.ts; GET, PUT and DELETE /api/v1/vault/{name}, POST /vault/reset): the vault deletes only providers’ secrets; delete asks no confirm or passkey; a reset sets the old file aside and leaves its key where it was; a paired phone resets with the box alone; no route says which part of Nova uses a secret. Those gaps are flagged, not drawn as working.', () => vtEntry((l, h) => state(l, h))],
      ['jarvis', 'Jarvis rings (proposed)', 'Compositions for the owner’s reaction, not a shipped theme: a HUD instrument of concentric segmented rings, arc sweeps and fine ticks in one cyan family on near-black, for the same ten states as the status icon. Told apart by structure and motion, also in greyscale and under reduced motion. Red only for stopped, amber only for needs-you.', jarvisEntry],
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
  // Appearance can arrive after someone has started editing. Keep Health's local form and
  // disclosure state through that catalogue redraw; never replace an unsaved edit with a fixture.
  const healthSpecimens = [...sg.querySelectorAll('[data-health-specimen], [data-diagnostics-notice]')];
  const healthFocus = document.activeElement?.closest('[data-health-specimen]') ? document.activeElement : null;
  const groups = entries();
  const all = groups.flatMap(([, list]) => list);
  const shown = only ? all.filter(([id]) => id === only) : null;
  if (frame) {
    document.body.classList.add('sg-full');
    sg.innerHTML = draw(() => ucFrame(frame[0], frame[1]));
    return;
  }
  if (automationsFrame) {
    document.body.classList.add('sg-full');
    sg.innerHTML = draw(() => auFrame(automationsFrame));
    bindAutomations(sg);
    return;
  }
  if (receiptsFrame) {
    document.body.classList.add('sg-full');
    sg.innerHTML = draw(() => rcFrame(receiptsFrame));
    bindReceipts(sg);
    return;
  }
  if (inboxFrame) {
    document.body.classList.add('sg-full');
    sg.innerHTML = draw(() => ibFrame(inboxFrame));
    bindInbox(sg);
    return;
  }
  if (computerFrame) {
    document.body.classList.add('sg-full');
    sg.innerHTML = draw(() => ncFrame(computerFrame));
    bindComputer(sg);
    return;
  }
  if (infraFrame) {
    document.body.classList.add('sg-full');
    sg.innerHTML = draw(() => ifFrame(infraFrame));
    bindInfraForms(sg);
    return;
  }
  if (memoryFrame) {
    document.body.classList.add('sg-full');
    sg.innerHTML = draw(() => mmFrame(memoryFrame));
    bindMemory(sg);
    return;
  }
  if (vaultFrame) {
    document.body.classList.add('sg-full');
    sg.innerHTML = draw(() => vtFrame(vaultFrame));
    bindVault(sg);
    return;
  }
  const one = ([id, name, about, body]) => `<article class="sg-entry" id="sg-${id}" aria-labelledby="sg-${id}-name"><header class="sg-entry-head"><h3 class="sg-entry-name" id="sg-${id}-name">${name}</h3><a class="sg-alone" href="?entry=${id}">Open alone</a></header><p class="sg-about">${about}</p>${draw(body)}</article>`;
  if (shown) {
    sg.innerHTML = shown.length ? `<p class="sg-back"><a class="link" href="/styleguide#sg-${only}">The whole styleguide</a></p>${shown.map(one).join('')}` : `<p class="sg-about">No entry is called “${only.replace(/[<>&"]/g, '')}”. <a class="link" href="/styleguide">The whole styleguide</a></p>`;
  } else {
    const index = `<nav class="sg-index" aria-label="Entries">${groups.map(([g, list]) => `<div><p class="sg-label">${g}</p><ul>${list.map(([id, name]) => `<li><a href="#sg-${id}">${name}</a></li>`).join('')}</ul></div>`).join('')}</nav>`;
    sg.innerHTML = index + groups.map(([g, list]) => `<section class="sg-section" aria-label="${g}"><h2>${g}</h2>${list.map(one).join('')}</section>`).join('');
  }
  for (const previous of healthSpecimens) {
    const selector = previous.hasAttribute('data-health-specimen') ? `[data-health-specimen="${previous.dataset.healthSpecimen}"]` : '[data-diagnostics-notice]';
    sg.querySelector(selector)?.replaceWith(previous);
  }
  if (healthFocus?.isConnected) healthFocus.focus({ preventScroll: true });
  bindTopology();
  bindBackups();
  bindConfig();
  bindPasskey();
  bindModels();
  bindHealthSpecimens();
  bindStatusIcons(sg);
  bindJarvis(sg);
  bindAutomations(sg);
  bindReceipts(sg);
  bindInbox(sg);
  bindComputer(sg);
  bindInfraForms(sg);
  bindMemory(sg);
  bindVault(sg);
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

// ?ds=<design system>&mode=<light|dark> previews one design system on this page, as the switch does.
let shown = params.get('ds');
let shownMode = MODES.includes(params.get('mode')) ? params.get('mode') : 'auto';
async function preview() {
  const res = await fetch(previewCss(shown, shownMode), { cache: 'no-store' });
  if (!res.ok) return;
  installCss(await res.text());
  document.documentElement.dataset.sgPreview = `${shown}-${shownMode}`;
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
  // The catalogue is drawn again for the appearance that arrived; once that redraw is done the page
  // says which appearance it shows, so nothing that reads the page races the redraw.
  requestAnimationFrame(() => { render(); document.documentElement.dataset.sgAppearance = `${cur.theme}-${cur.mode}`; });
});

// Specimen forms send nothing (the page's Content-Security-Policy allows no inline onsubmit).
document.addEventListener('submit', (e) => { if (e.target.closest?.('[data-sg-inert]')) e.preventDefault(); });

apply();
render();
if (shown) preview();
