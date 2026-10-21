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
  const code = (s) => `<code>${esc(s)}</code>`;
  const cmd = String(a.command ?? '').split('\n')[0];
  const labels = {
    read_file: { running: `Reading ${code(a.path)}`, done: `Read ${code(a.path)}`, failed: `Couldn't read ${code(a.path)}` },
    write_file: { running: `Saving ${code(a.path)}`, done: `Saved ${code(a.path)}`, failed: `Couldn't save ${code(a.path)}` },
    web_fetch: { running: `Reading ${esc(host(a.url))}`, done: `Read ${esc(host(a.url))}`, failed: `Couldn't reach ${esc(host(a.url))}` },
    exec: { running: `Running ${code(cmd)}`, done: `Ran ${code(cmd)}`, failed: `${code(cmd)} didn't finish`, declined: `Didn't run ${code(cmd)}`, waiting: `Waiting to run ${code(cmd)}` },
  };
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

function renderApproval(tool) {
  const cmd = String(tool.args?.command ?? '');
  const multi = cmd.includes('\n') || cmd.length > 72;
  return `<div class="approval" role="group" aria-labelledby="ap-${esc(tool.id)}" data-tool="${esc(tool.id)}">
  <p class="approval-title" id="ap-${esc(tool.id)}">A small decision, when you're ready</p>
  <p class="approval-body">Nova wants to run ${multi ? 'this command' : `<code>${esc(cmd)}</code>`} in your workspace.</p>
  ${multi ? `<pre class="approval-cmd">${esc(cmd)}</pre>` : ''}
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
  const label = state === 'skipped' ? `Never ran ${tool.name === 'exec' ? `<code>${esc(String(tool.args?.command ?? '').split('\n')[0])}</code>` : esc(tool.name)}` : toolLabel(tool, state);
  const cls = `record is-${state}" data-tool="${esc(tool.id)}`;
  const output = tool.result?.output;
  if (state === 'running') return `<div class="${cls}" role="status"><span class="pulse" aria-hidden="true"></span>${label}…</div>`;
  if (!output) return `<div class="${cls}">${stamp}<span class="record-label">${label}</span>${when}</div>`;
  return `<details class="${cls}"><summary>${stamp}<span class="record-label">${label}</span>${when}</summary><pre class="record-output" tabindex="0">${esc(output)}</pre></details>`;
}

export function renderNotes(notes) {
  return notes.map((n) => {
    const day = n.source.match(/(\d{4})-(\d{2})-(\d{2})/);
    const from = day ? shortDay(new Date(+day[1], +day[2] - 1, +day[3])).replace(/^(Today|Yesterday)$/, (w) => w.toLowerCase()) : n.source;
    const text = n.text.length > 90 ? `${n.text.slice(0, 88).replace(/\s+\S*$/, '')}…` : n.text;
    return `<p class="margin-note" title="${esc(n.source)}">recalled from ${esc(from)}: ${esc(text)}</p>`;
  }).join('');
}

// One exchange: the user's message and everything Nova did in reply.
// live: { phase, text } while this turn is running, else null.
export function renderTurn(turn, { live = null, isLast = false } = {}) {
  const open = turn.state === 'open';
  const running = open && !!live;
  let nova = '';
  let lastTextId = null;
  for (const it of turn.items) {
    if (it.kind === 'recall') nova += `<aside class="margins" aria-label="From memory">${renderNotes(it.notes)}</aside>`;
    if (it.kind === 'text') { nova += `<div class="prose" data-text="${esc(it.id)}">${renderMarkdown(it.text)}</div>`; lastTextId = it.id; }
    if (it.kind === 'tool') nova += renderTool(it, running);
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

  return `<section class="turn" data-turn="${esc(turn.id)}">
  <div class="msg-user"><div class="bubble">${esc(turn.text)}</div>
    <div class="actions"><button type="button" class="act" data-action="copy-user" data-turn="${esc(turn.id)}" aria-label="Copy message">${icons.copy}<span>Copy</span></button></div></div>
  <div class="msg-nova">${nova}${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}</div>
</section>`;
}

// Each turn is keyed, with a dateline when a new day begins ("days are chapters").
export function renderBlocks(session, live, now = new Date()) {
  let day = null;
  return session.turns.map((t, i) => {
    const d = new Date(t.ts);
    const line = dayKey(d) !== day ? `<h2 class="dateline">${esc(longDate(d, now))}</h2>` : '';
    day = dayKey(d);
    const isLive = live && live.turn === t.id && live.attempt === t.attempt ? live : null;
    return { key: t.id, html: line + renderTurn(t, { live: isLive, isLast: i === session.turns.length - 1 }) };
  });
}

export function renderThread(session, live, now = new Date()) {
  if (!session.turns.length) return renderEmpty(now);
  return renderBlocks(session, live, now).map((b) => `<div class="block" data-key="${esc(b.key)}">${b.html}</div>`).join('');
}
