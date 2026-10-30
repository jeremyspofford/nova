// Pure view builders for Era 2's surfaces (conversations, Memory, Skills, Schedules, Activity,
// permissions): state in, HTML out. Used by the app and by the living style reference, so the
// reference always shows the real components. The PWA's own components are in components.js.
import { escapeHtml as esc, renderMarkdown } from './markdown.js';
import { status } from './components.js';
import { activityStatus, toolTier } from './status.js';
import { since, waitState, waitingLine } from './wait.js';

export const icons = {
  send: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15.5V4.5M5 9.5l5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stop: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  sidebar: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5v11" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
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

// A message's exact time, to the second: "Wednesday, October 28, 2026, 9:02:30 AM".
export function exactTime(d) {
  const p = parts(d);
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
}

// Timestamps in a conversation (Amendment 2026-10-30-C Part 1 §3): a group is one author's
// messages less than five minutes apart, and only its first message shows the time; every
// message keeps its exact time, shown on hover, on a tap or long press, and on keyboard focus.
// A new day gets a date divider, and a gap of an hour or more a divider with the time.
export const GROUP_MS = 5 * 60_000;
export const GAP_MS = 60 * 60_000;

export function msgTime(iso, lead) {
  const d = new Date(iso);
  return `<time class="when${lead ? ' is-lead' : ''}" datetime="${esc(iso)}" tabindex="0"><span class="when-short" aria-hidden="true">${esc(clock(d))}</span><span class="when-exact">${esc(exactTime(d))}</span></time>`;
}

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

// The front page with nothing on it yet, or a fresh conversation.
export function renderEmpty(now = new Date(), { fresh = false } = {}) {
  return `<div class="empty"><p class="empty-date">${esc(longDate(now, now))}</p><p class="empty-line">${fresh ? 'A new conversation, apart from the main one.' : 'Nothing needs you yet.'}</p></div>`;
}

// Today's page in the main conversation, before anything has happened today.
export function renderToday(now = new Date()) {
  return `<h2 class="dateline">${esc(longDate(now, now))}</h2><p class="today-line">Nothing needs you yet.</p>`;
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
    gmail_draft: { running: 'Saving the draft in Gmail', done: `Saved a draft in Gmail${sum ? `: “${esc(sum)}”` : ''}`, failed: "Couldn't save the draft", declined: "Didn't save the draft", waiting: 'Waiting to save a draft' },
    gmail_organize: { running: 'Changing your Gmail', done: sum ? esc(sum) : 'Changed your Gmail', failed: "Couldn't change your Gmail", declined: 'Left your Gmail as it was', waiting: 'Waiting to change your Gmail' },
    gmail_read: { running: 'Reading an email', done: sum ? `Read “${esc(sum)}”` : 'Read an email', failed: "Couldn't read that email" },
    schedule_set: { running: 'Setting up the schedule', done: `Set up “${esc(sum || a.name)}”`, failed: "Couldn't set up the schedule", declined: `Didn't set up “${esc(a.name)}”`, waiting: 'Waiting to set up a schedule' },
    schedule_remove: { running: 'Removing the schedule', done: `Removed the schedule “${esc(sum || a.id)}”`, failed: "Couldn't remove the schedule", declined: 'Kept the schedule', waiting: 'Waiting to remove a schedule' },
    use_skill: { running: 'Opening a skill', done: `Opened ${esc(sum || a.name)}`, failed: `Couldn't open the skill ${esc(a.name)}` },
    delegate: { running: 'Starting a helper', done: `Asked a helper: “${esc(sum || a.title)}”`, failed: "Couldn't start a helper" },
    nova_instance: { running: 'Checking this Nova and its models', done: 'Checked this Nova and its models', failed: "Couldn't check this Nova" },
    nova_capture: { running: 'Checking capture', done: 'Checked capture', failed: "Couldn't check capture" },
    nova_devices: { running: 'Checking your devices', done: 'Checked your devices', failed: "Couldn't check your devices" },
    nova_schedules: { running: 'Checking schedules', done: 'Checked schedules', failed: "Couldn't check schedules" },
    nova_settings: { running: 'Looking at settings', done: `Looked at settings${a.part ? `: ${esc(a.part)}` : ''}`, failed: "Couldn't read that setting" },
    memory_import: { running: 'Loading memories', done: `Loaded ${esc(sum || 'memories')} into Memory`, failed: "Couldn't load those memories", declined: 'Left Memory as it was', waiting: 'Waiting to load memories' },
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
  const p = tool.preview ?? {};
  if (tool.name === 'gmail_draft') return `Nova wants to save this ${p.reply ? 'reply' : 'email'} as a draft in your Gmail. It won't be sent; you send it from Gmail when you're happy with it.`;
  if (tool.name === 'gmail_organize') {
    const made = p.create?.length ? ` That makes the new label${p.create.length > 1 ? 's' : ''} ${p.create.map((l) => `“${esc(l)}”`).join(' and ')}.` : '';
    return `Nova wants to change your Gmail: ${esc((p.verb ?? 'change some emails').replace(/^\w/, (c) => c.toLowerCase()))}.${made}`;
  }
  if (tool.name === 'schedule_set') {
    return p.replaces
      ? `Nova wants to change the schedule ${esc(p.replaces)}. From then on it runs on its own and sends you a report.`
      : `Nova wants to set up ${p.once ? 'a reminder' : 'a schedule'}. It runs on its own and sends you ${p.once ? 'one report, then removes itself' : 'a report each time'}.`;
  }
  if (tool.name === 'schedule_remove') return `Nova wants to remove the schedule ${esc(p.name ?? tool.args?.id ?? '')}${p.when ? ` (${esc(p.when.replace(/^\w/, (c) => c.toLowerCase()))})` : ''}. It won't run again.`;
  if (tool.name === 'memory_import') return `Nova wants to load ${p.fresh ?? 'the'} ${p.fresh === 1 ? 'memory' : 'memories'} from <code>${esc(p.path ?? a.path ?? '')}</code> into Memory${p.already ? ` (${p.already} ${p.already === 1 ? 'is' : 'are'} there already)` : ''}. They arrive unreviewed, for you to confirm, correct or forget.`;
  if (tool.name === 'web_fetch') return `Nova wants to open <code>${esc(host(a.url))}</code>. ${ONLINE}`;
  if (tool.name === 'web_search') return `Nova wants to search the web for “${esc(a.query)}”. ${ONLINE}`;
  const cmd = String(a.command ?? '');
  return `Nova wants to run ${cmd.includes('\n') || cmd.length > 72 ? 'this command' : `<code>${esc(cmd)}</code>`} in your workspace.`;
}

// Exactly what will change in Gmail, so the decision is about the real thing.
function approvalDetail(tool) {
  const p = tool.preview;
  if (!p) return '';
  if (tool.name === 'gmail_draft') {
    return `<div class="approval-mail"><dl class="approval-fields"><dt>To</dt><dd>${esc(p.to)}</dd>${p.cc ? `<dt>Cc</dt><dd>${esc(p.cc)}</dd>` : ''}<dt>Subject</dt><dd>${esc(p.subject || '(no subject)')}</dd></dl>
<div class="approval-letter">${esc(p.body)}</div></div>`;
  }
  if (tool.name === 'schedule_set') {
    const to = p.deliver === 'main' ? 'The main conversation' : p.deliver === 'here' ? 'This conversation' : 'Another conversation';
    return `<div class="approval-mail"><dl class="approval-fields"><dt>Name</dt><dd>${esc(p.name)}</dd><dt>When</dt><dd>${esc(p.when)}${p.once ? '' : `<span class="approval-next">Next: <time>${esc(p.next)}</time></span>`}</dd><dt>Reports</dt><dd>${to}</dd></dl>
<div class="approval-letter">${esc(p.prompt)}</div></div>`;
  }
  if (tool.name === 'gmail_organize') {
    return `<ul class="approval-list">${(p.messages ?? []).map((m) => `<li><span class="approval-subject">${esc(m.subject)}</span> <span class="approval-from">${esc(m.from)}</span></li>`).join('')}</ul>`;
  }
  return '';
}

function renderApproval(tool) {
  const cmd = String(tool.args?.command ?? '');
  const multi = tool.name === 'exec' && (cmd.includes('\n') || cmd.length > 72);
  const url = tool.name === 'web_fetch' ? String(tool.args?.url ?? '') : '';
  const change = tool.name.startsWith('gmail_') || tool.name.startsWith('schedule_');
  const yes = { gmail_draft: 'Save draft', schedule_set: tool.preview?.replaces ? 'Change it' : 'Set it up', schedule_remove: 'Remove it' }[tool.name] ?? (change ? 'Make the change' : 'Allow once');
  const verb = { gmail_draft: 'save', schedule_set: 'set it up', schedule_remove: 'remove it' }[tool.name] ?? (change ? 'make it' : 'allow');
  const tier = toolTier(tool.name, tool.args);
  return `<div class="approval approval-sheet" data-tier="${tier}" role="group" aria-labelledby="ap-${esc(tool.id)}" data-tool="${esc(tool.id)}">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <p class="approval-title" id="ap-${esc(tool.id)}">A small decision, when you're ready</p>
  <p class="approval-body">${approvalBody(tool)}</p>
  ${multi ? `<pre class="approval-cmd">${esc(cmd)}</pre>` : ''}${url ? `<pre class="approval-cmd">${esc(url)}</pre>` : ''}${approvalDetail(tool)}
  ${tier === 3 ? `<p class="approval-body">${tool.name === 'exec' ? 'This command looks like it can’t be undone.' : 'This deletes something; it can’t be undone from here.'}</p><label class="confirm"><input type="checkbox" data-confirm="${esc(tool.id)}"> I understand, and I want Nova to do this.</label>` : ''}
  <div class="approval-actions">
    <button type="button" class="btn primary" data-action="allow" data-tool="${esc(tool.id)}"${tier === 3 ? ' disabled' : ''}>${yes}</button>
    <button type="button" class="btn" data-action="deny" data-tool="${esc(tool.id)}">${change ? 'Not now' : 'Deny'}</button>
    <span class="keys" aria-hidden="true">${tier === 3 ? 'Tick the box first' : `<kbd>Enter</kbd> ${verb}`} · <kbd>Esc</kbd> ${change ? 'not now' : 'deny'}</span>
  </div>
</div>`;
}

// How an approval ended. "Without asking": Settings lets Nova take this kind
// of step without asking. "Not asked": an older run that couldn't ask, so didn't.
const stampWord = (a) => (a.auto ? (a.decision === 'deny' ? 'Not asked' : 'Without asking') : a.decision === 'deny' ? 'Declined' : 'Allowed');

function renderTool(tool, turnOpen) {
  const state = toolState(tool, turnOpen);
  if (state === 'waiting') return renderApproval(tool);
  const stamp = tool.approval
    ? `<span class="stamp${tool.approval.decision === 'deny' ? ' is-declined' : ''}">${stampWord(tool.approval)}</span>`
    : '';
  // A finished step says how long it took and when it finished (its start and end are in the log).
  const ended = tool.result?.ts ?? null;
  const when = ended && tool.ts
    ? `<span class="record-time">took ${esc(took(tool.ts, ended))}, finished <time datetime="${esc(ended)}">${esc(clock(new Date(ended)))}</time></span>`
    : tool.approval?.ts ? `<span class="record-time">${esc(clock(new Date(tool.approval.ts)))}</span>` : '';
  const label = state === 'skipped' ? `Never ran ${tool.name === 'exec' ? `<code>${esc(String(tool.args?.command ?? '').split('\n')[0])}</code>` : 'that step'}` : toolLabel(tool, state);
  const cls = `record is-${state}" data-tool="${esc(tool.id)}`;
  const output = tool.result?.output;
  if (state === 'running') {
    const w = waitState(`step-${tool.name}`, Date.parse(tool.ts) || since(`step-${tool.id}`));
    return `<div class="record is-running${w.cls}" data-tool="${esc(tool.id)}"${w.attrs} role="status"><span class="wait-dot" aria-hidden="true"><span class="pulse"></span></span>${label}…${w.more}</div>`;
  }
  const inside = tool.result?.link?.startsWith('/');
  const link = state === 'done' && tool.result?.link ? ` <a class="record-link" href="${esc(tool.result.link)}"${inside ? '' : ' target="_blank" rel="noopener"'}>${inside ? 'Follow it in Activity' : 'Open in Gmail'}</a>` : '';
  if (!output) return `<div class="${cls}">${stamp}<span class="record-label">${label}</span>${link}${when}</div>`;
  return `<details class="${cls}"><summary>${stamp}<span class="record-label">${label}</span>${link}${when}</summary><pre class="record-output" tabindex="0">${esc(output)}</pre></details>`;
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

// When Nova's side of a turn began: its first step or words. Nothing yet while it is thinking.
export const novaStart = (turn) => turn.items.find((it) => (it.kind === 'text' || it.kind === 'tool') && it.ts)?.ts ?? null;

// `times`: { person, nova }, each true when that message leads its group (msgTime).
export function renderTurn(turn, { live = null, isLast = false, memory = new Map(), skills = null, readOnly = false, times = { person: true, nova: true } } = {}) {
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
        `${readOnly ? '' : '<button type="button" class="btn" data-action="regenerate">Try again</button>'}</div>`;
    }
  }
  if (running && live.text) nova += `<div class="prose is-live" data-live>${renderMarkdown(live.text)}<span class="caret" aria-hidden="true"></span></div>`;
  else if (running && live.phase === 'thinking') {
    const steps = turn.items.filter((it) => it.kind === 'tool' && it.result).length;
    nova += waitingLine('Thinking', { key: 'reply', since: Date.parse(turn.ts) || since(`reply-${turn.id}`), done: steps || null, noun: 'step', tag: 'div' });
  }
  if (turn.state === 'stopped') nova += '<p class="notice">Stopped.</p>';
  if (open && !live) nova += '<p class="notice">This reply was interrupted.</p>';

  const actions = [];
  if (lastTextId && !running) actions.push(`<button type="button" class="act" data-action="copy" data-copy="${esc(lastTextId)}" aria-label="Copy reply">${icons.copy}<span>Copy</span></button>`);
  if (isLast && !running && !readOnly) actions.push(`<button type="button" class="act" data-action="regenerate" aria-label="Regenerate reply">${icons.again}<span>Regenerate</span></button>`);

  // The person's turn is a tinted bubble; Nova's is the page itself, full width. No avatar, no
  // orb: the orb is in the view once (DESIGN-SYSTEM §1).
  const started = novaStart(turn);
  return `<section class="turn" id="t-${esc(turn.id)}" data-turn="${esc(turn.id)}">
  ${turn.followup ? '' : `<div class="msg-user msg" data-author="person">${turn.ts ? msgTime(turn.ts, times.person) : ''}<div class="bubble">${esc(turn.text)}</div>${turn.sending ? waitingLine('Sending', { key: 'send', since: Date.parse(turn.ts) }) : ''}
    <div class="actions"><button type="button" class="act" data-action="copy-user" data-turn="${esc(turn.id)}" aria-label="Copy message">${icons.copy}<span>Copy</span></button></div></div>`}
  <div class="msg-nova msg" data-author="nova">${started ? msgTime(started, times.nova) : ''}${nova}${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}</div>
</section>`;
}

// A report from scheduled work or a helper, set as a front page: what it is
// and when, then Nova's writing in the voice of record.
export function renderHandoff(h) {
  const when = clock(new Date(h.ts));
  const due = h.due ? clock(new Date(h.due)) : '';
  const late = h.late && due && due !== when ? ` · late, Nova wasn't running at ${esc(due)}` : '';
  const again = h.helper
    ? `<button type="button" class="btn" data-action="retry-helper" data-run="${esc(h.helper)}">Try again</button>`
    : `<button type="button" class="btn" data-action="run-schedule" data-schedule="${esc(h.schedule)}">Run it again</button>`;
  const body = h.ok
    ? `<div class="prose handoff-body" data-text="${esc(h.id)}">${renderMarkdown(h.text)}</div>`
    : h.stopped
      ? `<p class="notice handoff-stopped">${esc(h.text)} ${again.replace('class="btn"', 'class="act"')}</p>`
      : `<div class="error" role="alert"><p class="error-title">${esc(h.text)}</p>${again}</div>`;
  const name = h.helper ? `<a href="/activity#a-${esc(h.helper)}">${esc(h.name)}</a> · a helper` : `<a href="/schedules#sc-${esc(h.schedule)}">${esc(h.name)}</a>`;
  return `<section class="turn handoff${h.helper ? ' is-helper' : ''}${h.ok ? '' : h.stopped ? ' is-stopped' : ' is-failed'}" id="h-${esc(h.id)}" data-turn="${esc(h.id)}" aria-label="${esc(h.name)}">
  <p class="handoff-kicker">${name} · ${esc(when)}${late}</p>
  ${body}
  ${h.ok ? `<div class="actions"><button type="button" class="act" data-action="copy" data-copy="${esc(h.id)}" aria-label="Copy report">${icons.copy}<span>Copy</span></button></div>` : ''}
</section>`;
}

// A helper's or a scheduled run's own log, opened from Activity: it reads
// like a conversation, but there's no one there to reply to.
export function renderWorkNote(session, parentTitle = '') {
  const report = session.delivered ? ` <a href="${where(session.delivered.to)}#h-${esc(session.delivered.handoff)}">Read its report</a>.` : '';
  const text = session.kind === 'helper'
    ? `This is a helper's work on “${esc(session.title)}”, asked for in <a href="${where(session.parent)}">${esc(parentTitle || 'a conversation')}</a>. It worked on its own, so there's nothing to reply to here.${report}`
    : `This is ${esc(session.title)} at work, on its own. Its report went to the conversation it reports to; <a href="/activity#a-${esc(session.id)}">see it in Activity</a>.`;
  return `<p class="work-note">${text}</p>`;
}

// Each turn is keyed, with a dateline when a new day begins ("days are chapters"), a divider
// after a long gap, and its messages' times grouped (GROUP_MS).
export function renderBlocks(session, live, now = new Date(), memory = new Map(), skills = null) {
  let day = null;
  let prev = null; // the last message: { author, at }
  const last = session.turns.length - 1;
  // True when this message starts a group, and remembers it as the last one.
  const leads = (author, iso) => {
    const at = Date.parse(iso);
    const lead = !prev || prev.author !== author || at - prev.at >= GROUP_MS;
    prev = { author, at };
    return lead;
  };
  return session.turns.map((t, i) => {
    const d = new Date(t.ts);
    let line = '';
    if (dayKey(d) !== day) { line = `<h2 class="dateline">${esc(longDate(d, now))}</h2>`; prev = null; }
    else if (prev && Date.parse(t.ts) - prev.at >= GAP_MS) { line = `<p class="gap-divider"><time datetime="${esc(t.ts)}">${esc(clock(d))}</time></p>`; prev = null; }
    day = dayKey(d);
    if (t.kind === 'handoff') { leads('nova', t.ts); return { key: t.id, html: line + renderHandoff(t) }; }
    const times = { person: t.followup ? false : leads('person', t.ts), nova: false };
    const started = novaStart(t);
    if (started) times.nova = leads('nova', started);
    const isLive = live && live.turn === t.id && live.attempt === t.attempt ? live : null;
    return { key: t.id, html: line + renderTurn(t, { live: isLive, isLast: i === last, memory, skills, readOnly: session.kind === 'helper' || session.kind === 'run', times }) };
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
  if (gmail?.connected) return `<p class="skill-needs">Uses your Gmail, which is connected.</p>`;
  if (gmail?.broken) return `<p class="skill-needs is-warn">Uses your Gmail, which <a href="#gmail" data-action="to-gmail">needs reconnecting</a>.</p>`;
  return `<p class="skill-needs is-warn">Uses your Gmail, which <a href="#gmail" data-action="to-gmail">isn't connected yet</a>.</p>`;
}

function skillItem(s, gmail, installed) {
  const action = installed
    ? `<button type="button" class="act" data-action="remove-skill">Remove</button>`
    : `<button type="button" class="btn" data-action="install-skill">Install</button>`;
  const tryIt = installed && s.try ? `<button type="button" class="act skill-try" data-action="try-skill" data-try="${esc(s.try)}">Try “${esc(s.try)}”</button>` : '';
  return `<li class="skill${installed ? '' : ' is-available'}" id="s-${esc(s.id)}" data-id="${esc(s.id)}" tabindex="0">
  <div class="skill-head"><h3 class="skill-name">${esc(s.name)}</h3>${action}</div>
  <p class="skill-about">${esc(s.about || s.when)}</p>
  ${installed ? skillNeeds(s, gmail) : ''}${installed && s.own ? `<p class="skill-needs">Added by you${s.files?.length ? `, with ${s.files.length} more file${s.files.length === 1 ? '' : 's'} in its folder` : ''}.</p>` : ''}
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

const APP_PASSWORDS = 'https://myaccount.google.com/apppasswords';
const PROMISE = 'Nova can read your mail, save drafts and organize it: archive, labels, read or unread. It never sends or deletes anything, and every change waits for your OK unless you turn that off in Settings.';

function passwordForm(g, again = false) {
  return `<form class="connection-form" data-form="gmail-password">
${again ? '' : `<ol class="steps">
  <li>Open <a href="${APP_PASSWORDS}" target="_blank" rel="noopener">App passwords</a> in your Google account. If Google says they aren't available, turn on <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener">2-Step Verification</a> first.</li>
  <li>Name it “Nova” and create it. Google shows a 16-letter password, once.</li>
  <li>Paste it here with your Gmail address.</li>
</ol>`}
<div class="field-row">
  <label class="field-label">Gmail address<input class="field" id="gmail-email" type="email" autocomplete="email" spellcheck="false" placeholder="you@gmail.com" value="${esc(g.account ?? '')}"></label>
  <label class="field-label">App password<input class="field" id="gmail-password" type="password" autocomplete="off" spellcheck="false" placeholder="abcd efgh ijkl mnop"></label>
</div>
<div class="connection-actions"><button type="submit" class="btn primary" data-action="connect-password">${again ? 'Reconnect Gmail' : 'Connect Gmail'}</button>
<span class="connection-note">An app password opens your mail only, not the rest of your Google account. You can remove it at Google whenever you like.</span></div>
</form>`;
}

// The way in with your own Google OAuth client, for work or school accounts
// that don't allow app passwords.
function advanced(g, local) {
  const away = local ? '' : '<p class="connection-note">To connect this way, open Nova at localhost on the computer it runs on. Google sends you back to that computer only.</p>';
  const inner = g.client
    ? `<p class="skill-about">Your Google client is saved.</p>
<div class="connection-actions">${local ? '<button type="button" class="btn" data-action="connect-gmail">Connect with Google</button>' : ''}<button type="button" class="act" data-action="forget-client">Use a different OAuth client</button></div>${away}`
    : `<p class="skill-about">For work or school accounts, which often can't make app passwords. Google lets Nova in through a sign-in client of your own, so no one else's app sits between you and your mail. It takes about five minutes, once.</p>
${CLIENT_STEPS}
<label class="sr-only" for="gmail-client">Your OAuth client JSON</label>
<textarea class="field" id="gmail-client" rows="3" spellcheck="false" placeholder='{"installed": {"client_id": "….apps.googleusercontent.com", …}}'></textarea>
<div class="connection-actions"><button type="button" class="btn" data-action="save-client">Save client</button>
<span class="connection-note">Google signs apps in Testing out after 7 days. To stay connected, publish yours under Audience; Google will call it unverified, which is expected for an app only you use.</span></div>${away}`;
  return `<details class="skill-playbook connection-advanced"${g.client ? ' open' : ''}><summary>Advanced: your own Google client</summary><div class="connection-more">${inner}</div></details>`;
}

export function renderGmail(gmail, { local = true } = {}) {
  const g = gmail ?? {};
  const pw = g.method === 'password';
  const state = g.connected ? 'connected' : g.broken ? 'broken' : 'setup';
  const pill = { connected: 'Connected', broken: 'Needs reconnecting', setup: 'Not connected' }[state];
  let body = '';
  if (state === 'connected') {
    body = `<p class="skill-about">Connected as <b>${esc(g.account ?? 'your account')}</b>${pw ? ' with an app password' : ' with your own Google client'}${g.since ? `, since ${esc(longDay(g.since))}` : ''}. ${PROMISE}</p>
<div class="connection-actions"><button type="button" class="btn" data-action="disconnect-gmail">Disconnect</button>
<span class="connection-note">${pw
    ? `Disconnecting deletes the app password from this computer. To switch it off at Google too, remove it in <a href="${APP_PASSWORDS}" target="_blank" rel="noopener">App passwords</a>.`
    : "Disconnecting removes Nova's access at Google and deletes the sign-in from this computer."}</span></div>`;
  } else if (state === 'broken' && pw) {
    body = `<p class="skill-about">Google stopped accepting the app password for <b>${esc(g.account ?? 'your account')}</b>. That happens when it's removed at Google or your Google password changes. Make a new one in <a href="${APP_PASSWORDS}" target="_blank" rel="noopener">App passwords</a> and paste it here.</p>
${passwordForm(g, true)}
<div class="connection-actions"><button type="button" class="act" data-action="disconnect-gmail">Disconnect</button></div>`;
  } else if (state === 'broken') {
    body = `<p class="skill-about">Google stopped accepting Nova's sign-in. That happens when access is removed in your Google account, or after 7 days while your Google app is in Testing.</p>
<div class="connection-actions">${local ? '<button type="button" class="btn primary" data-action="connect-gmail">Reconnect Gmail</button>' : ''}<button type="button" class="btn" data-action="disconnect-gmail">Disconnect</button></div>`;
  } else {
    body = `<p class="skill-about">${PROMISE}</p>
${passwordForm(g)}
${advanced(g, local)}`;
  }
  return `<div class="connection" data-state="${state}"${g.method ? ` data-method="${esc(g.method)}"` : ''}>
  <div class="skill-head"><h3 class="skill-name">Gmail</h3><span class="pill${state === 'connected' ? ' is-on' : state === 'broken' ? ' is-warn' : ''}">${pill}</span></div>
  ${body}
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
  out.push(`<section class="memory-section" id="add" aria-labelledby="ks-add"><h2 class="memory-heading" id="ks-add">Add your own</h2>
<div class="dropzone" data-drop="skill">
  <p class="skill-about">A skill is a folder with a SKILL.md: a name, a description of when to use it, then the steps. Nova reads its own format and Claude's, so skills made for Claude work here too.</p>
  <div class="connection-actions"><button type="button" class="btn" data-action="add-folder">Choose a folder</button><button type="button" class="btn" data-action="add-zip">Choose a .zip</button><span class="connection-note">or drop one here.</span></div>
  <p class="connection-note">A skill is instructions Nova follows, so add ones you trust. Anything a skill would run still asks you first.</p>
</div>
<input type="file" id="add-folder-input" webkitdirectory multiple hidden>
<input type="file" id="add-zip-input" accept=".zip,application/zip" hidden></section>`);
  out.push(`<section class="memory-section" id="gmail" aria-labelledby="ks-connections"><h2 class="memory-heading" id="ks-connections">Connections</h2>
<p class="memory-kind">Services a skill can reach on your behalf.</p>
${renderGmail(gmail, { local })}</section>`);
  return out.join('\n');
}

// ---- schedules ---------------------------------------------------------------

// "today at 7:00 AM", "tomorrow at 7:00 AM", "Friday at 7:00 AM", "October 30 at 7:00 AM".
export function relWhen(iso, now = new Date(), timeZone = undefined) {
  const d = new Date(iso);
  const key = (x) => x.toLocaleDateString('en-CA', { timeZone });
  const days = Math.round((Date.parse(key(d)) - Date.parse(key(now))) / 86_400_000);
  const time = d.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString('en-US', { timeZone, weekday: 'long' })} at ${time}`;
  return `${d.toLocaleDateString('en-US', { timeZone, month: 'long', day: 'numeric' })} at ${time}`;
}

// What happened last time, in a sentence: running, missed, failed, or the
// report's headline with a way to read it.
function scheduleLast(s, now, tz) {
  if (s.running?.waiting) return `<p class="schedule-last is-warn" role="status">Waiting for your OK. <a href="/c/${esc(s.running.run)}">See what it's asking</a></p>`;
  if (s.running) {
    const w = waitState('schedule', since(`schedule-${s.id}`));
    return `<p class="schedule-last is-running${w.cls}"${w.attrs} role="status"><span class="wait-dot" aria-hidden="true"><span class="pulse"></span></span>Running now…${w.more}</p>`;
  }
  if (s.queued) return '<p class="schedule-last">Waiting for another schedule to finish.</p>';
  const r = s.last;
  if (!r) return '';
  if (r.missed) return `<p class="schedule-last is-warn">Missed ${esc(relWhen(r.due, now, tz))}: Nova wasn't running then.</p>`;
  const when = relWhen(r.finished ?? r.ts, now, tz);
  const where = r.delivered === 'main' ? `/chat#h-${esc(r.handoff)}` : `/c/${esc(r.delivered)}#h-${esc(r.handoff)}`;
  if (!r.ok) return `<p class="schedule-last is-warn">Last run, ${esc(when)}, didn't finish: ${esc(r.error ?? 'something went wrong')} <a href="${where}">See it</a></p>`;
  return `<p class="schedule-last">Last ran ${esc(when)}${r.late ? ', late' : ''}. <a href="${where}">Read the report</a></p>${r.summary ? `<p class="schedule-headline">${esc(r.summary)}</p>` : ''}`;
}

function scheduleItem(s, now, tz) {
  const state = s.error ? '' : s.paused ? '<span class="pill">Paused</span>' : '';
  const next = s.next ? `<span class="schedule-next">Next: ${esc(relWhen(s.next, now, tz))}</span>` : '';
  const busy = s.running || s.queued;
  const actions = s.error ? '' : `<button type="button" class="act" data-action="run-schedule"${busy ? ' disabled' : ''}>Run now</button>
    <button type="button" class="act" data-action="${s.paused ? 'resume-schedule' : 'pause-schedule'}">${s.paused ? 'Resume' : 'Pause'}</button>`;
  const elsewhere = s.deliver !== 'main' ? `<p class="skill-needs">Reports go to <a href="/c/${esc(s.deliver)}">the conversation where you asked for it</a>.</p>` : '';
  return `<li class="skill schedule${s.paused ? ' is-paused' : ''}" id="sc-${esc(s.id)}" data-id="${esc(s.id)}" tabindex="0">
  <div class="skill-head"><h3 class="skill-name">${esc(s.name)}</h3>${state}<span class="schedule-actions">${actions}<button type="button" class="act" data-action="remove-schedule">Remove</button></span></div>
  ${s.error ? `<p class="skill-needs is-warn">${esc(s.error)}</p>` : `<p class="schedule-when">${esc(s.when)}${next ? ` · ${next}` : ''}</p>`}
  ${elsewhere}${scheduleLast(s, now, tz)}
  <details class="skill-playbook"><summary>What Nova does</summary><div class="prose">${renderMarkdown(s.prompt)}</div></details>
</li>`;
}

const hhmm = (cron) => {
  const [m, h] = String(cron).split(/\s+/);
  return /^\d+$/.test(m) && /^\d+$/.test(h) ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : '07:00';
};

function offerItem(s) {
  return `<li class="skill is-available" id="sc-${esc(s.id)}" data-id="${esc(s.id)}" tabindex="0">
  <div class="skill-head"><h3 class="skill-name">${esc(s.name)}</h3></div>
  <p class="skill-about">${esc(s.about)}</p>
  <form class="schedule-setup" data-form="setup-schedule">
    <label class="field-label">Time<input class="field" type="time" name="time" value="${hhmm(s.cron)}" required></label>
    <label class="field-label">Days<select class="field" name="days"><option value="every">Every day</option><option value="weekdays">Weekdays</option><option value="weekends">Weekends</option></select></label>
    <button type="submit" class="btn">Turn on</button>
  </form>
  <details class="skill-playbook"><summary>What Nova does</summary><div class="prose">${renderMarkdown(s.prompt)}</div></details>
</li>`;
}

export function renderSchedules(data, now = new Date()) {
  const set = data?.set ?? [];
  const available = data?.available ?? [];
  const tz = data?.timezone;
  const out = [`<header class="memory-intro"><p class="empty-date">Schedules</p>
<p class="memory-lede">Work Nova does on its own, at times you choose. Reports arrive in the main conversation, and each schedule is a plain file in your Nova folder.</p></header>`];
  out.push(`<section class="memory-section" aria-labelledby="sc-set"><h2 class="memory-heading" id="sc-set">Set</h2>
${set.length
    ? `<ul class="skill-list">${set.map((s) => scheduleItem(s, now, tz)).join('')}</ul>`
    : `<p class="memory-none">Nothing is scheduled yet. Turn on the morning digest below, or ask Nova in any conversation, such as “Every Friday at 4, remind me to send my timesheet.”</p>`}
${set.length ? '<p class="memory-kind">Nova runs schedules while it\'s running. If it was off at a run\'s time, the run happens when Nova starts, if that\'s within six hours.</p>' : ''}</section>`);
  if (available.length) {
    out.push(`<section class="memory-section" aria-labelledby="sc-offer"><h2 class="memory-heading" id="sc-offer">Ready to set up</h2>
<ul class="skill-list">${available.map(offerItem).join('')}</ul></section>`);
  }
  return out.join('\n');
}

// ---- activity --------------------------------------------------------------

const where = (session) => (session === 'main' ? '/chat' : `/c/${esc(session)}`);
const lower = (s) => s.replace(/^\w/, (c) => c.toLowerCase());
const count = (n, one, many = `${one}s`) => `${n === 1 ? 'one' : n < 10 ? ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][n] : n} ${n === 1 ? one : many}`;
const list = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);

// How long something took, in the largest unit that reads well.
export function took(from, to) {
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (s < 1) return 'under a second';
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// A day in one sentence: what Nova did, then what it asked and what it
// couldn't ask. "Six replies, the morning digest and two helpers. You were
// asked twice and said yes once."
export function daySentence(n, schedules = []) {
  const did = [];
  if (n.replies) did.push(count(n.replies, 'reply', 'replies'));
  if (n.schedules) did.push(schedules.length === 1 && n.schedules === 1 ? `the ${lower(schedules[0])}` : count(n.schedules, 'scheduled run'));
  if (n.helpers) did.push(count(n.helpers, 'helper'));
  let out = did.length ? `${list(did).replace(/^\w/, (c) => c.toUpperCase())}.` : '';
  if (n.asked) {
    const times = n.asked === 1 ? 'once' : n.asked === 2 ? 'twice' : `${count(n.asked, 'time')}`;
    const each = n.asked === 1 ? '' : ' each time';
    const yes = n.allowed === n.asked ? `said yes${each}` : n.allowed ? `said yes ${n.allowed === 1 ? 'once' : n.allowed === 2 ? 'twice' : count(n.allowed, 'time')}` : `said no${each}`;
    out += ` You were asked ${times} and ${yes}.`;
  }
  if (n.onOwn) out += ` Nova took ${count(n.onOwn, 'step')} without asking, as Settings allows.`;
  if (n.notAsked) out += ` ${count(n.notAsked, 'step').replace(/^\w/, (c) => c.toUpperCase())} needed your OK while no one could ask, so ${n.notAsked === 1 ? 'it was' : 'they were'} suggested instead.`;
  if (n.kept) out += ` ${count(n.kept, 'thing').replace(/^\w/, (c) => c.toUpperCase())} went into memory.`;
  if (n.missed) out += ` ${count(n.missed, 'scheduled run').replace(/^\w/, (c) => c.toUpperCase())} missed while Nova was off.`;
  return out.trim();
}

function stepLine(s, open = false) {
  if (s.kind === 'skill') return `Followed <a href="/skills#s-${esc(s.id)}">${esc(s.name)}</a>`;
  if (s.kind === 'memory') return s.forgot && !s.kept ? 'Forgot something, as asked' : `Kept ${count(s.kept, 'thing')} in memory${s.forgot ? ', forgot one' : ''}`;
  if (s.kind === 'error') return `<span class="act-problem">${esc(s.message)}</span>`;
  const st = toolState(s, open);
  const label = toolLabel(s, st === 'skipped' ? 'failed' : st);
  const stamp = s.approval ? `<span class="stamp${s.approval.decision === 'deny' ? ' is-declined' : ''}">${stampWord(s.approval)}</span>` : '';
  return `${stamp}${label}`;
}

// Activity states in the one status vocabulary (status.js), with the detail beside it.
const DETAIL = { waiting: 'waiting for you', queued: 'waiting its turn', stopped: 'stopped', failed: 'didn’t finish', interrupted: 'interrupted', missed: 'missed' };
const actState = (state) => {
  if (!['working', 'waiting', 'queued', 'stopped', 'failed', 'interrupted', 'missed'].includes(state)) return '';
  const pill = status(activityStatus(state));
  return `<span class="act-state">${pill}${DETAIL[state] ? `<span class="act-detail">${esc(DETAIL[state])}</span>` : ''}</span>`;
};

export const activityId = (e) => (e.kind === 'reply' ? `a-${e.session}-${e.turn}` : `a-${e.session ?? e.id.replace(/[^\w-]/g, '-')}`);

// What it was, in a line: "You asked “…”", "Morning digest", "A helper: Compare e-bikes".
function entryTitle(e) {
  if (e.followup) return `Nova on “${esc(e.followup)}”`;
  if (e.kind === 'reply') return `<span class="act-quote">“${esc(e.text)}”</span>`;
  if (e.kind === 'helper') return `Helper: ${esc(e.title)}`;
  return esc(e.title);
}

// Where it happened and how it ended, with links to the conversation and the report.
function entryMeta(e) {
  const bits = [];
  if (e.kind === 'reply') bits.push(e.first && e.session !== 'main' ? `started <a href="${where(e.session)}">a conversation</a>` : `in <a href="${where(e.session)}#t-${esc(e.turn)}">${esc(e.title)}</a>`);
  if (e.kind === 'helper' && e.parent) bits.push(`asked in <a href="${where(e.parent)}">${esc(clip(e.parentTitle ?? '', 40))}</a>`);
  if (e.kind === 'schedule' && !e.missed) bits.push(e.manual ? 'run now, by you' : e.late ? 'ran late' : 'on schedule');
  if (e.missed) bits.push("Nova wasn't running then");
  if (e.ended && e.state !== 'working' && e.state !== 'waiting') bits.push(`took ${took(e.started, e.ended)}, finished <time datetime="${esc(e.ended)}">${esc(clock(new Date(e.ended)))}</time>`);
  if (e.report) bits.push(`<a href="${where(e.report.to)}#h-${esc(e.report.handoff)}">${e.state === 'done' ? 'Read the report' : 'See what it said'}</a>`);
  if (e.kind !== 'reply' && e.session && !e.missed && e.state !== 'queued') bits.push(`<a href="/c/${esc(e.session)}">Every step</a>`);
  return bits.join(' · ');
}

export function activityEntry(e, now = new Date()) {
  const live = e.state === 'working' || e.state === 'waiting';
  const waitingStep = e.approval ? e.steps.find((s) => s.id === e.approval) : null;
  const shown = e.steps.filter((s) => s !== waitingStep);
  const steps = shown.map((s) => stepLine(s, live));
  const time = clock(new Date(e.started));
  const stop = e.kind === 'helper' && ['working', 'queued'].includes(e.state) ? `<button type="button" class="act" data-action="stop-helper" data-run="${esc(e.session)}">Stop</button>` : '';
  const retry = e.kind === 'helper' && ['failed', 'stopped', 'interrupted'].includes(e.state) ? `<button type="button" class="act" data-action="retry-helper" data-run="${esc(e.session)}">Try again</button>` : '';
  const head = `<p class="act-head"><span class="act-title">${entryTitle(e)}</span>${actState(e.state)}${stop || retry ? `<span class="act-actions">${stop}${retry}</span>` : ''}</p>`;
  const go = waitingStep ? `<p class="act-go"><a class="btn" href="${where(e.session)}#t-${esc(e.turn)}">Go to it</a> ${esc(clip(toolLabel(waitingStep, 'waiting').replace(/<[^>]+>/g, ''), 80))}</p>` : '';
  let body = '';
  if (steps.length > 3) {
    const first = shown.slice(0, 3).map((s) => stepLine(s, live).replace(/<span class="stamp[^>]*>[^<]*<\/span>/, '').replace(/<a [^>]*>([^<]*)<\/a>/g, '$1'));
    body = `<details class="act-steps"><summary>${first.join(' · ')} · and ${steps.length - 3} more</summary><ol class="act-step-list">${steps.map((s) => `<li>${s}</li>`).join('')}</ol></details>`;
  } else if (steps.length) {
    body = `<ol class="act-step-list is-short">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>`;
  }
  const brief = e.brief ? `<p class="act-brief">${esc(e.brief)}</p>` : '';
  return `<li class="act-entry is-${esc(e.kind)} is-${esc(e.state)}" id="${esc(activityId(e))}" tabindex="0">
  <time class="act-time" datetime="${esc(e.started)}">${esc(time)}</time>
  <div class="act-body">${head}${brief}<p class="act-meta">${entryMeta(e)}</p>${go}${body}</div>
</li>`;
}

export function renderActivity(data, now = new Date()) {
  const out = [`<header class="memory-intro"><p class="empty-date">Activity</p>
<p class="memory-lede">What Nova is doing and has done: each reply, scheduled run and helper, with the steps it took and what it asked you. It's read from the conversation logs in your Nova folder.</p></header>`];
  if (data.now?.length) {
    out.push(`<section class="memory-section act-now" aria-labelledby="act-now"><h2 class="memory-heading" id="act-now">Now</h2>
<ol class="act-list">${data.now.map((e) => activityEntry(e, now)).join('')}</ol></section>`);
  }
  const days = (data.days ?? []).map((d) => {
    const [y, m, dd] = d.day.split('-').map(Number);
    const date = new Date(y, m - 1, dd);
    const names = [...new Set(d.entries.filter((e) => e.kind === 'schedule' && !e.missed).map((e) => e.title))];
    const entries = d.entries.filter((e) => e.state !== 'working' && e.state !== 'waiting');
    return `<section class="act-day" aria-label="${esc(shortDay(date, now))}"><h2 class="dateline">${esc(longDate(date, now))}</h2>
<p class="act-summary">${esc(daySentence(d.summary, names))}</p>
${entries.length ? `<ol class="act-list">${entries.map((e) => activityEntry(e, now)).join('')}</ol>` : ''}</section>`;
  });
  if (!days.length && !data.now?.length) {
    out.push(`<p class="memory-none act-empty">${data.earlier ? 'Nothing happened that week.' : 'Nothing yet this week. When you talk with Nova, or a schedule or helper runs, each step shows up here.'}</p>`);
  }
  out.push(...days);
  if (data.more) out.push(`<p class="act-more"><button type="button" class="btn" data-action="earlier" data-before="${esc(data.before)}">Show the week before</button></p>`);
  return out.join('\n');
}

// ---- settings: what Nova may do without asking ---------------------------------------------

// Each permission is one kind of step that normally asks first. The list comes from the tools
// Nova has, so a new tool brings its own switch, starting off.
export function renderPermissions(list) {
  const rows = list.map((p) => `<li class="perm" id="p-${esc(p.id)}">
  <div class="perm-text"><p class="perm-label" id="pl-${esc(p.id)}">${esc(p.label)}</p>${p.note ? `<p class="perm-note">${esc(p.note)}.</p>` : ''}</div>
  <button type="button" class="switch" role="switch" aria-checked="${p.yes}" aria-labelledby="pl-${esc(p.id)}" data-action="toggle-permission" data-id="${esc(p.id)}"><span class="switch-word">${p.yes ? 'Without asking' : 'Ask first'}</span><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span></button>
</li>`).join('');
  return `<section class="memory-section" id="perms" aria-labelledby="set-perms"><h2 class="memory-heading" id="set-perms">Without asking</h2>
<p class="memory-lede">Everything Nova can do that changes something outside the conversation asks you first. Turn a switch on and Nova does that without asking, in a conversation or while it works on its own; Activity shows each time.</p>
${list.length ? `<ul class="perm-list">${rows}</ul>` : '<p class="memory-none">Nothing Nova can do asks first right now.</p>'}
<p class="perm-foot">When Nova gets a new tool, from an update, a plugin or a connector, anything it can change shows up here, set to Ask first. These switches are kept in permissions.md in your Nova folder.</p></section>`;
}
