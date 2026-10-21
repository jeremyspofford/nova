// Renders the style reference from the live tokens and the app's own views.
import { CONTRACT } from './contract.js';
import { THEMES, MODES, apply, choose, current } from './theme.js';
import { icons, memoryIndex, renderActivity, renderEmpty, renderHandoff, renderMemory, renderNotes, renderSchedules, renderSkills, renderToc, renderToday, renderTurn, renderWorkNote } from './view.js';

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

function render() {
  const colors = CONTRACT.color.map((n) => `<div class="sg-swatch"><div class="sg-chip" style="background: var(${n})"></div><span class="sg-name">${n}</span><span class="sg-value">${value(n)}</span></div>`).join('');
  const type = ['--t-display', '--t-wordmark', '--t-title', '--t-body', '--t-callout', '--t-caption', '--t-margin', '--t-mono']
    .map((n) => `<div class="sg-row"><span class="sg-name">${n}</span><span style="font: var(${n})">A thoughtful journal that happens to act</span></div>`).join('');
  const space = CONTRACT.spacing.map((n) => `<div class="sg-row"><span class="sg-name">${n} · ${value(n)}</span><div class="sg-bar" style="width: var(${n})"></div></div>`).join('');
  const shape = ['--r-card', '--r-bubble', '--r-input', '--r-pill'].map((n) => `<div class="sg-swatch"><div class="sg-box" style="border-radius: var(${n})">${value(n)}</div><span class="sg-name">${n}</span></div>`).join('') +
    ['--shadow-1', '--shadow-2'].map((n) => `<div class="sg-swatch"><div class="sg-box" style="border-radius: var(--r-card); box-shadow: var(${n})">elevation</div><span class="sg-name">${n}</span></div>`).join('');
  const motion = ['--m-fast', '--m-med', '--m-slow'].map((n) => `<div class="sg-row"><span class="sg-name">${n} · ${value(n)}</span><div class="sg-track"><span class="sg-dot" style="transition: left var(${n}) var(--ease)"></span></div></div>`).join('');

  const at = (h) => new Date(t0.getTime() + h * 3600_000).toISOString();
  const sched = (id, name, when, more = {}) => ({ id, name, when, cron: '0 7 * * *', deliver: 'main', prompt: 'Write the morning digest.', next: at(20), last: null, ...more });
  const scheduleSample = {
    set: [
      sched('morning-digest', 'Morning digest', 'Every day at 7:00 AM', { last: { ok: true, finished: at(-1), delivered: 'main', handoff: 'h1', summary: 'One thing matters today: the contract, due Thursday.' } }),
      sched('inbox', 'Inbox sweep', 'Every 2 hours', { running: { started: at(0) } }),
      sched('weekly', 'Weekly review', 'Fridays at 4:00 PM', { paused: true, next: null }),
      sched('plants', 'Water the plants', 'Mondays at 8:00 AM', { last: { missed: true, due: at(-26) } }),
      sched('bills', 'Bills check', 'On the 1st of every month at 9:00 AM', { last: { ok: false, finished: at(-2), delivered: 'main', handoff: 'h3', error: "Nova couldn't reach the model." } }),
      sched('broken', 'Broken', '', { error: "Nova can't read when this runs: A schedule needs five parts.", next: null }),
    ],
    available: [{ id: 'evening', name: 'Evening wrap-up', about: 'What got done today, and what is waiting for tomorrow.', cron: '0 18 * * *', prompt: 'Wrap up the day.' }],
  };
  const tool = (name, args, more = {}) => ({ kind: 'tool', id: name, name, args, ts: at(-1), result: { ok: true }, ...more });
  const entry = (kind, title, state, more = {}) => ({ id: `${kind}-${title}`, kind, title, state, session: '2026-10-21-aaaaaa', turn: 't1', started: at(-1), ended: at(-0.99), steps: [], ...more });
  const activitySample = {
    now: [
      entry('helper', 'Read the lease', 'working', { brief: 'Read the lease in workspace/flat and list anything unusual: fees, notice periods, who fixes what.', parent: 'main', parentTitle: 'Main conversation', steps: [tool('read_file', { path: 'workspace/flat/lease.md' })] }),
      entry('reply', 'Main conversation', 'waiting', { text: 'Run git status in my workspace', session: 'main', approval: 'exec', steps: [{ kind: 'tool', id: 'exec', name: 'exec', args: { command: 'git status' }, needsApproval: true, approval: null, result: null }] }),
      entry('helper', 'Compare flights', 'queued', { parent: 'main', parentTitle: 'Main conversation', ended: null, steps: [] }),
    ],
    days: [{
      day: t0.toISOString().slice(0, 10),
      summary: { replies: 2, schedules: 1, helpers: 2, missed: 1, asked: 2, allowed: 1, declined: 1, notAsked: 1, kept: 1 },
      entries: [
        entry('helper', 'Compare e-bikes', 'done', { brief: 'Compare commuter e-bikes under $2,000 for a 9-mile ride with one hill.', parent: 'main', parentTitle: 'Main conversation', report: { to: 'main', handoff: 'h9' }, steps: [tool('web_search', { query: 'best commuter e-bikes 2026' }, { result: { ok: true, summary: '8 results' } }), tool('web_fetch', { url: 'https://ridgeline.example/c2' }), tool('web_fetch', { url: 'https://voltway.example/metro' }), tool('exec', { command: 'open lease.pdf' }, { needsApproval: true, approval: { decision: 'deny', auto: true }, result: null })] }),
        entry('schedule', 'Morning digest', 'done', { report: { to: 'main', handoff: 'h1' }, steps: [{ kind: 'skill', id: 'email-summary', name: 'Email summary' }, tool('gmail_search', {}, { result: { ok: true, summary: '5 messages' } })] }),
        entry('reply', 'Trip planning', 'done', { text: 'Draft a reply to Sam saying yes', first: true, steps: [tool('gmail_draft', {}, { needsApproval: true, approval: { decision: 'allow' }, result: { ok: true, summary: 'Re: Saturday hike' } })] }),
        entry('reply', 'Main conversation', 'done', { text: 'I take my coffee black', session: 'main', steps: [{ kind: 'memory', kept: 1, forgot: 0 }] }),
        entry('helper', 'Check the bus times', 'stopped', { parent: 'main', parentTitle: 'Main conversation', steps: [] }),
        entry('schedule', 'Water the plants', 'missed', { missed: true, session: null, ended: null, steps: [] }),
      ],
    }],
    more: true,
    before: t0.toISOString().slice(0, 10),
  };
  sg.innerHTML = [
    section('Color', `Every theme defines these ${CONTRACT.color.length} tokens. Components use nothing else.`, `<div class="sg-grid">${colors}</div>`),
    section('Type', `Serif is the voice of record in Paper: dates, empty states, and anything Nova concludes. Chrome stays sans. Font families: ${tokenList(['--font', '--font-display', '--font-mono'])}.`, type),
    section('Spacing', 'A 4-point base with an editorial rhythm.', space),
    section('Shape and elevation', 'Warm, soft, and sparing.', `<div class="sg-grid">${shape}</div>`),
    section('Motion', `Durations and the easing curve are tokens; nothing bounces. Click to play. With reduced motion, movement becomes a crossfade (${tokenList(['--shift'])} is ${value('--shift')}).`, `<div id="motion">${motion}</div><p class="sg-sub">Easing: <code>${value('--ease')}</code></p>`),
    section('Components', 'The real views, rendered with sample data.', `<div class="sg-demo">
      <p class="sg-label">Buttons</p>
      <div class="approval-actions"><button class="btn primary">Allow once</button><button class="btn">Deny</button><button class="btn" disabled>Disabled</button><button class="send" aria-label="Send">${icons.send}</button><button class="send is-stop" aria-label="Stop">${icons.stop}</button></div>
      <p class="sg-label">Sidebar</p>
      <div class="sg-frame is-bg"><nav class="toc">${renderToc([{ id: '2026-10-21-aaaaaa', title: 'Morning plan', created: t0.toISOString() }, { id: '2026-10-21-bbbbbb', title: 'Timecard for Monday and Tuesday', created: t0.toISOString() }], '2026-10-21-aaaaaa')}</nav></div>
      <p class="sg-label">A reply, with a margin note from memory</p>
      <div class="thread">${renderTurn(turnDone, { isLast: true })}</div>
      <p class="sg-label">Records, including decided approvals</p>
      <div class="thread">${renderTurn(tools)}</div>
      <p class="sg-label">An approval waiting for you</p>
      <div class="thread">${renderTurn(waiting, { live: { phase: 'approval', text: '' } })}</div>
      <p class="sg-label">Thinking, then streaming</p>
      <div class="thread">${renderTurn(streaming, { live: { phase: 'thinking', text: '' } })}</div>
      <div class="thread">${renderTurn(streaming, { live: { phase: 'streaming', text: 'The weekend is mostly open. Saturday morning has' } })}</div>
      <p class="sg-label">Errors and interruptions</p>
      <div class="thread">${renderTurn(failed, { isLast: true })}</div>
      <div class="thread">${renderTurn({ ...streaming, state: 'stopped', items: [{ kind: 'text', id: 't9', text: 'The weekend is mostly' }] })}</div>
      <p class="sg-label">Banner</p>
      <div class="banner">You're offline. Nova can still read your files, but replies need a connection.</div>
      <p class="sg-label">Composer</p>
      <form class="composer" onsubmit="return false"><textarea rows="1" placeholder="Write to Nova…" aria-label="Sample composer"></textarea><button class="send" aria-label="Send">${icons.send}</button></form>
      <p class="sg-label">What Nova kept, in the margin</p>
      <div class="thread">${renderTurn(kept, { memory: memoryIndex(memorySample) })}</div>
      <p class="sg-label">Memory</p>
      <div class="sg-frame"><div class="thread memory">${renderMemory(memorySample)}</div></div>
      <p class="sg-label">A reply that followed a skill</p>
      <div class="thread">${renderTurn(usedSkill, { skills: new Set(['email-summary']) })}</div>
      <p class="sg-label">Skills, with a connection</p>
      <div class="sg-frame"><div class="thread memory skills">${renderSkills(skillSample)}</div></div>
      <p class="sg-label">A report on the front page, one that ran late, and one that didn't finish</p>
      <div class="thread">${renderHandoff({ id: 'h1', name: 'Morning digest', schedule: 'morning-digest', ok: true, ts: t0.toISOString(), due: t0.toISOString(), text: 'One thing matters today: the contract, due Thursday.\n\n**Needs you**\n\n- **Dana Whitfield** needs the spring contract signed by Thursday.\n\nWant me to draft a note to Dana?' })}</div>
      <div class="thread">${renderHandoff({ id: 'h2', name: 'Morning digest', schedule: 'morning-digest', ok: true, late: true, ts: new Date(t0.getTime() + 5400_000).toISOString(), due: t0.toISOString(), text: 'A quiet morning: nothing is due today.' })}</div>
      <div class="thread">${renderHandoff({ id: 'h3', name: 'Bills check', schedule: 'bills', ok: false, ts: t0.toISOString(), text: "Bills check didn't finish. Nova couldn't reach the model." })}</div>
      <div class="thread">${renderToday(t0)}</div>
      <p class="sg-label">Schedules: done, running, paused, missed, failed, unreadable, and one to set up</p>
      <div class="sg-frame"><div class="thread memory skills schedules">${renderSchedules(scheduleSample, t0)}</div></div>
      <p class="sg-label">A helper's report, and one you stopped</p>
      <div class="thread">${renderHandoff({ id: 'h9', name: 'Compare e-bikes', helper: '2026-10-21-cccccc', ok: true, ts: t0.toISOString(), text: 'The **Ridgeline C2** is the one to get: $1,849, with a mid-drive motor that climbs well.\n\n| Bike | Price |\n| --- | --- |\n| Ridgeline C2 | $1,849 |\n| Voltway Metro | $1,499 |' })}</div>
      <div class="thread">${renderHandoff({ id: 'h8', name: 'Check the bus times', helper: '2026-10-21-dddddd', ok: false, stopped: true, ts: t0.toISOString(), text: 'You stopped this helper before it finished.' })}</div>
      <p class="sg-label">A helper's own log, read-only</p>
      <div class="thread">${renderWorkNote({ kind: 'helper', title: 'Compare e-bikes', parent: 'main', delivered: { to: 'main', handoff: 'h9' } }, 'the main conversation')}</div>
      <p class="sg-label">Activity: working, waiting for you, waiting its turn; then a day of done, declined, stopped and missed</p>
      <div class="sg-frame"><div class="thread memory activity">${renderActivity(activitySample, t0)}</div></div>
      <p class="sg-label">Activity, empty</p>
      <div class="sg-frame"><div class="thread memory activity">${renderActivity({ now: [], days: [], more: false }, t0)}</div></div>
      <p class="sg-label">Toast</p>
      <div class="sg-frame" style="position: relative; min-height: 80px"><div class="toast">Forgotten, with 1 day note that said the same.<button type="button" class="toast-btn">Undo</button></div></div>
      <p class="sg-label">Empty state</p>
      <div class="sg-frame"><div class="thread">${renderEmpty()}</div></div>
    </div>`),
  ].join('');
  sg.querySelector('#motion').addEventListener('click', () => sg.querySelectorAll('.sg-dot').forEach((d) => d.classList.toggle('is-moved')));
}

function renderSwitch() {
  const cur = current();
  document.getElementById('switch').innerHTML =
    `<div class="choices" role="radiogroup" aria-label="Theme">${THEMES.map((t) => `<label class="choice"><input type="radio" name="theme" value="${t.id}"${t.id === cur.theme ? ' checked' : ''}><span class="choice-name">${t.name}</span></label>`).join('')}</div>` +
    `<div class="choices" role="radiogroup" aria-label="Mode">${MODES.map((m) => `<label class="choice"><input type="radio" name="mode" value="${m}"${m === cur.mode ? ' checked' : ''}><span class="choice-name">${m[0].toUpperCase()}${m.slice(1)}</span></label>`).join('')}</div>`;
}

document.getElementById('switch').addEventListener('change', (e) => {
  choose({ [e.target.name]: e.target.value });
  requestAnimationFrame(render);
});

apply();
renderSwitch();
render();
