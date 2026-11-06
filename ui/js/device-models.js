// A device's Models screen in the app (model-fit step 3, built from the approved styleguide entry
// models-screen): Settings › Devices › [device] › Models, and the same component in device setup.
// It draws components.js deviceModels from GET /api/v1/models and runs the fit engine in the
// browser (fit-engine.js is src/core/models/fit.ts with its types erased), so a quant, a context or a
// change to the plan recomputes at once, by the server's own rule. Nothing is sent until the person
// asks: Install and assign first says what would download, where, and what it would serve; only on
// their OK does it go to POST /models/install, whose downloads are the same tier-2 tasks every model
// download is, approved here with that OK exactly as Settings › Models approves one
// (POST /tasks/{id}/approve). Already-installed models are assigned as PUT /models/roles does.
import { api, on } from './core.js';
import { ICONS, ago, deviceModels } from './components.js';
import * as fitEngine from './fit-engine.js';
import { escapeHtml as esc } from './markdown.js';
import { toast } from './shell.js';
import { makePart, waitingLine } from './wait.js';

const GiB = fitEngine.GiB;
const gb = (b) => `${(b / GiB).toFixed(1)} GB`;
// The contexts the slider offers: 2k to 32k, never past what the model says it can take.
const CONTEXTS = [2048, 4096, 8192, 16384, 32768];
// The role a task class's pick serves when it is installed and assigned. Coding has no role of its
// own yet, so a coding pick serves thinking and writing; vision and transcription serve none.
const TASK_ROLE = { 'general-chat': 'reasoner', coding: 'reasoner', screening: 'triage-text', embeddings: 'embedder', vision: null, transcription: null };
const ROLE_NAMES = { 'triage-text': 'sorting', reasoner: 'thinking and writing', embedder: 'finding by meaning' };

let data = null;
const part = makePart('models-device', async () => { data = await api('GET', '/models'); });
export const loadDeviceModels = () => part.load();
export const modelsData = () => data;

// Per device: the plan as the person left it, the OK an install waits for, what happened since,
// and the downloads it is following.
const plans = new Map();
const asks = new Map();
const said = new Map();
const busy = new Set();
const following = new Map();

// The screen Settings › Devices shows instead of its list, or null.
let screen = null;
export const screenDevice = () => screen;
export function setScreenDevice(id) {
  const was = screen;
  screen = id || null;
  if (screen && screen !== was) loadDeviceModels();
  return was;
}

const deviceOf = (id) => data?.devices.find((d) => d.id === id) ?? null;
const cand = (d, name) => d.plan?.candidates.find((c) => c.name === name && c.where === 'local') ?? null;
const same = (a, b) => a === b || a === `${b}:latest` || b === `${a}:latest`;
const isEmbed = (c) => c.capabilities.includes('embedding');
const isText = (c) => !isEmbed(c) && (c.capabilities.includes('completion') || !c.capabilities.length);
const contextsOf = (c, current) => {
  if (isEmbed(c)) return [c.max_context ?? 2048];
  const max = c.max_context ?? Infinity;
  const list = CONTEXTS.filter((n) => n <= max);
  return [...new Set([...list, current])].filter(Boolean).sort((a, b) => a - b);
};
const defaultContext = (c, role) => (isEmbed(c) ? c.max_context ?? 2048 : role === 'triage-text' ? 4096 : 4096);

// What a device runs models on, in a line: the GPU and its memory, the Mac's unified memory, or no GPU.
function hardwareLine(d) {
  const h = d.hardware;
  const gpu = h.gpus.filter((g) => g.unified || g.vram_bytes >= 2 * GiB).sort((a, b) => b.vram_bytes - a.vram_bytes)[0];
  const hub = d.hub ? ' · this is the hub' : '';
  if (gpu?.unified) return `${gpu.name} · ${gb(h.ram_bytes)} unified memory${hub}`;
  if (gpu) return `${gpu.name} · ${gb(gpu.vram_bytes)} video memory${hub}`;
  return `No GPU · ${gb(h.ram_bytes)} memory${hub}`;
}

// A device that is asleep shows what it last reported, and says how old that is.
function seenLine(d) {
  if (d.hub || d.online) return null;
  const a = (iso) => (iso ? ago(iso) : 'not yet');
  const p = d.plan;
  return `Last seen ${d.last_seen ? ago(d.last_seen) : 'never'}. What shows here is what it last reported: its hardware ${a(p?.hardware_at)}, its models ${p?.models_live ? 'now' : a(p?.models_at)}.`;
}

// The plan Nova starts from: what serves a role here, and what is loaded now.
function initialPlan(d) {
  const p = d.plan;
  const out = [];
  const add = (name, context, role, loaded) => {
    const c = cand(d, name) ?? p.candidates.find((x) => x.where === 'local' && same(x.name, name));
    if (!c || out.some((x) => x.name === c.name)) return;
    out.push({ name: c.name, quant: c.installed?.quant ?? c.default_quant, context: isEmbed(c) ? defaultContext(c, role) : context ?? defaultContext(c, role), role, loaded });
  };
  for (const r of p.roles) add(r.model, r.context, r.role, p.loaded.some((l) => same(l.name, r.model)));
  for (const l of p.loaded) add(l.name, l.context, null, true);
  return out;
}
const planOf = (d) => {
  if (!plans.has(d.id)) plans.set(d.id, initialPlan(d));
  return plans.get(d.id);
};

function fitModel(c, m) {
  const installed = !!c.installed && c.installed.quant === m.quant;
  return { name: m.name, params: c.params, weights_bytes: installed ? c.installed.weights_bytes : null, quant: m.quant, context: m.context, arch: c.arch, arch_source: c.arch ? (installed ? c.arch_source ?? 'backend' : 'catalog') : null, kv_type: 'f16' };
}

// Who serves what: a pick keeps its task's role; a model added by hand serves what nothing else in
// the plan does (an embedder finding by meaning; a text model thinking and writing, or on the hub,
// sorting if it is small); each role goes to one model only.
function withRoles(d, plan) {
  const used = new Set();
  const first = plan.map((m) => { const r = m.role && !used.has(m.role) ? m.role : null; if (r) used.add(r); return { ...m, role: r }; });
  return first.map((m) => {
    if (m.role || m.task) return m;
    const c = cand(d, m.name);
    let role = null;
    if (c && isEmbed(c) && !used.has('embedder')) role = 'embedder';
    else if (c && isText(c) && !used.has('reasoner')) role = 'reasoner';
    else if (c && isText(c) && d.hub && c.params <= 9e9 && !used.has('triage-text')) role = 'triage-text';
    if (role) used.add(role);
    return { ...m, role };
  });
}

const sizeOf = (c, quant) => (c.default_quant === quant && c.size ? c.size : fitEngine.weightsBytes(c.params, quant));

// The OK Install and assign asks for, from the plan: each download with its size and what it will
// serve, and each installed model that takes a role now.
function confirmOf(d, plan) {
  const rows = withRoles(d, plan);
  const downloads = rows.filter((m) => { const c = cand(d, m.name); return !(c.installed && c.installed.quant === m.quant); });
  const now = rows.filter((m) => m.role && !downloads.includes(m));
  const lines = [
    ...downloads.map((m) => `${m.name} at ${m.quant}, about ${gb(sizeOf(cand(d, m.name), m.quant))}, downloads to ${d.name}${m.role ? `, then serves ${ROLE_NAMES[m.role]}` : ''}.`),
    ...now.map((m) => `${m.name}, already here, serves ${ROLE_NAMES[m.role]} from now on.`),
  ];
  if (downloads.length) lines.push('Ollama downloads from its library on the internet; nothing of yours is sent. A role is given only once Nova has checked the download arrived.');
  if (!lines.length) lines.push('Everything planned is installed here, and none of it takes a role, so nothing changes.');
  const title = downloads.length ? `Download ${downloads.length === 1 ? 'this model' : `these ${downloads.length} models`}${rows.some((m) => m.role) ? ' and assign' : ''}?` : 'Assign these models?';
  return { title, lines, ok: downloads.length ? (rows.some((m) => m.role) ? 'Download and assign' : 'Download') : 'Assign', rows };
}

// The component's view for one device, as the styleguide builds it, from the server's own data.
function viewOf(d, where) {
  const p = d.plan;
  const device = fitEngine.deviceBudget(d.hardware, { overhead: p.overhead, loaded_vram_bytes: p.loaded.reduce((s, l) => s + (l.vram_bytes ?? 0), 0) });
  const plan = planOf(d).filter((m) => cand(d, m.name)).map((m) => {
    const c = cand(d, m.name);
    const installed = !!c.installed && c.installed.quant === m.quant;
    return {
      ...m, installed, loaded: !!m.loaded && installed, estimate: c.arch === null,
      quants: [...new Set([...c.quants, m.quant])], contexts: contextsOf(c, m.context),
      result: fitEngine.fit({ device, models: [fitModel(c, m)] }),
    };
  });
  const total = plan.length ? fitEngine.fit({ device, models: plan.map((m) => fitModel(cand(d, m.name), m)) }) : null;
  const advice = fitEngine.TASK_CLASSES.map((task) => fitEngine.recommendFit({ device, privacy: data.privacy, task, hub: d.hub, candidates: p.candidates }));
  const ask = asks.get(d.id);
  return {
    id: `dm-${where}-${d.id.replace(/[^\w-]/g, '')}`, privacy: data.privacy, plan, total, advice,
    catalog: p.candidates.filter((c) => c.where === 'local').map((c) => c.name),
    crumb: where === 'setup' ? `Setup › ${d.name}` : undefined,
    confirm: ask ? confirmOf(d, planOf(d)) : null, status: said.get(d.id) ?? null, busy: busy.has(d.id),
    device: { name: d.name, hardware: hardwareLine(d), memory: device.memory, budget_bytes: device.budget_bytes, ram_bytes: d.hardware.ram_bytes, overhead_source: device.overhead_source, overhead_loads: p.overhead.n, seen: seenLine(d) },
  };
}

// What goes inside a screen's frame for one device: the component, or why it can't be drawn yet.
function inner(id, where) {
  if (!data) return part.failed ? `<p class="settings-note">${esc(part.failed)}</p><button type="button" class="btn" data-action="dm-retry">Try again</button>` : waitingLine('Loading this device’s models', { key: 'models-device' });
  const d = deviceOf(id);
  if (!d) return '<p class="settings-note">This device hasn’t reported its hardware to Nova yet, so there is nothing to plan against. It shows here once it has.</p>';
  if (!d.plan) return `<p class="settings-note">${esc(d.name)} isn’t a compute device, so Nova plans no models for it. Give it the Compute role in Settings › Devices first.</p>`;
  if (!d.hardware) return `<p class="settings-note">${esc(d.name)} hasn’t reported its hardware yet, so Nova can’t say what fits.</p>`;
  return deviceModels(viewOf(d, where));
}

// The frame: Settings › Devices gets a way back to the list; device setup has its own.
export function deviceModelsFrame(id, where = 'settings') {
  const back = where === 'settings' ? `<button type="button" class="btn quiet dm-back" data-action="dm-back" data-device="${esc(id)}">${ICONS.back}<span>Devices</span></button>` : '';
  return `<div class="dm-screen" id="models-on-${esc(id)}" data-dm-device="${esc(id)}" data-dm-where="${esc(where)}">${back}<div data-dm-body>${inner(id, where)}</div></div>`;
}

// Redraws every frame on the page for a device (or all), keeping focus on the control that had it.
function redraw(only = null, focusId = null) {
  const active = document.activeElement;
  for (const f of document.querySelectorAll('[data-dm-device]')) {
    const id = f.dataset.dmDevice;
    if (only && id !== only) continue;
    const body = f.querySelector('[data-dm-body]');
    const keep = focusId ?? (body.contains(active) && active.id ? active.id : null);
    body.innerHTML = inner(id, f.dataset.dmWhere);
    if (keep) document.getElementById(keep)?.focus({ preventScroll: true });
  }
}
part.rerender = () => redraw();

const frameOf = (el) => el.closest('[data-dm-device]');
const idOf = (el) => frameOf(el)?.dataset.dmDevice ?? null;
const keyOf = (el) => el.closest('[data-device-models]')?.dataset.deviceModels ?? '';

async function install(d) {
  const rows = confirmOf(d, planOf(d)).rows;
  busy.add(d.id);
  asks.delete(d.id);
  said.set(d.id, 'Asking Nova to install and assign.');
  redraw(d.id);
  try {
    const r = await api('POST', '/models/install', { device: d.id, plan: rows.map((m) => ({ model: m.name, quant: m.quant, context: isEmbed(cand(d, m.name)) ? null : m.context, role: m.role ?? null })) });
    // The person's OK above is the OK each download waits for, given now, one task at a time.
    const failed = [];
    for (const t of r.tasks) {
      // Followed before the OK, so a download that finishes before the OK's answer is still heard.
      following.set(t.id, { device: d.id, model: t.model, role: t.role });
      try { await api('POST', `/tasks/${encodeURIComponent(t.id)}/approve`, {}); } catch (e) { following.delete(t.id); failed.push(`${t.model}: ${e.message}`); }
    }
    const going = r.tasks.filter((t) => following.has(t.id)).length;
    // A download that already finished has said so (below); this only says what is still going.
    if (!r.tasks.length || going || failed.length) said.set(d.id, [
      r.assigned.length ? `${r.assigned.map((a) => `${a.model} serves ${ROLE_NAMES[a.role]}`).join('; ')} now.` : '',
      going ? `Downloading ${going === 1 ? 'one model' : `${going} models`}; Settings › Models shows the progress.${r.tasks.some((t) => t.role) ? ' Each is assigned once Nova has checked it arrived.' : ''}` : '',
      failed.length ? `Not started: ${failed.join(' ')} It waits in Settings › Models › Downloads.` : '',
    ].filter(Boolean).join(' ') || r.words);
    plans.delete(d.id);
  } catch (e) {
    said.set(d.id, e.message);
  } finally {
    busy.delete(d.id);
  }
  toast(said.get(d.id));
  await loadDeviceModels();
}

// Wires a root (Settings, or the setup panel) to every Models frame inside it; the event stream's
// listeners are added once, whichever root is bound first.
let listening = false;
export function bindDeviceModels(root) {
  root.addEventListener('change', (e) => {
    const t = e.target;
    const id = idOf(t);
    const d = id && deviceOf(id);
    if (!d?.plan) return;
    const plan = planOf(d);
    if (t.dataset.modelsQuant !== undefined) { const m = plan[Number(t.dataset.modelsQuant)]; if (m) m.quant = t.value; }
    else if (t.dataset.modelsContext !== undefined) { const m = plan[Number(t.dataset.modelsContext)]; if (m) { const c = cand(d, m.name); m.context = contextsOf(c, m.context)[Number(t.value)] ?? m.context; } }
    else return;
    asks.delete(d.id);
    said.delete(d.id);
    redraw(d.id, t.id);
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b || !frameOf(b) || b.disabled) return;
    const a = b.dataset.action;
    const id = idOf(b);
    if (a === 'dm-retry') { loadDeviceModels(); return; }
    const d = deviceOf(id);
    if (!d?.plan || !a.startsWith('models-')) return;
    e.preventDefault();
    e.stopPropagation();
    const plan = planOf(d);
    const key = keyOf(b);
    const frame = frameOf(b);
    if (a === 'models-install') { asks.set(d.id, true); said.delete(d.id); redraw(d.id); frame.querySelector('[data-action="models-confirm"]')?.focus({ preventScroll: true }); return; }
    if (a === 'models-not-now') { asks.delete(d.id); said.set(d.id, 'Nothing was installed or assigned.'); redraw(d.id); frame.querySelector('[data-action="models-install"]')?.focus({ preventScroll: true }); return; }
    if (a === 'models-confirm') { install(d); return; }
    asks.delete(d.id);
    said.delete(d.id);
    if (a === 'models-remove') { plan.splice(Number(b.dataset.index), 1); redraw(d.id, `${key}-add`); return; }
    let entry;
    if (a === 'models-add') {
      const c = cand(d, document.getElementById(`${key}-add`)?.value ?? '');
      if (!c) return;
      entry = { name: c.name, quant: c.installed?.quant ?? c.default_quant, context: defaultContext(c, null), role: null };
    } else if (a === 'models-plan') {
      const c = cand(d, b.dataset.name);
      const task = b.closest('[data-task]')?.dataset.task;
      if (!c) return;
      entry = { name: c.name, quant: b.dataset.quant, context: Number(b.dataset.context) || defaultContext(c, null), role: TASK_ROLE[task] ?? null, task };
    } else return;
    const at = plan.findIndex((m) => m.name === entry.name);
    if (at >= 0) plan[at] = { ...plan[at], ...entry, loaded: plan[at].loaded && plan[at].quant === entry.quant };
    else plan.push(entry);
    redraw(d.id, `${key}-m${at >= 0 ? at : plan.length - 1}-quant`);
  });
  if (listening) return;
  listening = true;
  // A download this screen started: say how it ended, and show what changed.
  on('task', (t) => {
    const f = t && following.get(t.id);
    if (!f || !['done', 'failed', 'cancelled'].includes(t.state)) return;
    following.delete(t.id);
    said.set(f.device, t.state === 'done' ? `${f.model} is downloaded and checked${f.role ? `, and serves ${ROLE_NAMES[f.role]}` : ''}.` : `${f.model} didn’t download: ${t.reason ?? t.state}.`);
    if (document.querySelector('[data-dm-device]')) loadDeviceModels();
  });
  on('models', () => { if (document.querySelector('[data-dm-device]') && !busy.size) loadDeviceModels(); });
}
