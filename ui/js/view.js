// Pure view builders: state in, HTML out. Used by the app and by the living
// style reference, so the reference always shows the real components.
import { escapeHtml as esc, renderMarkdown } from './markdown.js';

export const icons = {
  send: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15.5V4.5M5 9.5l5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stop: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  menu: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6.5h12M4 10h12M4 13.5h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  again: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 4.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ---- dates ---------------------------------------------------------------

const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth',
  'nineteenth', 'twentieth', 'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth',
  'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first'];

const parts = (d) => ({
  weekday: d.toLocaleDateString('en-US', { weekday: 'long' }),
  month: d.toLocaleDateString('en-US', { month: 'long' }),
  day: d.getDate(),
  year: d.getFullYear(),
});

// "Wednesday, the twenty-first of October": the date as a chapter heading.
export function longDate(d, now = new Date()) {
  const p = parts(d);
  return `${p.weekday}, the ${ORD[p.day]} of ${p.month}${p.year !== now.getFullYear() ? `, ${p.year}` : ''}`;
}

export const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function shortDay(d, now = new Date()) {
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return 'Today';
  if (dayKey(d) === dayKey(y)) return 'Yesterday';
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

export const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// ---- sidebar -------------------------------------------------------------

export function renderToc(list, currentId, now = new Date()) {
  if (!list.length) return '<p class="toc-empty">Your conversations will gather here, a chapter for each day.</p>';
  let out = '';
  let day = null;
  for (const s of list) {
    const d = new Date(s.created ?? s.updated);
    const k = dayKey(d);
    if (k !== day) {
      if (day !== null) out += '</ul></section>';
      day = k;
      out += `<section class="toc-day"><h2 class="toc-label">${esc(shortDay(d, now))}</h2><ul>`;
    }
    const cur = s.id === currentId ? ' aria-current="page"' : '';
    out += `<li><a class="toc-item" href="/c/${esc(s.id)}" data-id="${esc(s.id)}"${cur}>${esc(s.title)}</a></li>`;
  }
  return `${out}</ul></section>`;
}

// ---- conversation --------------------------------------------------------

export function renderEmpty(now = new Date()) {
  return `<div class="empty"><p class="empty-date">${esc(longDate(now, now))}</p><p class="empty-line">Nothing needs you yet.</p></div>`;
}

const host = (url) => { try { return new URL(url).host; } catch { return url; } };

export function toolLabel(tool, state) {
  const a = tool.args ?? {};
  const sum = tool.result?.summary ?? '';
  const code = (s) => `<code>${esc(s)}</code>`;
  const cmd = String(a.command ?? '').split('\n')[0];
  const labels = {
    read_file: { running: `Reading ${code(a.path)}`, done: `Read ${code(a.path)}`, failed: `Couldn't read ${code(a.path)}` },
    write_file: { running: `Saving ${code(a.path)}`, done: `Saved ${code(a.path)}`, failed: `Couldn't save ${code(a.path)}` },
    web_fetch: { running: `Reading ${esc(host(a.url))}`, done: `Read ${esc(host(a.url))}`, failed: `Couldn't reach ${esc(host(a.url))}` },
    exec: { running: `Running ${code(cmd)}`, done: `Ran ${code(cmd)}`, failed: `${code(cmd)} didn't finish`, declined: `Didn't run ${code(cmd)}`, waiting: `Waiting to run ${code(cmd)}` },
    web_search: { running: `Searching the web for “${esc(a.query)}”`, done: `Searched the web for “${esc(a.query)}”`, failed: "Couldn't search the web", declined: `Didn't search for “${esc(a.query)}”` },
    gmail_search: { running: 'Searching your Gmail', done: `Searched your Gmail${sum ? `: ${esc(sum)}` : ''}`, failed: "Couldn't search your Gmail" },
    gmail_read: { running: 'Reading an email', done: sum ? `Read “${esc(sum)}”` : 'Read an email', failed: "Couldn't read that email" },
    use_skill: { running: 'Opening a skill', done: `Opened ${esc(sum || a.name)}`, failed: `Couldn't open the skill ${esc(a.name)}` },
  };
  labels.web_fetch.declined = `Didn't open ${esc(host(a.url))}`;
  const l = labels[tool.name] ?? { running: `Using ${esc(tool.name)}`, done: `Used ${esc(tool.name)}`, failed: `${esc(tool.name)} didn't work` };
  return l[state] ?? l.failed;
}

export function toolState(tool, turnOpen) {
  if (tool.approval?.decision === 'deny') return 'declined';
  if (tool.result) return tool.result.ok ? 'done' : 'failed';
  if (!turnOpen) return tool.needsApproval && !tool.approval ? 'skipped' : 'failed';
  if (tool.needsApproval && !tool.approval) return 'waiting';
  return 'running';
}

// Why Nova is asking, in one sentence. Web tools ask only after mail has
// been read in the conversation.
const ONLINE = 'It has read your email in this conversation, so it checks with you before anything goes online.';
function approvalBody(tool) {
  const a = tool.args ?? {};
  if (tool.name === 'web_fetch') return `Nova wants to open <code>${esc(host(a.url))}</code>. ${ONLINE}`;
  if (tool.name === 'web_search') return `Nova wants to search the web for “${esc(a.query)}”. ${ONLINE}`;
  const cmd = String(a.command ?? '');
  return `Nova wants to run ${cmd.includes('\n') || cmd.length > 72 ? 'this command' : `<code>${esc(cmd)}</code>`} in your workspace.`;
}

function renderApproval(tool) {
  const cmd = String(tool.args?.command ?? '');
  const multi = tool.name === 'exec' && (cmd.includes('\n') || cmd.length > 72);
  const url = tool.name === 'web_fetch' ? String(tool.args?.url ?? '') : '';
  return `<div class="approval" role="group" aria-labelledby="ap-${esc(tool.id)}" data-tool="${esc(tool.id)}">
  <p class="approval-title" id="ap-${esc(tool.id)}">A small decision, when you're ready</p>
  <p class="approval-body">${approvalBody(tool)}</p>
  ${multi ? `<pre class="approval-cmd">${esc(cmd)}</pre>` : ''}${url ? `<pre class="approval-cmd">${esc(url)}</pre>` : ''}
  <div class="approval-actions">
    <button type="button" class="btn primary" data-action="allow" data-tool="${esc(tool.id)}">Allow once</button>
    <button type="button" class="btn" data-action="deny" data-tool="${esc(tool.id)}">Deny</button>
    <span class="keys" aria-hidden="true"><kbd>Enter</kbd> allow · <kbd>Esc</kbd> deny</span>
  </div>
</div>`;
}

function renderTool(tool, turnOpen) {
  const state = toolState(tool, turnOpen);
  if (state === 'waiting') return renderApproval(tool);
  const stamp = tool.approval
    ? `<span class="stamp${tool.approval.decision === 'deny' ? ' is-declined' : ''}">${tool.approval.decision === 'deny' ? 'Declined' : 'Allowed'}</span>`
    : '';
  const when = tool.approval?.ts ? `<span class="record-time">${esc(clock(new Date(tool.approval.ts)))}</span>` : '';
  const label = state === 'skipped' ? `Never ran ${tool.name === 'exec' ? `<code>${esc(String(tool.args?.command ?? '').split('\n')[0])}</code>` : 'that step'}` : toolLabel(tool, state);
  const cls = `record is-${state}" data-tool="${esc(tool.id)}`;
  const output = tool.result?.output;
  if (state === 'running') return `<div class="${cls}" role="status"><span class="pulse" aria-hidden="true"></span>${label}…</div>`;
  if (!output) return `<div class="${cls}">${stamp}<span class="record-label">${label}</span>${when}</div>`;
  return `<details class="${cls}"><summary>${stamp}<span class="record-label">${label}</span>${when}</summary><pre class="record-output" tabindex="0">${esc(output)}</pre></details>`;
}

const fromDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return shortDay(new Date(y, m - 1, d)).replace(/^(Today|Yesterday)$/, (w) => w.toLowerCase());
};
const clip = (t, n = 90) => (t.length > n ? `${t.slice(0, n - 2).replace(/\s+\S*$/, '')}…` : t);

// What Nova recalled for this message. Notes are looked up by id in today's
// memory, so a note forgotten since then is not shown again.
export function renderNotes(notes, memory = new Map()) {
  return notes.map((n) => {
    const text = n.id ? memory.get(n.id)?.text : n.text;
    if (!text) return '';
    const day = n.source.match(/(\d{4}-\d{2}-\d{2})/);
    return `<p class="margin-note" title="${esc(n.source)}">recalled from ${esc(day ? fromDay(day[1]) : n.source)}: ${esc(clip(text))}</p>`;
  }).join('');
}

// What Nova kept from this exchange, in the margin, linked to the Memory view.
export function renderKept(ops, memory = new Map(), when = null) {
  return ops.filter((o) => o.ok && !o.existing).map((o) => {
    if (o.op === 'forget') return '<p class="margin-note is-quiet">forgot something, as you asked</p>';
    const entry = memory.get(o.id);
    if (!entry) return '<p class="margin-note is-quiet">kept in memory, since forgotten</p>';
    const later = !o.replaced && entry.updated && when && entry.updated > when;
    const verb = o.op === 'note' ? 'noted for the day' : o.replaced ? 'corrected in memory' : later ? 'kept in memory, since changed' : 'kept in memory';
    return `<p class="margin-note"><a class="margin-link" href="/memory#m-${esc(o.id)}">${verb}</a>: ${esc(clip(entry.text))}</p>`;
  }).join('');
}

// One exchange: the user's message and everything Nova did in reply.
// live: { phase, text } while this turn is running, else null.
// The skill a reply followed, linked to it in Skills while it's installed.
export function renderSkillNote(item, skills = null) {
  const here = !skills || skills.has(item.id);
  return here
    ? `<p class="margin-note">following <a class="margin-link" href="/skills#s-${esc(item.id)}">${esc(item.name)}</a></p>`
    : `<p class="margin-note is-quiet">followed ${esc(item.name)}, since removed</p>`;
}

export function renderTurn(turn, { live = null, isLast = false, memory = new Map(), skills = null } = {}) {
  const open = turn.state === 'open';
  const running = open && !!live;
  let nova = '';
  let lastTextId = null;
  for (const it of turn.items) {
    if (it.kind === 'recall' || it.kind === 'memory') {
      const notes = it.kind === 'recall' ? renderNotes(it.notes, memory) : renderKept(it.ops, memory, turn.ts);
      if (notes) nova += `<aside class="margins" aria-label="${it.kind === 'recall' ? 'From memory' : 'Kept in memory'}">${notes}</aside>`;
    }
    if (it.kind === 'skill') nova += `<aside class="margins" aria-label="Skill">${renderSkillNote(it, skills)}</aside>`;
    if (it.kind === 'text') { nova += `<div class="prose" data-text="${esc(it.id)}">${renderMarkdown(it.text)}</div>`; lastTextId = it.id; }
    if (it.kind === 'tool' && !(it.name === 'use_skill' && it.result?.ok)) nova += renderTool(it, running);
    if (it.kind === 'error') {
      nova += `<div class="error" role="alert"><p class="error-title">${esc(it.message)}</p>` +
        (it.detail ? `<details class="error-detail"><summary>Details</summary><pre tabindex="0">${esc(it.detail)}</pre></details>` : '') +
        `<button type="button" class="btn" data-action="regenerate">Try again</button></div>`;
    }
  }
  if (running && live.text) nova += `<div class="prose is-live" data-live>${renderMarkdown(live.text)}<span class="caret" aria-hidden="true"></span></div>`;
  else if (running && live.phase === 'thinking') nova += '<div class="thinking" role="status"><span class="pulse" aria-hidden="true"></span><span class="sr-only">Nova is thinking</span></div>';
  if (turn.state === 'stopped') nova += '<p class="notice">Stopped.</p>';
  if (open && !live) nova += '<p class="notice">This reply was interrupted.</p>';

  const actions = [];
  if (lastTextId && !running) actions.push(`<button type="button" class="act" data-action="copy" data-copy="${esc(lastTextId)}" aria-label="Copy reply">${icons.copy}<span>Copy</span></button>`);
  if (isLast && !running) actions.push(`<button type="button" class="act" data-action="regenerate" aria-label="Regenerate reply">${icons.again}<span>Regenerate</span></button>`);

  return `<section class="turn" id="t-${esc(turn.id)}" data-turn="${esc(turn.id)}">
  <div class="msg-user"><div class="bubble">${esc(turn.text)}</div>
    <div class="actions"><button type="button" class="act" data-action="copy-user" data-turn="${esc(turn.id)}" aria-label="Copy message">${icons.copy}<span>Copy</span></button></div></div>
  <div class="msg-nova">${nova}${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}</div>
</section>`;
}

// Each turn is keyed, with a dateline when a new day begins ("days are chapters").
export function renderBlocks(session, live, now = new Date(), memory = new Map(), skills = null) {
  let day = null;
  return session.turns.map((t, i) => {
    const d = new Date(t.ts);
    const line = dayKey(d) !== day ? `<h2 class="dateline">${esc(longDate(d, now))}</h2>` : '';
    day = dayKey(d);
    const isLive = live && live.turn === t.id && live.attempt === t.attempt ? live : null;
    return { key: t.id, html: line + renderTurn(t, { live: isLive, isLast: i === session.turns.length - 1, memory, skills }) };
  });
}

export function renderThread(session, live, now = new Date(), memory = new Map()) {
  if (!session.turns.length) return renderEmpty(now);
  return renderBlocks(session, live, now, memory).map((b) => `<div class="block" data-key="${esc(b.key)}">${b.html}</div>`).join('');
}

// ---- memory ----------------------------------------------------------------

// id → { text, day } for every entry, so conversations can show what Nova
// kept or recalled without storing the words themselves.
export function memoryIndex(data) {
  const index = new Map();
  for (const s of data?.sections ?? []) for (const e of s.entries) index.set(e.id, { text: e.text, updated: e.updated });
  for (const d of data?.days ?? []) for (const e of d.entries) index.set(e.id, { text: e.text, day: d.day });
  return index;
}

const KIND_NOTES = {
  Facts: 'Who you are and what is true about your life.',
  Preferences: 'How you like things done.',
  Decisions: 'What you settled, so it stays settled.',
  Commitments: 'What you or Nova said would happen.',
};

function memorySource(e, titles, now) {
  const when = (iso) => shortDay(new Date(iso), now).replace(/^(Today|Yesterday)$/, (w) => w.toLowerCase());
  const bits = [];
  if (e.time) bits.push(esc(e.time));
  if (e.by === 'hand') bits.push('written into MEMORY.md by hand');
  else if (e.from) {
    const [sid, turn] = e.from.split('/');
    const title = titles?.[sid];
    bits.push(title
      ? `from <a class="memory-from" href="/c/${esc(sid)}${turn ? `#t-${esc(turn)}` : ''}">“${esc(clip(title, 48))}”</a>${e.at && !e.time ? `, ${esc(when(e.at))}` : ''}`
      : `from a conversation${e.at && !e.time ? `, ${esc(when(e.at))}` : ''}`);
  }
  if (e.by === 'you' && e.updated) bits.push(`edited by you ${esc(when(e.updated))}`);
  else if (e.updated) bits.push(`corrected ${esc(when(e.updated))}`);
  return bits.join(' · ');
}

function memoryItem(e, titles, now) {
  return `<li class="memory-item" id="m-${esc(e.id)}" data-id="${esc(e.id)}" tabindex="0">
  <p class="memory-text">${esc(e.text)}</p>
  <p class="memory-source">${memorySource(e, titles, now)}</p>
  <div class="memory-actions">
    <button type="button" class="act" data-action="edit-memory" aria-label="Edit">Edit</button>
    <button type="button" class="act" data-action="forget-memory" aria-label="Forget">Forget</button>
  </div>
</li>`;
}

export function renderMemory(data, now = new Date()) {
  const sections = data?.sections ?? [];
  const days = data?.days ?? [];
  const count = sections.reduce((n, s) => n + s.entries.length, 0) + days.reduce((n, d) => n + d.entries.length, 0);
  if (!count) {
    return `<div class="empty memory-empty"><p class="empty-date">What Nova knows</p><p class="empty-line">Nothing kept yet.</p>
<p class="memory-lede">As you talk, Nova keeps what lasts here: facts about you, your preferences, decisions and commitments. You can change or forget any of it.</p></div>`;
  }
  const titles = data.titles ?? {};
  const out = [`<header class="memory-intro"><p class="empty-date">What Nova knows</p>
<p class="memory-lede">Nova reads this before every reply. Change anything, or forget it.</p></header>`];
  for (const s of sections) {
    const hid = `ms-${s.title.toLowerCase().replace(/\W+/g, '-')}`;
    out.push(`<section class="memory-section" aria-labelledby="${hid}"><h2 class="memory-heading" id="${hid}">${esc(s.title)}</h2>
${KIND_NOTES[s.title] ? `<p class="memory-kind">${KIND_NOTES[s.title]}</p>` : ''}
${s.entries.length ? `<ul class="memory-list">${s.entries.map((e) => memoryItem(e, titles, now)).join('')}</ul>` : '<p class="memory-none">Nothing yet.</p>'}</section>`);
  }
  if (days.length) {
    out.push(`<section class="memory-section" aria-labelledby="ms-days"><h2 class="memory-heading" id="ms-days">Day notes</h2>
<p class="memory-kind">Detail from each day. Nova looks here when a message calls for it.</p>
${days.map((d) => {
    const [y, m, dd] = d.day.split('-').map(Number);
    return `<h3 class="memory-day">${esc(longDate(new Date(y, m - 1, dd), now))}</h3><ul class="memory-list">${d.entries.map((e) => memoryItem(e, titles, now)).join('')}</ul>`;
  }).join('')}</section>`);
  }
  return out.join('\n');
}

// ---- skills ----------------------------------------------------------------

const longDay = (iso) => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'long' });

function skillNeeds(s, gmail) {
  if (!s.needs.includes('gmail')) return '';
  if (gmail?.connected) return `<p class="skill-needs">Reads your Gmail, which is connected.</p>`;
  if (gmail?.broken) return `<p class="skill-needs is-warn">Reads your Gmail, which <a href="#gmail" data-action="to-gmail">needs reconnecting</a>.</p>`;
  return `<p class="skill-needs is-warn">Reads your Gmail, which <a href="#gmail" data-action="to-gmail">isn't connected yet</a>.</p>`;
}

function skillItem(s, gmail, installed) {
  const action = installed
    ? `<button type="button" class="act" data-action="remove-skill">Remove</button>`
    : `<button type="button" class="btn" data-action="install-skill">Install</button>`;
  const tryIt = installed && s.try ? `<button type="button" class="act skill-try" data-action="try-skill" data-try="${esc(s.try)}">Try “${esc(s.try)}”</button>` : '';
  return `<li class="skill${installed ? '' : ' is-available'}" id="s-${esc(s.id)}" data-id="${esc(s.id)}" tabindex="0">
  <div class="skill-head"><h3 class="skill-name">${esc(s.name)}</h3>${action}</div>
  <p class="skill-about">${esc(s.about || s.when)}</p>
  ${installed ? skillNeeds(s, gmail) : ''}
  <details class="skill-playbook"><summary>How Nova does it</summary><div class="prose">${renderMarkdown(s.body.replace(/^# .*\n+/, ''))}</div></details>
  ${tryIt}
</li>`;
}

const CLIENT_STEPS = `<ol class="steps">
  <li>In <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud</a>, create a project, then <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">turn on the Gmail API</a> for it.</li>
  <li>Under <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Google Auth Platform</a>, set up sign-in for External users, and add your own address as a test user.</li>
  <li>Under <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener">Clients</a>, create a client of type <b>Desktop app</b> and download its JSON.</li>
  <li>Paste the JSON here.</li>
</ol>`;

export function renderGmail(gmail, { local = true } = {}) {
  const g = gmail ?? {};
  const state = g.connected ? 'connected' : g.broken ? 'broken' : g.client ? 'ready' : 'setup';
  const pill = { connected: 'Connected', broken: 'Needs reconnecting', ready: 'Not connected', setup: 'Not set up' }[state];
  let body = '';
  if (state === 'connected') {
    body = `<p class="skill-about">Connected as <b>${esc(g.account ?? 'your account')}</b>${g.since ? ` since ${esc(longDay(g.since))}` : ''}. Nova can search and read your mail. It can't send, change or delete anything.</p>
<div class="connection-actions"><button type="button" class="btn" data-action="disconnect-gmail">Disconnect</button>
<span class="connection-note">Disconnecting removes Nova's access at Google and deletes the sign-in from this computer.</span></div>`;
  } else if (state === 'broken') {
    body = `<p class="skill-about">Google stopped accepting Nova's sign-in. That happens when access is removed in your Google account, or after 7 days while your Google app is in Testing.</p>
<div class="connection-actions">${local ? '<button type="button" class="btn primary" data-action="connect-gmail">Reconnect Gmail</button>' : ''}<button type="button" class="btn" data-action="disconnect-gmail">Disconnect</button></div>`;
  } else if (state === 'ready') {
    body = `<p class="skill-about">Read-only: Nova can search and read your mail, and can't send, change or delete anything.</p>
<div class="connection-actions">${local ? '<button type="button" class="btn primary" data-action="connect-gmail">Connect Gmail</button>' : ''}<button type="button" class="act" data-action="forget-client">Use a different OAuth client</button></div>`;
  } else {
    body = `<p class="skill-about">Read-only: Nova can search and read your mail, and can't send, change or delete anything. Gmail lets Nova in through a Google sign-in client of your own, so no one else's app sits between you and your mail. Setting it up takes about five minutes, once.</p>
${CLIENT_STEPS}
<label class="sr-only" for="gmail-client">Your OAuth client JSON</label>
<textarea class="field" id="gmail-client" rows="3" spellcheck="false" placeholder='{"installed": {"client_id": "….apps.googleusercontent.com", …}}'></textarea>
<div class="connection-actions"><button type="button" class="btn primary" data-action="save-client">Save client</button>
<span class="connection-note">Google signs apps in Testing out after 7 days. To stay connected, publish yours under Audience; Google will call it unverified, which is expected for an app only you use.</span></div>`;
  }
  const away = local || state === 'connected' ? '' : '<p class="connection-note">To connect, open Nova at localhost on the computer it runs on. Google sends you back to that computer only.</p>';
  return `<div class="connection" data-state="${state}">
  <div class="skill-head"><h3 class="skill-name">Gmail</h3><span class="pill${state === 'connected' ? ' is-on' : state === 'broken' ? ' is-warn' : ''}">${pill}</span></div>
  ${body}${away}
</div>`;
}

export function renderSkills(data, { local = true } = {}) {
  const installed = data?.installed ?? [];
  const available = data?.available ?? [];
  const gmail = data?.connectors?.gmail;
  const out = [`<header class="memory-intro"><p class="empty-date">Skills</p>
<p class="memory-lede">Playbooks Nova follows for particular kinds of work. Each one is a plain file in your Nova folder, and removing it leaves nothing behind.</p></header>`];
  out.push(`<section class="memory-section" aria-labelledby="ks-installed"><h2 class="memory-heading" id="ks-installed">Installed</h2>
${installed.length
    ? `<ul class="skill-list">${installed.map((s) => skillItem(s, gmail, true)).join('')}</ul>`
    : '<p class="memory-none">No skills yet. Install one below, and Nova uses it whenever a message calls for it.</p>'}</section>`);
  if (available.length) {
    out.push(`<section class="memory-section" aria-labelledby="ks-available"><h2 class="memory-heading" id="ks-available">Available</h2>
<ul class="skill-list">${available.map((s) => skillItem(s, gmail, false)).join('')}</ul></section>`);
  }
  out.push(`<section class="memory-section" id="gmail" aria-labelledby="ks-connections"><h2 class="memory-heading" id="ks-connections">Connections</h2>
<p class="memory-kind">Services a skill can reach on your behalf.</p>
${renderGmail(gmail, { local })}</section>`);
  return out.join('\n');
}
