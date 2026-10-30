// Renders the style reference from the live tokens and the app's own views.
// The schema comes from the core, never from a copy (src/core/design.ts).
const schema = await fetch('/api/v1/design-systems/schema').then((r) => r.json());
const tokensOf = (test) => schema.tokens.filter(test).map((t) => t.css);
import { MODES, apply, current, previewCss } from './theme.js';
import { icons, memoryIndex, renderActivity, renderEmpty, renderHandoff, renderMemory, renderSchedules, renderSkills, renderToc, renderToday, renderTurn, renderWorkNote } from './view.js';
import { ICONS, addDeviceSheet, approvalSheet, briefCard, chatBubble, deviceMeshCard, joinRequestSheet, emptyState, evidenceViewer, handlingCard, healthCard, lookingIntoItCard, memoryHighlightCard, orb, proactiveBanner, settingsRow, status, taskRow, triggerRow, verifiedResultCard, voiceState } from './components.js';
import { ORB_STATES } from './status.js';

const sg = document.getElementById('sg');
const value = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const sample = `Here's the plan for **Friday**, with one decision left for you.

- Ship the endpoint migration (*two hours*)
- Pay the card: \`$41\` minimum
- Pick up the inhaler refill

\`\`\`bash
terraform plan -out=tfplan
\`\`\`

| Item | When |
| --- | --- |
| Migration | Friday |
| Card | Today |

> Quoted context reads quieter than Nova's own words.

More detail is in the [provider docs](https://registry.terraform.io).`;

const t0 = new Date();
const turnDone = {
  id: 'a', text: 'What does Friday look like?', ts: t0.toISOString(), attempt: 0, state: 'done',
  items: [
    { kind: 'recall', notes: [{ source: 'memory/2026-10-20.md', text: 'Flying Tools is the only client work this week.' }] },
    { kind: 'text', id: 't1', text: sample },
  ],
};
const skillSample = {
  installed: [{ id: 'email-summary', name: 'Email summary', about: 'Tells you what in your inbox needs you, without opening Gmail.', needs: ['gmail'], try: 'What in my inbox needs me today?', body: '## Choose the window\n\n- With no window given, cover the inbox since yesterday.' }],
  available: [{ id: 'shopping', name: 'Shopping research', about: 'Finds and compares things to buy, and recommends one. It never buys anything.', needs: [], body: '## Search\n\n- Search results are leads.' }],
  connectors: { gmail: { client: true, connected: true, account: 'you@example.com', since: '2026-10-21T09:00:00Z' } },
};
const usedSkill = {
  id: 'sg3', text: 'What in my inbox needs me today?', ts: Date.now(), attempt: 0, state: 'done',
  items: [
    { kind: 'skill', id: 'email-summary', name: 'Email summary', how: 'matched' },
    { kind: 'tool', id: 'g1', name: 'gmail_search', args: { query: 'in:inbox newer_than:1d' }, result: { ok: true, output: '5 messages in 5 conversations, newest first.', summary: '5 messages' } },
    { kind: 'tool', id: 'g2', name: 'gmail_read', args: { id: '19a0c1d2e3f4a501' }, result: { ok: true, output: 'From: Dana Whitfield', summary: 'Contract for the spring project' } },
    { kind: 'text', id: 'g3', text: 'One thing needs you: **Dana Whitfield** needs the contract signed by Thursday.' },
  ],
};

const memorySample = {
  titles: { '2026-10-21-aaaaaa': 'Morning plan' },
  sections: [
    { title: 'Facts', entries: [{ id: 'm00000001', text: 'Daughter June starts kindergarten at Maple Street in September.', from: '2026-10-21-aaaaaa/a', at: t0.toISOString(), by: 'nova' }] },
    { title: 'Preferences', entries: [{ id: 'm00000002', text: 'Takes coffee with oat milk.', from: '2026-10-21-aaaaaa/a', at: t0.toISOString(), updated: t0.toISOString(), by: 'nova' }, { id: 'h00000003', text: 'Short replies before 9am.', by: 'hand' }] },
    { title: 'Decisions', entries: [] },
    { title: 'Commitments', entries: [{ id: 'm00000004', text: 'Nova drafts the migration PR description on Thursday.', at: t0.toISOString(), updated: t0.toISOString(), by: 'you' }] },
  ],
  days: [{ day: t0.toISOString().slice(0, 10), entries: [{ id: 'n00000005', time: '08:12', text: 'Comparing flights to Lisbon for March.', from: '2026-10-21-aaaaaa/a', by: 'nova' }] }],
};
const kept = {
  id: 'k', text: 'I take my coffee with oat milk now.', ts: t0.toISOString(), attempt: 0, state: 'done',
  items: [{ kind: 'text', id: 'k1', text: "Got it, oat milk from now on." }, { kind: 'memory', ops: [{ op: 'remember', ok: true, id: 'm00000002', replaced: true }, { op: 'note', ok: true, id: 'n00000005' }] }],
};
const tools = {
  id: 'b', text: 'Check the repo before standup.', ts: t0.toISOString(), attempt: 0, state: 'done',
  items: [
    { kind: 'tool', id: 'x1', name: 'read_file', args: { path: 'USER.md' }, result: { ok: true, output: '# USER.md\n…' } },
    { kind: 'tool', id: 'x2', name: 'exec', args: { command: 'git status --short' }, needsApproval: true, approval: { decision: 'allow', ts: t0.toISOString() }, result: { ok: true, output: '## main...origin/main\n[exit 0]' } },
    { kind: 'tool', id: 'x3', name: 'exec', args: { command: 'rm -rf build/' }, needsApproval: true, approval: { decision: 'deny', ts: t0.toISOString() }, result: null },
    { kind: 'tool', id: 'x4', name: 'web_fetch', args: { url: 'https://status.aws.amazon.com' }, result: { ok: false, output: 'HTTP 503' } },
    { kind: 'text', id: 't2', text: "The tree is clean. I left `build/` alone, as you asked." },
  ],
};
const waiting = {
  id: 'c', text: 'Run the tests.', ts: t0.toISOString(), attempt: 0, state: 'open',
  items: [
    { kind: 'text', id: 't3', text: "I'll run the suite so we know where things stand." },
    { kind: 'tool', id: 'x5', name: 'exec', args: { command: 'npm test' }, needsApproval: true, approval: null, result: null },
  ],
};
const failed = {
  id: 'd', text: 'Summarize my inbox.', ts: t0.toISOString(), attempt: 0, state: 'error',
  items: [{ kind: 'error', message: 'The model ran into a problem and stopped.', detail: 'connection refused' }],
};
const streaming = { id: 'e', text: 'And the weekend?', ts: t0.toISOString(), attempt: 0, state: 'open', items: [] };

const section = (title, intro, body) => `<section class="sg-section"><h2>${title}</h2><p>${intro}</p>${body}</section>`;
const tokenList = (names) => names.map((n) => `<code>${n}</code>`).join(' ');
const label = (text) => `<p class="sg-label">${text}</p>`;

// Sample work for the PWA's components.
const at = (h) => new Date(t0.getTime() + h * 3600_000).toISOString();
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

function render() {
  const colors = tokensOf((t) => t.group === 'color').map((n) => `<div class="sg-swatch"><div class="sg-chip" style="background: var(${n})"></div><span class="sg-name">${n}</span><span class="sg-value">${value(n)}</span></div>`).join('');
  const sizes = tokensOf((t) => t.syntax === 'size').map((n) => `<div class="sg-row"><span class="sg-name">${n} · ${value(n)}</span><span style="font-size: var(${n}); line-height: var(--type-line-tight); font-family: var(--font-display)">A calm companion that acts</span></div>`).join('');
  const space = tokensOf((t) => t.name.startsWith('space/')).map((n) => `<div class="sg-row"><span class="sg-name">${n} · ${value(n)}</span><div class="sg-bar" style="width: var(${n})"></div></div>`).join('');
  const shape = tokensOf((t) => t.name.startsWith('radius/')).map((n) => `<div class="sg-swatch"><div class="sg-box" style="border-radius: var(${n})">${value(n)}</div><span class="sg-name">${n}</span></div>`).join('') +
    tokensOf((t) => t.name.startsWith('shadow/')).map((n) => `<div class="sg-swatch"><div class="sg-box" style="border-radius: var(--radius-card); box-shadow: var(${n})">elevation</div><span class="sg-name">${n}</span></div>`).join('');
  const motion = tokensOf((t) => t.syntax === 'duration').map((n) => `<div class="sg-row"><span class="sg-name">${n} · ${value(n)}</span><div class="sg-track"><span class="sg-dot" style="transition: left var(${n}) var(--motion-ease)"></span></div></div>`).join('');

  const sched = (id, name, when, more = {}) => ({ id, name, when, cron: '0 7 * * *', deliver: 'main', prompt: 'Write the morning digest.', next: at(20), last: null, ...more });
  const scheduleSample = {
    set: [
      sched('morning-digest', 'Morning digest', 'Every day at 7:00 AM', { last: { ok: true, finished: at(-1), delivered: 'main', handoff: 'h1', summary: 'One thing matters today: the contract, due Thursday.' } }),
      sched('inbox', 'Inbox sweep', 'Every 2 hours', { running: { started: at(0) } }),
      sched('weekly', 'Weekly review', 'Fridays at 4:00 PM', { paused: true, next: null }),
      sched('plants', 'Water the plants', 'Mondays at 8:00 AM', { last: { missed: true, due: at(-26) } }),
      sched('bills', 'Bills check', 'On the 1st of every month at 9:00 AM', { last: { ok: false, finished: at(-2), delivered: 'main', handoff: 'h3', error: "Nova couldn't reach the model." } }),
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
  const orbs = ORB_STATES.map((s) => `<div class="sg-swatch">${orb({ state: s, size: 'rail' })}<span class="sg-name">${s}</span></div>`).join('');
  sg.innerHTML = [
    section('Color', `Every design system defines these ${tokensOf((t) => t.group === 'color').length} colour tokens. Components use nothing else.`, `<div class="sg-grid">${colors}</div>`),
    section('Type', `Families: ${tokenList(tokensOf((t) => t.syntax === 'font'))}. Weights and line heights: ${tokenList(tokensOf((t) => t.syntax === 'weight' || t.syntax === 'line'))}.`, sizes),
    section('Spacing', `Space tokens, plus ${tokenList(tokensOf((t) => t.group === 'layout'))} for the layout.`, space),
    section('Shape and elevation', `Rounded cards, frosted with ${tokenList(['--blur-glass'])}.`, `<div class="sg-grid">${shape}</div>`),
    section('Motion', `Slow, small, purposeful. Click to play. Under reduced motion the loops stop and transitions are near-instant. Easing: <code>${value('--motion-ease')}</code>.`, `<div id="motion">${motion}</div>`),
    section('The orb', 'Nova’s presence: abstract light, no face. One component at every size; its state comes from real signals.', `<div class="sg-grid">${orbs}</div>${label('Hero')}<div class="sg-demo-center">${orb({ state: 'idle', size: 'hero' })}</div>`),
    section('Status', 'One vocabulary everywhere, each with a fixed colour. Verified always opens its evidence.', `<div class="sg-demo-row">${['quiet', 'working', 'waiting', 'needs-you', 'failed'].map((s) => status(s)).join('')}${status('verified', { task: 'v1' })}</div>`),
    section('Cards', 'One job each: a headline, a few lines, one action.', `<div class="sg-cards">
      ${briefCard()}
      ${handlingCard({ tasks: workTasks, now: t0 })}
      ${handlingCard({ tasks: [], now: t0 })}
      ${verifiedResultCard(doneTask, { now: t0 })}
      ${lookingIntoItCard(workTasks[0])}
      ${deviceMeshCard({ devices: [{ id: 'h', name: 'Hub', kind: 'computer', role: 'hub', trust: 'trusted', online: true, this: true }, { id: 'p', name: 'Phone', kind: 'phone', role: 'client', trust: 'trusted', online: false, last_seen: new Date(Date.now() - 600_000).toISOString() }] })}
      ${healthCard({ health: { ok: true, checks: { database: { ok: true }, workers: { ok: true, workers: [{}, {}, {}] } } } })}
      ${healthCard({ health: { ok: true, checks: {} }, problems: [{ id: 1, message: 'The heartbeat couldn’t check the schedules.' }] })}
      ${memoryHighlightCard({ records: [{ active: true, user_state: 'active', kind: 'preference', content: 'Prefers short answers before nine.', created_at: at(-2) }] })}
    </div>`),
    section('Task rows', 'Every ledger state, mapped once.', `<div class="panel"><ul class="task-list">${workTasks.map((t) => taskRow(t, { now: t0 })).join('')}</ul></div>`),
    section('Sheets', 'Approvals are tiered: tier 3 needs an explicit confirmation. Evidence shows how Nova checked.', `<div class="sg-cards">
      <div class="sheet-inner panel">${approvalSheet(task('a2', 'Send the draft reply', 'waiting', { approval_tier: 2 }))}</div>
      <div class="sheet-inner panel">${approvalSheet(task('a3', 'Delete the old backups', 'waiting', { approval_tier: 3 }))}</div>
      <div class="sheet-inner panel">${joinRequestSheet({ id: 'j1', name: 'Phone', kind: 'phone', platform: 'Android', capabilities: [], fingerprint: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789', confirmation: '042917' })}</div>
      <div class="sheet-inner panel">${addDeviceSheet({ pairing_id: 'p1', code: 'ABCD-EFGH', expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), hub_url: 'https://hub.example:4320', url: 'https://hub.example:4320/pair#c=ABCD-EFGH&h=ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789', command: 'curl -fsS https://hub.example:4320/join.sh | sh -s -- ABCD-EFGH' })}</div>
      <div class="sheet-inner panel">${evidenceViewer(doneTask)}</div>
    </div>`),
    section('Automations, notices, settings', '', `<div class="sg-demo">
      ${label('Trigger rows')}<ul class="trigger-list">${triggerRow({ id: 'r1', name: 'Weekly review', class: 'heartbeat', schedule: 'Mondays at 9:00', action: { kind: 'message', text: 'Time for the weekly review.' }, paused: false })}${triggerRow({ id: 'r2', name: 'New invoice', class: 'event', hook_path: '/api/v1/hooks/invoice', action: { kind: 'task', task: { title: 'File the invoice' } }, paused: true })}</ul>
      ${label('Proactive messages')}${proactiveBanner({ id: 'm1', text: 'The weekly review is ready when you are.' })}${proactiveBanner({ id: 'm2', text: 'I held this one because I wasn’t sure it should go out now.', hold: 'needs_ok' })}
      ${label('Toasts')}<div class="sg-frame sg-toasts"><div class="toast">Forgotten.<button type="button" class="toast-btn">Undo</button></div><div class="toast" data-tone="alert">The heartbeat couldn’t check the schedules.<button type="button" class="toast-btn">See Health</button></div></div>
      ${label('Banner')}<div class="banner">You’re offline. What you see was saved earlier; nothing new can arrive or be sent until you’re back.</div>
      ${label('Settings rows')}<ul class="settings-list">${settingsRow({ title: 'Your name', note: 'What Nova calls you.', control: '<input class="input" value="Sam" aria-label="Your name"><button type="button" class="btn small">Save</button>' })}${settingsRow({ title: 'Appearance id', note: 'It lets this browser keep its own appearance.' })}</ul>
      ${label('Empty state')}${emptyState({ line: 'No tasks yet.', orbState: 'idle' })}
      ${label('Buttons')}<div class="sg-demo-row"><button class="btn primary">Approve</button><button class="btn">Not now</button><button class="btn quiet">Cancel</button><button class="btn small">Pause</button><button class="btn" disabled>Disabled</button><button class="send" aria-label="Send">${icons.send}</button><button class="send is-stop" aria-label="Stop">${icons.stop}</button></div>
    </div>`),
    section('Conversation', 'Nova speaks from beside its orb; your words sit in the accent.', `<div class="sg-demo">
      ${label('Chat bubbles')}<div class="sg-bubbles">${chatBubble({ from: 'person', text: 'What’s on today?' })}${chatBubble({ from: 'nova', text: 'Two small things. I’ll look into the second.' })}</div>
      ${label('Composer, with voice off in local-only')}<div class="dock"><form class="composer" onsubmit="return false"><textarea rows="1" placeholder="Ask Nova anything…" aria-label="Sample composer"></textarea><button type="button" class="mic" aria-label="Talk to Nova" disabled>${ICONS.mic}</button><button class="send" aria-label="Send">${icons.send}</button></form><p class="voice-note">${voiceState({ privacy: 'local-only' }).reason}</p></div>
      ${label('A reply, with a margin note from memory')}<div class="thread">${renderTurn(turnDone, { isLast: true })}</div>
      ${label('Records, including decided approvals')}<div class="thread">${renderTurn(tools)}</div>
      ${label('A tool approval waiting for you')}<div class="thread">${renderTurn(waiting, { live: { phase: 'approval', text: '' } })}</div>
      ${label('Thinking, then streaming')}<div class="thread">${renderTurn(streaming, { live: { phase: 'thinking', text: '' } })}${renderTurn(streaming, { live: { phase: 'streaming', text: 'The weekend is mostly open. Saturday morning has' } })}</div>
      ${label('Errors and interruptions')}<div class="thread">${renderTurn(failed, { isLast: true })}</div>
      ${label('What Nova kept, in the margin')}<div class="thread">${renderTurn(kept, { memory: memoryIndex(memorySample) })}</div>
      ${label('A reply that followed a skill')}<div class="thread">${renderTurn(usedSkill, { skills: new Set(['email-summary']) })}</div>
      ${label('Reports: on time, and one that didn’t finish')}<div class="thread">${renderHandoff({ id: 'h1', name: 'Morning digest', schedule: 'morning-digest', ok: true, ts: t0.toISOString(), due: t0.toISOString(), text: 'One thing matters today: the contract, due Thursday.' })}${renderHandoff({ id: 'h3', name: 'Bills check', schedule: 'bills', ok: false, ts: t0.toISOString(), text: "Bills check didn't finish. Nova couldn't reach the model." })}${renderToday(t0)}</div>
      ${label('A helper’s own log, read-only')}<div class="thread">${renderWorkNote({ kind: 'helper', title: 'Compare e-bikes', parent: 'main', delivered: { to: 'main', handoff: 'h9' } }, 'the main conversation')}</div>
      ${label('Conversations')}<div class="sg-frame"><nav class="toc">${renderToc([{ id: '2026-10-21-aaaaaa', title: 'Morning plan', created: t0.toISOString() }, { id: '2026-10-21-bbbbbb', title: 'Timecard for Monday and Tuesday', created: t0.toISOString() }], '2026-10-21-aaaaaa')}</nav></div>
      ${label('An empty conversation')}<div class="thread">${renderEmpty()}</div>
    </div>`),
    section('Era 2 views, re-homed', 'Memory, Skills, Schedules and Activity, drawn by the app’s own view code.', `<div class="sg-demo">
      ${label('Memory')}<div class="thread memory">${renderMemory(memorySample)}</div>
      ${label('Skills, with a connection')}<div class="thread memory skills">${renderSkills(skillSample)}</div>
      ${label('Schedules')}<div class="thread memory skills schedules">${renderSchedules(scheduleSample, t0)}</div>
      ${label('Activity')}<div class="thread memory activity">${renderActivity(activitySample, t0)}</div>
    </div>`),
  ].join('');
  sg.querySelector('#motion').addEventListener('click', () => sg.querySelectorAll('.sg-dot').forEach((d) => d.classList.toggle('is-moved')));
}

// The switch previews another design system on this page only; nothing is applied.
async function renderSwitch() {
  const cur = current();
  const usable = cur.list.filter((d) => d.valid && d.state !== 'disabled');
  document.getElementById('switch').innerHTML = `<label class="sg-pick">Design system <select class="input" id="sg-ds">${usable.map((d) => `<option value="${d.id}"${d.id === shown ? ' selected' : ''}>${d.name}</option>`).join('')}</select></label>
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
