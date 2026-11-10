// Receipts (/receipts): what Nova's model calls and service calls were told, and where each went
// (F-028). A child of Settings (nav.js), reached from Settings › Privacy. The screen is the owner's
// composition exactly (styleguide ?entry=receipts, drawn by receipts-draw.js), filled with the hub's
// real receipts from GET /api/v1/receipts; the composition still waits for the owner's reaction.
// The address says what is open: /receipts (the newest receipt beside the list), /receipts#<id>
// (that receipt), /receipts#coverage (what receipts cover). Read-only: nothing here sends anything.
import { api } from './core.js';
import { waitingLine } from './wait.js';
import { ALL, coverage, detail, emptyDetail, listPane, localOnlyDetail, panes, refilter } from './receipts-draw.js';

const ID = 'rc-app';
// Real addresses in place of the specimens' anchors.
const HREF = {
  receipt: (_id, r) => `/receipts#${r.id}`,
  list: () => '/receipts',
  coverage: () => '/receipts#coverage',
  task: () => '/tasks',
  conversation: (_id, r) => `/c/${encodeURIComponent(r.session_id)}`,
};

let generation = 0;
// The last read: receipts newest first, the privacy setting, and task titles by id.
let last = null;
let filter = ALL;

// The composition's styles (ui/styles/compositions.css, .uc-* and .rc-*), loaded the first time the
// screen opens: the rest of the app doesn't use them.
function styles() {
  if (document.querySelector('link[data-rc-styles]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/styles/compositions.css';
  l.dataset.rcStyles = '';
  document.head.append(l);
}

// The composition's own heading; its menu button and status icon are the app shell's already.
const frame = (inner) => `<div class="uc-screen rc rc-app" data-rc-frame="app"><div class="uc-main"><header class="uc-top"><h2 class="uc-title">Receipts</h2></header>${inner}</div></div>`;

function draw(root) {
  if (!last) return;
  const { list, privacy, tasks } = last;
  const at = decodeURIComponent(location.hash.slice(1));
  const localOnly = privacy === 'local-only';
  const f = localOnly && filter === ALL ? { where: 'left', mode: 'all' } : filter;
  const open = at && at !== 'coverage' ? list.find((r) => r.id === at) ?? null : null;
  const left = listPane(ID, { list, current: open?.id ?? (at ? '' : list[0]?.id ?? ''), f, localOnly, today: new Date().toISOString().slice(0, 10), href: HREF });
  let right;
  let pane = at ? 'detail' : 'list';
  if (at === 'coverage') right = coverage(ID, { href: HREF });
  else if (!list.length) { right = emptyDetail(ID, { href: HREF }); pane = 'detail'; }
  else if (localOnly && !open && !list.some((r) => r.egress !== 'local')) right = localOnlyDetail(ID, { href: HREF });
  else right = detail(ID, open ?? list[0], { tasks, href: HREF });
  root.innerHTML = frame(panes(pane, left, right));
}

async function read() {
  const mine = ++generation;
  const [receipts, profile, tasks] = await Promise.all([
    api('GET', '/receipts'),
    api('GET', '/profile').catch(() => null),
    api('GET', '/tasks?limit=200').catch(() => null),
  ]);
  if (mine !== generation) return null;
  const titles = {};
  for (const t of Array.isArray(tasks) ? tasks : []) titles[t.id] = t.title;
  return { list: Array.isArray(receipts) ? receipts : [], privacy: profile?.privacy?.default ?? null, tasks: titles };
}

export async function show(root) {
  styles();
  if (!last) root.innerHTML = frame(`<div class="rc-detail">${waitingLine('Reading the receipts', { key: 'receipts' })}</div>`);
  else draw(root);
  try {
    const r = await read();
    if (!r) return;
    last = r;
    draw(root);
  } catch {
    root.innerHTML = frame(`<div class="rc-detail"><h3 class="uc-h">Nova couldn’t read the receipts</h3><p class="rc-note">Its server didn’t answer. Open this page again once Nova is back.</p></div>`);
  }
}

// A new address inside the screen (a receipt, coverage, back to the list): drawn again from what
// was read, without reading again.
export function redraw(root) { draw(root); }

// The filters filter what was read, and "Open the task" opens the task's sheet.
export function bind(root, { openTask }) {
  root.addEventListener('change', (e) => {
    if (!e.target.closest('[data-rc-filter]')) return;
    filter = refilter(root) ?? ALL;
  });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-rc-task]');
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    openTask(t.dataset.rcTask);
  }, true);
}

