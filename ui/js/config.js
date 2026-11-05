// Settings › Configuration (config onboarding, door 1; design approved in #303): bring settings in
// from a file, checked and shown as a diff first, or take them out as one. The file is only a
// format; the settings live in Nova. Applying something tier 3 goes through the passkey step.
import { api } from './core.js';
import { configField, configImport, configSetup } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { waitingLine } from './wait.js';

const view = { state: 'choose', name: 'nova-config.json', file: null, plan: null, problems: [] };
const words = (s) => s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const shown = (v) => (v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v));
const row = (c) => ({ key: c.key, label: `${words(c.section)} › ${words(c.name)}`, from: shown(c.from), to: shown(c.to), layer: c.layer, refused: c.refused });

export function renderConfig() {
  return `<section class="memory-section" id="config" aria-labelledby="set-config"><h2 class="memory-heading" id="set-config">Configuration</h2>
${configImport({ state: view.state, file: view.name, changes: (view.plan?.changes ?? []).map(row), problems: view.problems })}<p class="settings-note" role="status" data-config-said></p></section>`;
}

export function bindConfig(root, redraw) {
  const say = (text) => { const n = root.querySelector('[data-config-said]'); if (n) n.textContent = text; };
  root.addEventListener('change', async (e) => {
    const input = e.target.closest('#config [data-config-file]');
    if (!input?.files?.[0]) return;
    const f = input.files[0];
    view.name = f.name;
    try { view.file = JSON.parse(await f.text()); } catch { Object.assign(view, { state: 'refused', problems: ['The file isn’t valid JSON.'], plan: null }); redraw(); return; }
    try {
      const p = await api('POST', '/config/import', { file: view.file });
      Object.assign(view, { plan: p, problems: p.problems, state: p.problems.length ? 'refused' : 'review' });
    } catch (err) { Object.assign(view, { state: 'refused', problems: [err.message], plan: null }); }
    redraw();
  });
  root.addEventListener('click', async (e) => {
    const action = e.target.closest('#config [data-action^="config-"]')?.dataset.action;
    if (!action) return;
    if (action === 'config-choose') return root.querySelector('#config [data-config-file]')?.click();
    if (action === 'config-cancel') { Object.assign(view, { state: 'choose', plan: null, file: null }); return redraw(); }
    if (action === 'config-export') {
      try {
        const file = await api('GET', '/config/export');
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })), download: 'nova-config.json' });
        a.click();
        URL.revokeObjectURL(a.href);
        say('Exported your configuration as nova-config.json. It has no secrets in it.');
      } catch (err) { say(err.message); }
      return;
    }
    if (action === 'config-apply' && view.file) {
      try {
        const out = await api('POST', '/config/apply', { file: view.file, ...(view.plan?.tier === 3 ? { confirm: true } : {}) });
        Object.assign(view, { plan: out, state: 'applied' });
      } catch (err) { say(err.message); return; }
      redraw();
    }
  });
}

// ---- door 2: your settings, drawn from the schema (GET /config/schema) -------------------------
// Every one of your settings with the layer that set it; change any, or answer a few questions,
// and both end in the same diff as a file, saved through the same check (POST /config/settings).
// Privacy or what asks first is tier 3, so saving it goes through the passkey step. "Use the
// default" deletes the setting (POST /config/reset), so Nova's default shows through again.
const form = { state: 'list', step: 0, fields: null, error: '', draft: {}, plan: null, back: 'list', said: '' };
const stepsOf = () => [...new Set((form.fields ?? []).map((f) => f.step))];
const display = (f, v) => (v === undefined || v === null ? '' : f.type === 'hours' ? `${v.start}–${v.end}` : f.options?.find(([o]) => o === v)?.[1] ?? String(v));
// What the control holds: a select its value, a text box the words.
const shownIn = (f, v) => (f.options ? v ?? '' : display(f, v));
const parse = (f, raw) => {
  if (f.type !== 'hours') return raw;
  const m = /^\s*(\d\d:\d\d)\s*[-–]\s*(\d\d:\d\d)\s*$/.exec(raw);
  return m ? { start: m[1], end: m[2] } : raw; // the core says what's wrong with anything else
};
// Only what the person changed from what they were shown.
function changed() {
  const settings = {};
  for (const f of form.fields ?? []) {
    const raw = form.draft[f.key];
    if (raw === undefined || raw === String(shownIn(f, f.value))) continue;
    (settings[f.section] ??= {})[f.name] = parse(f, raw);
  }
  return settings;
}
const formRow = (c) => {
  const f = form.fields.find((x) => x.key === c.key);
  const was = c.from ?? f?.default;
  return { key: c.key, label: f?.label ?? c.key, from: was == null ? undefined : display(f, was), to: display(f, c.to), layer: c.layer, refused: c.refused };
};

export async function loadConfigForm() {
  try { form.fields = (await api('GET', '/config/schema')).fields; form.error = ''; } catch (e) { form.error = e.message; }
}

export function renderConfigForm() {
  const steps = stepsOf();
  const fields = (form.fields ?? []).map((f) => ({ ...f, value: form.draft[f.key] ?? shownIn(f, f.value) }));
  const body = !form.fields
    ? (form.error ? `<p class="memory-lede">${esc(form.error)}</p><button type="button" class="btn" data-action="config-retry">Try again</button>` : waitingLine('Reading your settings'))
    : form.state === 'step' ? configSetup({ state: 'step', step: form.step + 1, of: steps.length, title: steps[form.step], fields: fields.filter((f) => f.step === steps[form.step]) })
    : form.state === 'review' ? configSetup({ state: 'review', changes: form.plan.changes.map(formRow) })
    : `<p class="memory-lede">Each of your settings, what it is now, and where it came from. Change any of them, then review the changes before anything is saved.</p>
<ul class="settings-list">${fields.map(configField).join('')}</ul>
<div class="connection-actions"><button type="button" class="btn primary" data-action="config-review">Review changes</button><button type="button" class="btn" data-action="config-ask">Answer a few questions</button></div>`;
  return `<section class="memory-section" id="config-form" aria-labelledby="set-config-form"><h2 class="memory-heading" id="set-config-form">Your settings</h2>
${body}<p class="settings-note" role="status" data-config-form-said>${esc(form.said)}</p></section>`;
}

// #config-form is a sibling of door 1's #config, so door 1's '#config [data-action^="config-"]'
// handler never sees these buttons, and the reverse holds too.
export function bindConfigForm(root, redraw) {
  const say = (text) => { form.said = text; const n = root.querySelector('[data-config-form-said]'); if (n) n.textContent = text; };
  const keep = (c) => { const key = c.closest('li[data-config-key]')?.dataset.configKey; if (key) form.draft[key] = c.value; };
  const go = (state, extra = {}) => { Object.assign(form, { state, said: '', ...extra }); redraw(); };

  async function review(back) {
    const settings = changed();
    if (!Object.keys(settings).length) return back === 'step' ? (go('list'), say('Your answers match what you have now, so nothing changed.')) : say('Nothing has changed yet.');
    try {
      const p = await api('POST', '/config/import', { file: { format: 'nova-config/1', settings } });
      if (p.problems.length) return say(p.problems.join(' '));
      go('review', { back, plan: p });
    } catch (err) { say(err.message); }
  }
  async function save() {
    try {
      const out = await api('POST', '/config/settings', { settings: changed(), ...(form.plan?.tier === 3 ? { confirm: true } : {}) });
      Object.assign(form, { state: 'list', draft: {}, plan: null });
      await loadConfigForm();
      redraw();
      say(`Saved ${out.applied} change${out.applied === 1 ? '' : 's'}. Each one is in the activity log, and each can go back to its default.`);
    } catch (err) { say(err.message); }
  }
  async function reset(key) {
    const f = form.fields?.find((x) => x.key === key);
    if (!f) return;
    try {
      await api('POST', '/config/reset', { key, ...(f.tier === 3 ? { confirm: true } : {}) });
      delete form.draft[key];
      await loadConfigForm();
      redraw();
      root.querySelector(`#cfg-${key.replace(/[^a-z0-9]+/gi, '-')}`)?.focus();
      say(`${f.label} is back to Nova’s default.`);
    } catch (err) { say(err.message); }
  }

  // On every keystroke, not on change: a redraw (a reset finishing, a profile event) would
  // otherwise put back what the box held before the person typed.
  root.addEventListener('input', (e) => { if (e.target.closest('#config-form li[data-config-key]')) keep(e.target); });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('#config-form [data-action]');
    if (!b) return;
    root.querySelectorAll('#config-form li[data-config-key] :is(input, select)').forEach(keep);
    const last = stepsOf().length - 1;
    switch (b.dataset.action) {
      case 'config-retry': await loadConfigForm(); return redraw();
      case 'config-ask': return go('step', { step: 0 });
      case 'config-next': return form.step < last ? go('step', { step: form.step + 1 }) : review('step');
      case 'config-review': return review('list');
      case 'config-back': return form.state === 'review' ? go(form.back, { step: form.back === 'step' ? last : 0 }) : form.step > 0 ? go('step', { step: form.step - 1 }) : go('list');
      case 'config-apply': return save();
      case 'config-reset': return reset(b.dataset.key);
    }
  });
}
