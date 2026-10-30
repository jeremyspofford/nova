// First run: on a blank profile, setup is a conversation (/api/v1/setup) that takes the whole
// screen in every layout. It ends on the welcome task's VerifiedResultCard, with its evidence
// one tap away, and then the person continues into Nova.
import { api, on } from './core.js';
import { ICONS, chatBubble, evidenceViewer, lookingIntoItCard, verifiedResultCard } from './components.js';
import { liveOrb, openSheet, toast } from './shell.js';
import { escapeHtml as esc } from './markdown.js';

const el = document.getElementById('setup');
let view = null;
let task = null;
let sending = false;
let finished = null;

// Resolves true when setup is showing (the profile is blank), false when it's already done.
export async function startSetup({ done }) {
  finished = done;
  try { view = await api('GET', '/setup'); } catch { return false; }
  if (view.done) return false;
  show();
  return true;
}

export const setupShowing = () => !el.hidden;

function show() {
  el.hidden = false;
  document.getElementById('app').inert = true;
  document.body.dataset.setup = 'on';
  render();
  document.getElementById('setup-input')?.focus();
}

function finish() {
  el.hidden = true;
  el.innerHTML = '';
  document.getElementById('app').inert = false;
  delete document.body.dataset.setup;
  finished?.();
}

function result() {
  if (!view.done) return '';
  if (!view.first_task) return '';
  if (!task) return '<p class="setup-sub">Checking the first task…</p>';
  if (task.state === 'done') return `<div class="setup-done"><p class="setup-sub">Your first task, checked by Nova:</p>${verifiedResultCard(task)}</div>`;
  if (task.state === 'failed' || task.state === 'cancelled') return `<div class="setup-done"><p class="setup-sub">The first task didn’t finish: ${esc(task.reason ?? 'no reason given')}. Setup is still done.</p></div>`;
  return `<div class="setup-done">${lookingIntoItCard(task)}</div>`;
}

function render() {
  const log = view.transcript.map((t) => chatBubble({ from: t.from === 'person' ? 'person' : 'nova', text: t.text })).join('');
  const dock = view.done
    ? '<div class="dock"><button type="button" class="btn primary" data-action="setup-continue">Continue to Nova</button></div>'
    : `<div class="dock"><form class="composer" id="setup-form"><label class="sr-only" for="setup-input">Answer Nova</label><textarea id="setup-input" rows="1" placeholder="Your answer…" autocomplete="off"></textarea><button type="submit" class="send" aria-label="Send">${ICONS.send}</button></form></div>`;
  el.innerHTML = `<div class="setup-panel" role="dialog" aria-modal="true" aria-labelledby="setup-title">
  <header class="setup-head">${liveOrb('rail')}<div><h1 class="setup-title" id="setup-title">Setting up Nova</h1><p class="setup-sub">A few quick questions. You can change any answer later just by telling Nova.</p></div></header>
  <div class="setup-log" id="setup-log" aria-live="polite">${log}${result()}</div>
  ${dock}
</div>`;
  const scroll = document.getElementById('setup-log');
  scroll.scrollTop = scroll.scrollHeight;
}

async function loadTask() {
  if (!view?.first_task) return;
  try { task = await api('GET', `/tasks/${encodeURIComponent(view.first_task)}`); } catch { return; }
  if (!el.hidden) render();
}

async function answer(text) {
  if (sending || !text.trim()) return;
  sending = true;
  try {
    const res = await api('POST', '/setup/messages', { text });
    view = res.view;
    render();
    if (view.done) { await loadTask(); el.querySelector('[data-action="setup-continue"]')?.focus(); }
    else document.getElementById('setup-input')?.focus();
  } catch (e) {
    toast(e.message);
    const input = document.getElementById('setup-input');
    if (input) { input.value = text; input.focus(); }
  } finally { sending = false; }
}

el.addEventListener('submit', (e) => {
  if (e.target.id !== 'setup-form') return;
  e.preventDefault();
  const input = document.getElementById('setup-input');
  const text = input.value;
  input.value = '';
  answer(text);
});
el.addEventListener('keydown', (e) => {
  if (e.target.id === 'setup-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});
el.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  if (b.dataset.action === 'setup-continue') finish();
  if (b.dataset.action === 'evidence' && task) openSheet(evidenceViewer(task), { label: task.title });
});

// The welcome task moves through the ledger while the person reads; follow it.
on('task', (t) => { if (view?.first_task && t?.id === view.first_task && !el.hidden) loadTask(); });
// Setup finished somewhere else (another tab or device).
on('setup', async (s) => {
  if (el.hidden || !s?.done || view?.done) return;
  try { view = await api('GET', '/setup'); render(); loadTask(); } catch {}
});
