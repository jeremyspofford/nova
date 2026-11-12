// Presentation only: no reads, clock, routing, event handlers or mutations. Shared by the
// owner-approved styleguide entry and the live app; provenance text is supplied by the caller.
import { escapeHtml as esc } from './markdown.js';
import { emptyState, status } from './components.js';

/**
 * @typedef {{name: string, role: string, detail: string}} TopologyVersion
 * @typedef {{source: string, reason: string, age: string}} TopologyObservation
 * @typedef {{available: boolean, tier?: number, selected?: string, versions?: {version: string}[], reason?: string|null}} TopologyActionView
 * @typedef {{id: string, name: string, status: 'quiet'|'working'|'waiting'|'verified'|'needs-you'|'failed',
 *   placement: string, capture: boolean, versions: TopologyVersion[], age?: string, stale?: boolean,
 *   observations?: TopologyObservation[], actions?: {promote: TopologyActionView, rollback: TopologyActionView}}} TopologyService
 * @typedef {{id: string, name: string, roles: string[], status: 'quiet'|'working'|'waiting'|'verified'|'needs-you'|'failed',
 *   age: string, stale?: boolean, lastObservation?: boolean, observations: TopologyObservation[], services: TopologyService[], captureFacts?: {reason: string, age: string}[]}} TopologyMachine
 * Ordered machines: the first is the hub, the rest connect to it. Ages and reasons are supplied
 * presentation text, never inferred health or a running clock. Live callers may supply verified
 * only when supported by current server observations. IDs are opaque, escaped attribute values.
 * `stale` is supplied presentation context, not calculated here. Optional service age/observations/stale/actions preserve independent live provenance; fixture
 * callers retain their historical fallback to machine context. No source-health merge is performed here.
 * Live callers supply hubId; unknown/absent hubs have no hub links. Legacy specimens retain their first hub.
 */

const group = (words) => `<h4 class="topology-group">${esc(words)}</h4>`;
const back = (words) => `<button type="button" class="btn quiet topology-back" data-topology-back>${esc(words)}</button>`;
const heading = (name, meta = '', tone = '') => `<header class="topology-heading"><div><h3 class="view-title" tabindex="-1" data-topology-heading>${esc(name)}</h3>${meta ? `<p class="topology-meta">${esc(meta)}</p>` : ''}</div>${tone ? status(tone) : ''}</header>`;
const observations = (machine) => !machine.observations.length ? '' : `${group('Observations')}<ul class="topology-observations">${machine.observations.map((o) => `<li><p>${esc(o.source)}: ${esc(o.reason)}</p><p class="topology-meta">${esc(o.age)}</p></li>`).join('')}</ul>`;

/** @param {{machines: TopologyMachine[], selectedMachine?: string|null, selectedService?: string|null, state?: string, hubId?: string|null}} input
 * @returns {string} Escaped HTML; selected IDs address only the supplied presentation fixture.
 */
export function renderTopology({ machines, selectedMachine = null, selectedService = null, state = 'overview', hubId = undefined }) {
  const wrap = (html) => `<section class="topology" aria-label="System topology" data-topology-state="${esc(state)}">${html}</section>`;
  if (state === 'empty' || (!machines.length && !['loading', 'failed'].includes(state))) {
    return wrap(`${heading('Your machines')}${group('Machines')}${emptyState({ title: 'No machines to show yet', line: 'Machines will appear here with their roles and services when observations are available.' })}`);
  }
  if (state === 'loading') return wrap(`${heading('Your machines')}${group('Machines')}${status('waiting')}${emptyState({ title: 'Waiting for machine observations', line: 'The map will appear when the first observations arrive.' })}<div data-topology-wait></div>`);
  if (state === 'failed') {
    const last = machines.find((m) => m.id === selectedMachine) ?? machines[0];
    const age = last?.age ? `${last.age}.` : 'No earlier observation is available.';
    return wrap(`${heading('Your machines')}${group('Refresh')}${status('needs-you')}${emptyState({ title: 'The map could not refresh', line: `${age} Current machine health is unknown.` })}${last ? '<button type="button" class="btn" data-topology-return>View last observation</button>' : ''}`);
  }
  const machine = machines.find((m) => m.id === selectedMachine);
  const service = machine?.services.find((s) => s.id === selectedService);
  if (machine && service) {
    const placement = service.placement === machine.name ? machine.name : `${machine.name} / ${service.placement}`;
    const historical = machine.stale === true || service.stale === true;
    const serviceAge = service.age ?? machine.age;
    const serviceObservations = service.observations ? observations(service) : '';
    const actions = service.actions;
    const promotion = actions?.promote;
    const controls = actions ? `${promotion?.versions?.length ? `<label class="topology-meta">Ready version <select class="input" data-topology-version>${promotion.versions.map(v => `<option value="${esc(v.version)}"${v.version === promotion.selected ? ' selected' : ''}>${esc(v.version)}</option>`).join('')}</select></label>` : ''}<div class="topology-actions"><button type="button" class="btn" data-topology-action="promote"${promotion?.available ? '' : ' disabled'}>Review promotion</button><button type="button" class="btn quiet" data-topology-action="rollback"${actions.rollback?.available ? '' : ' disabled'}>Review rollback</button></div><p class="topology-meta">${esc(promotion?.available ? `Promotion asks for ${promotion.tier === 3 ? 'explicit confirmation (tier 3)' : 'approval (tier 2)'}.` : promotion?.reason ?? 'No ready version is available.')}${esc(actions.rollback?.available ? ' Manual rollback asks for approval (tier 2).' : ` ${actions.rollback?.reason ?? 'Rollback is unavailable.'}`)}</p>` : `<div class="topology-actions"><button type="button" class="btn" data-topology-action="promote">Review promotion</button><button type="button" class="btn quiet" data-topology-action="rollback">Review rollback</button></div><p class="topology-meta">${service.capture ? 'Capture promotion needs explicit confirmation (tier 3). Manual rollback asks for approval (tier 2).' : 'Service promotion and manual rollback ask for approval (tier 2).'}</p>`;
    return wrap(`${back('Back to services')}${heading(service.name, `${placement} / ${serviceAge}`, machine.stale && !service.observations ? machine.status : service.status)}${historical ? '<p class="topology-meta">Current service health is unknown. These versions describe the last observation.</p>' : ''}${observations(machine)}${serviceObservations}${group(historical ? 'Last observed versions' : 'Versions')}<ul class="topology-versions">${service.versions.map((v) => `<li><div><p class="topology-name">${esc(v.name)}</p><p class="topology-meta">${historical ? 'Previously reported: ' : ''}${esc(v.detail)}</p></div><span class="topology-meta">${esc(v.role)}</span></li>`).join('')}</ul>${group('Actions')}${controls}`);
  }
  if (machine) {
    return wrap(`${back('Back to machines')}${heading(machine.name, `${machine.roles.join(', ')} / ${machine.age}`, machine.status)}${machine.lastObservation ? '<p class="topology-meta">Current machine health is unknown. This is the last observation.</p>' : ''}${observations(machine)}${machine.captureFacts ? `${group('Capture lag')}<ul class="topology-observations">${machine.captureFacts.map(f => `<li><p>${esc(f.reason)}</p><p class="topology-meta">${esc(f.age)}</p></li>`).join('')}</ul>` : ''}${group('Services')}${machine.services.length ? `<ul class="topology-services">${machine.services.map((s) => `<li><button type="button" class="topology-row" data-topology-service="${esc(s.id)}"><span><strong class="topology-name">${esc(s.name)}</strong><span class="topology-meta">${esc(s.placement)}</span></span>${status(machine.stale && !s.observations ? machine.status : s.status)}</button></li>`).join('')}</ul>` : emptyState({ title: 'No services observed', line: 'Services reported by this machine will appear here.' })}`);
  }
  const hasHub = hubId === undefined || machines.some(m => m.id === hubId);
  if (!hasHub) {
    // An unknown active hub is a list of observed machines, not an invented graph root.
    return wrap(`${heading('Your machines', 'No active hub is observed in this map.')}${group('Machines')}<ol class="topology-services">${machines.map(m => `<li><button type="button" class="topology-row" data-topology-machine="${esc(m.id)}"><span><strong class="topology-name">${esc(m.name)}</strong><span class="topology-meta">${esc(m.roles.join(', '))}</span><span class="topology-meta">${m.services.length} ${m.services.length === 1 ? 'service' : 'services'} / ${esc(m.age)}</span></span>${status(m.status)}</button></li>`).join('')}</ol>`);
  }
  const peers = Math.max(1, machines.length - 1);
  const connections = machines.length > 1 ? `<svg class="topology-connections" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5">${machines.slice(1).map((_, i) => `<path vector-effect="non-scaling-stroke" d="M0 50 H50 V${100 * (i + 0.5) / peers} H100"/>`).join('')}</g></svg>` : '';
  return wrap(`${heading('Your machines', 'Choose a machine to see its services.')}${group('Machines')}<div class="topology-map">${connections}<ol class="topology-machines" style="--topology-peers: ${peers}">${machines.map((m, i) => `<li${i === 0 ? ' class="topology-hub"' : ''}><button type="button" class="topology-machine" data-topology-machine="${esc(m.id)}"><span class="topology-machine-title"><strong class="topology-name">${esc(m.name)}</strong>${status(m.status)}</span><span class="topology-meta">${esc(m.roles.join(', '))}</span><span class="topology-meta">${m.services.length} ${m.services.length === 1 ? 'service' : 'services'} / ${esc(m.age)}</span></button></li>`).join('')}</ol></div>`);
}
