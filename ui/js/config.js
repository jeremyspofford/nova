// Settings › Configuration (config onboarding, door 1; design approved in #303): bring settings in
// from a file, checked and shown as a diff first, or take them out as one. The file is only a
// format; the settings live in Nova. Applying something tier 3 goes through the passkey step.
import { api } from './core.js';
import { configImport } from './components.js';

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
