// One safe, captured-at topology. Pure normalization and Mermaid serialization: no I/O or cluster client.
import type { ServiceStatus, VersionStatus } from './driver.ts';
import { consoleStatus, type SupervisorState } from '../resilience/link.ts';

export type TopologyHealth = 'healthy' | 'degraded' | 'failed' | 'unknown';
export type TopologyStatus = 'Quiet' | 'Working' | 'Waiting' | 'Verified' | 'Needs you' | 'Failed';
export type TopologySource = 'heartbeat' | 'local' | 'cluster' | 'supervisor' | 'workload';
export interface ObservationInput { source: TopologySource; health: TopologyHealth; at: string | null; reason: string }
export interface TopologyObservation extends ObservationInput { age_ms: number | null; stale: boolean }
export interface TopologyAction { available: boolean; tier: 2 | 3 | null; path: string | null; confirm: string | null; reason: string | null }
export interface TopologyVersion { version: string; status: VersionStatus; since: string | null; observed_at: string | null; promote: TopologyAction }
export interface TopologyService {
  id: string; service: string; driver: string; placement: string; live: string | null; previous: string | null;
  assigned: { version: string; want: 'alongside' | 'live' | 'stopped'; at: string } | null;
  health: TopologyHealth; status: TopologyStatus; observations: TopologyObservation[];
  versions: TopologyVersion[]; rollback: TopologyAction;
}
export interface TopologyCaptureLag { queued: number; synced_to: string | null; at: string | null; age_ms: number | null; paused: string | null }
export interface TopologyMachine {
  id: string; name: string; kind: 'machine' | 'cloud'; roles: string[]; hub: boolean;
  health: TopologyHealth; status: TopologyStatus; observations: TopologyObservation[]; services: TopologyService[];
  capture_lag: TopologyCaptureLag | null;
}
/** GET /api/v1/services/topology. All timestamps ISO; ages milliseconds at captured_at.
 * `live` is observed serving, `assigned` is intent. Actions describe fixed POST paths (API-relative),
 * not permission grants: access/confirmation/readiness are rechecked by the mutation authority.
 * Version policy may differ by version; null tier disables promotion. Mermaid is THIS snapshot.
 */
export interface TopologySnapshot { captured_at: string; fresh_for_ms: number; hub_id: string | null; local_id: string; partial: boolean; issues: string[]; machines: TopologyMachine[]; mermaid: string }
export interface ServiceInput {
  service: string; driver: string; placement: string; live: string | null; previous: string | null;
  observation: ObservationInput; observations?: ObservationInput[]; assigned?: TopologyService['assigned'];
  versions: { version: string; status: VersionStatus; since: string; observed_at: string | null; promotion_tier: 2 | 3 | null }[];
  authority: 'hub' | 'device' | null;
}
export interface MachineInput { id: string; name: string; kind?: 'machine' | 'cloud'; roles: string[]; observations: ObservationInput[]; services: ServiceInput[]; capture_lag?: Omit<TopologyCaptureLag, 'age_ms'> }
/** Trusted in-process stand-in/future cluster adapter. No public write route. Names/health still validated. */
export interface ClusterObservation { machines: { id: string; name: string; kind: 'machine' | 'cloud'; roles: string[]; observation: Omit<ObservationInput, 'source'>; services: ServiceInput[] }[] }
export interface TopologyInput { captured_at: string; hub_id: string | null; local_id: string; machines: MachineInput[]; cluster?: ClusterObservation | null; cluster_error?: boolean; issues?: string[]; excluded_ids?: string[] }
export interface ServicePolicy { service: string; version: string; promotion_tier: 2 | 3 }

export const TOPOLOGY_FRESH_MS = 120_000;
const FRESH_MS = TOPOLOGY_FRESH_MS;
const healths = ['healthy', 'degraded', 'failed', 'unknown'];
const statuses: Record<TopologyHealth, TopologyStatus> = { healthy: 'Verified', unknown: 'Waiting', degraded: 'Needs you', failed: 'Failed' };
const weight: Record<TopologyHealth, number> = { healthy: 0, unknown: 1, degraded: 2, failed: 3 };
const text = (v: unknown, max = 240): string => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
const timestamp = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const age = (at: string | null, now: number): number | null => at === null || Date.parse(at) > now ? null : now - Date.parse(at);
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const validService = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(v);
const validVersion = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const worst = (items: TopologyHealth[]): TopologyHealth => items.length ? items.reduce((a, b) => weight[a] >= weight[b] ? a : b) : 'unknown';
function observation(o: ObservationInput, now: number): TopologyObservation {
  const at = timestamp(o.at), age_ms = age(at, now), stale = age_ms === null || age_ms >= FRESH_MS;
  return { source: o.source, at, age_ms, stale, health: stale || !healths.includes(o.health) ? 'unknown' : o.health, reason: text(o.reason) || 'No observation available.' };
}
function action(tier: 2 | 3 | null, path: string | null, confirm: string, reason: string | null): TopologyAction {
  return { tier, path, confirm, reason, available: reason === null && path !== null && tier !== null };
}
function service(s: ServiceInput, machine: TopologyMachine, now: number): TopologyService {
  const observations = [s.observation, ...(s.observations ?? [])].map(o => observation(o, now));
  const sourceHealth = worst(observations.map(o => o.health));
  const base = validService(s.service) ? s.authority === 'hub' ? `/services/hub/${s.service}` : s.authority === 'device' ? `/services/devices/${encodeURIComponent(machine.id)}/${s.service}` : null : null;
  const unavailable = !base ? 'No supported mutation authority.' : machine.observations.some(o => o.stale) || machine.health === 'unknown' || machine.health === 'failed' ? 'The machine observation is unavailable or stale.' : observations.some(o => o.stale) || sourceHealth === 'unknown' ? 'The service observation is unavailable or stale.' : null;
  const health = worst([sourceHealth, machine.health]);
  return {
    id: `${machine.id}/${s.service}`, service: text(s.service, 128), driver: text(s.driver, 64), placement: text(s.placement),
    live: s.live === null ? null : text(s.live, 128), previous: s.previous === null ? null : text(s.previous, 128),
    assigned: s.assigned ? { version: text(s.assigned.version, 128), want: s.assigned.want, at: timestamp(s.assigned.at) ?? '' } : null,
    health, status: statuses[health], observations,
    versions: s.versions.map(v => {
      const observed_at = timestamp(v.observed_at), ago = age(observed_at, now);
      const tier = v.promotion_tier === 2 || v.promotion_tier === 3 ? v.promotion_tier : null;
      const why = unavailable ?? (!validVersion(v.version) ? 'Invalid version.' : tier === null ? 'Promotion policy is unavailable.' : ago === null || ago >= FRESH_MS ? 'The version observation is unavailable or stale.' : v.status !== 'ready' ? 'Only a ready version can be promoted.' : null);
      return { version: text(v.version, 128), status: v.status, since: timestamp(v.since), observed_at, promote: action(tier, base ? `${base}/promote` : null, `${s.service}@${v.version}`, why) };
    }),
    rollback: action(2, base ? `${base}/rollback` : null, 'rollback', unavailable ?? (!s.previous ? 'No previous version is kept.' : null)),
  };
}
const versionStatuses: readonly string[] = ['installed', 'alongside', 'ready', 'live', 'kept', 'failed', 'rolled_back', 'removed'];
function validClusterMachine(m: ClusterObservation['machines'][number]): boolean {
  return !!m && validId(m.id) && typeof m.name === 'string'
    && (m.kind === 'machine' || m.kind === 'cloud')
    && Array.isArray(m.roles) && m.roles.every(r => typeof r === 'string')
    && !!m.observation && healths.includes(m.observation.health)
    && typeof m.observation.reason === 'string' && !!timestamp(m.observation.at)
    && Array.isArray(m.services) && m.services.every(s => !!s && validService(s.service)
      && typeof s.driver === 'string' && typeof s.placement === 'string'
      && (s.live === null || validVersion(s.live)) && (s.previous === null || validVersion(s.previous))
      && !!s.observation && healths.includes(s.observation.health)
      && typeof s.observation.reason === 'string'
      && Array.isArray(s.versions) && s.versions.every(v => !!v && validVersion(v.version) && versionStatuses.includes(v.status)));
}
export function buildTopology(input: TopologyInput): TopologySnapshot {
  const now = Date.parse(input.captured_at), issues = [...(input.issues ?? [])].map(v => text(v));
  const excluded = new Set(input.excluded_ids ?? []);
  const rows = new Map(input.machines.filter(m => !excluded.has(m.id)).map(m => [m.id, { ...m, roles: [...m.roles], observations: [...m.observations], services: [...m.services] }]));
  if (input.cluster_error) issues.push('Cluster observations unavailable.');
  if (input.cluster != null) {
    if (!Array.isArray(input.cluster.machines)) issues.push('Cluster observations malformed.');
    else for (const m of input.cluster.machines) {
      if (!validClusterMachine(m)) { issues.push('Cluster observation malformed.'); if (m && validId(m.id) && rows.has(m.id)) rows.get(m.id)!.observations.push({ source: 'cluster', at: null, health: 'unknown', reason: 'Cluster observation malformed.' }); continue; }
      if (excluded.has(m.id)) continue;
      const row = rows.get(m.id);
      const obs: ObservationInput = { ...m.observation, source: 'cluster' };
      // Cluster services are read-only until a cluster driver supplies an actual mutation authority.
      const services: ServiceInput[] = m.services.map(s => ({
        service: s.service, driver: s.driver, placement: s.placement, live: s.live, previous: s.previous,
        authority: null, observation: { source: 'cluster', health: s.observation.health, at: s.observation.at, reason: s.observation.reason },
        versions: s.versions.map(v => ({ version: v.version, status: v.status, since: v.since, observed_at: v.observed_at, promotion_tier: null })),
      }));
      if (row) {
        row.observations.push(obs);
        row.roles = [...new Set([...row.roles, ...m.roles])];
        for (const s of services) {
          const existing = row.services.find(r => r.service === s.service);
          if (existing) {
            const index = row.services.indexOf(existing);
            row.services[index] = { ...existing, observations: [...(existing.observations ?? []), s.observation] };
          } else row.services.push(s);
        }
      }
      else rows.set(m.id, { ...m, observations: [obs], services });
    }
  }
  const machines: TopologyMachine[] = [...rows.values()].sort((a, b) => Number(b.id === input.hub_id) - Number(a.id === input.hub_id) || a.id.localeCompare(b.id)).map(m => {
    const observations = m.observations.map(o => observation(o, now));
    const health = worst(observations.map(o => o.health));
    const lag = m.capture_lag;
    const result: TopologyMachine = { id: m.id, name: text(m.name, 160), kind: m.kind ?? 'machine', roles: m.roles.map(r => text(r, 64)).slice(0, 32), hub: m.id === input.hub_id, observations, health, status: statuses[health], services: [], capture_lag: lag ? { queued: lag.queued, synced_to: timestamp(lag.synced_to), at: timestamp(lag.at), age_ms: age(timestamp(lag.at), now), paused: lag.paused ? text(lag.paused) : null } : null };
    result.services = m.services.map(s => service(s, result, now));
    return result;
  });
  const snapshot: TopologySnapshot = { captured_at: input.captured_at, fresh_for_ms: FRESH_MS, hub_id: input.hub_id, local_id: input.local_id, partial: issues.length > 0, issues: [...new Set(issues)], machines, mermaid: '' };
  snapshot.mermaid = serializeTopology(snapshot);
  return snapshot;
}
// Decimal entities are Mermaid syntax. Encode all punctuation capable of ending a quoted label,
// injecting a directive, HTML, link or entity. IDs are generated; no raw source ID becomes syntax.
const label = (s: string): string => s.replace(/[^\p{L}\p{N} .,:_\/-]/gu, c => `#${c.codePointAt(0)};`);
export function serializeTopology(snapshot: Pick<TopologySnapshot, 'machines'>): string {
  const lines = ['flowchart TD'];
  snapshot.machines.forEach((m, i) => {
    lines.push(`  m${i}["${label(m.name)} | ${label(m.status)}"]`);
    m.services.forEach((s, j) => {
      lines.push(`  m${i}s${j}["${label(s.service)} | ${label(s.live ?? 'No observed serving version')} | ${label(s.status)} | ${label(s.placement)}"]`);
      lines.push(`  m${i} --- m${i}s${j}`);
    });
  });
  const hub = snapshot.machines.findIndex(m => m.hub);
  if (hub >= 0) snapshot.machines.forEach((_, i) => { if (i !== hub) lines.push(`  m${hub} --- m${i}`); });
  return `${lines.join('\n')}\n`;
}

/** Safe projection: never copies said/history/process output, paths, ports, argv, env or definitions. */
export function projectService(s: ServiceStatus, o: { placement: string; at: string | null; source: 'supervisor' | 'workload'; authority: ServiceInput['authority']; policies: ServicePolicy[]; reports?: { version: string; at: string }[]; assigned?: TopologyService['assigned'] }): ServiceInput {
  const ready = new Set(s.versions.filter(v => v.status === 'ready').map(v => v.version));
  // Readiness is evidence from that version's report, never a fresh unrelated report. With
  // several ready versions, the most recently received readiness report supplies the claim.
  const readyAt = o.reports?.filter(r => ready.has(r.version)).reduce<string | null>((latest, r) => {
    const at = timestamp(r.at);
    return at && (!latest || at > latest) ? at : latest;
  }, null) ?? null;
  // A candidate's readiness cannot establish health for an observed serving version.
  const readiness = s.live === null && !s.held && s.health.ok === null && ready.size > 0;
  const observedAt = readiness && o.reports ? readyAt : o.at;
  const health: TopologyHealth = s.held ? 'failed' : s.health.ok === false ? 'degraded' : s.health.ok === true || readiness ? 'healthy' : 'unknown';
  return { service: s.service, driver: s.driver, live: s.live, previous: s.previous, placement: o.placement, assigned: o.assigned ?? null, authority: o.authority,
    observation: { source: o.source, at: observedAt, health, reason: s.held ? 'The service is held after stopping repeatedly.' : s.health.ok === false ? 'The service health check failed.' : s.health.ok === true ? 'The service reported healthy.' : readiness ? 'A version passed its readiness checks.' : 'No verified service health observation.' },
    versions: s.versions.map(v => ({ version: v.version, status: v.status, since: v.since, observed_at: o.reports ? o.reports.find(r => r.version === v.version)?.at ?? null : o.at, promotion_tier: o.policies.find(p => p.service === s.service && p.version === v.version)?.promotion_tier ?? null })),
  };
}
function validStatus(s: ServiceStatus): boolean {
  return !!s && validService(s.service) && typeof s.driver === 'string'
    && (s.live === null || validVersion(s.live)) && (s.previous === null || validVersion(s.previous))
    && (s.held === null || !!s.held && typeof s.held.reason === 'string' && timestamp(s.held.at) !== null)
    && !!s.health && [true, false, null].includes(s.health.ok)
    && (s.health.checked_at === null || timestamp(s.health.checked_at) !== null)
    && Array.isArray(s.versions) && s.versions.every(v => !!v && validVersion(v.version)
      && versionStatuses.includes(v.status));
}
export function supervisorServices(state: SupervisorState | null, managed: boolean, localId: string, capturedAt: string, version: string, canMutate = false): { services: ServiceInput[]; issue: string | null } {
  try {
    if (managed && (!state || state.v !== 1 || !Array.isArray(state.services) || !Array.isArray(state.releases.slots) || !state.health || !Number.isInteger(state.health.failing) || state.health.failing < 0 || !state.server)) throw new Error('unavailable');
    if (state && managed) {
      const rows = [consoleStatus(state), ...state.services!];
      if (!rows.every(validStatus) || !['starting', 'running', 'restarting', 'safe_mode', 'deploying', 'stopped'].includes(state.mode)) throw new Error('malformed');
      const services = rows.map(s => projectService(s, { placement: localId, source: 'supervisor', at: s.health.checked_at ?? state.observed_at ?? null, authority: canMutate ? 'hub' : null, policies: state.service_policies ?? [] }));
      if (state.mode === 'stopped') services[0]!.observation = { ...services[0]!.observation, health: 'failed', reason: 'The supervisor reports that the console stopped.' };
      return { services, issue: null };
    }
  } catch { /* A managed but unreadable state is not an intentionally unsupervised server. */ }
  return { issue: managed ? 'Supervisor observations unavailable or malformed.' : null, services: [{ service: 'nova-console', driver: managed ? 'supervisor' : 'unsupervised', placement: localId, live: managed ? null : version, previous: null, authority: null, versions: [], observation: { source: managed ? 'supervisor' : 'local', at: managed ? null : capturedAt, health: 'unknown', reason: managed ? 'Supervisor state unavailable or malformed.' : 'This console runs unsupervised; managed version actions are unavailable.' } }] };
}
