// Nova's PWA: the shell (layout, navigation, the orb), the core's surfaces (Home, Tasks,
// Automations, Health, Settings) and Era 2's conversations, Memory, Skills, Schedules and
// Activity, re-homed. Conversation state comes from the server as a snapshot plus a live event
// stream; the thread is rebuilt from state, patching only what changed so nothing that is
// already on screen animates twice.
import { applyEvent, emptySession } from './reduce.js';
import { escapeHtml, renderMarkdown } from './markdown.js';
import { dayKey, icons, memoryIndex, renderActivity, renderBlocks, renderEmpty, renderMemory, renderSchedules, renderPermissions, renderSkills, renderToc, renderToday, renderWorkNote } from './view.js';
import { apply as applyTheme } from './theme.js';
import { fromCache, on as onCore, stream as coreStream } from './core.js';
import { ICONS, lookingIntoItCard, voiceState } from './components.js';
import { routeOf } from './nav.js';
import { CATEGORIES, GROUPS, categoryOf, searchSettings } from './settings-ia.js';
import { closeMore, closeSheet, layout, markCurrent, openSheet, readLayout, runToastAction, setBadge, signal, toast as notify, toggleAside, liveOrb } from './shell.js';
import * as core from './surfaces.js';
import { bindConnections, loadConnections, renderConnections } from './connections.js';
import { bindCapture, captureChanged, loadCapture, loadCaptureView, renderCaptureSettings, renderCaptureView } from './capture.js';
import { bindModels, loadModels, renderModels } from './models.js';
import { bindChanges, loadChanges, renderChanges } from './changes.js';
import { bindCheckpoints, loadCheckpoints, renderCheckpoints } from './checkpoints.js';
import { bindReset, loadReset, renderReset } from './reset.js';
import { startSetup, setupShowing } from './setup.js';
import { renew, sessionEnds } from './device-key.js';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), toc: $('toc'), thread: $('thread'), scroller: $('scroller'), title: $('title'),
  input: $('input'), send: $('send'), mic: $('mic'), voiceNote: $('voice-note'), composer: $('composer'), hint: $('hint'), banner: $('banner'),
  jump: $('jump'), menu: $('menu'), scrim: $('scrim'), newChat: $('new-chat'), drawerClose: $('drawer-close'),
  sidebar: $('sidebar'), dock: $('dock'), toast: $('toast'), topbarOrb: $('topbar-orb'), asideToggle: $('aside-toggle'),
  home: $('home'), tasks: $('tasks-view'), memory: $('memory'), automations: $('automations'), rules: $('rules'),
  skills: $('skills'), schedules: $('schedules'), activity: $('activity'), health: $('health-view'), settings: $('settings-view'),
  aside: $('aside'), mainLink: $('main-link'), mainDot: $('main-dot'), capture: $('capture-view'),
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
  view: 'home',         // home | chat | tasks | memory | automations | skills | activity | health | settings
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
  busy: { working: 0, waiting: 0 }, // Era 2's own work, from the activity nudge
  listening: false,     // voice input is on
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
    if (!res.ok) throw new Error();
    state.list = await res.json();
    setReachable(!fromCache(res));
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
      // A report that arrived in the main conversation since it was last open.
      const latest = data.set.map((s) => s.last).filter((r) => r?.delivered === 'main' && r.finished).map((r) => r.finished).sort().at(-1);
      if (latest && latest > seenMain() && !onMain()) setMainDot(true);
      if (state.view === 'automations') renderSchedulesView();
    })
    .catch(() => {
      state.schedulesError = "Nova's server didn't answer, so schedules can't be shown right now.";
      if (state.view === 'automations' && !state.schedules) renderSchedulesView();
    });
}

const onMain = () => state.view === 'chat' && state.id === 'main';
const seenMain = () => { try { return localStorage.getItem('nova.mainSeen') ?? ''; } catch { return ''; } };
// A report waiting in the main conversation: a dot in the drawer and on Chat.
function setMainDot(on) {
  el.mainDot.hidden = !on;
  setBadge('chat', on ? { tone: 'attention', label: 'a new report' } : null);
}
function markMainSeen() {
  setMainDot(false);
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

// Nova's work anywhere, Era 2's and the ledger's: badges on Activity and Tasks, and the orb.
function showBusy(busy = state.busy) {
  state.busy = { working: busy.working ?? 0, waiting: busy.waiting ?? 0 };
  const w = state.busy.waiting;
  setBadge('activity', w ? { tone: 'attention', label: `${w} waiting for you` } : state.busy.working ? { tone: 'working', label: 'Nova is working' } : null);
  showSignals();
}

function showSignals() {
  const asking = core.needsYou();
  setBadge('tasks', asking ? { tone: 'attention', label: `${asking} need${asking === 1 ? 's' : ''} you` } : null);
  setBadge('health', core.store.problems.length ? { tone: 'alert', label: `${core.store.problems.length} problem${core.store.problems.length === 1 ? '' : 's'}` } : null);
  signal({
    reachable: state.reachable && state.online,
    listening: state.listening,
    problems: core.store.problems.length,
    needsYou: asking + state.busy.waiting,
    speaking: state.view === 'chat' && state.live?.phase === 'streaming',
    working: core.working() + state.busy.working + (state.pending || state.live ? 1 : 0),
  });
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
  es.addEventListener('open', () => setReachable(true));
  es.addEventListener('error', () => { if (es.readyState !== EventSource.OPEN) setReachable(false); });
  es.addEventListener('handoff', (e) => {
    if (JSON.parse(e.data).target !== 'main') return;
    if (onMain()) markMainSeen();
    else setMainDot(true);
  });
  es.addEventListener('sessions', () => loadList());
}

let healthTimer = null;
function setReachable(ok) {
  if (state.reachable === ok) return;
  state.reachable = ok;
  core.store.reachable = ok;
  renderChrome();
  renderCore();
  clearTimeout(healthTimer);
  if (!ok) {
    const check = () => fetch('/api/health').then((r) => {
      if (!r.ok || fromCache(r)) throw new Error();
      setReachable(true);
      loadList();
      refreshCore();
      if (state.id && (!stream || stream.readyState === EventSource.CLOSED)) open(state.id, { quiet: true });
    }).catch(() => { healthTimer = setTimeout(check, 2000); });
    healthTimer = setTimeout(check, 2000);
  }
}

// ---- routing -------------------------------------------------------------

// "/" is Home; "/chat" the main conversation; "/new" starts another; "/c/<id>" opens one.
// Era 2's paths keep working (/schedules is Automations).
function route() {
  if (setupShowing()) return;
  const r = routeOf(location.pathname);
  closeMore();
  if (r.unknown) history.replaceState(null, '', `/${location.hash}`);
  if (r.dest === 'chat') {
    if (r.conversation === null) startNew();
    else {
      if (r.conversation === 'main' && location.pathname !== '/chat') history.replaceState(null, '', `/chat${location.hash}`);
      open(r.conversation);
      if (!location.hash) el.input.focus({ preventScroll: true });
    }
  } else if (r.dest === 'memory') showMemory();
  else if (r.dest === 'skills') showSkills();
  else if (r.dest === 'automations') showSchedules();
  else if (r.dest === 'activity') showActivity();
  else if (r.dest === 'settings') showSettings();
  else if (r.dest === 'capture') showCaptureView();
  else showCore(r.dest);
}

const VIEWS = { home: 'home', chat: 'thread', tasks: 'tasks', memory: 'memory', automations: 'automations', skills: 'skills', activity: 'activity', health: 'health', settings: 'settings', capture: 'capture' };
function setView(view) {
  const was = state.view;
  state.view = view;
  document.body.dataset.view = view;
  for (const [v, key] of Object.entries(VIEWS)) el[key].hidden = v !== view;
  el.dock.hidden = view !== 'chat';
  el.menu.hidden = view !== 'chat';
  if (view !== 'chat') el.jump.hidden = true;
  if (was === 'settings' && view !== 'settings') core.cancelPreview();
  // The Capture view belongs to Settings in the navigation.
  markCurrent(view === 'capture' ? 'settings' : view);
  if (was !== view) showSignals();
}

// The core's own surfaces: Home, Tasks, Health.
function showCore(view) {
  stream?.close();
  stream = null;
  Object.assign(state, { id: null, live: null, pending: null });
  setView(view);
  el.scroller.scrollTop = 0;
  renderChrome();
  renderToc_();
  renderCore({ enter: true });
  const target = view === 'home' ? null : el[VIEWS[view]];
  if (target) target.focus({ preventScroll: true });
}

function enter(node) {
  node.classList.remove('view-enter');
  void node.offsetWidth;
  node.classList.add('view-enter');
}

// Draw whatever of the core's surfaces is on screen, keeping the reader's place and focus.
function renderCore({ enter: entering = false } = {}) {
  const keep = (node, draw) => {
    const focusKey = document.activeElement && node.contains(document.activeElement) ? (document.activeElement.dataset.task ?? document.activeElement.dataset.action ?? null) : null;
    draw(node);
    if (focusKey) node.querySelector(`[data-task="${CSS.escape(focusKey)}"], [data-action="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    if (entering) enter(node);
  };
  core.renderAside(el.aside);
  if (state.view === 'home') keep(el.home, core.renderHome);
  if (state.view === 'tasks') keep(el.tasks, core.renderTasks);
  if (state.view === 'health') keep(el.health, core.renderHealth);
  if (state.view === 'automations') core.renderRules(el.rules);
  if (state.view === 'chat' && state.session.turns.length) renderThread();
  showSignals();
}

let refreshing = null;
function refreshCore(parts) {
  // The chrome too: the "saved earlier" banner depends on whether these answers were live.
  refreshing = core.load(parts).then(({ any, live }) => { if (any) setReachable(live); renderChrome(); renderCore(); renderVoice(); });
  return refreshing;
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
  es.addEventListener('live', (e) => { state.live = JSON.parse(e.data); renderThread(); renderChrome(); showSignals(); });
  es.addEventListener('delta', (e) => {
    const d = JSON.parse(e.data);
    if (!state.live || state.live.turn !== d.turn || state.live.attempt !== d.attempt) return;
    state.live.text = (state.live.text || '') + d.text;
    if (state.live.phase !== 'streaming') { state.live.phase = 'streaming'; showSignals(); }
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
  // Work Nova said it would look into, from this conversation, while it's still open.
  const looking = state.id ? core.store.tasks.filter((t) => ['queued', 'active', 'waiting', 'verifying'].includes(t.state) && t.brief?.inputs?.kind === 'helper' && t.brief.inputs.parent === state.id) : [];
  if (looking.length) blocks.push({ key: 'looking-into-it', html: looking.map(lookingIntoItCard).join('') });
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
      // A message whose exact time the person revealed (a tap, a long press) keeps it shown.
      const shown = na.classList.contains('show-time');
      for (const { name, value } of [...nb.attributes]) na.setAttribute(name, value);
      if (shown) na.classList.add('show-time');
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
    // Tier 3 starts on the confirm box: Enter must never be enough on its own.
    if (!typing) card.querySelector('[data-confirm], [data-action="allow"]').focus({ preventScroll: true });
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

const TITLES = { home: '', tasks: 'Tasks', memory: 'Memory', automations: 'Automations', skills: 'Skills', activity: 'Activity', health: 'Health', settings: 'Settings', capture: 'Capture' };
function renderChrome() {
  const title = state.view === 'chat' ? (state.id && state.id !== 'main' ? state.session.title || 'Untitled' : 'Nova') : TITLES[state.view] ?? '';
  el.dock.hidden = state.view !== 'chat' || readOnly();
  if (onMain()) el.mainLink.setAttribute('aria-current', 'page');
  else el.mainLink.removeAttribute('aria-current');
  el.title.textContent = title;
  document.title = title && title !== 'Nova' ? `${title} · Nova` : 'Nova';

  const run = running();
  const hasText = !!el.input.value.trim();
  el.send.innerHTML = run ? icons.stop : icons.send;
  el.send.classList.toggle('is-stop', run);
  el.send.setAttribute('aria-label', run ? 'Stop' : 'Send');
  el.send.title = run ? 'Stop (Esc)' : 'Send (Enter)';
  el.send.disabled = run ? !!state.pending : !hasText || !state.reachable;

  // Honest about being offline: what's on screen may be from before.
  let banner = '';
  if (!state.online) banner = 'You’re offline. What you see was saved earlier; nothing new can arrive or be sent until you’re back.';
  else if (!state.reachable) banner = 'Nova’s server isn’t answering. Your conversations are safe on disk; this page reconnects when it’s back.';
  else if (core.store.stale) banner = 'Some of this was saved earlier, while Nova was out of reach.';
  // A standby (or a hub that stepped down) says so on every screen, with which node is hub.
  const replica = state.online && state.reachable ? core.store.mesh?.replica : null;
  if (!banner && replica) banner = replica.reason;
  el.banner.hidden = !banner;
  el.banner.textContent = banner;
  if (banner && replica && banner === replica.reason && !replica.demoted && core.store.mesh?.you?.can_approve) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.dataset.action = 'promote';
    b.textContent = 'Make this the hub';
    el.banner.append(b);
  }

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
  // Tier 3: allowed only with the confirm box ticked, this time.
  if (decision === 'allow' && card?.dataset.tier === '3' && !card.querySelector('[data-confirm]')?.checked) return;
  card?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try { await post(`/api/sessions/${state.id}/approvals/${tool}`, { decision }); }
  catch (e) { card?.querySelectorAll('button').forEach((b) => { b.disabled = false; }); say(e.message); }
}

el.composer.addEventListener('submit', (e) => { e.preventDefault(); running() ? stop() : send(); });
// A tier-3 step's confirm box unlocks its Allow button.
el.thread.addEventListener('change', (e) => {
  const box = e.target.closest?.('[data-confirm]');
  if (!box) return;
  const allow = box.closest('.approval')?.querySelector('[data-action="allow"]');
  if (allow) allow.disabled = !box.checked;
});
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

// Links to Nova's own places stay inside the app (the style reference and Google don't).
function inApp(href) {
  if (!href || !href.startsWith('/') || href.startsWith('//')) return false;
  const path = href.split(/[?#]/)[0];
  if (path === '/styleguide' || path.startsWith('/api/') || path.startsWith('/oauth/')) return false;
  return !routeOf(path).unknown || path === '/';
}
function followLink(e) {
  const a = e.target.closest('a[href]');
  if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !inApp(a.getAttribute('href'))) return false;
  e.preventDefault();
  closeDrawer();
  closeMore();
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

// A message's exact time on a touch screen, where there is no hover: a tap on the message shows
// it (another tap, or a tap elsewhere, hides it), and so does a long press.
let pointer = 'mouse';
let pressTimer = 0;
let pressed = false; // a long press showed it: the click that follows doesn't hide it again
let pressAt = null; // where the press began
const PRESS_SLOP = 10; // px a finger may move and still be pressing
const SHOWS_TIME = '.msg';
const INTERACTIVE = 'a, button, summary, input, textarea, select, label, [tabindex]:not(time)';
// Something inside the message the person operates (a link, a button, a step's details): a press
// there is theirs, not a request for the time.
const operating = (e, msg) => { const hit = e.target.closest(INTERACTIVE); return !!hit && !!msg && msg.contains(hit); };
function showTime(msg, on) {
  for (const x of el.thread.querySelectorAll('.msg.show-time')) if (x !== msg) x.classList.remove('show-time');
  msg?.classList.toggle('show-time', on);
}
el.thread.addEventListener('pointerdown', (e) => {
  pointer = e.pointerType;
  clearTimeout(pressTimer);
  const msg = e.target.closest(SHOWS_TIME);
  pressed = false;
  pressAt = { x: e.clientX, y: e.clientY };
  if (e.pointerType === 'touch' && msg && !operating(e, msg)) pressTimer = setTimeout(() => { pressed = true; showTime(msg, true); }, 450);
});
for (const ev of ['pointerup', 'pointercancel']) el.thread.addEventListener(ev, () => clearTimeout(pressTimer));
el.thread.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch' || !pressAt) return;
  if (Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > PRESS_SLOP) clearTimeout(pressTimer);
});
el.thread.addEventListener('click', (e) => {
  const msg = e.target.closest(SHOWS_TIME);
  if (pointer !== 'touch' || operating(e, msg)) return;
  if (pressed) { pressed = false; return; }
  showTime(msg, msg ? !msg.classList.contains('show-time') : false);
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
  const at = focused ? [...el.memory.querySelectorAll('.memory-item')].findIndex((x) => x.dataset.id === focused) : -1;
  if (state.memory) el.memory.innerHTML = renderMemory(state.memory);
  else if (state.memoryError) el.memory.innerHTML = `<div class="empty"><p class="empty-line">Memory couldn't be read.</p><p class="memory-lede">${state.memoryError}</p><button type="button" class="btn" data-action="retry-memory">Try again</button></div>`;
  else el.memory.innerHTML = '';
  // An edit gives the memory a new id; focus stays where it was in the list.
  if (focused) (document.getElementById(`m-${focused}`) ?? el.memory.querySelectorAll('.memory-item')[at])?.focus({ preventScroll: true });
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
    (next && document.getElementById(next.id) || el.memory.querySelector('.memory-item') || el.memory).focus({ preventScroll: true });
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

// A short confirmation; with Undo when something went. Undo also answers ⌘/Ctrl Z.
function toast(text, { undo = false } = {}) {
  if (!undo) { notify(text); return; }
  notify(text, { action: { label: 'Undo', run: runUndo, expire: () => { state.undo = null; } } });
}
function runUndo() {
  const undo = state.undo;
  if (!undo) return;
  state.undo = null;
  el.toast.hidden = true;
  undo();
}

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
    (next && $(next.id) || el.skills.querySelector('.skill') || el.skills).focus({ preventScroll: true });
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

// ---- schedules -------------------------------------------------------------

function showSchedules() {
  stream?.close();
  stream = null;
  Object.assign(state, { id: null, live: null, pending: null });
  setView('automations');
  el.scroller.scrollTop = 0;
  renderChrome();
  renderToc_();
  core.renderRules(el.rules);
  renderSchedulesView({ enter: true });
  loadSchedules().then(() => {
    const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); flash(target); }
    else el.automations.querySelector('.trigger-row button, #schedules')?.focus({ preventScroll: true });
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
setInterval(() => { if (state.view === 'automations' && !document.hidden) renderSchedulesView(); }, 60_000);

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

// ---- settings: you and Nova, privacy, permissions, appearance, devices ------------------------

let permissions = null;
let permissionsError = '';
function loadPermissions() {
  return fetch('/api/permissions')
    .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
    .then((data) => { permissions = data.permissions; permissionsError = ''; if (state.view === 'settings') renderSettingsView({ only: 'perms' }); })
    .catch(() => {
      permissionsError = "Nova's server didn't answer, so settings can't be shown right now.";
      if (state.view === 'settings' && !permissions) renderSettingsView({ only: 'perms' });
    });
}

// Settings is one structure (settings-ia.js) in two layouts: from the expanded width (840px,
// layout.css) on a flat screen, a sidebar of categories beside the open one; below it, the
// grouped list, and a category's page in its place with a way back. The hash says what is open: a
// category (#models), opened at its top as a click does, or a setting in one (#appearance-mode),
// which opens its category and is brought into view.
// `touched`: the person has typed in search or opened something since Settings opened, so data
// arriving late must not move their focus or scroll.
const settingsUi = { cat: null, touched: false, active: -1 };
const settingsList = () => {
  const wide = getComputedStyle(document.documentElement).getPropertyValue('--settings-layout').trim() === 'sidebar';
  return !wide || layout.layout === 'phone' || (layout.layout === 'tablet' && layout.posture !== 'continuous');
};

function settingsTarget(hash) {
  const id = decodeURIComponent(hash.replace(/^#/, ''));
  if (!id) return { cat: null, target: null };
  if (categoryOf(id)) return { cat: id, target: null };
  const target = el.settings.querySelector(`#${CSS.escape(id)}`);
  const pane = target?.closest('.settings-pane');
  if (pane) return { cat: pane.dataset.cat, target: pane === target ? null : target };
  return { cat: categoryOf(id) ? id : null, target: null };
}

function selectSettings(cat) {
  settingsUi.cat = cat && categoryOf(cat) ? cat : null;
  const list = settingsList();
  const open = settingsUi.cat ?? (list ? null : CATEGORIES[0].id);
  for (const p of el.settings.querySelectorAll('.settings-pane')) p.hidden = p.dataset.cat !== open;
  el.settings.dataset.show = open ? 'detail' : 'list';
  el.settings.dataset.layout = list ? 'list' : 'sidebar';
  document.body.dataset.settingsLayout = list ? 'list' : 'sidebar';
  for (const a of el.settings.querySelectorAll('.settings-cat')) {
    if (a.dataset.cat === open && !list) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const back = $('settings-back');
  if (back) back.hidden = !(list && open);
  const title = $('settings-title');
  if (title) title.textContent = list && open ? categoryOf(open).label : 'Settings';
}

// From the list or the sidebar to a category, as its own step in the history.
function openSettingsCat(cat, { push = true } = {}) {
  if (push) history.pushState(null, '', `/settings#${cat}`);
  selectSettings(cat);
  el.scroller.scrollTop = 0;
  const heading = el.settings.querySelector(`.settings-pane[data-cat="${CSS.escape(cat)}"] h2`);
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
}

// Bring one setting into view, mark it, and put focus on its control.
function goToSetting(target) {
  selectSettings(target.closest('.settings-pane')?.dataset.cat ?? settingsUi.cat);
  target.scrollIntoView({ block: 'center' });
  const first = (sel) => [...target.querySelectorAll(sel)].find((n) => n.checkVisibility()) ?? null;
  const control = first('.switch') ?? first('input:checked') ?? first('button:not([disabled]), input:not([disabled]), select, textarea, a[href]');
  // Nothing to operate in it (a list, a note): the setting itself takes focus.
  if (!control && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  (control ?? target).focus({ preventScroll: true });
  flash(target);
}

// Search is a combobox over a listbox of results. Only the count is announced (#settings-count, a
// live region that stays put); the list itself is read as the person moves through it.
function renderSettingsResults(query) {
  const box = $('settings-results');
  const input = $('settings-search');
  const count = $('settings-count');
  if (!box) return;
  const q = query.trim();
  const found = q ? searchSettings(q).slice(0, 8) : [];
  settingsUi.active = -1;
  box.hidden = !q;
  input.setAttribute('aria-expanded', String(found.length > 0));
  input.removeAttribute('aria-activedescendant');
  const said = !q ? '' : found.length ? `${found.length} setting${found.length === 1 ? '' : 's'} found` : 'No settings found';
  if (count.textContent !== said) count.textContent = said;
  box.innerHTML = !q ? '' : found.length
    ? found.map((r, i) => `<li class="settings-result" role="option" id="set-opt-${i}" aria-selected="false" data-target="${escapeHtml(r.target)}" data-cat="${escapeHtml(r.cat)}"><span class="result-label">${escapeHtml(r.label)}</span><span class="result-path">${escapeHtml(r.path)}</span></li>`).join('')
    : `<li class="settings-noresult" role="presentation">Nothing matches “${escapeHtml(q)}”. Try another word, like “theme”, “phone” or “backup”.</li>`;
}

// Arrow keys move through the results; the input keeps focus.
function moveSettingsResult(dir) {
  const options = [...el.settings.querySelectorAll('#settings-results [role="option"]')];
  if (!options.length) return;
  settingsUi.active = (settingsUi.active + dir + options.length) % options.length;
  options.forEach((o, i) => o.setAttribute('aria-selected', String(i === settingsUi.active)));
  const now = options[settingsUi.active];
  $('settings-search').setAttribute('aria-activedescendant', now.id);
  now.scrollIntoView({ block: 'nearest' });
}

function chooseSettingsResult(option) {
  const target = $(option.dataset.target) ?? el.settings.querySelector(`.settings-pane[data-cat="${CSS.escape(option.dataset.cat)}"]`);
  $('settings-search').value = '';
  renderSettingsResults('');
  history.pushState(null, '', `/settings#${option.dataset.target}`);
  if (target) goToSetting(target);
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
  settingsUi.touched = false;
  selectSettings(settingsTarget(location.hash).cat);
  const opened = location.hash;
  Promise.all([loadPermissions(), refreshCore(['profile']), loadConnections(), core.loadProviders(), loadCapture(), loadModels(), loadChanges(), loadCheckpoints(), loadReset()]).then(() => {
    renderSettingsView({ only: 'you' });
    renderSettingsView({ only: 'privacy' });
    // The person has moved on since (typed in search, opened something): leave them be.
    if (settingsUi.touched || state.view !== 'settings' || location.hash !== opened) return;
    const { cat, target } = settingsTarget(location.hash);
    if (target) goToSetting(target);
    else if (cat) openSettingsCat(cat, { push: false });
    else { selectSettings(null); el.settings.focus({ preventScroll: true }); }
  });
}

const PARTS = {
  you: () => core.renderYou(),
  privacy: () => core.renderPrivacy(),
  providers: () => core.renderProviders(),
  perms: () => (permissions ? renderPermissions(permissions) : permissionsError ? `<section class="memory-section" id="perms" aria-labelledby="set-perms"><h2 class="memory-heading" id="set-perms">Without asking</h2>
<p class="memory-lede">${permissionsError}</p><button type="button" class="btn set-retry" data-action="retry-settings">Try again</button></section>` : ''),
  connections: () => renderConnections(),
  capture: () => renderCaptureSettings(),
  models: () => renderModels(),
  changes: () => renderChanges(),
  checkpoints: () => renderCheckpoints(),
  // Drawn in place, so its live regions stay the same elements (surfaces.js drawAppearance).
  look: { draw: (box) => core.drawAppearance(box) },
  devices: () => core.renderDevices(),
  // The Danger zone (M7 amendment §2) stays last, set apart.
  danger: () => renderReset(),
};

function settingsShell() {
  const groups = GROUPS.map((g) => `<section class="settings-group"><h3 class="settings-group-title">${escapeHtml(g.title)}</h3><ul class="settings-cats">${g.cats.map((id) => {
    const c = categoryOf(id);
    return `<li><a class="settings-cat" href="/settings#${id}" data-cat="${id}"><span class="cat-label">${escapeHtml(c.label)}</span><span class="cat-summary">${escapeHtml(c.summary)}</span></a></li>`;
  }).join('')}</ul></section>`).join('');
  return `<header class="view-head settings-head">
  <button type="button" class="btn small quiet settings-back" id="settings-back" hidden>${ICONS.back}<span>Settings</span></button>
  <h2 class="view-title" id="settings-title">Settings</h2>
  <div class="settings-search"><label class="sr-only" for="settings-search">Search settings</label><input type="search" class="input settings-search-input" id="settings-search" placeholder="Search settings" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="settings-results"></div>
  <p class="settings-count" id="settings-count" role="status"></p>
  <ul class="settings-results" id="settings-results" role="listbox" aria-label="Settings found" hidden></ul>
</header>
<div class="settings-layout">
  <nav class="settings-nav" id="settings-nav" aria-label="Settings">${groups}</nav>
  <div class="settings-detail">${CATEGORIES.map((c) => `<section class="settings-pane" data-cat="${c.id}" aria-label="${escapeHtml(c.label)}" hidden>${c.parts.map((k) => `<div class="settings-part" id="settings-${k}"></div>`).join('')}</section>`).join('')}</div>
</div>`;
}

// What the person has typed or picked in a part's forms, and which of its details are open, carried
// over a redraw: a status changing underneath (a source that can't be reached, say) must not throw
// away a fix they are halfway through typing. Fields are matched by their form and name. A form
// that was sent successfully is reset first, so it shows what was saved.
function keepEdits(box) {
  const where = (n) => { const form = n.closest('form'); const src = n.closest('[data-source]')?.dataset.source ?? ''; return `${form?.dataset.form ?? form?.id ?? ''}|${src}`; };
  const keyOf = (f) => `${where(f)}|${f.name || f.id}|${f.type === 'radio' ? f.value : ''}`;
  const toggle = (f) => f.type === 'checkbox' || f.type === 'radio';
  const changed = (f) => (toggle(f) ? f.checked !== f.defaultChecked : f.tagName === 'SELECT' ? [...f.options].some((o) => o.selected !== o.defaultSelected) : f.value !== f.defaultValue);
  const edits = new Map([...box.querySelectorAll('input, select, textarea')].filter((f) => (f.name || f.id) && changed(f)).map((f) => [keyOf(f), toggle(f) ? f.checked : f.value]));
  const detailKey = (d) => `${where(d)}|${d.querySelector('summary')?.textContent ?? ''}`;
  const open = new Set([...box.querySelectorAll('details')].filter((d) => d.open).map(detailKey));
  return () => {
    for (const f of box.querySelectorAll('input, select, textarea')) {
      const k = keyOf(f);
      if (!edits.has(k)) continue;
      if (toggle(f)) f.checked = edits.get(k); else f.value = edits.get(k);
    }
    for (const d of box.querySelectorAll('details')) if (open.has(detailKey(d))) d.open = true;
  };
}

function renderSettingsView({ enter: entering = false, only = null } = {}) {
  if (!$('settings-you')) el.settings.innerHTML = settingsShell();
  for (const k of only ? [only] : Object.keys(PARTS)) {
    const box = $(`settings-${k}`);
    const active = document.activeElement;
    // Don't redraw a part under the person's typing.
    if (box.contains(active) && active.matches('input[type="text"], input[type="number"], input[type="password"], input[type="url"], input[type="search"], input:not([type]), textarea')) continue;
    const focus = box.contains(active) ? (active.dataset.id ? `[data-id="${CSS.escape(active.dataset.id)}"]` : active.name ? `input[name="${CSS.escape(active.name)}"]:checked` : active.dataset.action ? `[data-action="${CSS.escape(active.dataset.action)}"]${active.dataset.ds ? `[data-ds="${CSS.escape(active.dataset.ds)}"]` : ''}${active.dataset.scope ? `[data-scope="${CSS.escape(active.dataset.scope)}"]` : ''}` : null) : null;
    // Capture's forms sit under a status that changes by itself; what is typed there is kept.
    const restore = k === 'capture' ? keepEdits(box) : () => {};
    const part = PARTS[k];
    if (typeof part === 'function') box.innerHTML = part(); else part.draw(box);
    restore();
    if (focus) box.querySelector(focus)?.focus({ preventScroll: true });
  }
  if (entering) enter(el.settings);
}

async function togglePermission(button) {
  const yes = button.getAttribute('aria-checked') !== 'true';
  const label = permissions.find((p) => p.id === button.dataset.id)?.label ?? 'That';
  button.disabled = true;
  try {
    ({ permissions } = await post(`/api/permissions/${encodeURIComponent(button.dataset.id)}/${yes ? 'allow' : 'ask'}`));
    renderSettingsView({ only: 'perms' });
    el.settings.querySelector(`[data-id="${CSS.escape(button.dataset.id)}"]`)?.focus({ preventScroll: true });
    toast(yes ? `${label}: Nova does this without asking now.` : `${label}: Nova asks first now.`);
  } catch (e) { button.disabled = false; toast(e.message); }
}

el.settings.addEventListener('click', (e) => {
  const cat = e.target.closest('a.settings-cat');
  if (cat && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); settingsUi.touched = true; openSettingsCat(cat.dataset.cat); return; }
  if (e.target.closest('#settings-back')) { settingsUi.touched = true; history.pushState(null, '', '/settings'); selectSettings(null); el.scroller.scrollTop = 0; el.settings.querySelector('.settings-cat')?.focus({ preventScroll: true }); return; }
  const found = e.target.closest('.settings-result');
  if (found) { settingsUi.touched = true; chooseSettingsResult(found); return; }
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  const action = b?.dataset.action;
  if (action === 'toggle-permission') togglePermission(b);
  else if (action === 'retry-settings') loadPermissions();
  else if (action === 'save-profile') core.saveProfile(b.dataset.section, b.dataset.key, $(b.dataset.field).value.trim());
  else if (['pick-ds', 'save-ds', 'cancel-ds', 'undo-ds', 'fix-contrast', 'undo-fix'].includes(action)) lookAction(action, b);
  else if (action === 'install') core.install().then(() => renderSettingsView({ only: 'devices' }));
  else if (action === 'provider-choose') core.chooseProvider(b.dataset.for, b.dataset.provider);
  else if (action === 'provider-on') core.providerOn(b.dataset.provider);
  else if (action === 'provider-off') core.providerOff(b.dataset.provider);
  else if (action === 'provider-setup') core.providerSetup(b.dataset.provider);
});
// An Appearance action, then focus on the next sensible control: the design now shown after Save,
// Cancel or Undo; a fix's Undo after the fix, and the fix after its Undo.
function lookAction(action, b) {
  return core.appearanceAction(action, b).then((next) => {
    renderSettingsView({ only: 'look' });
    if (next) $('settings-look').querySelector(next)?.focus({ preventScroll: true });
  });
}

el.settings.addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'privacy') core.saveProfile('privacy', 'default', t.value);
  else if (t.name === 'mode') lookAction('mode', t);
  else if (t.name === 'ds-scope') lookAction('scope', t);
  else if (t.dataset.action === 'set-profile') core.saveProfile(t.dataset.section, t.dataset.key, t.value);
});
el.settings.addEventListener('input', (e) => { if (e.target.id === 'settings-search') { settingsUi.touched = true; renderSettingsResults(e.target.value); } });
el.settings.addEventListener('keydown', (e) => {
  if (e.target.id === 'settings-search' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveSettingsResult(e.key === 'ArrowDown' ? 1 : -1); return; }
  if (e.target.id === 'settings-search' && e.key === 'Enter') {
    e.preventDefault();
    const options = el.settings.querySelectorAll('#settings-results [role="option"]');
    const option = options[Math.max(0, settingsUi.active)];
    if (option) { settingsUi.touched = true; chooseSettingsResult(option); }
    return;
  }
  if (e.target.id === 'settings-search' && e.key === 'Escape' && e.target.value) { e.preventDefault(); e.target.value = ''; renderSettingsResults(''); return; }
  if (e.key === 'Enter' && e.target.matches('#you-name, #nova-name')) { e.preventDefault(); e.target.nextElementSibling?.click(); }
});
window.addEventListener('nova:appearance', () => { if (state.view === 'settings') renderSettingsView({ only: 'look' }); });
window.addEventListener('nova:installable', () => { if (state.view === 'settings') renderSettingsView({ only: 'devices' }); });
window.addEventListener('nova:providers', () => { if (state.view === 'settings') renderSettingsView({ only: 'providers' }); });

// ---- voice: dictation into the composer, off in local-only --------------------------------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
function renderVoice() {
  const v = voiceState({ privacy: core.privacy(), supported: !!Recognition });
  el.mic.innerHTML = ICONS.mic;
  el.mic.disabled = !v.enabled;
  el.mic.title = v.enabled ? 'Talk to Nova' : v.reason;
  el.voiceNote.hidden = v.enabled;
  el.voiceNote.textContent = v.reason;
  if (!v.enabled && recognition) stopListening();
}
function stopListening() {
  try { recognition?.stop(); } catch {}
  recognition = null;
  state.listening = false;
  el.mic.setAttribute('aria-pressed', 'false');
  el.mic.setAttribute('aria-label', 'Talk to Nova');
  showSignals();
}
function toggleListening() {
  if (recognition) { stopListening(); return; }
  if (!voiceState({ privacy: core.privacy(), supported: !!Recognition }).enabled) return;
  const before = el.input.value.trim();
  recognition = new Recognition();
  recognition.interimResults = true;
  recognition.lang = navigator.language;
  recognition.onresult = (e) => {
    const said = [...e.results].map((r) => r[0].transcript).join('');
    el.input.value = before ? `${before} ${said}` : said;
    autosize();
    saveDraft();
    renderChrome();
  };
  recognition.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Voice input stopped: the browser couldn’t hear you.'); stopListening(); };
  recognition.onend = () => { if (recognition) stopListening(); el.input.focus(); };
  try { recognition.start(); } catch { stopListening(); return; }
  state.listening = true;
  el.mic.setAttribute('aria-pressed', 'true');
  el.mic.setAttribute('aria-label', 'Stop listening');
  showSignals();
}
el.mic.addEventListener('click', toggleListening);

// ---- the core's events: tasks, problems, messages, rules, profile -----------------------------

let pending = new Set();
let pendingTimer = 0;
function scheduleRefresh(parts) {
  for (const p of parts) pending.add(p);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => { const list = [...pending]; pending = new Set(); refreshCore(list); }, 120);
}
onCore('task', () => scheduleRefresh(['tasks']));
onCore('problem', (p) => {
  scheduleRefresh(['problems', 'health', 'resilience']);
  notify(p?.message ?? 'Something went wrong inside Nova.', { tone: 'alert', action: { label: 'See Health', run: () => navigate('/health') } });
});
onCore('message', () => scheduleRefresh(['messages']));
// A repair playbook moved (M7b): what Nova did shows under its problem.
onCore('playbook', () => scheduleRefresh(['resilience', 'problems']));
onCore('trigger', () => scheduleRefresh(['rules', 'messages']));
onCore('profile', () => scheduleRefresh(['profile']));
// A connection changed (connected, dropped, reconnecting, disconnected), here or elsewhere.
onCore('connector', () => { if (state.view === 'settings') loadConnections(); });
// Capture (M6a): the indicator on every page, Settings › Capture and the Capture view.
onCore('capture', () => captureChanged(() => state.view === 'capture'));
bindCapture([el.settings, el.capture], () => {
  if (state.view === 'settings' && $('settings-capture')) renderSettingsView({ only: 'capture' });
  if (state.view === 'capture') drawCapture();
});
function drawCapture() {
  const active = document.activeElement;
  const focus = el.capture.contains(active) ? active.dataset.action : null;
  el.capture.innerHTML = renderCaptureView();
  if (focus) el.capture.querySelector(`[data-action="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
}
function showCaptureView() {
  stream?.close();
  stream = null;
  Object.assign(state, { id: null, live: null, pending: null });
  setView('capture');
  el.scroller.scrollTop = 0;
  renderChrome();
  renderToc_();
  drawCapture();
  enter(el.capture);
  el.capture.focus({ preventScroll: true });
  Promise.all([loadCapture(), loadCaptureView()]);
}
el.capture.addEventListener('click', (e) => { followLink(e); });
// The indicator opens the Capture view in place, from any page.
$('capture-ind').addEventListener('click', (e) => { followLink(e); });
bindConnections(el.settings, () => { if (state.view === 'settings' && $('settings-connections')) renderSettingsView({ only: 'connections' }); });
// Settings › Models (M6b): hardware, roles, downloads with live progress, budgets.
bindModels(el.settings, () => { if (state.view === 'settings' && $('settings-models')) renderSettingsView({ only: 'models' }); });
// Settings › Changes (M7a): the change pipeline, the one waiting for you, canaries, roll back.
bindChanges(el.settings, () => { if (state.view === 'settings' && $('settings-changes')) renderSettingsView({ only: 'changes' }); });
// Settings › Backups › Checkpoints (M7 amendment): take one, restore (the hub's screen only), delete.
bindCheckpoints(el.settings, () => { if (state.view === 'settings' && $('settings-checkpoints')) renderSettingsView({ only: 'checkpoints' }); });
// Settings › Danger zone (M7 amendment §2): export, confirm, erase and start over.
bindReset(el.settings, () => { if (state.view === 'settings' && $('settings-danger')) renderSettingsView({ only: 'danger' }); });
// A provider was set up, turned on or off, or checked (M5a): Settings shows it at once.
onCore('provider', () => { if (state.view === 'settings') core.loadProviders(); });
// The device mesh: the registry changed, or a device is asking to join (only approvers hear that).
onCore('device', () => scheduleRefresh(['devices', 'mesh']));
// Hub or standby changed (promoted, stepped down); on a standby, the hub's changes arrived.
onCore('mesh', () => scheduleRefresh(['mesh', 'devices', 'health']));
onCore('sync', () => scheduleRefresh(['tasks', 'problems', 'health', 'profile', 'memory', 'rules', 'messages', 'devices', 'mesh']));
onCore('join_request', (r) => {
  scheduleRefresh(['requests']);
  if (r?.state === 'pending') core.promptJoin(r);
  else core.joinDecided(r);
});
window.addEventListener('nova:devices', () => { if (state.view === 'settings') renderSettingsView({ only: 'devices' }); renderCore(); renderChrome(); });

// Actions on the core's surfaces, wherever they appear: Home, the right column, Tasks, Health,
// Automations, and the sheet.
async function coreAction(b) {
  const action = b.dataset.action;
  const task = b.dataset.task ?? b.closest('[data-task]')?.dataset.task;
  if (action === 'open-task' || action === 'evidence') return core.openTask(task);
  if (action === 'retry-task' || action === 'cancel-task') return core.taskAction(action, task);
  if (action === 'close-sheet') return closeSheet();
  if (['pause-rule', 'resume-rule', 'delete-rule'].includes(action)) return core.ruleAction(action, b.closest('[data-rule]').dataset.rule);
  if (action === 'add-device') return core.addDevice();
  if (action === 'copy-command') return core.copyCommand();
  if (action === 'review-request') return core.openRequest(b.dataset.request);
  if (action === 'deny-request') return core.denyRequest(b.dataset.request);
  if (action === 'revoke-device') return core.revokeDevice(b.dataset.device);
  if (action === 'allow-approve') return core.allowApprove(b.dataset.device, b.dataset.value);
  if (action === 'promote') return core.promote();
  if (['backup-now', 'drill-now', 'repair-problem'].includes(action)) return core.resilienceAction(action, b.dataset.problem).then(() => scheduleRefresh(['resilience', 'problems', 'health', 'tasks']));
  try {
    if (action === 'resolve-problem') { await post(`/api/v1/problems/${encodeURIComponent(b.dataset.problem)}/resolve`); scheduleRefresh(['problems', 'health']); toast('Marked as dealt with.'); }
    if (action === 'read-message') { await post(`/api/v1/messages/${encodeURIComponent(b.dataset.message)}/read`); scheduleRefresh(['messages']); }
    if (action === 'send-message') { await post(`/api/v1/messages/${encodeURIComponent(b.dataset.message)}/approve`); scheduleRefresh(['messages']); toast('Sent.'); }
  } catch (e) { toast(e.message); }
}
const CORE_ACTIONS = new Set(['open-task', 'evidence', 'retry-task', 'cancel-task', 'close-sheet', 'pause-rule', 'resume-rule', 'delete-rule', 'resolve-problem', 'read-message', 'send-message',
  'add-device', 'copy-command', 'review-request', 'deny-request', 'revoke-device', 'allow-approve', 'promote', 'backup-now', 'drill-now', 'repair-problem']);
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.target.closest('#setup')) return;
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  if (b && CORE_ACTIONS.has(b.dataset.action)) { e.preventDefault(); coreAction(b); }
});
// The approval sheet: tier 3 needs the box ticked before Confirm can be pressed.
$('sheet').addEventListener('submit', (e) => {
  const settings = e.target.closest('.provider-form');
  if (settings) { e.preventDefault(); core.saveProvider(settings); return; }
  const form = e.target.closest('.approval-sheet');
  if (!form) return;
  e.preventDefault();
  core.approve(form);
});
$('sheet').addEventListener('change', (e) => {
  const form = e.target.closest('.approval-sheet[data-tier="3"]');
  if (form && e.target.name === 'confirm') form.querySelector('[data-action="approve"]').disabled = !e.target.checked;
});

// ---- navigation ------------------------------------------------------------

el.toc.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-id]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  closeDrawer();
  navigate(`/c/${a.dataset.id}`);
});
el.newChat.innerHTML = icons.plus;
el.newChat.addEventListener('click', () => { closeDrawer(); navigate('/new'); });
el.mainLink.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  closeDrawer();
  navigate('/chat');
});
window.addEventListener('popstate', route);

// Conversations are a drawer over the page, in every layout.
el.menu.innerHTML = ICONS.conversations;
el.drawerClose.innerHTML = ICONS.close;
el.sidebar.inert = true;
function openDrawer() {
  el.app.classList.add('drawer-open');
  el.sidebar.inert = false;
  el.scrim.hidden = false;
  el.menu.setAttribute('aria-expanded', 'true');
  (el.sidebar.querySelector('[aria-current]') ?? el.newChat).focus();
}
function closeDrawer() {
  if (!el.app.classList.contains('drawer-open')) return;
  el.app.classList.remove('drawer-open');
  el.sidebar.inert = true;
  el.scrim.hidden = true;
  el.menu.setAttribute('aria-expanded', 'false');
}
el.menu.addEventListener('click', () => (el.app.classList.contains('drawer-open') ? closeDrawer() : openDrawer()));
el.drawerClose.addEventListener('click', () => { closeDrawer(); el.menu.focus(); });
el.scrim.addEventListener('click', closeDrawer);
el.asideToggle.addEventListener('click', () => { toggleAside(); renderCore(); });
window.addEventListener('nova:layout', () => { renderCore(); if (state.view === 'settings') selectSettings(settingsUi.cat); });
// Settings changes layout at its own width too (840px, layout.css), within one app layout.
let settingsFrame = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(settingsFrame); settingsFrame = requestAnimationFrame(() => { if (state.view === 'settings') selectSettings(settingsUi.cat); }); });

function step(dir) {
  const i = state.list.findIndex((s) => s.id === state.id);
  const next = state.list[i < 0 ? (dir > 0 ? 0 : -1) : i + dir];
  if (next) navigate(`/c/${next.id}`);
}

document.addEventListener('keydown', (e) => {
  if (setupShowing() || e.defaultPrevented) return;
  const mod = e.metaKey || e.ctrlKey;
  const inField = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); navigate('/new'); return; }
  if (mod && e.key === '\\') { e.preventDefault(); if (layout.layout === 'desktop' && layout.room === 'yes') { toggleAside(); renderCore(); } return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); step(e.key === 'ArrowUp' ? -1 : 1); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && !inField && state.view !== 'chat' && state.undo) { e.preventDefault(); runToastAction() || runUndo(); return; }
  if (e.key === '/' && !inField && state.view === 'chat') { e.preventDefault(); el.input.focus(); return; }
  if (e.key === 'Escape') {
    if (el.app.classList.contains('drawer-open')) { closeDrawer(); el.menu.focus(); return; }
    const card = e.target.closest?.('.approval');
    if (card) { e.preventDefault(); decide(card.dataset.tool, 'deny', card.querySelector('button')); return; }
    if (state.listening) { e.preventDefault(); stopListening(); return; }
    if (state.live) { e.preventDefault(); stop(); }
  }
});

// ---- a paired browser's session ---------------------------------------------

// A paired browser (not the hub's own screen) signs in again before its 12-hour session runs out,
// with the key it keeps in IndexedDB. If the hub won't have it (revoked), it goes to /pair.
function keepSession() {
  const ends = () => sessionEnds();
  if (!ends()) return;
  const check = async () => {
    const at = Date.parse(ends() ?? '');
    if (!(at - Date.now() < 2 * 3600_000)) return;
    if (!(await renew())) location.assign('/pair');
  };
  check();
  setInterval(check, 10 * 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

// ---- start -----------------------------------------------------------------

window.addEventListener('online', () => { state.online = true; renderChrome(); showSignals(); refreshCore(); });
window.addEventListener('offline', () => { state.online = false; renderChrome(); showSignals(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !setupShowing()) { loadList(); refreshCore(); } });

// The app shell is cached so Nova opens without a connection; the API stays network-first.
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

readLayout();
// The composer lines up with the conversation: as wide as the scroller's content, which is
// narrower by its scrollbar gutters (none for overlay scrollbars).
new ResizeObserver(() => $('main').style.setProperty('--gutter', `${el.scroller.offsetWidth - el.scroller.clientWidth}px`)).observe(el.scroller);
el.topbarOrb.innerHTML = liveOrb('avatar');
applyTheme();
coreStream();
keepSession();
renderVoice();

let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  loadList();
  loadMemory();
  loadSkills();
  loadSchedules();
  loadActivity();
  watch();
  refreshCore();
  loadCapture();
  route();
}
// A blank profile opens the setup conversation, full screen, before anything else.
if (!(await startSetup({ done: () => { boot(); navigate('/'); } }))) boot();
document.documentElement.dataset.ready = 'true';
