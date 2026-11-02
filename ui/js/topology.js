// Live topology controller. The renderer remains presentation-only; this module owns the
// captured snapshot, independent source ages, visible-route polling and fixed approval actions.
import { request } from './core.js';
import { renderTopology } from './topology-view.js';
import { approvalSheet } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { openSheet, closeSheet } from './shell.js';

let root, snapshot = null, snapshotSince = 0, selectedMachine = null, selectedService = null;
let visible = false, timer = null, generation = 0, pending = null, failed = '', last = false;
let approval = null, submitting = false, notice = '', chosen = null;
const POLL_MS = 10_000;
const tones = { Quiet: 'quiet', Working: 'working', Waiting: 'waiting', Verified: 'verified', 'Needs you': 'needs-you', Failed: 'failed' };
const elapsed = () => Math.max(0, performance.now() - snapshotSince);
const ago = (ms) => ms == null ? 'Observation age unknown' : ms < 60_000 ? `${Math.floor(ms / 1000)} seconds old` : `${Math.floor(ms / 60_000)} minutes old`;
const ageOf = (o) => o.age_ms == null ? null : Math.max(0, o.age_ms) + elapsed();
const expired = (o) => o.stale || ageOf(o) == null || ageOf(o) >= snapshot.fresh_for_ms;
const ageLine = (items) => {
  const ages = items.map(ageOf);
  return !ages.length || ages.some(a => a == null) ? 'Observation age unknown' : `Last observation is ${ago(Math.max(...ages))}`;
};
const sourceRows = (items) => items.map(o => ({ source: o.source[0].toUpperCase() + o.source.slice(1), reason: o.reason, age: `${ago(ageOf(o))}${o.at ? ` / ${o.at}` : ''}${expired(o) ? ' / stale; current health unknown' : ''}` }));
const isOverlay = () => !!snapshot && (!!failed || elapsed() >= snapshot.fresh_for_ms || snapshot.machines.some(m => [...m.observations, ...m.services.flatMap(s => s.observations)].some(o => !o.stale && expired(o)) || m.services.some(s => s.versions.some(v => { const age = Date.parse(snapshot.captured_at) - Date.parse(v.observed_at); return Number.isFinite(age) && age >= 0 && age < snapshot.fresh_for_ms && age + elapsed() >= snapshot.fresh_for_ms; }))));
const globallyStale = () => !!failed || elapsed() >= (snapshot?.fresh_for_ms ?? 0);
const selected = (data = snapshot) => {
  const machine = data?.machines.find(m => m.id === selectedMachine);
  return { machine, service: machine?.services.find(s => s.id === selectedService) };
};
function presentation() {
  return (snapshot?.machines ?? []).map(m => {
    const stale = globallyStale() || m.observations.some(expired);
    const machineOverlay = globallyStale() || m.observations.some(o => !o.stale && expired(o));
    const tone = tones[m.status] ?? 'waiting';
    return { id: m.id, name: m.name, roles: m.roles, age: ageLine(m.observations), observations: sourceRows(m.observations), stale, lastObservation: globallyStale(),
      status: machineOverlay || (stale && tone === 'verified') ? 'waiting' : tone,
      captureFacts: m.capture_lag ? [{ reason: `${m.capture_lag.queued} pending events${m.capture_lag.paused ? `. ${m.capture_lag.paused}` : ''}. Last synchronized event: ${m.capture_lag.synced_to ?? 'unknown'}.`, age: `${ago(ageOf(m.capture_lag))}${ageOf(m.capture_lag) == null || ageOf(m.capture_lag) >= snapshot.fresh_for_ms ? ' / stale report' : ''}` }, { reason: 'Recording consent is unknown from workload status.', age: 'Capture content is not shown here.' }] : [{ reason: 'Capture lag is unknown: no report is available.', age: 'Recording consent is unknown from workload status.' }],
      services: m.services.map(s => {
        const serviceStale = stale || s.observations.some(expired);
        const unavailable = submitting || serviceStale;
        const eligible = s.versions.filter(v => v.status === 'ready' && v.promote.available && !unavailable && currentVersion(v));
        const version = eligible.find(v => v.version === chosen) ?? eligible[0];
        const promote = version?.promote;
        const reason = serviceStale ? 'Current service health is unknown. Refresh before changing versions.' : s.versions.find(v => v.status === 'ready')?.promote.reason ?? 'No ready version is available.';
        return { id: s.id, name: s.service, placement: s.placement === m.id ? m.name : s.placement, status: machineOverlay || s.observations.some(o => !o.stale && expired(o)) || (serviceStale && s.status === 'Verified') ? 'waiting' : tones[s.status] ?? 'waiting', stale: serviceStale,
          age: ageLine(s.observations), observations: sourceRows(s.observations), capture: false,
          versions: s.versions.map(v => ({ name: v.version, role: v.status, detail: v.version === s.live ? 'Serving on this machine' : v.status === 'ready' ? 'Passed readiness checks' : v.version === s.previous ? 'Kept for rollback' : `Reported ${v.status}` })),
          actions: { promote: { available: !!promote, tier: promote?.tier, selected: version?.version, versions: eligible, reason }, rollback: { ...s.rollback, available: s.rollback.available && !unavailable, reason: serviceStale ? reason : s.rollback.reason } },
        };
      }),
    };
  });
}
function currentVersion(v) {
  const captured = Date.parse(snapshot.captured_at), at = Date.parse(v.observed_at);
  return Number.isFinite(at) && at <= captured && captured - at + elapsed() < snapshot.fresh_for_ms;
}
function focusKey() {
  const active = document.activeElement;
  if (!root?.contains(active)) return null;
  for (const attr of ['data-topology-machine', 'data-topology-service', 'data-topology-action', 'data-topology-back', 'data-topology-refresh', 'data-topology-export', 'data-topology-version', 'data-topology-heading']) if (active.hasAttribute(attr)) return [attr, active.getAttribute(attr)];
  return null;
}
function draw(focus = null) {
  if (!root || approval) return;
  const keep = focus ?? focusKey();
  const overlay = isOverlay();
  root.innerHTML = `<header class="view-head"><h2 class="view-title">Topology</h2><p class="view-lede">Machines, services and their observed versions.</p></header><div class="topology-actions"><button type="button" class="btn quiet" data-topology-refresh${pending ? ' disabled' : ''}>Refresh map</button><button type="button" class="btn quiet" data-topology-export${!snapshot || overlay ? ' disabled' : ''}>Download Mermaid</button></div>${overlay ? '<p class="topology-meta">Refresh the map before exporting or changing versions. Current health is unknown where observations have expired.</p>' : ''}${snapshot?.partial ? `<p class="topology-meta">Partial map. ${snapshot.issues.map(esc).join(' ')}</p>` : ''}${notice ? `<p class="topology-meta" data-topology-notice role="status">${esc(notice)}</p>` : ''}${renderTopology({ machines: presentation(), hubId: snapshot?.hub_id ?? null, selectedMachine, selectedService, state: failed && !last ? 'failed' : !snapshot ? pending ? 'loading' : 'empty' : selectedService ? 'service' : selectedMachine ? 'machine' : 'overview' })}`;
  if (keep) {
    const original = root.querySelector(`[${keep[0]}="${CSS.escape(keep[1])}"]`);
    const target = original && !original.matches(':disabled') ? original : root.querySelector('[data-topology-heading]');
    target?.focus({ preventScroll: true });
  }
}
async function collect() {
  // Count the whole collection interval conservatively: receiving an older report must not
  // reset its age. Source age_ms is measured at the server's captured_at, never at this read.
  // A monotonic clock prevents a wall-clock adjustment from making retained evidence fresh.
  const startedAt = performance.now();
  const result = await request('GET', '/services/topology');
  if (result.stale) throw new Error('Nova’s server did not provide a current topology.');
  const data = result.data;
  if (!data || !Array.isArray(data.machines) || !Number.isFinite(Date.parse(data.captured_at)) || !(data.fresh_for_ms > 0) || typeof data.mermaid !== 'string') throw new Error('Nova’s topology answer was incomplete.');
  return { data, startedAt };
}
function accept({ data, startedAt }) { snapshot = data; snapshotSince = startedAt; failed = ''; last = false; notice = ''; }
async function refresh() {
  if (!visible || document.hidden || approval) return;
  if (pending?.generation === generation) return pending.promise;
  const token = generation;
  const operation = { generation: token, promise: null };
  pending = operation;
  operation.promise = (async () => {
    try { const data = await collect(); if (token === generation && visible && !approval) accept(data); }
    catch (e) { if (token === generation && visible && !approval) { failed = e.message; last = false; } }
    finally { if (pending === operation) pending = null; if (token === generation && visible && !approval) draw(); }
  })();
  draw(); return operation.promise;
}
function schedule() {
  clearInterval(timer); timer = null;
  // wait: poll: collect the real map only while this route is visible and no approval is open.
  if (visible && !document.hidden && !approval) timer = setInterval(() => { draw(); refresh(); }, POLL_MS);
}
export function topologyVisible(yes) {
  if (yes === visible) return;
  visible = yes; generation++;
  if (!visible && approval) closeSheet();
  schedule();
}
export function showTopology() { draw(); refresh(); }
function drill(machine, service, focus) {
  selectedMachine = machine; selectedService = service; chosen = null;
  draw(focus);
  if (focus[0] === 'data-topology-heading') document.getElementById('scroller').scrollTop = 0;
  else document.activeElement?.scrollIntoView({ block: 'nearest' });
}
function exportMap() {
  if (!snapshot || isOverlay()) return;
  const url = URL.createObjectURL(new Blob([snapshot.mermaid], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'nova-topology.mmd'; a.click();
  // wait: expiry: release the temporary download URL after the browser has consumed its click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function target(kind, version = null) {
  const { machine, service } = selected();
  const row = presentation().find(m => m.id === machine?.id)?.services.find(s => s.id === service?.id);
  if (!machine || !service || !row) return null;
  const candidate = service.versions.find(v => v.version === (version ?? row.actions.promote.selected));
  const action = kind === 'promote' ? candidate?.promote : service.rollback;
  if (!action?.available || (kind === 'promote' ? !row.actions.promote.available || !candidate || candidate.status !== 'ready' || !currentVersion(candidate) : !row.actions.rollback.available)) return null;
  return { kind, machine: machine.id, service: service.id, name: service.service, version: kind === 'promote' ? candidate.version : service.previous, live: service.live, assigned: service.assigned, action };
}
function signature(t) { return JSON.stringify(t); }
function review(kind) {
  if (submitting) return;
  const t = target(kind); if (!t) return;
  generation++; approval = t; schedule();
  const verb = kind === 'promote' ? 'Promote' : 'Roll back';
  // Reuse the existing tiered sheet, with a scoped form so generic ledger handlers cannot act.
  const html = approvalSheet({ id: 'topology-change', title: `${verb} ${t.name}`, owner: selected().machine.name, approval_tier: t.action.tier, privacy_mode: 'local-only', brief: { goal: `${verb} ${t.name}${t.live ? ` from ${t.live}` : ''} to ${t.version}. This asks the current authority to change the version. Acceptance does not verify that it is serving.` } }).replace('data-task="topology-change"', 'data-topology-approval').replace('<button type="button" class="btn" data-action="cancel-task">Cancel the task</button>', '');
  openSheet(html, { label: `${verb} ${t.name}`, onClose: () => { approval = null; schedule(); draw(['data-topology-action', kind]); } });
}
export async function submitTopology(form) {
  if (!approval || submitting || (approval.action.tier === 3 && !form.querySelector('[name="confirm"]')?.checked)) return;
  submitting = true;
  form.querySelectorAll('button, input, select').forEach(control => { control.disabled = true; });
  const before = approval;
  try {
    const fresh = await collect();
    if (approval !== before || !visible) return;
    accept(fresh);
    submitting = false;
    const next = target(before.kind, before.kind === 'promote' ? before.version : null);
    if (!next || signature(next) !== signature(before)) { notice = 'The target or its policy changed. Review the refreshed versions before asking again.'; closeSheet(); return; }
    submitting = true;
    // No retry: a lost acknowledgement may still have changed an assignment or restarted Nova.
    const response = await request('POST', next.action.path, { ...(next.kind === 'promote' ? { version: next.version } : {}), confirm: next.action.confirm }, true);
    notice = response.data.accepted ? 'Accepted by the supervisor. This does not confirm that the version is serving. Refresh to observe the outcome.' : next.action.path.startsWith('/services/devices/') ? 'The device assignment was acknowledged. This does not confirm that the version is serving. Refresh to observe the outcome.' : 'The authority acknowledged the request. Refresh to observe whether the version is serving.';
    closeSheet();
  } catch (e) {
    failed = e.message; last = true;
    notice = `${e.message} The outcome is unknown until refreshed; Nova will not retry this request automatically.`;
    closeSheet();
  } finally { submitting = false; if (!approval) draw(); }
}
export function bindTopology(element) {
  root = element;
  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.hasAttribute('data-topology-machine')) drill(b.dataset.topologyMachine, null, ['data-topology-heading', '']);
    else if (b.hasAttribute('data-topology-service')) drill(selectedMachine, b.dataset.topologyService, ['data-topology-heading', '']);
    else if (b.hasAttribute('data-topology-back')) {
      if (selectedService) { const id = selectedService; drill(selectedMachine, null, ['data-topology-service', id]); }
      else { const id = selectedMachine; drill(null, null, ['data-topology-machine', id]); }
    } else if (b.hasAttribute('data-topology-refresh')) refresh();
    else if (b.hasAttribute('data-topology-return')) { last = true; draw(); }
    else if (b.hasAttribute('data-topology-export')) exportMap();
    else if (b.hasAttribute('data-topology-action')) review(b.dataset.topologyAction);
  });
  root.addEventListener('change', e => { if (e.target.hasAttribute('data-topology-version')) { chosen = e.target.value; draw(); } });
  document.addEventListener('visibilitychange', () => { generation++; schedule(); if (visible && !document.hidden && !approval) refresh(); });
  window.addEventListener('offline', () => { if (visible) { generation++; failed = 'Nova’s server is unreachable.'; last = true; if (!approval) draw(); } });
}
