// Settings › Services, minimal (M10f, docs/plans/M10f.md §4): how Nova runs its services on this
// computer, from /api/v1/services/backend: the backend in use, what it means on this OS, and where
// switching will be. There is no switch to press, because the K3s driver isn't built: it says so,
// rather than offering a choice that does nothing. The map and what runs where come later (M10i).
import { api } from './core.js';
import { settingsRow } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { over, waitingLine } from './wait.js';

let data = null;
let failed = '';
let rerender = () => {};

export function bindServices(render) { rerender = render; }

export async function loadServices() {
  try {
    data = await api('GET', '/services/backend');
    failed = '';
    over('services');
  } catch (e) {
    failed = e.message || 'Nova’s server didn’t answer.';
  }
  rerender();
}

export function renderServices() {
  const head = '<h2 class="memory-heading" id="set-services">Services</h2>';
  if (!data) {
    return `<section class="memory-section" id="services" aria-labelledby="set-services">${head}${failed
      ? `<p class="memory-lede">${esc(failed)}</p>`
      : waitingLine('Reading how Nova runs its services', { key: 'services' })}</section>`;
  }
  const other = data.options.filter((o) => o.id !== 'supervisor');
  const rows = [
    settingsRow({ id: 'services-backend', title: 'In use: ordinary programs', note: `${data.gets}` }),
    settingsRow({ title: 'On this computer', note: data.misses }),
    ...other.map((o) => settingsRow({ title: o.label, note: o.note })),
    // Only where K3s could come (Linux); elsewhere the row above says it isn't offered.
    ...(data.os === 'linux' ? [settingsRow({ id: 'services-switch', title: 'Switching', note: 'Switching to K3s isn’t available yet, so there is nothing to switch to. When it is, it will be here, and it will ask for your explicit confirmation.' })] : []),
  ];
  return `<section class="memory-section" id="services" aria-labelledby="set-services">${head}
<p class="memory-lede">How Nova runs the services it manages here, and what that means on this computer.</p>
<ul class="settings-list">${rows.join('')}</ul></section>`;
}
