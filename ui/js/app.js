// Nova's chat surface. State comes from the server as a snapshot plus a live
// event stream; the view is rebuilt from state, patching only what changed so
// nothing that is already on screen animates twice.
import { applyEvent, emptySession } from './reduce.js';
import { renderMarkdown } from './markdown.js';
import { icons, memoryIndex, renderBlocks, renderEmpty, renderMemory, renderToc } from './view.js';
import { THEMES, MODES, apply as applyTheme, choose as chooseTheme, current as currentTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), toc: $('toc'), thread: $('thread'), scroller: $('scroller'), title: $('title'),
  input: $('input'), send: $('send'), composer: $('composer'), hint: $('hint'), banner: $('banner'),
  jump: $('jump'), status: $('status'), menu: $('menu'), scrim: $('scrim'), newChat: $('new-chat'),
  settings: $('settings'), appearance: $('appearance'),
  memory: $('memory'), memoryLink: $('memory-link'), memoryCount: $('memory-count'), dock: $('dock'), toast: $('toast'),
};

const state = {
  list: [],
  id: null,
  session: emptySession(),
  live: null,
  pending: null,        // a message on its way to the server
  reachable: true,
  online: navigator.onLine,
  stick: true,
  notice: '',
  view: 'chat',         // 'chat' | 'memory'
  memory: null,         // what Nova knows, from /api/memory
  memoryError: '',
  memIndex: new Map(),  // id → entry, for the notes in conversation margins
  forgotten: null,      // the last forget, for Undo
};

let stream = null;
let rendered = new Map(); // block key → html
const approvalsShown = new Set();

// ---- server --------------------------------------------------------------

async function post(path, body = {}) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify(body) });
  } catch {
    setReachable(false);
    throw new Error("Nova's server didn't answer.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

async function loadList() {
  try {
    const res = await fetch('/api/sessions');
    state.list = await res.json();
    setReachable(true);
  } catch { setReachable(false); }
  renderToc_();
}

let memoryLoad = null;
function loadMemory() {
  memoryLoad = fetch('/api/memory')
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((data) => {
      state.memory = data;
      state.memoryError = '';
      state.memIndex = memoryIndex(data);
      const kept = data.sections.reduce((n, sec) => n + sec.entries.length, 0);
      el.memoryCount.textContent = kept ? String(kept) : '';
      if (state.view === 'memory') renderMemoryView();
      else if (state.session.turns.length) renderThread();
    })
    .catch(() => {
      state.memoryError = "Nova's server didn't answer, so memory can't be read right now.";
      if (state.view === 'memory' && !state.memory) renderMemoryView();
    });
  return memoryLoad;
}

// Changes that aren't one conversation's: memory, and the list of conversations.
function watch() {
  const es = new EventSource('/api/events');
  es.addEventListener('memory', () => loadMemory());
  es.addEventListener('sessions', () => loadList());
}

let healthTimer = null;
function setReachable(ok) {
  if (state.reachable === ok) return;
  state.reachable = ok;
  renderChrome();
  clearTimeout(healthTimer);
  if (!ok) {
    const check = () => fetch('/api/health').then((r) => {
      if (!r.ok) throw new Error();
      setReachable(true);
      loadList();
      if (state.id && (!stream || stream.readyState === EventSource.CLOSED)) open(state.id, { quiet: true });
    }).catch(() => { healthTimer = setTimeout(check, 2000); });
    healthTimer = setTimeout(check, 2000);
  }
}

// ---- routing -------------------------------------------------------------

function route() {
  const m = location.pathname.match(/^\/c\/([\w-]+)$/);
  if (location.pathname === '/memory') showMemory();
  else if (m) open(m[1]);
  else startNew();
}

function setView(view) {
  state.view = view;
  el.thread.hidden = view !== 'chat';
  el.memory.hidden = view !== 'memory';
  el.dock.hidden = view !== 'chat';
  if (view !== 'chat') el.jump.hidden = true;
  el.memoryLink.toggleAttribute('aria-current', view === 'memory');
  if (view === 'memory') el.memoryLink.setAttribute('aria-current', 'page');
}

function navigate(path) {
  if (location.pathname + location.hash !== path) history.pushState(null, '', path);
  route();
}

function startNew() {
  stream?.close();
  stream = null;
  setView('chat');
  Object.assign(state, { id: null, session: emptySession(), live: null, pending: null, stick: true });
  restoreDraft();
  renderAll({ enter: true });
  el.input.focus();
}

function open(id, { quiet = false } = {}) {
  stream?.close();
  setView('chat');
  if (!quiet || state.id !== id) Object.assign(state, { id, live: null, pending: state.pending?.sessionId === id ? state.pending : null, stick: true });
  restoreDraft();
  const es = new EventSource(`/api/sessions/${id}/events`);
  stream = es;
  let first = true;
  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    state.session = snap.session;
    state.live = snap.live;
    if (state.pending && state.session.turns.some((t) => t.text === state.pending.text && t.ts >= state.pending.since)) state.pending = null;
    renderAll({ enter: first && !quiet });
    first = false;
  });
  es.addEventListener('event', (e) => onEvent(JSON.parse(e.data)));
  es.addEventListener('live', (e) => { state.live = JSON.parse(e.data); renderThread(); renderChrome(); });
  es.addEventListener('delta', (e) => {
    const d = JSON.parse(e.data);
    if (!state.live || state.live.turn !== d.turn || state.live.attempt !== d.attempt) return;
    state.live.text = (state.live.text || '') + d.text;
    state.live.phase = 'streaming';
    scheduleLiveText();
  });
  es.addEventListener('open', () => setReachable(true));
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) { setReachable(false); return; }
    setTimeout(() => { if (es === stream && es.readyState !== EventSource.OPEN) setReachable(false); }, 1500);
  });
}

function onEvent(ev) {
  applyEvent(state.session, ev);
  if (ev.type === 'user') state.pending = null;
  if (ev.type === 'assistant' && state.live?.turn === ev.turn) state.live.text = '';
  if (ev.type === 'session' || ev.type === 'title') loadList();
  renderThread();
  renderChrome();
}

// ---- rendering -----------------------------------------------------------

function viewSession() {
  if (!state.pending) return state.session;
  const turn = { id: 'pending', text: state.pending.text, ts: state.pending.since, attempt: 0, items: [], state: 'open' };
  return { ...state.session, turns: [...state.session.turns, turn] };
}

function viewLive() {
  if (state.pending) return { turn: 'pending', attempt: 0, phase: 'thinking', text: '' };
  return state.live;
}

function renderAll({ enter = false } = {}) {
  rendered = new Map();
  el.thread.innerHTML = '';
  el.thread.classList.add('no-anim');
  renderThread();
  requestAnimationFrame(() => el.thread.classList.remove('no-anim'));
  if (enter) {
    el.thread.classList.remove('view-enter');
    void el.thread.offsetWidth;
    el.thread.classList.add('view-enter');
  }
  renderChrome();
  renderToc_();
  const target = location.hash.startsWith('#t-') && document.getElementById(location.hash.slice(1));
  if (target) {
    state.stick = false;
    target.scrollIntoView({ block: 'start' });
    flash(target);
  } else scrollToEnd(true);
}

// Briefly mark what a link pointed at.
function flash(node) {
  node.classList.remove('is-found');
  void node.offsetWidth;
  node.classList.add('is-found');
}

function renderThread() {
  const session = viewSession();
  const wasNear = nearBottom();
  if (!session.turns.length) {
    if (!el.thread.querySelector('.empty')) { el.thread.innerHTML = renderEmpty(); rendered = new Map(); }
    return;
  }
  el.thread.querySelector('.empty')?.remove();
  const blocks = renderBlocks(session, viewLive(), new Date(), state.memIndex);
  const keep = new Set(blocks.map((b) => b.key));
  for (const node of [...el.thread.children]) if (!keep.has(node.dataset.key)) { node.remove(); rendered.delete(node.dataset.key); }
  let prev = null;
  for (const b of blocks) {
    let node = el.thread.querySelector(`:scope > [data-key="${CSS.escape(b.key)}"]`);
    if (!node) {
      node = document.createElement('div');
      node.className = 'block';
      node.dataset.key = b.key;
      node.innerHTML = b.html;
      node.querySelector('.turn')?.classList.add('is-new');
      prev ? prev.after(node) : el.thread.prepend(node);
    } else if (rendered.get(b.key) !== b.html) {
      patch(node, b.html);
    }
    rendered.set(b.key, b.html);
    prev = node;
  }
  placeCaret();
  afterRender();
  if (wasNear || state.stick) scrollToEnd();
  else el.jump.hidden = false;
}

// Replace only the children that changed, so finished content stays still.
function patch(node, html) {
  const next = document.createElement('div');
  next.innerHTML = html;
  morph(node, next);
}

function morph(a, b) {
  const ac = [...a.children];
  const bc = [...b.children];
  bc.forEach((nb, i) => {
    const na = ac[i];
    if (!na) { a.append(nb); return; }
    if (na.outerHTML === nb.outerHTML) return;
    if (na.matches('[data-live]') && nb.matches('.prose')) {
      // Streamed text becomes the saved reply in place, without a flicker.
      na.removeAttribute('data-live');
      na.className = nb.className;
      na.dataset.text = nb.dataset.text;
      na.innerHTML = nb.innerHTML;
      return;
    }
    if (na.tagName === nb.tagName && (na.matches('.turn, .msg-nova, .msg-user') )) {
      for (const { name, value } of [...nb.attributes]) na.setAttribute(name, value);
      morph(na, nb);
      return;
    }
    if (na.matches('details') && nb.matches('details') && na.open) nb.open = true;
    na.replaceWith(nb);
  });
  for (const extra of ac.slice(bc.length)) extra.remove();
}

let liveFrame = 0;
function scheduleLiveText() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    const node = el.thread.querySelector('[data-live]');
    if (!node) { renderThread(); return; }
    const wasNear = nearBottom();
    node.innerHTML = renderMarkdown(state.live?.text ?? '');
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.setAttribute('aria-hidden', 'true');
    node.append(caret);
    placeCaret();
    if (wasNear || state.stick) scrollToEnd();
  });
}

// Put the caret at the end of the last line of text, not below it.
function placeCaret() {
  const node = el.thread.querySelector('[data-live]');
  const caret = node?.querySelector(':scope > .caret');
  if (!caret) return;
  const blocks = node.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, pre code');
  const last = blocks[blocks.length - 1];
  if (last && node.lastElementChild !== last) last.append(caret);
}

function afterRender() {
  // A new approval takes focus, unless the user is in the middle of typing.
  const card = el.thread.querySelector('.approval');
  if (card && !approvalsShown.has(card.dataset.tool)) {
    approvalsShown.add(card.dataset.tool);
    const typing = document.activeElement === el.input && el.input.value.trim();
    if (!typing && !el.settings.open) card.querySelector('[data-action="allow"]').focus({ preventScroll: true });
  }
  for (const rec of el.thread.querySelectorAll('.record[data-tool]')) {
    if (approvalsShown.has(rec.dataset.tool) && rec.querySelector('.stamp')) {
      approvalsShown.delete(rec.dataset.tool);
      rec.classList.add('is-new');
      if (document.activeElement === document.body) el.input.focus({ preventScroll: true });
    }
  }
}

function running() {
  return !!state.pending || !!state.live;
}

function renderChrome() {
  const title = state.view === 'memory' ? 'Memory' : state.id ? state.session.title || 'Untitled' : '';
  el.title.textContent = title;
  document.title = title ? `${title} · Nova` : 'Nova';

  const run = running();
  const hasText = !!el.input.value.trim();
  el.send.innerHTML = run ? icons.stop : icons.send;
  el.send.classList.toggle('is-stop', run);
  el.send.setAttribute('aria-label', run ? 'Stop' : 'Send');
  el.send.title = run ? 'Stop (Esc)' : 'Send (Enter)';
  el.send.disabled = run ? !!state.pending : !hasText || !state.reachable;

  let banner = '';
  if (!state.reachable) banner = "Nova's server isn't answering. Your conversations are safe on disk; this page reconnects when it's back.";
  else if (!state.online) banner = "You're offline. Nova can still read your files, but replies need a connection.";
  el.banner.hidden = !banner;
  el.banner.textContent = banner;
  el.status.textContent = state.reachable ? '' : 'Reconnecting';
  el.status.dataset.state = state.reachable ? 'ok' : 'offline';

  let hint = state.notice;
  if (!hint && run) hint = 'Esc to stop';
  else if (!hint && document.activeElement === el.input && !hasText) hint = 'Enter to send · Shift Enter for a new line';
  el.hint.textContent = hint;
}

function renderToc_() {
  el.toc.innerHTML = renderToc(state.list, state.view === 'chat' ? state.id : null);
}

// ---- scrolling -----------------------------------------------------------

const nearBottom = () => el.scroller.scrollHeight - el.scroller.scrollTop - el.scroller.clientHeight < 80;

function scrollToEnd(force = false) {
  if (force) state.stick = true;
  el.scroller.scrollTop = el.scroller.scrollHeight;
  el.jump.hidden = true;
}

el.scroller.addEventListener('scroll', () => {
  state.stick = nearBottom();
  if (state.stick) el.jump.hidden = true;
}, { passive: true });
el.jump.addEventListener('click', () => { el.scroller.scrollTo({ top: el.scroller.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); state.stick = true; el.jump.hidden = true; el.input.focus(); });

// ---- composer ------------------------------------------------------------

const draftKey = () => `nova.draft.${state.id ?? 'new'}`;
function restoreDraft() {
  try { el.input.value = localStorage.getItem(draftKey()) ?? ''; } catch { el.input.value = ''; }
  autosize();
}
let draftTimer = 0;
function saveDraft() {
  clearTimeout(draftTimer);
  const key = draftKey();
  const value = el.input.value;
  draftTimer = setTimeout(() => { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {} }, 250);
}

function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${el.input.scrollHeight}px`;
}

function say(notice, ms = 4000) {
  state.notice = notice;
  renderChrome();
  clearTimeout(say.t);
  say.t = setTimeout(() => { state.notice = ''; renderChrome(); }, ms);
}

async function send() {
  const text = el.input.value.trim();
  if (!text || running() || !state.reachable) return;
  const sessionId = state.id;
  state.pending = { text, since: new Date().toISOString(), sessionId };
  el.input.value = '';
  autosize();
  clearTimeout(draftTimer); // a pending save would bring the sent text back as a draft
  try { localStorage.removeItem(draftKey()); } catch {}
  state.stick = true;
  renderThread();
  renderChrome();
  try {
    if (!sessionId) {
      const { id } = await post('/api/sessions', { text });
      state.pending.sessionId = id;
      history.pushState(null, '', `/c/${id}`);
      open(id);
      loadList();
    } else {
      await post(`/api/sessions/${sessionId}/messages`, { text });
    }
  } catch (e) {
    state.pending = null;
    el.input.value = text;
    autosize();
    renderThread();
    say(`${e.message} Your message is back in the box.`, 6000);
  }
}

async function stop() {
  if (!state.id || !state.live) return;
  try { await post(`/api/sessions/${state.id}/stop`); } catch (e) { say(e.message); }
}

async function regenerate() {
  if (!state.id || running()) return;
  try { await post(`/api/sessions/${state.id}/regenerate`); } catch (e) { say(e.message); }
}

async function decide(tool, decision, button) {
  const card = button?.closest('.approval');
  card?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try { await post(`/api/sessions/${state.id}/approvals/${tool}`, { decision }); }
  catch (e) { card?.querySelectorAll('button').forEach((b) => { b.disabled = false; }); say(e.message); }
}

el.composer.addEventListener('submit', (e) => { e.preventDefault(); running() ? stop() : send(); });
el.input.addEventListener('input', () => { autosize(); saveDraft(); renderChrome(); });
el.input.addEventListener('focus', renderChrome);
el.input.addEventListener('blur', () => setTimeout(renderChrome, 0));
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!running()) send(); }
});

// ---- actions in the thread -------------------------------------------------

async function copy(text, button) {
  try { await navigator.clipboard.writeText(text); } catch { say("Couldn't copy. Your browser blocked the clipboard."); return; }
  const label = button.querySelector('span') ?? button;
  const before = label.textContent;
  button.classList.add('is-done');
  label.textContent = 'Copied';
  setTimeout(() => { button.classList.remove('is-done'); label.textContent = before; }, 1600);
}

// Links between conversations and memory stay inside the app.
function followLink(e) {
  const a = e.target.closest('a[href^="/memory"], a[href^="/c/"]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return false;
  e.preventDefault();
  navigate(a.getAttribute('href'));
  return true;
}

el.thread.addEventListener('click', (e) => {
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const action = b.dataset.action;
  if (action === 'allow' || action === 'deny') decide(b.dataset.tool, action, b);
  if (action === 'regenerate') regenerate();
  if (action === 'copy-code') copy(b.closest('.code-block').querySelector('code').textContent, b);
  if (action === 'copy-user') copy(state.session.turns.find((t) => t.id === b.dataset.turn)?.text ?? '', b);
  if (action === 'copy') {
    for (const t of state.session.turns) {
      const it = t.items.find((i) => i.kind === 'text' && i.id === b.dataset.copy);
      if (it) {
        const all = t.items.filter((i) => i.kind === 'text').map((i) => i.text).join('\n\n');
        copy(all, b);
        break;
      }
    }
  }
});

// ---- memory ------------------------------------------------------------------

function showMemory() {
  stream?.close();
  stream = null;
  Object.assign(state, { id: null, live: null, pending: null });
  setView('memory');
  el.scroller.scrollTop = 0;
  renderChrome();
  renderToc_();
  renderMemoryView({ enter: true });
  loadMemory().then(() => {
    const target = location.hash.startsWith('#m-') && document.getElementById(location.hash.slice(1));
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); flash(target); }
    else el.memory.focus({ preventScroll: true }); // Tab goes straight to the first memory

  });
}

let memoryDeferred = false;
function renderMemoryView({ enter = false } = {}) {
  if (el.memory.querySelector('.is-editing')) { memoryDeferred = true; return; }
  memoryDeferred = false;
  const focused = document.activeElement?.closest?.('.memory-item')?.dataset.id;
  if (state.memory) el.memory.innerHTML = renderMemory(state.memory);
  else if (state.memoryError) el.memory.innerHTML = `<div class="empty"><p class="empty-line">Memory couldn't be read.</p><p class="memory-lede">${state.memoryError}</p><button type="button" class="btn" data-action="retry-memory">Try again</button></div>`;
  else el.memory.innerHTML = '';
  if (focused) document.getElementById(`m-${focused}`)?.focus({ preventScroll: true });
  if (enter) {
    el.memory.classList.remove('view-enter');
    void el.memory.offsetWidth;
    el.memory.classList.add('view-enter');
  }
}

function autosizeField(field) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
}

function editMemory(item) {
  if (item.classList.contains('is-editing')) return;
  const text = item.querySelector('.memory-text');
  const field = document.createElement('textarea');
  field.className = 'memory-edit';
  field.rows = 1;
  field.value = text.textContent;
  field.setAttribute('aria-label', 'Edit this memory');
  item.classList.add('is-editing');
  text.hidden = true;
  text.after(field);
  autosizeField(field);
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const next = field.value.replace(/\s+/g, ' ').trim();
    const before = text.textContent;
    field.remove();
    text.hidden = false;
    item.classList.remove('is-editing');
    item.focus({ preventScroll: true });
    if (save && next && next !== before) {
      text.textContent = next;
      try { await post(`/api/memory/${item.dataset.id}`, { text: next }); toast('Saved. Nova will use it from the next message.'); }
      catch (e) { text.textContent = before; toast(e.message); }
    }
    if (memoryDeferred) renderMemoryView();
  };
  field.addEventListener('input', () => autosizeField(field));
  field.addEventListener('blur', () => finish(true));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
}

async function forgetMemory(item) {
  const items = [...el.memory.querySelectorAll('.memory-item')];
  const next = items[items.indexOf(item) + 1] ?? items[items.indexOf(item) - 1];
  item.classList.add('is-leaving');
  try {
    const { removed } = await post(`/api/memory/${item.dataset.id}/forget`);
    state.forgotten = removed;
    await loadMemory();
    (next && document.getElementById(next.id) || el.memory.querySelector('.memory-item') || el.memoryLink).focus({ preventScroll: true });
    const notes = removed.length - 1;
    toast(notes ? `Forgotten, with ${notes} day note${notes > 1 ? 's' : ''} that said the same.` : 'Forgotten.', { undo: true });
  } catch (e) {
    item.classList.remove('is-leaving');
    toast(e.message);
  }
}

async function undoForget() {
  const items = state.forgotten;
  if (!items) return;
  state.forgotten = null;
  try {
    await post('/api/memory/restore', { items });
    await loadMemory();
    document.getElementById(`m-${items[0].id}`)?.focus();
    toast('Back in memory.');
  } catch (e) { toast(e.message); }
}

let toastTimer = 0;
function toast(text, { undo = false } = {}) {
  el.toast.innerHTML = `<span>${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</span>${undo ? '<button type="button" class="toast-btn" data-action="undo">Undo</button>' : ''}`;
  el.toast.hidden = false;
  el.toast.classList.remove('view-enter');
  void el.toast.offsetWidth;
  el.toast.classList.add('view-enter');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; if (undo) state.forgotten = null; }, undo ? 8000 : 3200);
}
el.toast.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="undo"]')) { el.toast.hidden = true; undoForget(); }
});

el.memory.addEventListener('click', (e) => {
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  const item = e.target.closest('.memory-item');
  if (b?.dataset.action === 'edit-memory') editMemory(item);
  else if (b?.dataset.action === 'forget-memory') forgetMemory(item);
  else if (b?.dataset.action === 'retry-memory') loadMemory();
  else if (item && e.target.closest('.memory-text')) editMemory(item);
});
el.memory.addEventListener('keydown', (e) => {
  const item = e.target.closest('.memory-item');
  if (!item || e.target !== item) return;
  const items = [...el.memory.querySelectorAll('.memory-item')];
  const i = items.indexOf(item);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
  if (e.key === 'Enter') { e.preventDefault(); editMemory(item); }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); forgetMemory(item); }
});
el.memoryLink.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  closeDrawer();
  navigate('/memory');
});

// ---- navigation ------------------------------------------------------------

el.toc.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-id]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  closeDrawer();
  navigate(`/c/${a.dataset.id}`);
});
document.querySelector('[data-nav="home"]').addEventListener('click', (e) => { e.preventDefault(); closeDrawer(); navigate('/'); });
el.newChat.innerHTML = icons.plus;
el.newChat.addEventListener('click', () => { closeDrawer(); navigate('/'); });
window.addEventListener('popstate', route);

el.menu.innerHTML = icons.menu;
el.menu.addEventListener('click', () => {
  const opening = !el.app.classList.contains('drawer-open');
  el.app.classList.toggle('drawer-open', opening);
  el.menu.setAttribute('aria-expanded', String(opening));
  if (opening) (el.toc.querySelector('[aria-current]') ?? el.newChat).focus();
});
el.scrim.addEventListener('click', closeDrawer);
function closeDrawer() {
  if (!el.app.classList.contains('drawer-open')) return;
  el.app.classList.remove('drawer-open');
  el.menu.setAttribute('aria-expanded', 'false');
}

function step(dir) {
  const i = state.list.findIndex((s) => s.id === state.id);
  const next = state.list[i < 0 ? (dir > 0 ? 0 : -1) : i + dir];
  if (next) navigate(`/c/${next.id}`);
}

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const inField = e.target.closest?.('input, textarea, [contenteditable]');
  if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); navigate('/'); return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); step(e.key === 'ArrowUp' ? -1 : 1); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && !inField && state.view === 'memory' && state.forgotten) { e.preventDefault(); el.toast.hidden = true; undoForget(); return; }
  if (e.key === '/' && !inField && !el.settings.open && state.view === 'chat') { e.preventDefault(); el.input.focus(); return; }
  if (e.key === 'Escape' && !el.settings.open) {
    if (el.app.classList.contains('drawer-open')) { closeDrawer(); el.menu.focus(); return; }
    const card = e.target.closest?.('.approval');
    if (card) { e.preventDefault(); decide(card.dataset.tool, 'deny', card.querySelector('button')); return; }
    if (state.live) { e.preventDefault(); stop(); }
  }
});

// ---- appearance ------------------------------------------------------------

function renderSettings() {
  const cur = currentTheme();
  $('theme-choices').innerHTML = THEMES.map((t) => `<label class="choice"><input type="radio" name="theme" value="${t.id}"${t.id === cur.theme ? ' checked' : ''}><span class="choice-name">${t.name}</span><span class="choice-note">${t.note}</span></label>`).join('');
  $('mode-choices').innerHTML = MODES.map((m) => `<label class="choice"><input type="radio" name="mode" value="${m}"${m === cur.mode ? ' checked' : ''}><span class="choice-name">${m[0].toUpperCase()}${m.slice(1)}</span></label>`).join('');
}
el.appearance.addEventListener('click', () => { renderSettings(); el.settings.showModal(); });
el.settings.addEventListener('change', (e) => {
  if (e.target.name === 'theme') chooseTheme({ theme: e.target.value });
  if (e.target.name === 'mode') chooseTheme({ mode: e.target.value });
});
el.settings.addEventListener('close', () => el.appearance.focus());

// ---- start -----------------------------------------------------------------

window.addEventListener('online', () => { state.online = true; renderChrome(); });
window.addEventListener('offline', () => { state.online = false; renderChrome(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadList(); });

applyTheme();
loadList();
loadMemory();
watch();
route();
document.documentElement.dataset.ready = 'true';
