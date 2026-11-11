// Nova's PWA: the shell (layout, navigation, the orb), the core's surfaces (Home, Tasks,
// Automations, Health, Settings) and Era 2's conversations, Memory, Skills, Schedules and
// Activity, re-homed. Conversation state comes from the server as a snapshot plus a live event
// stream; the thread is rebuilt from state, patching only what changed so nothing that is
// already on screen animates twice.
import { applyEvent, emptySession } from './reduce.js';
import { escapeHtml, renderMarkdown } from './markdown.js';
import { dayKey, icons, memoryFilterCount, memoryIndex, memoryMatch, renderActivity, renderBlocks, renderEmpty, renderMemory, renderSchedules, renderPermissions, renderSkills, renderToc, renderToday, renderWorkNote } from './view.js';
import { apply as applyTheme } from './theme.js';
import { NOVA_HEADERS, NO_ANSWER_MS, api, fromCache, on as onCore, reach, refused, stream as coreStream } from './core.js';
import { approvalFor, loadSecurity, renderSecurity, setupPasskey } from './passkey.js';
import { bindConfig, bindConfigForm, loadConfigForm, renderConfig, renderConfigForm } from './config.js';
import { ICONS, lookingIntoItCard, voiceState } from './components.js';
import { destination, routeOf } from './nav.js';
import { greeting, healthBadge } from './status.js';
import { CATEGORIES, GROUPS, categoryOf, filterSettings } from './settings-ia.js';
import { closeSheet, layout, markCurrent, openSheet, readLayout, runToastAction, setBadge, setBuild, setRecent, signal, toast as notify, toggleAside, liveIcon } from './shell.js';
import * as core from './surfaces.js';
import { bindConnections, loadConnections, renderConnections } from './connections.js';
import { bindSites, loadSites, renderSites } from './sites.js';
import { bindCapture, captureChanged, loadCapture, loadCaptureView, renderCaptureSettings, renderCaptureView } from './capture.js';
import { bindModels, loadModels, renderModels } from './models.js';
import { bindApprovals, loadApprovals, renderApprovals } from './approvals.js';
import { bindDeviceModels, deviceModelsFrame, refreshDeviceModels, screenDevice, setScreenDevice } from './device-models.js';
import { bindChanges, loadChanges, renderChanges } from './changes.js';
import { bindCheckpoints, loadCheckpoints, renderCheckpoints } from './checkpoints.js';
import { bindTopology, showTopology, topologyVisible, submitTopology } from './topology.js';
import { bindServices, loadServices, renderServices } from './services.js';
import { bindReset, loadReset, renderReset } from './reset.js';
import { startSetup, setupShowing } from './setup.js';
import { renew, sessionEnds } from './device-key.js';
import { begin, over, remember, waitingLine } from './wait.js';
import { blocksOf, doneWaiting, keepShape, showWaiting } from './skeleton.js';
import { initPalette, openPalette } from './palette.js';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), toc: $('toc'), thread: $('thread'), scroller: $('scroller'), title: $('title'),
  input: $('input'), send: $('send'), mic: $('mic'), voiceNote: $('voice-note'), composer: $('composer'), privacyChip: $('privacy-chip'), hint: $('hint'), banner: $('banner'),
  jump: $('jump'), menu: $('menu'), scrim: $('scrim'), newChat: $('new-chat'), drawerClose: $('drawer-close'),
  sidebar: $('sidebar'), dock: $('dock'), toast: $('toast'), topbarOrb: $('topbar-orb'), asideToggle: $('aside-toggle'),
  home: $('home'), tasks: $('tasks-view'), memory: $('memory'), automations: $('automations'), rules: $('rules'),
  skills: $('skills'), schedules: $('schedules'), activity: $('activity'), health: $('health-view'), settings: $('settings-view'),
  aside: $('aside'), mainLink: $('main-link'), mainDot: $('main-dot'), capture: $('capture-view'), topology: $('topology-view'),
  about: $('about-view'), changelog: $('changelog-view'), pipeline: $('pipeline-view'), receipts: $('receipts-view'),
};

const state = {
  list: [],
  id: null,
  session: emptySession(),
  live: null,
  pending: null,        // a message on its way to the server
  reachable: true,
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

// Era 2's paths (not under /api/v1), through core.js's one client. No answer means Nova is out of
// reach, and the page says so.
async function post(path, body = {}) {
  let res;
  try {
    res = await reach(path, { method: 'POST', headers: NOVA_HEADERS, body: JSON.stringify(body) }, "Nova's server didn't answer.");
  } catch (e) {
    setReachable(false);
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw refused(res, data);
  return data;
}

async function loadList() {
  const seen = outage;
  try {
    const res = await reach('/api/sessions');
    if (!res.ok) throw new Error();
    state.list = await res.json();
    since(seen, !fromCache(res));
  } catch { setReachable(false); }
  renderToc_();
}

// A GET that fails the same way whether the server is gone or answers with an error.
// Given up after the same limit the core reads have (F-023), so a pane never waits forever; its
// waiting line (`key`) is over either way.
const getJson = (path, key = '') => reach(path, { signal: AbortSignal.timeout(NO_ANSWER_MS) }).then((r) => { if (!r.ok) throw new Error(); return r.json(); }).finally(() => { if (key) over(key); });

// A view whose data couldn't be read: what failed, why, and a way to try again.
const errorEmpty = (title, msg, retry) => `<div class="empty"><p class="empty-line">${title}</p><p class="memory-lede">${msg}</p><button type="button" class="btn" data-action="${retry}">Try again</button></div>`;

let memoryLoad = null;
function loadMemory() {
  memoryLoad = getJson('/api/memory')
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
  return getJson('/api/skills', 'view-skills')
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
  return getJson('/api/schedules', 'view-schedules')
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
  activityLoad = getJson('/api/activity', 'view-activity')
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
  setBadge('activity', w ? { tone: 'attention', label: `${w} waiting for you`, count: w } : state.busy.working ? { tone: 'working', label: 'Nova is working' } : null);
  showSignals();
}

function showSignals() {
  const asking = core.needsYou();
  setBadge('tasks', asking ? { tone: 'attention', label: `${asking} need${asking === 1 ? 's' : ''} you`, count: asking } : null);
  // One severity for the mark, the badge, Home and Health (status.js severity; ruling D5): red only
  // when Nova is stopped, amber for anything else that needs the person while it runs.
  const s = core.severityNow(state.busy.waiting);
  setBadge('health', healthBadge(s));
  signal({
    reachable: state.reachable,
    listening: state.listening,
    stopped: s.stopped,
    needsYou: s.needs,
    unknown: s.level === 'unknown',
    speaking: state.view === 'chat' && state.live?.phase === 'streaming',
    thinking: state.view === 'chat' && viewLive()?.phase === 'thinking',
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
// Each time the page learns Nova is out of reach, a new outage begins. An answer to a read sent
// before that is no sign Nova is back: it left before the outage (a slow part of a refresh still on
// its way when the server went down), so it may say "unreachable" but never "reachable".
let outage = 0;
const since = (seen, ok) => { if (!ok || seen === outage) setReachable(ok); };
function setReachable(ok) {
  if (state.reachable === ok) return;
  if (!ok) outage++;
  state.reachable = ok;
  core.store.reachable = ok;
  renderChrome();
  renderCore();
  clearTimeout(healthTimer);
  if (!ok) {
    const check = () => reach('/api/health').then((r) => {
      if (!r.ok || fromCache(r)) throw new Error();
      setReachable(true);
      loadList();
      refreshCore();
      if (state.id && (!stream || stream.readyState === EventSource.CLOSED)) open(state.id, { quiet: true });
    }).catch(() => { healthTimer = setTimeout(check, 2000); }); // wait: retry: is the server back?
    healthTimer = setTimeout(check, 2000); // wait: retry: is the server back?
  }
}

// ---- routing -------------------------------------------------------------

// "/" is Home; "/chat" the main conversation; "/new" starts another; "/c/<id>" opens one.
// Era 2's paths keep working (/schedules is Automations).
function route() {
  if (setupShowing()) return;
  const r = routeOf(location.pathname);
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
  else if (r.dest === 'topology') showTopologyView();
  else if (['about', 'changelog', 'pipeline'].includes(r.dest)) showAboutView(r.dest);
  else if (r.dest === 'receipts') showReceiptsView();
  else showCore(r.dest);
}

const VIEWS = { home: 'home', chat: 'thread', tasks: 'tasks', memory: 'memory', automations: 'automations', skills: 'skills', activity: 'activity', health: 'health', settings: 'settings', capture: 'capture', topology: 'topology', about: 'about', changelog: 'changelog', pipeline: 'pipeline', receipts: 'receipts' };
function setView(view) {
  const was = state.view;
  state.view = view;
  document.body.dataset.view = view;
  // The glance column's default differs in a conversation (shell.js): read the layout again.
  if ((was === 'chat') !== (view === 'chat')) { readLayout(); window.dispatchEvent(new CustomEvent('nova:layout', { detail: { ...layout } })); }
  topologyVisible(view === 'topology');
  for (const [v, key] of Object.entries(VIEWS)) el[key].hidden = v !== view;
  el.dock.hidden = view !== 'chat';
  if (view !== 'chat') { document.body.removeAttribute('data-empty'); document.body.removeAttribute('data-dock-wait'); }
  showMenu();
  if (view !== 'chat') el.jump.hidden = true;
  if (was === 'settings' && view !== 'settings') { core.cancelPreview(); core.leaveBackups(); }
  // Settings' children (Capture, Topology, About and its pages) belong to Settings in the navigation.
  markCurrent(destination(view)?.parent ?? view);
  if (was !== view) showSignals();
}

// Every view but a conversation opens the same way: the conversation's stream closes, and the page
// starts at its top. `extra` is any other state the view resets.
function leaveChat(view, extra = {}) {
  stream?.close();
  stream = null;
  Object.assign(state, { id: null, live: null, pending: null, ...extra });
  setView(view);
  el.scroller.scrollTop = 0;
  renderChrome();
  renderToc_();
}

// The core's own surfaces: Home, Tasks, Health.
function showCore(view) {
  leaveChat(view);
  renderCore({ enter: true });
  // Conversations and month rollover need no Core event; opening Health reads current spend.
  // A Caps-only failure belongs to its panel, not the whole Core's availability.
  if (view === 'health') core.load(['caps', 'version']).then(() => renderCore());
  const target = view === 'home' ? null : el[VIEWS[view]];
  if (target) target.focus({ preventScroll: true });
}

// After a real render, once the view's entrance has settled: its layout, for the next skeleton.
function rememberShape(view, node, id = '') {
  doneWaiting(view);
  const moving = node.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
  Promise.all(moving.map((a) => a.finished.catch(() => {}))).then(() => { if (state.view === (view === 'chat' ? 'chat' : view) && node.isConnected) keepShape(view, node, blocksOf(view, node), id); });
}

function enter(node) {
  node.classList.remove('view-enter');
  void node.offsetWidth;
  node.classList.add('view-enter');
}

// Draw whatever of the core's surfaces is on screen, keeping the reader's place and focus.
function renderCore({ enter: entering = false } = {}) {
  const keep = (node, draw) => {
    const waited = !!node.querySelector('[data-skeleton], .view-waiting');
    const focusKey = document.activeElement && node.contains(document.activeElement) ? (document.activeElement.dataset.task ?? document.activeElement.dataset.action ?? null) : null;
    draw(node);
    if (core.store.loaded && !node.querySelector('[data-skeleton], .view-waiting') && (entering || waited)) rememberShape(state.view, node);
    if (focusKey) node.querySelector(`[data-task="${CSS.escape(focusKey)}"], [data-action="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    if (entering) enter(node);
  };
  core.renderAside(el.aside);
  if (state.view === 'home') keep(el.home, core.renderHome);
  if (state.view === 'tasks') keep(el.tasks, core.renderTasks);
  if (state.view === 'health') keep(el.health, core.renderHealth);
  if (state.view === 'automations') core.renderRules(el.rules);
  // An empty chat too: its greeting takes the name once the profile is in.
  if (state.view === 'chat') renderThread();
  showSignals();
}

let refreshing = null;
function refreshCore(parts) {
  // The chrome too: the "saved earlier" banner depends on whether these answers were live.
  // No part answered at all, not even from the offline cache: Nova is out of reach, and the page says so.
  const seen = outage;
  refreshing = core.load(parts).then(({ any, live }) => { since(seen, any && live); renderChrome(); renderCore(); renderVoice(); });
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
  Object.assign(state, { id: null, session: emptySession(), live: null, pending: null, stick: true, missing: false });
  restoreDraft();
  renderAll({ enter: true });
  el.input.focus();
}

function open(id, { quiet = false } = {}) {
  stream?.close();
  setView('chat');
  if (!quiet || state.id !== id) Object.assign(state, { id, live: null, pending: state.pending?.sessionId === id ? state.pending : null, stick: true, snapshot: false, missing: false });
  if (!state.snapshot && !state.pending) { rendered = new Map(); showWaiting('chat', el.thread, 'Loading the conversation', { end: true, id }); }
  restoreDraft();
  // The dock's state for the wait (renderThread): set now, before the first paint of it.
  renderThread();
  renderChrome();
  if (id === 'main') markMainSeen();
  const es = new EventSource(`/api/sessions/${id}/events`);
  stream = es;
  let first = true;
  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    state.session = snap.session;
    state.live = snap.live;
    state.snapshot = true;
    // In at last (the stream kept trying): whatever was said while it couldn’t be opened is over.
    state.missing = false;
    if (state.pending && state.session.turns.some((t) => !t.kind && t.text === state.pending.text && t.ts >= state.pending.since)) state.pending = null;
    renderAll({ enter: first && !quiet });
    if (first && state.session.turns.length) rememberShape('chat', el.thread, id);
    first = false;
  });
  es.addEventListener('event', (e) => onEvent(JSON.parse(e.data)));
  // The server sends a phase (with the text so far) before the pieces that follow it, so the page
  // just takes it (src/runner.js; tests/m9-stream-order.test.js).
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
    // A stream that fails before any snapshot: the wait is over, never left waiting for good. Refused
    // (closed), or never answered (a network failure: the browser keeps trying, so it stays open;
    // walker W-7). A failed stream doesn't say why, so one ordinary read asks (F-024): "no such
    // conversation" is said as that, with Nova still reachable; only no answer at all is an outage.
    // A stream still trying while Nova answers that read is still on its way: it keeps waiting.
    if (es === stream && !state.snapshot) {
      const closed = es.readyState === EventSource.CLOSED;
      reach(`/api/sessions/${encodeURIComponent(id)}`).then((r) => {
        if (es !== stream || state.snapshot) return;
        if (r.status === 404) { Object.assign(state, { snapshot: true, missing: 'gone', session: emptySession(id) }); setReachable(true); renderThread(); renderChrome(); return; }
        if (!closed && r.ok && !fromCache(r)) return;
        throw new Error('refused');
      }).catch(() => {
        if (es !== stream || state.snapshot) return;
        Object.assign(state, { snapshot: true, missing: 'unreachable', session: emptySession(id) });
        renderThread(); renderChrome();
        setReachable(false);
      });
      return;
    }
    if (es.readyState === EventSource.CLOSED) {
      setReachable(false);
      return;
    }
    setTimeout(() => { if (es === stream && es.readyState !== EventSource.OPEN) setReachable(false); }, 1500); // wait: debounce: a stream that reconnects at once is not a drop
  });
}

function onEvent(ev) {
  applyEvent(state.session, ev);
  // The person's message is in: its send is over, and Nova's turn is timed from when they sent it.
  if (ev.type === 'user') { if (state.pending) begin(`reply-${ev.turn}`, state.pending.at); state.pending = null; over('send'); }
  if (ev.type === 'done') { const t = state.session.turns.find((x) => x.id === ev.turn); if (t?.ts && ev.ts) remember('reply', Date.parse(ev.ts) - Date.parse(t.ts)); }
  if (ev.type === 'assistant' && state.live?.turn === ev.turn) state.live.text = '';
  if (ev.type === 'session' || ev.type === 'title') loadList();
  renderThread();
  renderChrome();
}

// ---- rendering -----------------------------------------------------------

function viewSession() {
  if (!state.pending) return state.session;
  const turn = { id: 'pending', text: state.pending.text, ts: state.pending.since, attempt: 0, items: [], state: 'open', sending: !state.pending.sent };
  return { ...state.session, turns: [...state.session.turns, turn] };
}

function viewLive() {
  if (state.pending) return { turn: 'pending', attempt: 0, phase: 'thinking', text: '' };
  return state.live;
}

function renderAll({ enter: entering = false } = {}) {
  rendered = new Map();
  el.thread.innerHTML = '';
  el.thread.classList.add('no-anim');
  renderThread();
  requestAnimationFrame(() => el.thread.classList.remove('no-anim'));
  if (entering) enter(el.thread);
  renderChrome();
  renderToc_();
  const target = /^#[th]-/.test(location.hash) && document.getElementById(location.hash.slice(1));
  if (target) {
    state.stick = false;
    target.scrollIntoView({ block: 'start' });
    flash(target);
  } else scrollToEnd(true);
}

// Briefly mark what a link pointed at: the mark stays for a moment, long enough to see where it
// is, then goes (wait: expiry).
const FOUND_MS = 1600;
let found = null;
function flash(node) {
  if (found) { clearTimeout(found.timer); found.node.classList.remove('is-found'); }
  node.classList.add('is-found');
  found = { node, timer: setTimeout(() => { node.classList.remove('is-found'); found = null; }, FOUND_MS) }; // wait: expiry: the mark
}

// A conversation that couldn't be opened, said as what it is (F-024): there is no such
// conversation, or Nova's server isn't answering. Never the greeting of an empty chat.
const MISSING = {
  gone: '<div class="empty" data-missing="gone"><p class="empty-line">This conversation doesn’t exist.</p><p class="memory-lede">It may have been deleted, or the link is wrong. <a href="/chat">Open the main conversation</a>.</p></div>',
  unreachable: '<div class="empty" data-missing="unreachable"><p class="empty-line">This conversation couldn’t be opened.</p><p class="memory-lede">Nova’s server isn’t answering. Your conversations are safe on disk; <a href="/chat">open the main conversation</a> once it’s back.</p><button type="button" class="btn" data-action="retry-chat">Try again</button></div>',
};
let emptyKey = '';

// A conversation whose snapshot isn't in yet is waiting (open): nothing of another one shows.
const loadingChat = () => state.view === 'chat' && !!state.id && state.snapshot === false && !state.pending;
// Known to have no turns: a fresh one at once, any other only once its snapshot is in.
const blankChat = () => state.view === 'chat' && !loadingChat() && !state.missing && !viewSession().turns.length;

function renderThread() {
  const waiting = loadingChat();
  const session = viewSession();
  // An empty chat centres its composer (components.css); the first turn docks it again. The dock's
  // geometry is final when it shows: only the main conversation can turn out empty after loading
  // (any other began with a message), so while it loads its dock keeps its place unseen but
  // focusable (components.css), then shows docked or centred, never moving on screen.
  document.body.toggleAttribute('data-empty', blankChat());
  document.body.toggleAttribute('data-dock-wait', waiting && state.id === 'main');
  if (waiting) return;
  const wasNear = nearBottom();
  if (!session.turns.length) {
    const name = core.store.identity?.address_as ?? core.store.identity?.user_name ?? '';
    // Drawn again only when what it says changes (the name arriving), so it doesn't rise twice.
    const key = state.missing ? `missing-${state.missing}` : greeting(new Date(), name);
    if (!el.thread.querySelector('.empty') || key !== emptyKey) {
      el.thread.innerHTML = state.missing ? MISSING[state.missing] ?? MISSING.unreachable : renderEmpty(new Date(), { name, orb: liveIcon('hero') });
      emptyKey = key;
      rendered = new Map();
    }
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

// Every view's heading names it, Home's too (UX review 1, F5: never an empty heading); beside a
// rail, and on a phone's Home, it is there for screen readers only (layout.css).
const TITLES = { home: 'Home', tasks: 'Tasks', memory: 'Memory', automations: 'Automations', skills: 'Skills', activity: 'Activity', health: 'Health', settings: 'Settings', capture: 'Capture', topology: 'Topology', about: 'About Nova', changelog: 'What’s new', pipeline: 'Where Nova stands', receipts: 'Receipts' };
// A conversation's own title, from its snapshot or the list. "Untitled" only once it is in and has
// none: while it loads, or when it couldn't be opened, its title isn't known (W-7).
const chatTitle = () => state.session.title || (Array.isArray(state.list) ? state.list.find((s) => s.id === state.id)?.title : '') || (state.snapshot && !state.missing ? 'Untitled' : 'Conversation');
function renderChrome() {
  const title = state.view === 'chat' ? (!state.id ? 'New chat' : state.missing === 'gone' ? 'Conversation not found' : state.id !== 'main' ? chatTitle() : 'Nova') : TITLES[state.view] ?? '';
  el.dock.hidden = state.view !== 'chat' || readOnly();
  // An empty chat asks; a thread with turns is replied to. The field is two rows while it is centred.
  // Only a chat known to be empty: while one loads, the field stays one row, as most land.
  const blank = blankChat();
  el.input.placeholder = blank ? 'Ask Nova anything…' : 'Reply to Nova…';
  if (el.input.rows !== (blank ? 2 : 1)) { el.input.rows = blank ? 2 : 1; autosize(); }
  if (onMain()) el.mainLink.setAttribute('aria-current', 'page');
  else el.mainLink.removeAttribute('aria-current');
  el.title.textContent = title;
  document.title = title && title !== 'Nova' && state.view !== 'home' ? `${title} · Nova` : 'Nova';

  const run = running();
  const hasText = !!el.input.value.trim();
  el.send.innerHTML = run ? icons.stop : icons.send;
  el.send.classList.toggle('is-stop', run);
  el.send.setAttribute('aria-label', run ? 'Stop' : 'Send');
  el.send.title = run ? 'Stop (Esc)' : 'Send (Enter)';
  el.send.disabled = run ? !!state.pending : !hasText || !state.reachable;

  // Honest about being offline: what's on screen may be from before.
  let banner = '';
  if (!state.reachable) banner = 'Nova’s server isn’t answering. Your conversations are safe on disk; this page reconnects when it’s back.';
  else if (core.store.stale) banner = 'Some of this was saved earlier, while Nova was out of reach.';
  // A standby (or a hub that stepped down) says so on every screen, with which node is hub.
  const replica = state.reachable ? core.store.mesh?.replica : null;
  if (!banner && replica) banner = replica.reason;
  el.banner.hidden = !banner;
  el.banner.textContent = banner;
  // A standby that can approve can make itself the hub. A node that stepped down copies nothing; if
  // the hub is gone, it can become the hub from the latest backup (M10g). The sheet says first what
  // that loses.
  if (banner && replica && banner === replica.reason && core.store.mesh?.you?.can_approve) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.dataset.action = replica.demoted ? 'promote-cold' : 'promote';
    b.textContent = replica.demoted ? 'Make this the hub from a backup' : 'Make this the hub';
    el.banner.append(b);
  }

  let hint = state.notice;
  if (!hint && run) hint = 'Esc to stop';
  else if (!hint && document.activeElement === el.input && !hasText) hint = 'Enter to send · Shift Enter for a new line';
  el.hint.textContent = hint;
}

function renderToc_() {
  const current = state.view === 'chat' ? state.id : null;
  el.toc.innerHTML = renderToc(state.list, current);
  setRecent(state.list, current);
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
  notePlace();
}, { passive: true });

// The reader's place survives a resize, a fold or an unfold (M9; UX-RESEARCH §7: "losing scroll
// position on unfold is the signature failure"): what was at the top of the screen stays there, at
// the same distance, however the text reflows. A conversation read at its end stays at its end.
let place = null;
let placeSize = '';
const sizeOf = () => `${el.scroller.clientWidth}x${el.scroller.clientHeight}`;
const BLOCK = '.turn, .dateline, .gap-divider, .card, .memory-item, .settings-row, .settings-cat, .task-row, .act-entry, .skill, section, li, header';
function notePlace() {
  // A scroll the browser makes while it resizes isn't the reader's: the place from before stands.
  if (sizeOf() !== placeSize) return;
  const box = el.scroller.getBoundingClientRect();
  if (state.view === 'chat' && state.stick) { place = { end: true }; return; }
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 8);
  const node = hit && el.scroller.contains(hit) && hit !== el.scroller ? hit.closest(BLOCK) ?? hit : null;
  place = node ? { node, off: node.getBoundingClientRect().top - box.top } : null;
}
const placeWatch = new ResizeObserver(() => {
  placeSize = sizeOf();
  if (place?.end) { if (state.view === 'chat') scrollToEnd(); return; }
  if (!place?.node?.isConnected) return;
  const box = el.scroller.getBoundingClientRect();
  el.scroller.scrollTop += place.node.getBoundingClientRect().top - box.top - place.off;
});
for (const n of [el.scroller, el.thread]) placeWatch.observe(n);
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
  draftTimer = setTimeout(() => { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {} }, 250); // wait: debounce: saving the draft
}

// The field grows with what is typed, up to its cap (then it scrolls inside). Past one line the
// composer stops being a pill: it keeps the input radius (UX review 1, F0).
function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${el.input.scrollHeight}px`;
  const cs = getComputedStyle(el.input);
  const line = Number.parseFloat(cs.lineHeight) || 0;
  const one = line + Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
  el.composer.classList.toggle('is-grown', el.input.scrollHeight >= one + line * 0.9);
}

function say(notice, ms = 4000) {
  state.notice = notice;
  renderChrome();
  clearTimeout(say.t);
  say.t = setTimeout(() => { state.notice = ''; renderChrome(); }, ms); // wait: expiry: the notice
}

async function send() {
  const text = el.input.value.trim();
  if (!text || running() || !state.reachable) return;
  const sessionId = state.id;
  // A new wait begins now, on this page's clock: the send, and Nova's turn after it.
  state.pending = { text, since: new Date().toISOString(), at: begin('send'), sessionId };
  begin('reply-pending', state.pending.at);
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
      state.pending.sent = true;
      over('send');
      history.pushState(null, '', `/c/${id}`);
      open(id);
      loadList();
    } else {
      await post(`/api/sessions/${sessionId}/messages`, { text });
      if (state.pending) { state.pending.sent = true; over('send'); renderThread(); }
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
  // Tier 3 on Nova's own screen is confirmed with a passkey (T2; null on a paired device).
  let body = { decision };
  if (decision === 'allow' && card?.dataset.tier === '3') {
    try { const signed = await approvalFor(api, 'POST', `/sessions/${state.id}/approvals/${tool}`, body); if (signed) body = { ...body, passkey_approval: signed }; } catch (e) { card?.querySelectorAll('button').forEach((b) => { b.disabled = false; }); toast(e.message); return; }
  }
  try { await post(`/api/sessions/${state.id}/approvals/${tool}`, body); }
  catch (e) { card?.querySelectorAll('button').forEach((b) => { b.disabled = false; }); say(e.message); }
}

el.composer.addEventListener('submit', (e) => { e.preventDefault(); running() ? stop() : send(); });
// The privacy chip opens Settings › Privacy in the app.
el.privacyChip.addEventListener('click', (e) => { followLink(e); });
// A tier-3 step's confirm box unlocks its Allow button.
el.thread.addEventListener('change', (e) => {
  const box = e.target.closest?.('[data-confirm]');
  if (!box) return;
  const allow = box.closest('.approval')?.querySelector('[data-action="allow"]');
  if (allow) allow.disabled = !box.checked;
});
el.input.addEventListener('input', () => { autosize(); saveDraft(); renderChrome(); });
// A suggestion on an empty chat fills the composer for the person to finish or send; it never sends.
el.dock.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  el.input.value = chip.textContent;
  autosize(); saveDraft(); renderChrome();
  el.input.focus();
});
el.input.addEventListener('focus', renderChrome);
el.input.addEventListener('blur', () => setTimeout(renderChrome, 0)); // wait: after the event: focus has moved
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
  setTimeout(() => { button.classList.remove('is-done'); label.textContent = before; }, 1600); // wait: expiry: “Copied”
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
  if (!a || a.hasAttribute('download') || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !inApp(a.getAttribute('href'))) return false;
  e.preventDefault();
  closeDrawer();
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
  if (e.pointerType === 'touch' && msg && !operating(e, msg)) pressTimer = setTimeout(() => { pressed = true; showTime(msg, true); }, 450); // wait: long press
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
  leaveChat('memory');
  renderMemoryView({ enter: true });
  loadMemory().then(() => {
    const target = location.hash.startsWith('#m-') && document.getElementById(location.hash.slice(1));
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); flash(target); }
    else el.memory.focus({ preventScroll: true }); // Tab goes straight to the first memory

  });
}

// Memory's filter (F-062). What is typed lives only here, in the page: never sent, never in the
// address, never in browser storage. It narrows the rows already loaded and keeps their order; a
// section or day left with none is hidden. Held items ("Waiting for your OK") are never hidden and
// never counted, since one may ask to forget a memory.
let memoryQuery = '';
function filterMemory() {
  const box = el.memory.querySelector('#memory-filter');
  if (!box) return;
  const rows = [...el.memory.querySelectorAll('.memory-item:not([data-candidate])')];
  let shown = 0;
  for (const row of rows) {
    const hit = memoryMatch(memoryQuery, row.querySelector('.memory-text')?.textContent ?? '');
    row.hidden = !hit;
    if (hit) shown++;
  }
  for (const list of el.memory.querySelectorAll('.memory-list')) {
    if (list.closest('#waiting')) continue;
    const empty = !list.querySelector('.memory-item:not([hidden])');
    list.hidden = empty;
    const day = list.previousElementSibling;
    if (day?.matches('.memory-day')) day.hidden = empty;
  }
  for (const section of el.memory.querySelectorAll('.memory-section')) {
    if (section.id === 'waiting') continue;
    section.hidden = !!memoryQuery.trim() && !section.querySelector('.memory-item:not([hidden])');
  }
  const filtering = !!memoryQuery.trim();
  const count = el.memory.querySelector('#memory-filter-count');
  const said = filtering ? memoryFilterCount(shown, rows.length) : '';
  if (count.textContent !== said) count.textContent = said;
  el.memory.querySelector('#memory-filter-scope').hidden = !filtering;
  el.memory.querySelector('.memory-filter-none').hidden = !filtering || shown > 0;
}
for (const ev of ['input', 'search']) {
  el.memory.addEventListener(ev, (e) => {
    if (e.target.id !== 'memory-filter' || e.target.value === memoryQuery) return;
    memoryQuery = e.target.value;
    filterMemory();
  });
}

let memoryDeferred = false;
function renderMemoryView({ enter: entering = false } = {}) {
  if (el.memory.querySelector('.is-editing')) { memoryDeferred = true; return; }
  const waited = !!el.memory.querySelector('[data-skeleton], .view-waiting');
  memoryDeferred = false;
  const focused = document.activeElement?.closest?.('.memory-item')?.dataset.id;
  const at = focused ? [...el.memory.querySelectorAll('.memory-item')].findIndex((x) => x.dataset.id === focused) : -1;
  // A re-render (a forget, an edit, a refresh) keeps what is typed and where the caret is.
  const typing = document.activeElement?.id === 'memory-filter' ? document.activeElement.selectionStart : null;
  if (state.memory) {
    el.memory.innerHTML = renderMemory(state.memory);
    const box = el.memory.querySelector('#memory-filter');
    if (box) {
      box.value = memoryQuery;
      filterMemory();
      if (typing != null) { box.focus({ preventScroll: true }); box.setSelectionRange(typing, typing); }
    }
  } else if (state.memoryError) el.memory.innerHTML = errorEmpty("Memory couldn't be read.", state.memoryError, 'retry-memory');
  else if (!el.memory.querySelector('[data-skeleton], .view-waiting')) showWaiting('memory', el.memory, 'Loading Memory', { head: '<header class="memory-intro"><p class="empty-date">What Nova knows</p></header>' });
  if (state.memory && (entering || waited)) rememberShape('memory', el.memory);
  // An edit gives the memory a new id; focus stays where it was in the list.
  if (focused) (document.getElementById(`m-${focused}`) ?? el.memory.querySelectorAll('.memory-item')[at])?.focus({ preventScroll: true });
  if (entering) enter(el.memory);
}

function autosizeField(field) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
}

// `draft`: words the person typed before, when a save failed and they edit again.
function editMemory(item, draft = null) {
  if (item.classList.contains('is-editing')) return;
  const text = item.querySelector('.memory-text');
  const field = document.createElement('textarea');
  field.className = 'memory-edit';
  field.rows = 1;
  field.value = draft ?? text.textContent;
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
      // The honest split (DESIGN-SYSTEM §1.6): the new words at once; "Saving" if the server takes
      // a second; "Saved" only when it has them. A failure puts back what is really saved, says
      // why, and keeps what was typed one tap away.
      text.textContent = next;
      text.insertAdjacentHTML('afterend', waitingLine('Saving', { key: 'memory-save' }));
      const saving = text.nextElementSibling;
      try {
        const { entry } = await post(`/api/memory/${item.dataset.id}`, { text: next });
        if (entry?.id) item.dataset.id = entry.id; // a correction is a new record; the next edit must name it
        toast('Saved. Nova will use it from the next message.');
      } catch (e) {
        text.textContent = before;
        // Changed elsewhere: show the newest wording instead of offering to resend a stale edit.
        if (e.status === 409) { notify(`${e.message} Your change wasn’t saved.`); loadMemory(); return; }
        notify(`${e.message} Your change wasn’t saved.`, { action: { label: 'Edit again', run: () => { const now = document.getElementById(item.id) ?? item; editMemory(now, next); } } });
      } finally { saving?.remove(); over('memory-save'); }
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

// F-038: the person says a memory Nova wrote is right (the core's confirm route). Its "Not yet
// checked" goes; focus stays on the row.
async function confirmMemory(item) {
  try {
    await post(`/api/v1/memory/${encodeURIComponent(item.dataset.id)}/confirm`);
    await loadMemory();
    document.getElementById(item.id)?.focus({ preventScroll: true });
    toast('Confirmed.');
  } catch (e) { toast(e.message); }
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

// Memory a conversation that read outside content wanted kept: the person keeps or drops it.
async function decideCandidate(b) {
  const id = b.closest('[data-candidate]')?.dataset.candidate;
  if (!id) return;
  const keep = b.dataset.action === 'keep-candidate';
  try {
    await post(`/api/memory/candidates/${encodeURIComponent(id)}/${keep ? 'keep' : 'drop'}`);
    toast(keep ? 'Kept.' : 'Dropped. It isn’t in Memory.');
    loadMemory();
  } catch (e) { toast(e.message); }
}

el.memory.addEventListener('click', (e) => {
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  const item = e.target.closest('.memory-item');
  if (b?.dataset.action === 'keep-candidate' || b?.dataset.action === 'drop-candidate') return decideCandidate(b);
  if (b?.dataset.action === 'edit-memory') editMemory(item);
  else if (b?.dataset.action === 'forget-memory') forgetMemory(item);
  else if (b?.dataset.action === 'confirm-memory') confirmMemory(item);
  else if (b?.dataset.action === 'retry-memory') loadMemory();
  else if (item && !item.dataset.candidate && e.target.closest('.memory-text')) editMemory(item);
});
// A list whose items take focus: the arrow keys move between them, and Enter and Delete (or
// Backspace) act on the focused one. Where `canEnter` or `canDel` says no, the key is the browser's.
function rove(root, selector, { enter: onEnter, del, canEnter = () => true, canDel = () => true }) {
  root.addEventListener('keydown', (e) => {
    const item = e.target.closest(selector);
    if (!item || e.target !== item) return;
    // A row a filter hid isn't a stop.
    const items = [...root.querySelectorAll(selector)].filter((x) => !x.closest('[hidden]'));
    const i = items.indexOf(item);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
    if (e.key === 'Enter' && canEnter(item)) { e.preventDefault(); onEnter(item); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && del && canDel(item)) { e.preventDefault(); del(item); }
  });
}
// A skill's or schedule's playbook opens and closes with Enter.
const togglePlaybook = (item) => { const d = item.querySelector('.skill-playbook'); d.open = !d.open; };

rove(el.memory, '.memory-item', { enter: (item) => editMemory(item), del: forgetMemory });

// ---- skills ----------------------------------------------------------------

const isLocal = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

function showSkills() {
  leaveChat('skills');
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

function renderSkillsView({ enter: entering = false } = {}) {
  // What the person was typing survives a re-render (another tab, a sign-in).
  const typed = Object.fromEntries(GMAIL_FIELDS.map((id) => [id, $(id)?.value]).filter(([, v]) => v));
  const focused = document.activeElement;
  const focusKey = focused?.closest?.('.skill')?.id ?? (GMAIL_FIELDS.includes(focused?.id) ? focused.id : null);
  const advancedOpen = el.skills.querySelector('.connection-advanced')?.open;
  const open = [...el.skills.querySelectorAll('.skill-playbook[open]')].map((d) => d.closest('.skill').id);
  if (state.skills) el.skills.innerHTML = renderSkills(state.skills, { local: isLocal() });
  else if (state.skillsError) el.skills.innerHTML = errorEmpty("Skills couldn't be shown.", state.skillsError, 'retry-skills');
  else el.skills.innerHTML = waitingLine('Loading skills', { key: 'view-skills' });
  for (const id of open) document.querySelector(`#${CSS.escape(id)} .skill-playbook`)?.setAttribute('open', '');
  for (const [id, v] of Object.entries(typed)) if ($(id)) $(id).value = v;
  if (advancedOpen) el.skills.querySelector('.connection-advanced')?.setAttribute('open', '');
  if (focusKey) $(focusKey)?.focus({ preventScroll: true });
  if (entering) enter(el.skills);
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
    const { files, data } = await post(`/api/skills/${id}/remove`);
    state.undo = async () => {
      try {
        await post(`/api/skills/${id}/restore`, { files, ...(data ? { data } : {}) });
        await loadSkills();
        $(`s-${id}`)?.focus();
        toast('Back, exactly as it was.');
      } catch (e) { toast(e.message); }
    };
    await loadSkills();
    (next && $(next.id) || el.skills.querySelector('.skill') || el.skills).focus({ preventScroll: true });
    toast(`Removed ${name}.`, { undo: true });
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
  else if (action === 'allow-skill') post(`/api/skills/${item.dataset.id}/allow`).then(() => { toast('Turned on. Nova uses it from now on.'); return loadSkills(); }).catch((err) => toast(err.message));
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
rove(el.skills, '.skill', { enter: togglePlaybook, del: removeSkill, canDel: (item) => !item.classList.contains('is-available') });

// ---- schedules -------------------------------------------------------------

function showSchedules() {
  leaveChat('automations');
  core.renderRules(el.rules);
  renderSchedulesView({ enter: true });
  loadSchedules().then(() => {
    const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); flash(target); }
    else el.automations.querySelector('.trigger-row button, #schedules')?.focus({ preventScroll: true });
  });
}

function renderSchedulesView({ enter: entering = false } = {}) {
  const focused = document.activeElement;
  const focusKey = focused?.closest?.('.skill')?.id;
  const inForm = focused?.closest?.('form') ? focused.name : null;
  const open = [...el.schedules.querySelectorAll('.skill-playbook[open]')].map((d) => d.closest('.skill').id);
  const typed = Object.fromEntries([...el.schedules.querySelectorAll('.schedule-setup')].map((f) => [f.closest('.skill').id, { time: f.time.value, days: f.days.value }]));
  if (state.schedules) el.schedules.innerHTML = renderSchedules(state.schedules, new Date());
  else if (state.schedulesError) el.schedules.innerHTML = errorEmpty("Schedules couldn't be shown.", state.schedulesError, 'retry-schedules');
  else el.schedules.innerHTML = waitingLine('Loading schedules', { key: 'view-schedules' });
  for (const id of open) document.querySelector(`#${CSS.escape(id)} .skill-playbook`)?.setAttribute('open', '');
  for (const [id, v] of Object.entries(typed)) {
    const f = document.querySelector(`#${CSS.escape(id)} .schedule-setup`);
    if (f) { f.time.value = v.time; f.days.value = v.days; }
  }
  if (focusKey) {
    const item = $(focusKey);
    (inForm && item?.querySelector(`[name="${inForm}"]`) || item)?.focus({ preventScroll: true });
  }
  if (entering) enter(el.schedules);
}
// "Next: tomorrow at 7:00 AM" stays true as the clock moves.
setInterval(() => { if (state.view === 'automations' && !document.hidden) renderSchedulesView(); }, 60_000); // wait: clock: “Next: …” stays true

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
rove(el.schedules, '.skill', { enter: togglePlaybook, del: removeSchedule, canDel: (item) => item.classList.contains('schedule') });

// ---- activity --------------------------------------------------------------

function showActivity() {
  leaveChat('activity', { earlier: [] });
  renderActivityView({ enter: true });
  loadActivity().then(() => {
    const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); flash(target); }
    else el.activity.focus({ preventScroll: true });
  });
}

function renderActivityView({ enter: entering = false } = {}) {
  const focused = document.activeElement;
  const focusKey = focused?.closest?.('.act-entry')?.id;
  const focusAction = focused?.dataset?.action ?? null;
  const open = [...el.activity.querySelectorAll('.act-steps[open]')].map((d) => d.closest('.act-entry').id);
  const top = el.scroller.scrollTop;
  if (state.activity) {
    const days = [...state.activity.days, ...state.earlier.flatMap((w) => w.days)];
    const last = state.earlier.at(-1) ?? state.activity;
    el.activity.innerHTML = renderActivity({ ...state.activity, days, more: last.more, before: last.before, earlier: state.earlier.length > 0 }, new Date());
  } else if (state.activityError) el.activity.innerHTML = errorEmpty("Activity couldn't be shown.", state.activityError, 'retry-activity');
  else el.activity.innerHTML = waitingLine('Loading activity', { key: 'view-activity' });
  for (const id of open) document.getElementById(id)?.querySelector('.act-steps')?.setAttribute('open', '');
  if (focusKey) {
    const item = $(focusKey);
    (focusAction && item?.querySelector(`[data-action="${focusAction}"]`) || item)?.focus({ preventScroll: true });
  }
  if (!entering) el.scroller.scrollTop = top;
  if (entering) enter(el.activity);
}
// "Working for 2 min" and the days stay true as the clock moves.
setInterval(() => { if (state.view === 'activity' && !document.hidden) renderActivityView(); }, 60_000); // wait: clock: “Working for …” stays true

async function earlier(button) {
  button.disabled = true;
  try {
    const week = await getJson(`/api/activity?before=${encodeURIComponent(button.dataset.before)}`);
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
// Enter opens an entry's steps, when it has any.
rove(el.activity, '.act-entry', { enter: (item) => { const d = item.querySelector('.act-steps'); d.open = !d.open; }, canEnter: (item) => !!item.querySelector('.act-steps') });

// ---- settings: you and Nova, privacy, permissions, appearance, devices ------------------------

let permissions = null;
let permissionsError = '';
function loadPermissions() {
  return getJson('/api/permissions')
    .then((data) => { permissions = data.permissions; permissionsError = ''; if (state.view === 'settings') renderSettingsView({ only: 'perms' }); })
    .catch(() => {
      permissionsError = "Nova's server didn't answer, so settings can't be shown right now.";
      if (state.view === 'settings' && !permissions) renderSettingsView({ only: 'perms' });
    });
}

// Settings is one structure (settings-ia.js) in two layouts, as the approved composition draws it
// (docs/plans/ui-rebuild-compositions-2026-11-06.md §2): from the expanded width (840px,
// layout.css) on a flat screen, the category list with its search at the head, beside the open
// category; below it, two screens: the list, then a category with a back row. The hash says what is
// open: a category (#models), opened at its top as a click does, or a setting in one
// (#appearance-mode), which opens its category and is brought into view.
// `touched`: the person has typed in search or opened something since Settings opened, so data
// arriving late must not move their focus or scroll.
// `query` and `found`: the search in force. It filters the list and marks matches in the detail.
const settingsUi = { cat: null, touched: false, query: '', found: [] };
const settingsList = () => {
  const wide = getComputedStyle(document.documentElement).getPropertyValue('--settings-layout').trim() === 'sidebar';
  return !wide || layout.layout === 'phone' || (layout.layout === 'tablet' && layout.posture !== 'continuous');
};

function settingsTarget(hash) {
  const id = decodeURIComponent(hash.replace(/^#/, ''));
  if (!id) return { cat: null, target: null };
  if (id.startsWith('models-on-')) return { cat: 'devices', target: null };
  if (categoryOf(id)) return { cat: id, target: null };
  const target = el.settings.querySelector(`#${CSS.escape(id)}`);
  const pane = target?.closest('.settings-pane');
  if (pane) return { cat: pane.dataset.cat, target: pane === target ? null : target };
  return { cat: categoryOf(id) ? id : null, target: null };
}

function selectSettings(cat) {
  if (settingsUi.cat !== cat) core.hideBackupsKey();
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
}

// From the list or the sidebar to a category, as its own step in the history.
// A device's Models screen, in the Devices pane: opened from a device's Models button (Settings ›
// Devices, or Settings › Models' overview) or its address, /settings#models-on-<device>.
function openDeviceModels(id, { push = true } = {}) {
  if (push) history.pushState(null, '', `/settings#models-on-${encodeURIComponent(id)}`);
  setScreenDevice(id);
  renderSettingsView({ only: 'devices' });
  selectSettings('devices');
  el.scroller.scrollTop = 0;
  $('settings-devices').querySelector('[data-action="dm-back"]')?.focus({ preventScroll: true });
}
function leaveDeviceModels() {
  if (setScreenDevice(null)) renderSettingsView({ only: 'devices' });
}

function openSettingsCat(cat, { push = true } = {}) {
  if (push) leaveDeviceModels();
  if (push) { core.hideBackupsKey(); history.pushState(null, '', `/settings#${cat}`); }
  selectSettings(cat);
  el.scroller.scrollTop = 0;
  const pane = el.settings.querySelector(`.settings-pane[data-cat="${CSS.escape(cat)}"]`);
  pane?.querySelector('.settings-pane-title')?.focus({ preventScroll: true });
  // While searching, the first match in it is brought into view.
  if (settingsUi.query) pane?.querySelector('[data-match]')?.scrollIntoView({ block: 'nearest' });
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

// Search filters the category list: only categories with a match stay, each with its count, and
// the matches are marked in the detail. Only the summary is announced (#settings-count, a live
// region that stays put). On a sidebar, an open category without a match gives way to the best one.
function searchSettingsView(query) {
  const q = query.trim();
  const { found, cats } = q ? filterSettings(q) : { found: [], cats: [] };
  settingsUi.query = q;
  settingsUi.found = found;
  const counts = new Map(cats.map((c) => [c.id, c.count]));
  const nav = $('settings-nav');
  if (!nav) return;
  for (const li of nav.querySelectorAll('.settings-cats > li')) {
    const n = counts.get(li.dataset.cat) ?? 0;
    li.hidden = !!q && !n;
    const c = li.querySelector('.cat-count');
    c.hidden = !q || !n;
    c.innerHTML = n ? `${n}<span class="sr-only"> ${n === 1 ? 'match' : 'matches'}</span>` : '';
  }
  for (const g of nav.querySelectorAll('.settings-group')) g.hidden = !!q && ![...g.querySelectorAll('.settings-cats > li')].some((li) => !li.hidden);
  el.settings.dataset.searching = q ? 'yes' : 'no';
  $('settings-clear').hidden = !q;
  const count = $('settings-count');
  const said = !q ? ''
    : found.length ? `${found.length} setting${found.length === 1 ? '' : 's'} match “${q}”, in ${cats.length} categor${cats.length === 1 ? 'y' : 'ies'}. Only categories with a match are listed.`
      : `Nothing matches “${q}”. Try another word, like “theme”, “phone” or “backup”.`;
  if (count.textContent !== said) count.textContent = said;
  markSettings();
  if (q && cats.length && !settingsList() && !counts.has(settingsUi.cat ?? CATEGORIES[0].id)) selectSettings(found[0].cat);
}

// The marks: the words searched for, where they appear in a matching setting; where they don't (it
// matched a word people use for it), its name. Live regions and form fields are left alone.
const SKIP_MARK = 'script, style, textarea, select, option, [role="status"], [aria-live], mark.settings-mark';
function unmarkSettings() {
  for (const m of el.settings.querySelectorAll('mark.settings-mark')) { const p = m.parentNode; m.replaceWith(...m.childNodes); p.normalize(); }
  for (const n of el.settings.querySelectorAll('[data-match]')) n.removeAttribute('data-match');
}
function markText(root, terms) {
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest(SKIP_MARK) || !n.data.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  let marked = 0;
  for (const node of nodes) {
    const parts = [];
    let last = 0;
    for (const m of node.data.matchAll(re)) {
      if (!m[0]) continue;
      parts.push(document.createTextNode(node.data.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = 'settings-mark';
      mark.textContent = m[0];
      parts.push(mark);
      last = m.index + m[0].length;
      marked++;
    }
    if (parts.length) { parts.push(document.createTextNode(node.data.slice(last))); node.replaceWith(...parts); }
  }
  return marked;
}
function markSettings() {
  unmarkSettings();
  const q = settingsUi.query.toLowerCase();
  if (!q) return;
  const words = q.split(/\s+/).filter((w) => w.length >= 2);
  for (const r of settingsUi.found) {
    const target = $(r.target);
    if (!target || !el.settings.contains(target) || target.hasAttribute('data-match')) continue;
    target.setAttribute('data-match', '');
    if (markText(target, [q]) || (words.length && markText(target, words))) continue;
    const name = target.matches('.settings-label, legend, h2, h3') ? target : target.querySelector('.settings-label, .perm-label, h2, h3, legend:not(.sr-only)');
    // Only its name's own words: a note beside them (a legend's “· all devices”) stays as it is.
    const text = name && !name.closest(SKIP_MARK) ? [...name.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.data.trim()) : null;
    if (text) { const mark = document.createElement('mark'); mark.className = 'settings-mark'; text.replaceWith(mark); mark.append(text); }
  }
}

// Enter in the search: the best match, opened, in view, with focus on its control. The search
// stays, so the other matches stay marked.
function openBestMatch() {
  const best = settingsUi.found[0];
  if (!best) return;
  core.hideBackupsKey();
  leaveDeviceModels();
  const target = $(best.target) ?? el.settings.querySelector(`.settings-pane[data-cat="${CSS.escape(best.cat)}"]`);
  history.pushState(null, '', `/settings#${best.target}`);
  if (target) goToSetting(target);
}

// "/" puts focus in the search from anywhere in Settings; on a phone's category screen it goes
// back to the list first, where the search is.
function focusSettingsSearch() {
  const input = $('settings-search');
  if (!input) return;
  if (!input.checkVisibility()) { leaveDeviceModels(); history.pushState(null, '', '/settings'); selectSettings(null); el.scroller.scrollTop = 0; }
  settingsUi.touched = true;
  input.focus();
  input.select();
}

function showSettings() {
  core.hideBackupsKey();
  core.enterBackups();
  leaveChat('settings');
  const dm = /^#models-on-(.+)$/.exec(location.hash);
  setScreenDevice(dm ? decodeURIComponent(dm[1]) : null);
  renderSettingsView({ enter: true });
  settingsUi.touched = false;
  // Settings opens without a search in force.
  $('settings-search').value = '';
  searchSettingsView('');
  selectSettings(settingsTarget(location.hash).cat);
  const opened = location.hash;
  Promise.all([core.loadBackups(), loadPermissions(), refreshCore(['profile', 'version']), loadConnections(), loadSites(), core.loadProviders(), loadCapture(), loadModels(), loadApprovals(), loadChanges(), loadCheckpoints(), loadServices(), loadReset(), loadSecurity(api), loadConfigForm()]).then(() => {
    renderSettingsView({ only: 'security' });
    renderSettingsView({ only: 'you' });
    renderSettingsView({ only: 'privacy' });
    renderSettingsView({ only: 'form' });
    renderSettingsView({ only: 'about' });
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
  about: () => core.renderAboutSettings(),
  privacy: () => core.renderPrivacy(),
  providers: () => core.renderProviders(),
  // Approvals (approvals.js: every registered capability's tier, from GET /approvals), then the
  // conversation's switches it links to as "Steps in a conversation", which stay as they were.
  perms: () => renderApprovals() + (permissions ? renderPermissions(permissions) : permissionsError ? `<section class="memory-section" id="perms" aria-labelledby="set-perms"><h2 class="memory-heading" id="set-perms">Without asking</h2>
<p class="memory-lede">${permissionsError}</p><button type="button" class="btn set-retry" data-action="retry-settings">Try again</button></section>` : ''),
  connections: () => renderConnections(),
  sites: () => renderSites(),
  capture: () => renderCaptureSettings(),
  models: () => renderModels(),
  changes: () => renderChanges(),
  backups: { draw: (box) => core.drawBackups(box) },
  checkpoints: () => renderCheckpoints(),
  // Drawn in place, so its live regions stay the same elements (surfaces.js drawAppearance).
  look: { draw: (box) => core.drawAppearance(box) },
  // Settings › Devices › [device] › Models (model-fit step 3) takes the Devices pane while it is open.
  // When that screen is already showing (a heartbeat refreshes the device list), it refreshes in place.
  devices: { draw: (box) => { const id = screenDevice(); if (id && refreshDeviceModels(box, id)) return; box.innerHTML = id ? deviceModelsFrame(id) : core.renderDevices(); } },
  services: () => renderServices(),
  security: () => renderSecurity(),
  form: () => renderConfigForm(),
  config: () => renderConfig(),
  // The Danger zone (M7 amendment §2) stays last, set apart.
  danger: () => renderReset(),
};

// A category's pane is a plain section, not a named region: its parts are named regions of their own,
// and a pane named like its part (You and Nova) would be a second landmark with that name (UX review 1, F5).
// The composition's two columns: the category list with the search at its head, and the detail.
// A category's page opens with its name and one line of what it holds, then its settings: a name,
// a line of what it does, and the control on the right (components.js settingsRow).
function settingsShell() {
  const groups = GROUPS.map((g) => `<section class="settings-group"><h3 class="settings-group-title">${escapeHtml(g.title)}</h3><ul class="settings-cats">${g.cats.map((id) => {
    const c = categoryOf(id);
    return `<li data-cat="${id}"><a class="settings-cat" href="/settings#${id}" data-cat="${id}"><span class="cat-label">${escapeHtml(c.label)}</span><span class="cat-count" hidden></span><span class="cat-chevron" aria-hidden="true">${ICONS.chevron}</span></a></li>`;
  }).join('')}</ul></section>`).join('');
  return `<div class="settings-layout">
  <div class="settings-side">
    <header class="view-head settings-head">
      <h2 class="view-title" id="settings-title">Settings</h2>
      <div class="settings-search" role="search">
        <span class="settings-search-icon" aria-hidden="true">${ICONS.search}</span>
        <label class="sr-only" for="settings-search">Search settings</label>
        <input type="search" class="settings-search-input" id="settings-search" placeholder="Search settings" autocomplete="off" spellcheck="false" aria-keyshortcuts="/" aria-describedby="settings-count">
        <kbd class="settings-key" aria-hidden="true">/</kbd>
        <button type="button" class="settings-clear" id="settings-clear" aria-label="Clear search" hidden>${ICONS.close}</button>
      </div>
      <p class="settings-count" id="settings-count" role="status"></p>
    </header>
    <nav class="settings-nav" id="settings-nav" aria-label="Settings">${groups}</nav>
  </div>
  <div class="settings-detail">
    <button type="button" class="settings-back" id="settings-back" hidden>${ICONS.back}<span>Settings</span></button>
    ${CATEGORIES.map((c) => `<section class="settings-pane" data-cat="${c.id}" hidden><header class="settings-pane-head"><h2 class="settings-pane-title" id="settings-pane-${c.id}" tabindex="-1">${escapeHtml(c.label)}</h2><p class="settings-pane-lede">${escapeHtml(c.summary)}</p></header>${c.parts.map((k) => `<div class="settings-part" id="settings-${k}"></div>`).join('')}</section>`).join('')}
  </div>
</div>`;
}

// A part whose own heading only repeats its category's name keeps it for screen readers alone:
// the page's heading already says it (one title per page, caption headings over groups).
function quietRepeatHeading(box) {
  const pane = box.closest('.settings-pane');
  const own = box.querySelector(':scope > section > h2:first-child, :scope > section > h3:first-child');
  if (!pane || !own) return;
  const same = own.textContent.trim().toLowerCase() === pane.querySelector('.settings-pane-title').textContent.trim().toLowerCase();
  own.classList.toggle('settings-repeat', same);
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
    if (k !== 'backups' && box.contains(active) && active.matches('input[type="text"], input[type="number"], input[type="password"], input[type="url"], input[type="search"], input:not([type]), textarea')) continue;
    // A device's Models screen keeps focus on its control by id (its selects and slider have no other name).
    const focus = box.contains(active) ? (active.closest('[data-device-models]') && active.id ? `#${CSS.escape(active.id)}` : active.dataset.id ? `[data-id="${CSS.escape(active.dataset.id)}"]` : active.name ? `input[name="${CSS.escape(active.name)}"]:checked` : active.dataset.action ? `[data-action="${CSS.escape(active.dataset.action)}"]${active.dataset.ds ? `[data-ds="${CSS.escape(active.dataset.ds)}"]` : ''}${active.dataset.scope ? `[data-scope="${CSS.escape(active.dataset.scope)}"]` : ''}` : active.type === 'submit' && active.form?.dataset.form ? `form[data-form="${CSS.escape(active.form.dataset.form)}"] [type="submit"]` : null) : null;
    // Capture's, Models' and Approvals' (in perms) forms sit under a status that changes by itself;
    // what is typed or picked there is kept.
    const restore = k === 'capture' || k === 'models' || k === 'perms' ? keepEdits(box) : () => {};
    const part = PARTS[k];
    if (typeof part === 'function') box.innerHTML = part(); else part.draw(box);
    restore();
    quietRepeatHeading(box);
    if (focus) box.querySelector(focus)?.focus({ preventScroll: true });
  }
  // A part drawn again under a search in force gets its marks again.
  if (settingsUi.query) markSettings();
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
  if (e.target.closest('#settings-back')) {
    settingsUi.touched = true;
    const was = settingsUi.cat;
    leaveDeviceModels(); history.pushState(null, '', '/settings'); selectSettings(null); el.scroller.scrollTop = 0;
    const cats = [...el.settings.querySelectorAll('#settings-nav .settings-cats > li:not([hidden]) .settings-cat')];
    (cats.find((a) => a.dataset.cat === was) ?? cats[0])?.focus({ preventScroll: true });
    return;
  }
  if (e.target.closest('#settings-clear')) { settingsUi.touched = true; const input = $('settings-search'); input.value = ''; searchSettingsView(''); input.focus(); return; }
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  const action = b?.dataset.action;
  if (action === 'device-models') { settingsUi.touched = true; openDeviceModels(b.dataset.device); }
  else if (action === 'dm-back') {
    settingsUi.touched = true;
    history.pushState(null, '', '/settings#devices');
    leaveDeviceModels();
    selectSettings('devices');
    $('settings-devices').querySelector(`[data-action="device-models"][data-device="${CSS.escape(b.dataset.device)}"]`)?.focus({ preventScroll: true });
  }
  else if (action === 'toggle-permission') togglePermission(b);
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
// Anything the person types in Settings is theirs: data arriving late leaves their focus alone (M9).
el.settings.addEventListener('input', (e) => { settingsUi.touched = true; if (e.target.id === 'settings-search') searchSettingsView(e.target.value); });
el.settings.addEventListener('keydown', (e) => {
  // The arrow keys go from the search into the list (only what is listed) and along it.
  const listed = () => [...el.settings.querySelectorAll('#settings-nav .settings-cats > li:not([hidden]) .settings-cat')];
  if (e.target.id === 'settings-search' && e.key === 'ArrowDown') { e.preventDefault(); listed()[0]?.focus(); return; }
  if (e.target.matches?.('#settings-nav .settings-cat') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const cats = listed();
    const i = cats.indexOf(e.target) + (e.key === 'ArrowDown' ? 1 : -1);
    if (i < 0) $('settings-search').focus(); else cats[Math.min(i, cats.length - 1)].focus();
    return;
  }
  if (e.target.id === 'settings-search' && e.key === 'Enter') { e.preventDefault(); settingsUi.touched = true; openBestMatch(); return; }
  if (e.target.id === 'settings-search' && e.key === 'Escape' && e.target.value) { e.preventDefault(); e.target.value = ''; searchSettingsView(''); return; }
  if (e.key === 'Enter' && e.target.matches('#you-name, #nova-name')) { e.preventDefault(); e.target.nextElementSibling?.click(); }
});
window.addEventListener('nova:appearance', () => { if (state.view === 'settings') renderSettingsView({ only: 'look' }); });
window.addEventListener('nova:installable', () => { if (state.view === 'settings') renderSettingsView({ only: 'devices' }); });
window.addEventListener('nova:providers', () => { if (state.view === 'settings') { renderSettingsView({ only: 'providers' }); renderSettingsView({ only: 'privacy' }); } });

// ---- voice: dictation into the composer, off in local-only --------------------------------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
// The composer's privacy chip names the current privacy mode.
const PRIVACY_CHIP = { 'local-only': 'Local only', 'local-preferred': 'Local first', 'cloud-allowed': 'Cloud allowed' };
function renderVoice() {
  const mode = PRIVACY_CHIP[core.privacy()] ?? 'Privacy';
  el.privacyChip.textContent = mode;
  el.privacyChip.setAttribute('aria-label', mode === 'Privacy' ? 'Privacy settings' : `Privacy: ${mode}. Change in Settings`);
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
  pendingTimer = setTimeout(() => { const list = [...pending]; pending = new Set(); refreshCore(list); }, 120); // wait: debounce: many events at once
}
onCore('task', () => scheduleRefresh(['tasks', 'caps']));
onCore('problem', (p) => {
  scheduleRefresh(['problems', 'health', 'resilience']);
  notify(p?.message ?? 'Something went wrong inside Nova.', { tone: p?.stops ? 'alert' : 'attention', action: { label: 'See Health', run: () => navigate('/health') } });
});
onCore('message', () => scheduleRefresh(['messages']));
// A repair playbook moved (M7b): what Nova did shows under its problem.
onCore('playbook', () => scheduleRefresh(['resilience', 'problems']));
onCore('trigger', () => scheduleRefresh(['rules', 'messages']));
onCore('profile', () => scheduleRefresh(['profile', 'caps']));
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
  leaveChat('capture');
  drawCapture();
  enter(el.capture);
  el.capture.focus({ preventScroll: true });
  Promise.all([loadCapture(), loadCaptureView()]);
}
bindTopology(el.topology);
function showTopologyView() {
  leaveChat('topology');
  showTopology();
  el.topology.focus({ preventScroll: true });
}
// About Nova, What's new and Where Nova stands (about.js, loaded the first time one opens).
function showAboutView(view) {
  leaveChat(view);
  enter(el[view]);
  el[view].focus({ preventScroll: true });
  import('./about.js').then((m) => m.show(view, el[view])).catch(() => {
    el[view].innerHTML = `<header class="view-head"><h2 class="view-title">${escapeHtml(TITLES[view])}</h2></header><div class="empty-state"><p class="empty-title">This page couldn’t open</p><p class="empty-sub">Nova’s server didn’t answer.</p><button type="button" class="btn" data-about-reopen>Try again</button></div>`;
    el[view].querySelector('[data-about-reopen]')?.addEventListener('click', () => { if (state.view === view) showAboutView(view); }, { once: true });
  });
}
// Receipts (receipts.js, loaded the first time it opens): the owner's composition with real receipts.
let receiptsBound = false;
function showReceiptsView() {
  leaveChat('receipts');
  enter(el.receipts);
  el.receipts.focus({ preventScroll: true });
  import('./receipts.js').then((m) => {
    if (!receiptsBound) { receiptsBound = true; m.bind(el.receipts, { openTask: (id) => core.openTask(id) }); }
    return m.show(el.receipts);
  }).catch(() => {
    el.receipts.innerHTML = `<header class="view-head"><h2 class="view-title">${escapeHtml(TITLES.receipts)}</h2></header><div class="empty-state"><p class="empty-title">This page couldn’t open</p><p class="empty-sub">Nova’s server didn’t answer. Open it again once Nova is back.</p></div>`;
  });
}
el.receipts.addEventListener('click', (e) => { followLink(e); });
el.capture.addEventListener('click', (e) => { followLink(e); });
// The indicator opens the Capture view in place, from any page.
$('capture-ind').addEventListener('click', (e) => { followLink(e); });
// A Settings part redraws when its own data changes, if Settings is open and the part is there.
const bindPart = (k) => () => { if (state.view === 'settings' && $(`settings-${k}`)) renderSettingsView({ only: k }); };
bindConnections(el.settings, bindPart('connections'));
bindSites(el.settings, bindPart('sites'));
// Settings › Models (M6b): hardware, roles, downloads with live progress, budgets.
bindModels(el.settings, bindPart('models'));
// Settings › Privacy and permissions › Approvals: each registered capability's tier.
bindApprovals(el.settings, bindPart('perms'), (path) => navigate(path));
bindDeviceModels(el.settings);
// Settings › Changes (M7a): the change pipeline, the one waiting for you, canaries, roll back.
bindChanges(el.settings, bindPart('changes'));
core.bindBackups(el.settings, () => { if ($('settings-backups')) renderSettingsView({ only: 'backups' }); });
bindConfig(el.settings, () => renderSettingsView({ only: 'config' }));
bindConfigForm(el.settings, () => renderSettingsView({ only: 'form' }));
// A setting changed elsewhere (a file, a chat, another screen): the list shows it, and its layer.
onCore('profile', () => { if (state.view === 'settings') loadConfigForm().then(() => renderSettingsView({ only: 'form' })); });
onCore('profile', () => { if (state.view === 'settings') core.loadBackups(); });
// Settings › Backups › Checkpoints (M7 amendment): take one, restore (the hub's screen only), delete.
bindCheckpoints(el.settings, bindPart('checkpoints'));
bindServices(bindPart('services'));
// Settings › Danger zone (M7 amendment §2): export, confirm, erase and start over.
bindReset(el.settings, bindPart('danger'));
// A provider was set up, turned on or off, or checked (M5a): Settings shows it at once.
onCore('provider', () => { if (state.view === 'settings') core.loadProviders(); });
// The device mesh: the registry changed, or a device is asking to join (only approvers hear that).
onCore('device', () => scheduleRefresh(['devices', 'mesh']));
// Hub or standby changed (promoted, stepped down); on a standby, the hub's changes arrived.
onCore('mesh', () => scheduleRefresh(['mesh', 'devices', 'health']));
onCore('sync', () => scheduleRefresh(['tasks', 'problems', 'health', 'profile', 'memory', 'rules', 'messages', 'devices', 'mesh', 'caps']));
onCore('join_request', (r) => {
  scheduleRefresh(['requests']);
  if (r?.state === 'pending') core.promptJoin(r);
  else core.joinDecided(r);
});
window.addEventListener('nova:devices', () => { if (state.view === 'settings') renderSettingsView({ only: 'devices' }); renderCore(); renderChrome(); });

// Health redraws its facts around the retained editor, including live per-part freshness.
window.addEventListener('nova:work-costs', () => { if (state.view === 'health') core.renderHealth(el.health); });
el.health.addEventListener('input', e => { const form = e.target.closest('[data-work-limits]'); if (form) core.editWorkCosts(form); });
el.health.addEventListener('change', e => { const form = e.target.closest('[data-work-limits]'); if (form) core.editWorkCosts(form); });
el.health.addEventListener('submit', e => { if (e.target.matches('[data-work-limits]')) { e.preventDefault(); core.saveWorkCosts(); } });
el.health.addEventListener('click', e => { if (e.target.closest('[data-retry-work-costs]')) core.retryWorkCosts(); });

// Actions on the core's surfaces, wherever they appear: Home, the right column, Tasks, Health,
// Automations, and the sheet.
// Each takes the button and its action. The last three show a failure as a toast.
const taskOf = (b) => b.dataset.task ?? b.closest('[data-task]')?.dataset.task;
const openTask = (b) => core.openTask(taskOf(b));
const taskAction = (b, action) => core.taskAction(action, taskOf(b));
const ruleAction = (b, action) => core.ruleAction(action, b.closest('[data-rule]').dataset.rule);
const resilienceAction = (b, action) => core.resilienceAction(action, b.dataset.problem).then(() => scheduleRefresh(['resilience', 'problems', 'health', 'tasks']));
const toasting = (act) => async (b) => { try { await act(b); } catch (e) { toast(e.message); } };
const CORE_ACTIONS = {
  'open-task': openTask, evidence: openTask, 'retry-task': taskAction, 'cancel-task': taskAction,
  'decline-merge': (b) => core.declineMerge(b.dataset.run),
  'decline-change': (b) => core.declineChange(b.dataset.path, b.dataset.said),
  'close-sheet': () => closeSheet(),
  'pause-rule': ruleAction, 'resume-rule': ruleAction, 'delete-rule': ruleAction,
  'add-device': () => core.addDevice(),
  'copy-command': () => core.copyCommand(),
  'review-request': (b) => core.openRequest(b.dataset.request),
  'deny-request': (b) => core.denyRequest(b.dataset.request),
  'revoke-device': (b) => core.revokeDevice(b.dataset.device),
  'allow-approve': (b) => core.allowApprove(b.dataset.device, b.dataset.value),
  'edit-roles': (b) => core.editRoles(b.dataset.device),
  promote: () => core.promote(),
  'promote-device': (b) => core.promoteDevice(b.dataset.device),
  'promote-cold': () => core.promoteCold(),
  'promotion-cancel': () => core.promotionAction('cancel'),
  'promotion-take-back': () => core.promotionAction('take-back'),
  'backup-now': resilienceAction, 'drill-now': resilienceAction, 'repair-problem': resilienceAction,
  // A part that couldn't be loaded (F-021, F-023): that part alone, read again and drawn in place.
  // One part failing again says nothing about whether Nova answers, so reachability is left alone.
  'retry-part': (b) => (['tasks', 'problems', 'health', 'rules', 'memory', 'devices'].includes(b.dataset.part) ? core.load([b.dataset.part]).then(() => renderCore()) : null),
  // A conversation that couldn’t be opened (W-7): open it again, waiting as at first.
  'retry-chat': () => { if (state.view === 'chat' && state.id) open(state.id); },
  'resolve-problem': toasting(async (b) => { await post(`/api/v1/problems/${encodeURIComponent(b.dataset.problem)}/resolve`); scheduleRefresh(['problems', 'health']); toast('Marked as dealt with.'); }),
  'read-message': toasting(async (b) => { await post(`/api/v1/messages/${encodeURIComponent(b.dataset.message)}/read`); scheduleRefresh(['messages']); }),
  'send-message': toasting(async (b) => { await post(`/api/v1/messages/${encodeURIComponent(b.dataset.message)}/approve`); scheduleRefresh(['messages']); toast('Sent.'); }),
};
async function coreAction(b) { return CORE_ACTIONS[b.dataset.action](b, b.dataset.action); }
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.target.closest('#setup')) return;
  if (followLink(e)) return;
  const b = e.target.closest('[data-action]');
  // Own keys only: an action named like an Object method (toString) is not a core action.
  if (b && Object.hasOwn(CORE_ACTIONS, b.dataset.action)) { e.preventDefault(); coreAction(b); }
  if (b?.dataset.action === 'passkey-setup') { e.preventDefault(); setupPasskey(api, () => renderSettingsView({ only: 'security' })).then(() => scheduleRefresh(['health'])); }
});
// The approval sheet: tier 3 needs the box ticked before Confirm can be pressed.
$('sheet').addEventListener('submit', (e) => {
  const settings = e.target.closest('.provider-form');
  if (settings) { e.preventDefault(); core.saveProvider(settings); return; }
  const roles = e.target.closest('.roles-sheet');
  if (roles) { e.preventDefault(); core.reviewRoles(roles); return; }
  const form = e.target.closest('.approval-sheet');
  if (!form) return;
  if (form.hasAttribute('data-topology-approval')) { e.preventDefault(); submitTopology(form); return; }
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
window.addEventListener('hashchange', () => { core.hideBackupsKey(); });
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
// A phone has no conversations button (owner decision 2026-11-08, option B): its navigation drawer
// lists the recent ones, opens this drawer for the rest, and takes the focus back.
const drawerDoor = () => (layout.layout === 'phone' ? $('nav-menu') : el.menu);
const showMenu = () => { el.menu.hidden = state.view !== 'chat' || layout.layout === 'phone'; };
document.addEventListener('click', (e) => {
  if (e.target.closest?.('#nav-all')) openDrawer();
  else if (e.target.closest?.('#nav-new')) navigate('/new');
});
el.drawerClose.addEventListener('click', () => { closeDrawer(); drawerDoor().focus(); });
el.scrim.addEventListener('click', closeDrawer);
el.asideToggle.addEventListener('click', () => { toggleAside(); renderCore(); });
window.addEventListener('nova:layout', () => { showMenu(); renderCore(); if (state.view === 'settings') selectSettings(settingsUi.cat); });
// Settings changes layout at its own width too (840px, layout.css), within one app layout.
let settingsFrame = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(settingsFrame); settingsFrame = requestAnimationFrame(() => { if (state.view === 'settings') selectSettings(settingsUi.cat); }); });

function step(dir) {
  const i = state.list.findIndex((s) => s.id === state.id);
  const next = state.list[i < 0 ? (dir > 0 ? 0 : -1) : i + dir];
  if (next) navigate(`/c/${next.id}`);
}

// The command palette (Ctrl K / Cmd K, palette.js) goes through this router, like every door.
initPalette({ navigate, conversations: () => state.list, toggleAside: () => { toggleAside(); renderCore(); } });
// The rail's search button: the palette's touch door (a button, so Enter and Space open it too).
document.addEventListener('click', (e) => { if (e.target.closest?.('#rail-search')) openPalette(); });

document.addEventListener('keydown', (e) => {
  if (setupShowing() || e.defaultPrevented) return;
  const mod = e.metaKey || e.ctrlKey;
  const inField = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); navigate('/new'); return; }
  if (mod && e.key === '\\') { e.preventDefault(); if (layout.layout === 'desktop' && layout.room === 'yes') { toggleAside(); renderCore(); } return; }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); step(e.key === 'ArrowUp' ? -1 : 1); return; }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && !inField && state.view !== 'chat' && state.undo) { e.preventDefault(); runToastAction() || runUndo(); return; }
  if (e.key === '/' && !inField && state.view === 'chat') { e.preventDefault(); el.input.focus(); return; }
  if (e.key === '/' && !mod && !inField && state.view === 'settings') { e.preventDefault(); focusSettingsSearch(); return; }
  if (e.key === 'Escape') {
    if (el.app.classList.contains('drawer-open')) { closeDrawer(); drawerDoor().focus(); return; }
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
  setInterval(check, 10 * 60_000); // wait: clock: the session’s renewal
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

// ---- start -----------------------------------------------------------------

window.addEventListener('nova:unreachable', () => setReachable(false));
// Browser network hints can be false while this local Core answers. Probe Core on either
// hint; only live responses, failed requests and cache provenance determine reachability.
window.addEventListener('online', () => refreshCore());
window.addEventListener('offline', () => refreshCore());
document.addEventListener('visibilitychange', () => { if (!document.hidden && !setupShowing()) { loadList(); refreshCore(); } });

// The app shell is cached so Nova opens without a connection; the API stays network-first.
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

readLayout();
// The composer lines up with the conversation: as wide as the scroller's content, which is
// narrower by its scrollbar gutters (none for overlay scrollbars).
new ResizeObserver(() => $('main').style.setProperty('--gutter', `${el.scroller.offsetWidth - el.scroller.clientWidth}px`)).observe(el.scroller);
el.topbarOrb.innerHTML = liveIcon('mini');
applyTheme();
coreStream();
keepSession();
renderVoice();

// The page asked for, before Nova has said whether setup is needed (walker W-4: on a slow server that
// first read takes as long as any other): its title, the rail's mark, its heading and its waiting
// state, and the right column waiting. None of it needs data, so none of it claims any; route()
// draws the same view again once the app starts. Setup, if it is needed, opens over it.
function frame() {
  const r = routeOf(location.pathname);
  const view = r.unknown ? 'home' : r.dest;
  if (!VIEWS[view]) return;
  if (view === 'chat') Object.assign(state, { id: r.conversation, snapshot: false, missing: false });
  setView(view);
  renderChrome();
  if (view === 'chat') { renderThread(); if (state.id) showWaiting('chat', el.thread, 'Loading the conversation', { end: true, id: state.id }); core.renderAside(el.aside); }
  else if (view === 'memory') { renderMemoryView(); core.renderAside(el.aside); }
  else if (['home', 'tasks', 'health'].includes(view)) renderCore();
  else core.renderAside(el.aside);
}

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
  getJson('/api/v1/version').then(setBuild).catch(() => {}); // the rail's version stamp
  // The page shows once its layout and first view are set: nothing moves into place (M9, CLS).
  // Shown before route() in the same task, so no frame paints in between, but the composer can
  // take route()'s focus: a visibility:hidden shell can't be focused.
  document.body.dataset.shown = '';
  route();
}
frame();
// A blank profile opens the setup conversation, full screen, before anything else.
if (!(await startSetup({ done: (path = '/') => { boot(); navigate(path); } }))) boot();
document.body.dataset.shown = '';
document.documentElement.dataset.ready = 'true';
