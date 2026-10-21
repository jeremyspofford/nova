// Renders the style reference from the live tokens and the app's own views.
import { CONTRACT } from './contract.js';
import { THEMES, MODES, apply, choose, current } from './theme.js';
import { icons, memoryIndex, renderEmpty, renderMemory, renderNotes, renderToc, renderTurn } from './view.js';

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
