// Settings › Connections (M5 plan §2): the services Nova works with, from /api/v1/connectors.
// Connected ones show their status in plain words and can be disconnected (a sheet that says what
// goes). Nova recommends one to connect next rather than listing every option: that card's Connect
// is the view's one standout. The others are one layer down.
import { api } from './core.js';
import { escapeHtml as esc } from './markdown.js';
import { closeSheet, openSheet, toast } from './shell.js';

let data = null;    // { connectors, vault }
let rules = [];     // the automation rules, to say which listen to a connection
let failed = '';
let rerender = () => {};

export async function loadConnections() {
  try {
    const [c, r] = await Promise.all([api('GET', '/connectors'), api('GET', '/triggers/rules').catch(() => [])]);
    data = c;
    rules = r;
    failed = '';
  } catch (e) {
    failed = e.message || 'Nova’s server didn’t answer.';
  }
  rerender();
}

const listening = (id) => rules.filter((r) => String(r.source ?? '').startsWith(`connector:${id}/`));
const since = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); } catch { return ''; } };
const LIVE = { listening: 'Hearing changes as they happen.', reconnecting: 'The live connection dropped; Nova is reconnecting.', off: '' };

function line(c) {
  if (c.broken) return c.detail ?? 'It no longer accepts Nova’s sign-in. Connect it again.';
  const parts = [c.account ? `Connected to ${c.account}` : 'Connected', c.since ? `since ${since(c.since)}` : ''].filter(Boolean).join(' ');
  return [`${parts}.`, c.detail ?? '', LIVE[c.live] ?? ''].filter(Boolean).join(' ');
}

function canList(c) {
  return `<ul class="conn-can">${c.can.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${c.never.length ? `<p class="settings-note">Never: ${esc(c.never.map((x) => x.replace(/\.$/, '').replace(/^./, (ch) => ch.toLowerCase())).join(', '))}.</p>` : ''}`;
}

function connectedRow(c) {
  const n = listening(c.id).length;
  return `<li class="conn" data-connector="${esc(c.id)}">
  <div class="conn-head"><p class="settings-label">${esc(c.name)}</p><span class="pill ${c.broken ? 'is-warn' : 'is-on'}">${c.broken ? 'Needs you' : 'Connected'}</span></div>
  <p class="settings-note">${esc(line(c))}${n ? ` ${n === 1 ? 'One rule listens' : `${n} rules listen`} to it.` : ''}</p>
  <details class="raw"><summary>What it can do</summary>${canList(c)}</details>
  <div class="sheet-actions">${c.broken && c.setup.kind === 'link' ? `<a class="btn small" href="${esc(c.setup.href)}">Reconnect</a>` : ''}<button type="button" class="btn small quiet" data-action="disconnect-connector" data-connector="${esc(c.id)}">Disconnect</button></div>
</li>`;
}

function setupForm(c, { primary }) {
  if (!c.allowed) return `<p class="settings-note">${esc(c.blocked)}</p>`;
  if (c.setup.kind === 'link') return `<div class="sheet-actions"><a class="btn${primary ? ' primary' : ''}" href="${esc(c.setup.href)}">${esc(c.setup.label)}</a></div>`;
  const fields = c.setup.fields.map((f) => {
    const hint = f.hint ? `conn-${c.id}-${f.key}-hint` : '';
    return `<div><label class="field-label">${esc(f.label)}<input class="field" name="${esc(f.key)}" type="${f.secret ? 'password' : 'text'}" autocomplete="off" spellcheck="false"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${hint ? ` aria-describedby="${esc(hint)}"` : ''} required></label>${hint ? `<p class="settings-note conn-hint" id="${esc(hint)}">${esc(f.hint)}</p>` : ''}</div>`;
  }).join('');
  return `<form class="conn-form" data-connector="${esc(c.id)}"><div class="field-row">${fields}</div>
  <div class="sheet-actions"><button type="submit" class="btn${primary ? ' primary' : ''}">Connect ${esc(c.name)}</button></div></form>`;
}

function offer(c, { primary }) {
  return `<div class="conn-offer" data-connector="${esc(c.id)}"><p class="settings-label">${esc(c.name)}</p><p class="settings-note">${esc(c.summary)}</p>${canList(c)}${setupForm(c, { primary })}</div>`;
}

export function renderConnections() {
  const head = '<section class="memory-section" id="connections" aria-labelledby="set-connections"><h2 class="memory-heading" id="set-connections">Connections</h2>';
  if (!data) return `${head}<p class="memory-lede">${esc(failed || 'Loading…')}</p>${failed ? '<button type="button" class="btn set-retry" data-action="retry-connections">Try again</button>' : ''}</section>`;
  const all = data.connectors;
  const on = all.filter((c) => c.connected || c.broken);
  const pick = all.find((c) => c.recommended);
  const rest = all.filter((c) => !c.connected && !c.broken && c !== pick);
  const vault = data.vault;
  const lede = on.length
    ? 'The services Nova works with for you. Their passwords and tokens stay in Nova’s vault, encrypted.'
    : 'Nothing is connected yet. Connect a service and Nova can work with it for you; its passwords and tokens stay in Nova’s vault, encrypted.';
  return `${head}
<p class="memory-lede">${esc(lede)}</p>
${vault?.notice ? `<p class="settings-note conn-notice">${esc(vault.notice)}</p>` : ''}
${vault && !vault.ok ? `<p class="settings-note conn-notice">${esc(vault.detail)}</p>` : ''}
${on.length ? `<ul class="conn-list">${on.map(connectedRow).join('')}</ul>` : ''}
${pick ? `<h3 class="conn-sub">Nova suggests</h3>${offer(pick, { primary: true })}` : ''}
${rest.length ? `<details class="raw conn-more"><summary>Other connections (${rest.length})</summary>${rest.map((c) => offer(c, { primary: false })).join('')}</details>` : ''}
</section>`;
}

function disconnectSheet(c) {
  const n = listening(c.id).length;
  const goes = [`its ${c.secrets.length === 1 ? 'secret' : 'secrets'} in Nova’s vault`, n ? `${n === 1 ? 'the rule' : `the ${n} rules`} listening to it` : '', 'its settings'].filter(Boolean);
  return `<form class="conn-disconnect" data-connector="${esc(c.id)}" method="dialog">
  <h2 class="sheet-title" id="sheet-title">Disconnect ${esc(c.name)}?</h2>
  <p class="sheet-line">Nova signs out at ${esc(c.name)} where it can, then deletes ${esc(goes.join(', ').replace(/, ([^,]*)$/, ' and $1'))}. Connecting again starts fresh.</p>
  <div class="sheet-actions">
    <button type="submit" class="btn primary">Disconnect</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Keep it</button>
  </div>
</form>`;
}

// Wires the part into Settings: `render` redraws it when the data changes.
export function bindConnections(root, render) {
  rerender = render;
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b?.dataset.action === 'retry-connections') loadConnections();
    if (b?.dataset.action === 'disconnect-connector') {
      const c = data?.connectors.find((x) => x.id === b.dataset.connector);
      if (c) openSheet(disconnectSheet(c), { label: `Disconnect ${c.name}` });
    }
  });
  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('.conn-form');
    if (!form) return;
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    const body = Object.fromEntries(new FormData(form));
    try {
      const c = await api('POST', `/connectors/${encodeURIComponent(form.dataset.connector)}/connect`, body);
      toast(`${c.name} is connected.`);
      await loadConnections();
      document.querySelector(`.conn[data-connector="${CSS.escape(c.id)}"] [data-action="disconnect-connector"]`)?.focus({ preventScroll: true });
    } catch (err) {
      button.disabled = false;
      toast(err.message);
    }
  });
  document.getElementById('sheet').addEventListener('submit', async (e) => {
    const form = e.target.closest('.conn-disconnect');
    if (!form) return;
    e.preventDefault();
    try {
      const r = await api('POST', `/connectors/${encodeURIComponent(form.dataset.connector)}/disconnect`);
      closeSheet();
      toast(r.note ? `${r.name} is disconnected. ${r.note}` : `${r.name} is disconnected${r.revoked ? ', and signed out there too' : ''}.`, { ms: r.note ? 10_000 : null });
    } catch (err) { toast(err.message); }
    await loadConnections();
  });
}
