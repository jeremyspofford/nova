// Nova's chat surface. State comes from the server as a snapshot plus a live
// event stream; the view is rebuilt from state, patching only what changed so
// nothing that is already on screen animates twice.
import { applyEvent, emptySession } from './reduce.js';
import { renderMarkdown } from './markdown.js';
import { dayKey, icons, memoryIndex, renderActivity, renderBlocks, renderEmpty, renderMemory, renderSchedules, renderSettings as renderSettingsPage, renderSkills, renderToc, renderToday, renderWorkNote } from './view.js';
import { THEMES, MODES, apply as applyTheme, choose as chooseTheme, current as currentTheme } from './theme.js';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), toc: $('toc'), thread: $('thread'), scroller: $('scroller'), title: $('title'),
  input: $('input'), send: $('send'), composer: $('composer'), hint: $('hint'), banner: $('banner'),
  jump: $('jump'), status: $('status'), menu: $('menu'), scrim: $('scrim'), newChat: $('new-chat'),
  sidebar: $('sidebar'), collapse: $('collapse'),
  memory: $('memory'), memoryLink: $('memory-link'), memoryCount: $('memory-count'), dock: $('dock'), toast: $('toast'),
  skills: $('skills'), skillsLink: $('skills-link'), skillsCount: $('skills-count'),
  schedules: $('schedules'), schedulesLink: $('schedules-link'), schedulesCount: $('schedules-count'),
  mainLink: $('main-link'), mainDot: $('main-dot'),
  activity: $('activity'), activityLink: $('activity-link'), activityPulse: $('activity-pulse'), activityWaiting: $('activity-waiting'),
  settings: $('settings-view'), settingsLink: $('settings-link'),
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
  view: 'chat',         // 'chat' | 'memory' | 'skills' | 'schedules' | 'activity'
  memory: null,         // what Nova knows, from /api/memory
  memoryError: '',
  memIndex: new Map(),  // id → entry, for the notes in conversation margins
  undo: null,           // the last forget or removal: () => Promise
  skills: null,         // installed and available skills, and connections
  skillsError: '',
  skillIds: null,       // installed skill ids, for conversation margins
  noticeAt: 0,          // the last Gmail sign-in notice shown
  schedules: null,      // what's scheduled, from /api/schedules
  schedulesError: '',
  activity: null,       // this week, from /api/activity
  earlier: [],          // weeks before it, as the person asks for them
  activityError: '',
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

function loadSkills() {
  return fetch('/api/skills')
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((data) => {
      state.skills = data;
      state.skillsError = '';
      state.skillIds = new Set(data.installed.map((s) => s.id));
      el.skillsCount.textContent = data.installed.length ? String(data.installed.length) : '';
      // How a Gmail sign-in went, once, on the page Google sent the person back to.
      const notice = data.connectors?.gmail?.notice;
      if (notice && notice.at !== state.noticeAt && state.view === 'skills' && location.hash === '#gmail' && !state.leaving) {
        state.noticeAt = notice.at;
        let seen = 0;
        try { seen = Number(sessionStorage.getItem('nova.notice')) || 0; sessionStorage.setItem('nova.notice', String(notice.at)); } catch {}
        if (seen !== notice.at) toast(notice.text);
      }
      if (state.view === 'skills') renderSkillsView();
      else if (state.session.turns.length) renderThread();
    })
    .catch(() => {
      state.skillsError = "Nova's server didn't answer, so skills can't be shown right now.";
      if (state.view === 'skills' && !state.skills) renderSkillsView();
    });
}

function loadSchedules() {
  return fetch('/api/schedules')
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((data) => {
      state.schedules = data;
      state.schedulesError = '';
      const on = data.set.filter((s) => !s.paused && !s.error).length;
      el.schedulesCount.textContent = on ? String(on) : '';
      // A report that arrived in the main conversation since it was last open.
      const latest = data.set.map((s) => s.last).filter((r) => r?.delivered === 'main' && r.finished).map((r) => r.finished).sort().at(-1);
      if (latest && latest > seenMain() && !onMain()) el.mainDot.hidden = false;
      if (state.view === 'schedules') renderSchedulesView();
    })
    .catch(() => {
      state.schedulesError = "Nova's server didn't answer, so schedules can't be shown right now.";
      if (state.view === 'schedules' && !state.schedules) renderSchedulesView();
    });
}

const onMain = () => state.view === 'chat' && state.id === 'main';
const seenMain = () => { try { return localStorage.getItem('nova.mainSeen') ?? ''; } catch { return ''; } };
function markMainSeen() {
  el.mainDot.hidden = true;
  try { localStorage.setItem('nova.mainSeen', new Date().toISOString()); } catch {}
}

let activityLoad = null;
function loadActivity() {
  activityLoad = fetch('/api/activity')
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((data) => {
      state.activity = data;
      state.activityError = '';
      showBusy(data.busy);
      if (state.view === 'activity') renderActivityView();
    })
    .catch(() => {
      state.activityError = "Nova's server didn't answer, so activity can't be shown right now.";
      if (state.view === 'activity' && !state.activity) renderActivityView();
    });
  return activityLoad;
}

// The sidebar breathes while Nova works anywhere, and says when something waits for the person.
function showBusy(busy = {}) {
  el.activityPulse.hidden = !busy.working || !!busy.waiting;
  el.activityWaiting.textContent = busy.waiting ? `${busy.waiting} waiting` : '';
  el.activityLink.setAttribute('aria-label', busy.waiting ? `Activity, ${busy.waiting} waiting for you` : busy.working ? 'Activity, Nova is working' : 'Activity');
}

// Changes that aren't one conversation's: memory, skills, schedules, activity, and the list of conversations.
function watch() {
  const es = new EventSource('/api/events');
  es.addEventListener('activity', (e) => {
    showBusy(JSON.parse(e.data));
    if (state.view === 'activity' && !document.hidden) loadActivity();
  });
  es.addEventListener('memory', () => loadMemory());
  es.addEventListener('skills', () => loadSkills());
  es.addEventListener('schedules', () => loadSchedules());
  es.addEventListener('permissions', () => { if (state.view === 'settings') loadPermissions(); });
  es.addEventListener('handoff', (e) => {
    if (JSON.parse(e.data).target !== 'main') return;
    if (onMain()) markMainSeen();
    else el.mainDot.hidden = false;
  });
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

// "/" is the main conversation, the front page; "/new" starts another.
function route() {
  const path = location.pathname;
  const m = path.match(/^\/c\/([\w-]+)$/);
  if (path === '/memory') showMemory();
  else if (path === '/skills') showSkills();
  else if (path === '/schedules') showSchedules();
  else if (path === '/activity') showActivity();
  else if (path === '/settings') showSettings();
  else if (path === '/new') startNew();
  else if (m && m[1] !== 'main') open(m[1]);
  else {
    if (path !== '/') history.replaceState(null, '', `/${location.hash}`);
    open('main');
    if (!location.hash) el.input.focus({ preventScroll: true });
  }
}

function setView(view) {
  state.view = view;
  el.thread.hidden = view !== 'chat';
  el.memory.hidden = view !== 'memory';
  el.skills.hidden = view !== 'skills';
  el.schedules.hidden = view !== 'schedules';
  el.activity.hidden = view !== 'activity';
  el.settings.hidden = view !== 'settings';
  el.dock.hidden = view !== 'chat';
  if (view !== 'chat') el.jump.hidden = true;
  for (const [link, v] of [[el.memoryLink, 'memory'], [el.skillsLink, 'skills'], [el.schedulesLink, 'schedules'], [el.activityLink, 'activity'], [el.settingsLink, 'settings']]) {
    if (view === v) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
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
  if (id === 'main') markMainSeen();
  const es = new EventSource(`/api/sessions/${id}/events`);
  stream = es;
  let first = true;
  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    state.session = snap.session;
    state.live = snap.live;
    if (state.pending && state.session.turns.some((t) => !t.kind && t.text === state.pending.text && t.ts >= state.pending.since)) state.pending = null;
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
  const target = /^#[th]-/.test(location.hash) && document.getElementById(location.hash.slice(1));
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
    if (!el.thread.querySelector('.empty')) { el.thread.innerHTML = renderEmpty(new Date(), { fresh: !state.id }); rendered = new Map(); }
    return;
  }
  el.thread.querySelector('.empty')?.remove();
  const blocks = renderBlocks(session, viewLive(), new Date(), state.memIndex, state.skillIds);
  if (readOnly()) blocks.unshift({ key: 'work-note', html: renderWorkNote(session, session.parent === 'main' ? 'the main conversation' : state.list.find((c) => c.id === session.parent)?.title) });
  // The front page always ends on today, even before anything has happened.
  const lastTs = session.turns.at(-1).ts;
  if (state.id === 'main' && lastTs && dayKey(new Date(lastTs)) !== dayKey(new Date())) blocks.push({ key: 'today', html: renderToday() });
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
    if (!typing) card.querySelector('[data-action="allow"]').focus({ preventScroll: true });
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

// A helper's or a scheduled run's own log: there to read, not to reply to.
const readOnly = () => state.view === 'chat' && ['helper', 'run'].includes(state.session.kind);

function renderChrome() {
  const title = { memory: 'Memory', skills: 'Skills', schedules: 'Schedules', activity: 'Activity', settings: 'Settings' }[state.view] ?? (state.id && state.id !== 'main' ? state.session.title || 'Untitled' : '');
  el.dock.hidden = state.view !== 'chat' || readOnly();
  if (onMain()) el.mainLink.setAttribute('aria-current', 'page');
  else el.mainLink.removeAttribute('aria-current');
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
  const a = e.target.closest('a[href^="/memory"], a[href^="/skills"], a[href^="/schedules"], a[href^="/activity"], a[href^="/settings"], a[href^="/c/"], a[href^="/#"], a[href="/"]');
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
  if (action === 'run-schedule') runSchedule(b.dataset.schedule, b);
  if (action === 'retry-helper') retryHelper(b.dataset.run, b);
  if (action === 'copy-code') copy(b.closest('.code-block').querySelector('code').textContent, b);
  if (action === 'copy-user') copy(state.session.turns.find((t) => t.id === b.dataset.turn)?.text ?? '', b);
  if (action === 'copy') {
    const report = state.session.turns.find((t) => t.kind === 'handoff' && t.id === b.dataset.copy);
    if (report) { copy(report.text, b); return; }
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
    state.undo = () => undoForget(removed);
    await loadMemory();
    (next && document.getElementById(next.id) || el.memory.querySelector('.memory-item') || el.memoryLink).focus({ preventScroll: true });
    const notes = removed.length - 1;
    toast(notes ? `Forgotten, with ${notes} day note${notes > 1 ? 's' : ''} that said the same.` : 'Forgotten.', { undo: true });
  } catch (e) {
    item.classList.remove('is-leaving');
    toast(e.message);
  }
}

async function undoForget(items) {
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
  toastTimer = setTimeout(() => { el.toast.hidden = true; if (undo) state.undo = null; }, undo ? 8000 : 3200);
}
function runUndo() {
  const undo = state.undo;
  if (!undo) return;
  state.undo = null;
  el.toast.hidden = true;
  undo();
}
el.toast.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="undo"]')) runUndo();
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

// ---- skills ----------------------------------------------------------------

const isLocal = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

function showSkills() {
  stream?.close();
  stream = null;
  Object.assign(state, { id: null, live: null, pending: null });
  setView('skills');
  el.scroller.scrollTop = 0;
  renderChrome();
  renderToc_();
  renderSkillsView({ enter: true });
  loadSkills().then(() => {
    const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
    if (target) {
      target.scrollIntoView({ block: 'center' });
      (target.matches('.skill') ? target : target.querySelector('input, button, textarea') ?? target).focus({ preventScroll: true });
      flash(target.matches('.skill') ? target : target.querySelector('.connection, .dropzone') ?? target);
    } else el.skills.focus({ preventScroll: true });
  });
}

const GMAIL_FIELDS = ['gmail-client', 'gmail-email', 'gmail-password'];

function renderSkillsView({ enter = false } = {}) {
  // What the person was typing survives a re-render (another tab, a sign-in).
  const typed = Object.fromEntries(GMAIL_FIELDS.map((id) => [id, $(id)?.value]).filter(([, v]) => v));
  const focused = document.activeElement;
  const focusKey = focused?.closest?.('.skill')?.id ?? (GMAIL_FIELDS.includes(focused?.id) ? focused.id : null);
  const advancedOpen = el.skills.querySelector('.connection-advanced')?.open;
  const open = [...el.skills.querySelectorAll('.skill-playbook[open]')].map((d) => d.closest('.skill').id);
  if (state.skills) el.skills.innerHTML = renderSkills(state.skills, { local: isLocal() });
  else if (state.skillsError) el.skills.innerHTML = `<div class="empty"><p class="empty-line">Skills couldn't be shown.</p><p class="memory-lede">${state.skillsError}</p><button type="button" class="btn" data-action="retry-skills">Try again</button></div>`;
  else el.skills.innerHTML = '';
  for (const id of open) document.querySelector(`#${CSS.escape(id)} .skill-playbook`)?.setAttribute('open', '');
  for (const [id, v] of Object.entries(typed)) if ($(id)) $(id).value = v;
  if (advancedOpen) el.skills.querySelector('.connection-advanced')?.setAttribute('open', '');
  if (focusKey) $(focusKey)?.focus({ preventScroll: true });
  if (enter) {
    el.skills.classList.remove('view-enter');
    void el.skills.offsetWidth;
    el.skills.classList.add('view-enter');
  }
}

async function installSkill(item) {
  const button = item.querySelector('[data-action="install-skill"]');
  button.disabled = true;
  try {
    await post(`/api/skills/${item.dataset.id}/install`);
    await loadSkills();
    const now = $(`s-${item.dataset.id}`);
    now?.focus({ preventScroll: true });
    if (now) { now.scrollIntoView({ block: 'nearest' }); flash(now); }
    toast('Installed. Nova uses it from your next message.');
  } catch (e) { button.disabled = false; toast(e.message); }
}

async function removeSkill(item) {
  const id = item.dataset.id;
  const name = item.querySelector('.skill-name').textContent;
  const items = [...el.skills.querySelectorAll('.skill:not(.is-available)')];
  const next = items[items.indexOf(item) + 1] ?? items[items.indexOf(item) - 1];
  item.classList.add('is-leaving');
  try {
    const { files } = await post(`/api/skills/${id}/remove`);
    state.undo = async () => {
      try {
        await post(`/api/skills/${id}/restore`, { files });
        await loadSkills();
        $(`s-${id}`)?.focus();
        toast('Back, exactly as it was.');
      } catch (e) { toast(e.message); }
    };
    await loadSkills();
    (next && $(next.id) || el.skills.querySelector('.skill') || el.skillsLink).focus({ preventScroll: true });
    toast(`Removed ${name}. Nothing of it is left.`, { undo: true });
  } catch (e) {
    item.classList.remove('is-leaving');
    toast(e.message);
  }
}

function trySkill(text) {
  navigate('/new');
  el.input.value = text;
  autosize();
  saveDraft();
  renderChrome();
  el.input.focus();
  el.input.setSelectionRange(text.length, text.length);
}

async function gmailAction(action, button) {
  if (button) button.disabled = true;
  try {
    if (action === 'connect-password') {
      const email = $('gmail-email').value.trim();
      const password = $('gmail-password').value;
      if (!email) { toast('Enter your Gmail address.'); $('gmail-email').focus(); return; }
      if (!password.trim()) { toast('Paste the app password Google showed you.'); $('gmail-password').focus(); return; }
      if (button) button.textContent = 'Connecting…';
      try {
        const status = await post('/api/connectors/gmail/password', { email, password });
        $('gmail-password').value = '';
        await loadSkills();
        el.skills.querySelector('[data-action="disconnect-gmail"]')?.focus({ preventScroll: true });
        flash(el.skills.querySelector('.connection'));
        toast(status.notice?.text ?? 'Gmail is connected.');
      } catch (e) {
        if (button?.isConnected) button.textContent = 'Connect Gmail';
        toast(e.message);
        $('gmail-password')?.select();
      }
      return;
    }
    if (action === 'save-client') {
      const json = $('gmail-client').value.trim();
      if (!json) { toast('Paste the JSON you downloaded from Google first.'); $('gmail-client').focus(); return; }
      await post('/api/connectors/gmail/client', { json });
      await loadSkills();
      el.skills.querySelector('[data-action="connect-gmail"]')?.focus();
      toast('Saved. Now connect Gmail.');
    }
    if (action === 'connect-gmail') {
      const { url } = await post('/api/connectors/gmail/connect');
      state.leaving = true; // this page is about to go to Google
      location.assign(url);
      return;
    }
    if (action === 'disconnect-gmail') {
      const { revoked, password } = await post('/api/connectors/gmail/disconnect');
      await loadSkills();
      toast(password ? 'Disconnected. The app password is gone from this computer.'
        : revoked ? 'Disconnected. Google no longer lets Nova into your mail.' : "Disconnected here. Google didn't answer, so also remove Nova in your Google account's security settings.");
    }
    if (action === 'forget-client') {
      await post('/api/connectors/gmail/forget-client');
      await loadSkills();
      $('gmail-client')?.focus();
    }
  } catch (e) { toast(e.message); }
  finally { if (button?.isConnected) button.disabled = false; }
}

// ---- adding a skill: a folder or a .zip, chosen or dropped ----

const MAX_SKILL = 5_000_000;
function base64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function addSkill(body) {
  try {
    const { skill } = await post('/api/skills/add', body);
    await loadSkills();
    const now = $(`s-${skill.id}`);
    if (now) { now.scrollIntoView({ block: 'center' }); now.focus({ preventScroll: true }); flash(now); }
    toast(`Added ${skill.name}. Nova uses it from your next message.`);
  } catch (e) { toast(e.message); }
}

// [{ path, file }] → the request body.
async function addFiles(list) {
  const size = list.reduce((n, f) => n + f.file.size, 0);
  if (size > MAX_SKILL) { toast('That skill is too big to add. Skills can be up to 5 MB.'); return; }
  if (list.length === 1 && /\.zip$/i.test(list[0].path)) return addSkill({ zip: base64(await list[0].file.arrayBuffer()) });
  const files = {};
  for (const { path, file } of list) files[path] = { base64: base64(await file.arrayBuffer()) };
  return addSkill({ files });
}

// A dropped folder arrives as entries to walk.
async function walkEntry(entry, prefix = '') {
  if (entry.isFile) return [{ path: prefix + entry.name, file: await new Promise((ok, fail) => entry.file(ok, fail)) }];
  const reader = entry.createReader();
  const all = [];
  for (;;) {
    const batch = await new Promise((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) break;
    all.push(...batch);
  }
  return (await Promise.all(all.map((e) => walkEntry(e, `${prefix}${entry.name}/`)))).flat();
}

el.skills.addEventListener('change', (e) => {
  const files = [...(e.target.files ?? [])];
  if (!files.length) return;
  if (e.target.id === 'add-zip-input') addFiles([{ path: files[0].name, file: files[0] }]);
  if (e.target.id === 'add-folder-input') addFiles(files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f })));
  e.target.value = '';
});
el.skills.addEventListener('dragover', (e) => {
  const zone = e.target.closest('.dropzone');
  if (!zone) return;
  e.preventDefault();
  zone.classList.add('is-over');
});
el.skills.addEventListener('dragleave', (e) => {
  const zone = e.target.closest('.dropzone');
  if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('is-over');
});
el.skills.addEventListener('drop', async (e) => {
  const zone = e.target.closest('.dropzone');
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove('is-over');
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const list = entries.length
    ? (await Promise.all(entries.map((en) => walkEntry(en)))).flat()
    : [...e.dataTransfer.files].map((f) => ({ path: f.name, file: f }));
  if (list.length) addFiles(list);
});

el.skills.addEventListener('submit', (e) => {
  if (e.target.dataset.form !== 'gmail-password') return;
  e.preventDefault();
  gmailAction('connect-password', e.target.querySelector('[data-action="connect-password"]'));
});
el.skills.addEventListener('click', (e) => {
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  const item = e.target.closest('.skill');
  const action = b?.dataset.action;
  if (action === 'connect-password') return; // the form's submit handles it
  if (action === 'add-folder' || action === 'add-zip') return $(`${action}-input`).click();
  if (action === 'install-skill') installSkill(item);
  else if (action === 'remove-skill') removeSkill(item);
  else if (action === 'try-skill') trySkill(b.dataset.try);
  else if (action === 'retry-skills') loadSkills();
  else if (action === 'to-gmail') {
    e.preventDefault();
    const card = el.skills.querySelector('.connection');
    card.scrollIntoView({ block: 'center' });
    (card.querySelector('#gmail-email, .btn.primary, textarea') ?? card.querySelector('button'))?.focus({ preventScroll: true });
    flash(card);
  } else if (action) gmailAction(action, b);
});
el.skills.addEventListener('keydown', (e) => {
  const item = e.target.closest('.skill');
  if (!item || e.target !== item) return;
  const items = [...el.skills.querySelectorAll('.skill')];
  const i = items.indexOf(item);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
  if (e.key === 'Enter') { e.preventDefault(); const d = item.querySelector('.skill-playbook'); d.open = !d.open; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !item.classList.contains('is-available')) { e.preventDefault(); removeSkill(item); }
});
el.skillsLink.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  closeDrawer();
  navigate('/skills');
});

// ---- schedules -------------------------------------------------------------

function showSchedules() {
  stream?.close();
  stream = null;
  Object.assign(state, { id: null, live: null, pending: null });
  setView('schedules');
  el.scroller.scrollTop = 0;
  renderChrome();
  renderToc_();
  renderSchedulesView({ enter: true });
  loadSchedules().then(() => {
    const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); flash(target); }
    else el.schedules.focus({ preventScroll: true });
  });
}

function renderSchedulesView({ enter = false } = {}) {
  const focused = document.activeElement;
  const focusKey = focused?.closest?.('.skill')?.id;
  const inForm = focused?.closest?.('form') ? focused.name : null;
  const open = [...el.schedules.querySelectorAll('.skill-playbook[open]')].map((d) => d.closest('.skill').id);
  const typed = Object.fromEntries([...el.schedules.querySelectorAll('.schedule-setup')].map((f) => [f.closest('.skill').id, { time: f.time.value, days: f.days.value }]));
  if (state.schedules) el.schedules.innerHTML = renderSchedules(state.schedules, new Date());
  else if (state.schedulesError) el.schedules.innerHTML = `<div class="empty"><p class="empty-line">Schedules couldn't be shown.</p><p class="memory-lede">${state.schedulesError}</p><button type="button" class="btn" data-action="retry-schedules">Try again</button></div>`;
  else el.schedules.innerHTML = '';
  for (const id of open) document.querySelector(`#${CSS.escape(id)} .skill-playbook`)?.setAttribute('open', '');
  for (const [id, v] of Object.entries(typed)) {
    const f = document.querySelector(`#${CSS.escape(id)} .schedule-setup`);
    if (f) { f.time.value = v.time; f.days.value = v.days; }
  }
  if (focusKey) {
    const item = $(focusKey);
    (inForm && item?.querySelector(`[name="${inForm}"]`) || item)?.focus({ preventScroll: true });
  }
  if (enter) {
    el.schedules.classList.remove('view-enter');
    void el.schedules.offsetWidth;
    el.schedules.classList.add('view-enter');
  }
}
// "Next: tomorrow at 7:00 AM" stays true as the clock moves.
setInterval(() => { if (state.view === 'schedules' && !document.hidden) renderSchedulesView(); }, 60_000);

const scheduleName = (id) => state.schedules?.set.find((s) => s.id === id)?.name ?? 'The schedule';

async function runSchedule(id, button) {
  if (button) button.disabled = true;
  try {
    const { queued } = await post(`/api/schedules/${id}/run`);
    toast(queued ? `Running ${scheduleName(id)} now. Its report arrives in the main conversation.` : `${scheduleName(id)} is already running.`);
    loadSchedules();
  } catch (e) { if (button) button.disabled = false; toast(e.message); }
}

async function pauseSchedule(item, paused) {
  try {
    await post(`/api/schedules/${item.dataset.id}/${paused ? 'pause' : 'resume'}`);
    await loadSchedules();
    $(`sc-${item.dataset.id}`)?.querySelector(`[data-action="${paused ? 'resume' : 'pause'}-schedule"]`)?.focus({ preventScroll: true });
    toast(paused ? `Paused. ${scheduleName(item.dataset.id)} won't run until you resume it.` : `Resumed. ${scheduleName(item.dataset.id)} runs on its schedule again.`);
  } catch (e) { toast(e.message); }
}

async function removeSchedule(item) {
  const id = item.dataset.id;
  const name = scheduleName(id);
  const items = [...el.schedules.querySelectorAll('.schedule')];
  const next = items[items.indexOf(item) + 1] ?? items[items.indexOf(item) - 1];
  item.classList.add('is-leaving');
  try {
    const { text } = await post(`/api/schedules/${id}/remove`);
    state.undo = async () => {
      try {
        await post(`/api/schedules/${id}/restore`, { text });
        await loadSchedules();
        $(`sc-${id}`)?.focus();
        toast('Back, exactly as it was.');
      } catch (e) { toast(e.message); }
    };
    await loadSchedules();
    (next && $(next.id) ? $(next.id) : el.schedules).focus({ preventScroll: true });
    toast(`Removed ${name}. It won't run again.`, { undo: true });
  } catch (e) { item.classList.remove('is-leaving'); toast(e.message); }
}

async function setupSchedule(form) {
  const item = form.closest('.skill');
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await post(`/api/schedules/${item.dataset.id}/setup`, { time: form.time.value, days: form.days.value });
    await loadSchedules();
    const now = $(`sc-${item.dataset.id}`);
    now?.focus({ preventScroll: true });
    if (now) { now.scrollIntoView({ block: 'nearest' }); flash(now); }
    const s = state.schedules.set.find((x) => x.id === item.dataset.id);
    toast(`${s?.name ?? 'It'} is on: ${(s?.when ?? '').replace(/^\w/, (c) => c.toLowerCase())}.`);
  } catch (e) { button.disabled = false; toast(e.message); }
}

el.schedules.addEventListener('submit', (e) => {
  if (e.target.dataset.form !== 'setup-schedule') return;
  e.preventDefault();
  setupSchedule(e.target);
});
el.schedules.addEventListener('click', (e) => {
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  const item = e.target.closest('.skill');
  const action = b?.dataset.action;
  if (action === 'run-schedule') runSchedule(item.dataset.id, b);
  else if (action === 'pause-schedule') pauseSchedule(item, true);
  else if (action === 'resume-schedule') pauseSchedule(item, false);
  else if (action === 'remove-schedule') removeSchedule(item);
  else if (action === 'retry-schedules') loadSchedules();
});
el.schedules.addEventListener('keydown', (e) => {
  const item = e.target.closest('.skill');
  if (!item || e.target !== item) return;
  const items = [...el.schedules.querySelectorAll('.skill')];
  const i = items.indexOf(item);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
  if (e.key === 'Enter') { e.preventDefault(); const d = item.querySelector('.skill-playbook'); d.open = !d.open; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && item.classList.contains('schedule')) { e.preventDefault(); removeSchedule(item); }
});
el.schedulesLink.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  closeDrawer();
  navigate('/schedules');
});

// ---- activity --------------------------------------------------------------

function showActivity() {
  stream?.close();
  stream = null;
  Object.assign(state, { id: null, live: null, pending: null, earlier: [] });
  setView('activity');
  el.scroller.scrollTop = 0;
  renderChrome();
  renderToc_();
  renderActivityView({ enter: true });
  loadActivity().then(() => {
    const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); flash(target); }
    else el.activity.focus({ preventScroll: true });
  });
}

function renderActivityView({ enter = false } = {}) {
  const focused = document.activeElement;
  const focusKey = focused?.closest?.('.act-entry')?.id;
  const focusAction = focused?.dataset?.action ?? null;
  const open = [...el.activity.querySelectorAll('.act-steps[open]')].map((d) => d.closest('.act-entry').id);
  const top = el.scroller.scrollTop;
  if (state.activity) {
    const days = [...state.activity.days, ...state.earlier.flatMap((w) => w.days)];
    const last = state.earlier.at(-1) ?? state.activity;
    el.activity.innerHTML = renderActivity({ ...state.activity, days, more: last.more, before: last.before, earlier: state.earlier.length > 0 }, new Date());
  } else if (state.activityError) el.activity.innerHTML = `<div class="empty"><p class="empty-line">Activity couldn't be shown.</p><p class="memory-lede">${state.activityError}</p><button type="button" class="btn" data-action="retry-activity">Try again</button></div>`;
  else el.activity.innerHTML = '';
  for (const id of open) document.getElementById(id)?.querySelector('.act-steps')?.setAttribute('open', '');
  if (focusKey) {
    const item = $(focusKey);
    (focusAction && item?.querySelector(`[data-action="${focusAction}"]`) || item)?.focus({ preventScroll: true });
  }
  if (!enter) el.scroller.scrollTop = top;
  if (enter) {
    el.activity.classList.remove('view-enter');
    void el.activity.offsetWidth;
    el.activity.classList.add('view-enter');
  }
}
// "Working for 2 min" and the days stay true as the clock moves.
setInterval(() => { if (state.view === 'activity' && !document.hidden) renderActivityView(); }, 60_000);

async function earlier(button) {
  button.disabled = true;
  try {
    const res = await fetch(`/api/activity?before=${encodeURIComponent(button.dataset.before)}`);
    if (!res.ok) throw new Error();
    const week = await res.json();
    state.earlier.push(week);
    const had = el.activity.querySelectorAll('.act-day').length;
    renderActivityView();
    const first = el.activity.querySelectorAll('.act-day')[had];
    (first?.querySelector('.act-entry') ?? el.activity.querySelector('[data-action="earlier"]') ?? el.activity).focus({ preventScroll: true });
    first?.scrollIntoView({ block: 'start' });
    if (!week.days.length) toast(week.more ? 'Nothing happened that week.' : 'Nothing happened that week, and nothing before it.');
  } catch { button.disabled = false; toast("Nova's server didn't answer. Try again in a moment."); }
}

async function stopHelper(run, button) {
  if (button) button.disabled = true;
  try {
    await post(`/api/helpers/${run}/stop`);
    toast('Stopped. The conversation that asked will say so.');
  } catch (e) { if (button) button.disabled = false; toast(e.message); }
}

async function retryHelper(run, button) {
  if (button) button.disabled = true;
  try {
    const h = await post(`/api/helpers/${run}/retry`);
    toast(`${h.title} is starting again. Its report comes back to the same conversation.`);
  } catch (e) { if (button) button.disabled = false; toast(e.message); }
}

el.activity.addEventListener('click', (e) => {
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  const action = b?.dataset.action;
  if (action === 'stop-helper') stopHelper(b.dataset.run, b);
  else if (action === 'retry-helper') retryHelper(b.dataset.run, b);
  else if (action === 'earlier') earlier(b);
  else if (action === 'retry-activity') loadActivity();
});
el.activity.addEventListener('keydown', (e) => {
  const item = e.target.closest('.act-entry');
  if (!item || e.target !== item) return;
  const items = [...el.activity.querySelectorAll('.act-entry')];
  const i = items.indexOf(item);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
  if (e.key === 'Enter') {
    const d = item.querySelector('.act-steps');
    if (d) { e.preventDefault(); d.open = !d.open; }
  }
});
el.activityLink.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  closeDrawer();
  navigate('/activity');
});

// ---- settings --------------------------------------------------------------

let permissions = null;
let permissionsError = '';
function loadPermissions() {
  return fetch('/api/permissions')
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((data) => { permissions = data.permissions; permissionsError = ''; if (state.view === 'settings') renderSettingsView(); })
    .catch(() => {
      permissionsError = "Nova's server didn't answer, so settings can't be shown right now.";
      if (state.view === 'settings' && !permissions) renderSettingsView();
    });
}

function showSettings() {
  stream?.close();
  stream = null;
  Object.assign(state, { id: null, live: null, pending: null });
  setView('settings');
  el.scroller.scrollTop = 0;
  renderChrome();
  renderToc_();
  renderSettingsView({ enter: true });
  loadPermissions().then(() => {
    const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
    if (target) { target.scrollIntoView({ block: 'center' }); (target.querySelector('.switch') ?? target.querySelector('input:checked'))?.focus({ preventScroll: true }); flash(target); }
    else el.settings.focus({ preventScroll: true });
  });
}

function renderSettingsView({ enter = false } = {}) {
  const active = document.activeElement;
  const focusId = active?.dataset?.action === 'toggle-permission' ? active.dataset.id : null;
  const focusRadio = active?.type === 'radio' && el.settings.contains(active) ? active.name : null;
  el.settings.innerHTML = renderSettingsPage(permissions, { appearance: { ...currentTheme(), themes: THEMES, modes: MODES }, error: permissionsError });
  if (focusId) el.settings.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
  if (focusRadio) el.settings.querySelector(`input[name="${focusRadio}"]:checked`)?.focus({ preventScroll: true });
  if (enter) {
    el.settings.classList.remove('view-enter');
    void el.settings.offsetWidth;
    el.settings.classList.add('view-enter');
  }
}

async function togglePermission(button) {
  const yes = button.getAttribute('aria-checked') !== 'true';
  const label = permissions.find((p) => p.id === button.dataset.id)?.label ?? 'That';
  button.disabled = true;
  try {
    ({ permissions } = await post(`/api/permissions/${encodeURIComponent(button.dataset.id)}/${yes ? 'allow' : 'ask'}`));
    renderSettingsView();
    el.settings.querySelector(`[data-id="${CSS.escape(button.dataset.id)}"]`)?.focus({ preventScroll: true });
    toast(yes ? `${label}: Nova does this without asking now.` : `${label}: Nova asks first now.`);
  } catch (e) { button.disabled = false; toast(e.message); }
}

el.settings.addEventListener('click', (e) => {
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  if (b?.dataset.action === 'toggle-permission') togglePermission(b);
  else if (b?.dataset.action === 'retry-settings') loadPermissions();
});
// Appearance lives here too: a pick applies at once and is kept in this browser.
el.settings.addEventListener('change', (e) => {
  if (e.target.name === 'theme') chooseTheme({ theme: e.target.value });
  if (e.target.name === 'mode') chooseTheme({ mode: e.target.value });
});
el.settingsLink.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  closeDrawer();
  navigate('/settings');
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
el.newChat.addEventListener('click', () => { closeDrawer(); navigate('/new'); });
el.mainLink.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  closeDrawer();
  navigate('/');
});
window.addEventListener('popstate', route);

// On a wide screen the sidebar collapses and stays that way across reloads;
// on a narrow one it is a drawer over the page, closed on every visit.
const narrow = matchMedia('(max-width: 760px)');
const root = document.documentElement;
function setSidebar(open, { focus = true } = {}) {
  root.dataset.sidebar = open ? 'open' : 'collapsed';
  try { localStorage.setItem('nova.sidebar', root.dataset.sidebar); } catch {}
  syncSidebar();
  if (focus) (open ? el.collapse : el.menu).focus({ preventScroll: true });
}
function syncSidebar() {
  const collapsed = !narrow.matches && root.dataset.sidebar === 'collapsed';
  el.sidebar.inert = collapsed;
  el.collapse.setAttribute('aria-expanded', String(!collapsed));
  if (!narrow.matches) el.menu.setAttribute('aria-expanded', String(!collapsed));
}
narrow.addEventListener('change', () => { closeDrawer(); syncSidebar(); });
el.collapse.innerHTML = icons.sidebar;
el.collapse.addEventListener('click', () => setSidebar(false));

el.menu.innerHTML = icons.sidebar;
el.menu.addEventListener('click', () => {
  if (!narrow.matches) { setSidebar(true); return; }
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
  if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); navigate('/new'); return; }
  if (mod && e.key === '\\' && !narrow.matches) { e.preventDefault(); setSidebar(root.dataset.sidebar === 'collapsed', { focus: !inField }); return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); step(e.key === 'ArrowUp' ? -1 : 1); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && !inField && state.view !== 'chat' && state.undo) { e.preventDefault(); runUndo(); return; }
  if (e.key === '/' && !inField && state.view === 'chat') { e.preventDefault(); el.input.focus(); return; }
  if (e.key === 'Escape') {
    if (el.app.classList.contains('drawer-open')) { closeDrawer(); el.menu.focus(); return; }
    const card = e.target.closest?.('.approval');
    if (card) { e.preventDefault(); decide(card.dataset.tool, 'deny', card.querySelector('button')); return; }
    if (state.live) { e.preventDefault(); stop(); }
  }
});

// ---- start -----------------------------------------------------------------

window.addEventListener('online', () => { state.online = true; renderChrome(); });
window.addEventListener('offline', () => { state.online = false; renderChrome(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadList(); });

applyTheme();
syncSidebar();
loadList();
loadMemory();
loadSkills();
loadSchedules();
loadActivity();
watch();
route();
document.documentElement.dataset.ready = 'true';
