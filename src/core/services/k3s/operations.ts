// Explicit, trusted cluster configuration. Durable work and approval belong ONLY to the ledger;
// network snapshots, approvals, readbacks and dead-man recovery belong ONLY to Network.
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CoreError } from '../../errors.ts';
import { ENVELOPE_VERSION, type Brief, type Report } from '../../envelope.ts';
import type { Ledger, LanedWorker, Task } from '../../ledger.ts';
import type { Verifier } from '../../verify.ts';
import type { Network } from '../../network/index.ts';
import type { NetworkTarget } from '../../network/targets.ts';
import { clusterNetworkPatch, clusterNetworkTarget } from './network.ts';
import type { Devices } from '../../mesh/devices.ts';
import { allows, type Principal } from '../../mesh/access.ts';
import type { Route } from '../../api.ts';
import { promotionTier, validate, type ServiceDefinition } from '../definition.ts';
import { sameServiceExpected, validServiceExpected, SERVICE_CHANGED, type ServiceExpectedState } from '../expected.ts';
import type { PlacementDevice } from '../placement.ts';
import type { ClusterObservation, ServiceInput } from '../topology.ts';
import { K3sDriver, type K3sClock, type K3sExecution } from './driver.ts';
import { k3sDeviceLabel, type K3sChartValues } from './values.ts';
import { unavailableClusterTools, type ClusterTools, type ClusterSnapshot } from './tools.ts';

export interface K3sRegistration {
  id: string; namespace: string; hubId: string; deviceIds: string[];
  sites: { id: string; name: string }[];
  networkTarget: string;
  services: ServiceDefinition[];
}
export interface K3sOptions {
  // Trusted composition only. No API creates registrations, joins or credential capabilities.
  registrations: () => readonly K3sRegistration[];
  // Resolve current authority; keep its object identity stable for the duration of each I/O.
  // Removing/replacing it revokes in-flight observations without discarding older evidence.
  tools?: (cluster: string) => ClusterTools | null | undefined;
  probeOrigin?: (cluster: string) => string | undefined;
  clock?: Pick<K3sClock, 'sleep' | 'schedule'>;
}
interface Options extends K3sOptions {
  home: string; ledger: Ledger; verifier: Verifier; network: Network; devices: Devices;
  placement: () => PlacementDevice[]; now: () => Date; activeHub: () => boolean; networkKey: symbol;
}
type Operation = 'deploy' | 'promote' | 'rollback';
interface Input {
  operation: Operation; cluster: string; namespace: string; service: string; version: string;
  artifact: string; registration: string; expected: ServiceExpectedState;
  network_change: string | null; actor: string;
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const closed = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const fields = ['operation', 'cluster', 'namespace', 'service', 'version', 'artifact', 'registration', 'expected', 'network_change', 'actor'];
const system = 'nova-k3s';
const workerId = 'k3s-operations';
export class K3sOperations {
  readonly worker: LanedWorker;
  #o: Options;
  #key = Symbol(workerId);
  #drivers = new Map<string, { fingerprint: string; driver: K3sDriver }>();
  constructor(options: Options) {
    this.#o = options;
    this.worker = {
      id: workerId, name: 'Cluster services', about: 'Explicit registered cluster service operations; control-plane loss waits without replaying uncertain effects.',
      egress: 'remote', evidence: ['confirmation'], effects: () => 'external', commits: () => true,
      timeoutMs: 10 * 60_000, lane: b => ({ key: `${b.inputs?.cluster}/${b.inputs?.service}`, max: 1 }),
      internal: { key: this.#key, why: 'Only the registered cluster operation facade can create these tasks.' },
      minTier: input => { try { const i = this.#input(input.inputs); return this.#tier(i); } catch { return 3; } },
      uncancellable: task => task.state === 'active' && this.#committed(task.id) ? 'Cluster effects may be in flight; wait for reconciliation before cancelling.' : null,
      health: () => ({ ok: true }), run: (brief, signal) => this.#run(brief, signal),
    };
    options.verifier.registerConfirmation(system, (e, b) => {
      const event = options.ledger.events(b.task_id).find(e => e.kind === 'k3s_completed');
      const d = event?.detail as { input?: string } | undefined;
      return { ok: e.kind === 'confirmation' && e.id === b.task_id && d?.input === digest(b.inputs), why: 'Actual cluster operation completion recorded for this task and approved input.' };
    });
  }
  #registration(id: string): K3sRegistration {
    const list = this.#o.registrations();
    const matches = list.filter(r => r.id === id);
    if (matches.length !== 1) throw new CoreError('not_found', 'This cluster is not registered.');
    const r = structuredClone(matches[0]!);
    const dns = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (!closed(r, ['id', 'namespace', 'hubId', 'deviceIds', 'sites', 'networkTarget', 'services']) || !dns.test(r.id) || !dns.test(r.namespace) || typeof r.hubId !== 'string' || typeof r.networkTarget !== 'string' || !Array.isArray(r.deviceIds) || r.deviceIds.length > 256 || r.deviceIds.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(r.deviceIds).size !== r.deviceIds.length || !Array.isArray(r.sites) || r.sites.some(s => !closed(s, ['id', 'name']) || typeof s.id !== 'string' || !s.id || typeof s.name !== 'string' || !s.name || r.deviceIds.includes(s.id)) || new Set(r.sites.map(s => s.id)).size !== r.sites.length || !Array.isArray(r.services) || r.services.length > 64 || r.services.some(d => !validate(d).ok) || new Set(r.services.map(d => `${d.service}@${d.version}`)).size !== r.services.length) throw new CoreError('validation', 'Invalid trusted cluster metadata.');
    return r;
  }
  #definition(r: K3sRegistration, service: string, version: string) {
    const def = r.services.find(d => d.service === service && d.version === version);
    if (!def) throw new CoreError('not_found', 'This service version is not registered for this cluster.');
    return def;
  }
  #driver(r: K3sRegistration) {
    const fingerprint = digest(r);
    let row = this.#drivers.get(r.id);
    if (row && row.fingerprint !== fingerprint) { void row.driver.close(); this.#drivers.delete(r.id); row = undefined; }
    if (!row) {
      const current = () => this.#o.placement().filter(d => r.deviceIds.includes(d.id));
      // Cache observations, never capability authority. A provider must remain current across
      // an awaited read; replacement cannot refresh cached evidence through a revoked port.
      const provider = () => this.#o.tools?.(r.id) ?? unavailableClusterTools;
      const tools: ClusterTools = {
        available: () => provider().available(),
        execute: async (operation, signal) => {
          const current = provider();
          if (!current.available().ok) throw new Error('The current cluster capability is unavailable.');
          const result = await current.execute(operation, signal);
          if (provider() !== current || !current.available().ok) throw new Error('The cluster capability changed during I/O.');
          return result;
        },
      };
      const driver = new K3sDriver({ cluster: { id: r.id, namespace: r.namespace, hubId: r.hubId, devices: [] },
        directory: join(this.#o.home, 'services', 'k3s', r.id), workloadOnly: true, devices: current,
        tools,
        ...(this.#o.probeOrigin?.(r.id) ? { probeOrigin: this.#o.probeOrigin(r.id)! } : {}),
        clock: { now: () => this.#o.now().getTime(), sleep: this.#o.clock?.sleep.bind(this.#o.clock) ?? (async (ms, signal) => { await sleep(ms, undefined, { signal }); }), schedule: this.#o.clock?.schedule.bind(this.#o.clock) ?? (() => () => {}) },
      });
      try { for (const def of r.services) driver.registry.register(def); }
      catch { void driver.close(); throw new CoreError('conflict', 'A registered cluster definition changed; use a new immutable version.'); }
      row = { fingerprint, driver }; this.#drivers.set(r.id, row);
    }
    return row.driver;
  }
  #actor(p: Principal): string {
    if (allows('approver', p) !== 'ok') throw new CoreError('forbidden', 'Cluster operations require approver access.');
    return p.kind === 'console' ? 'console' : p.kind === 'device' ? p.device.id : '';
  }
  #access(actor: string) {
    if (!this.#o.activeHub()) throw new CoreError('conflict', 'Only the active hub can operate this cluster.');
    if (actor === 'console') return;
    const device = this.#o.devices.find(actor);
    if (!device || device.trust !== 'trusted' || allows('approver', { kind: 'device', device }) !== 'ok') throw new CoreError('forbidden', 'The requesting approver no longer has access.');
  }
  #input(raw: unknown): Input {
    if (!closed(raw, fields) || !['deploy', 'promote', 'rollback'].includes(String(raw.operation)) || !['cluster', 'namespace', 'service', 'version', 'artifact', 'registration', 'actor'].every(k => typeof raw[k] === 'string') || !validServiceExpected(raw.expected) || !(raw.network_change === null || typeof raw.network_change === 'string')) throw new CoreError('validation', 'Invalid structured cluster operation input.');
    return raw as unknown as Input;
  }
  #check(i: Input) {
    this.#access(i.actor);
    const r = this.#registration(i.cluster);
    const def = this.#definition(r, i.service, i.version);
    if (r.namespace !== i.namespace || digest(r) !== i.registration || digest(def) !== i.artifact) throw new CoreError('conflict', 'The approved cluster registration or artifact changed.');
    const driver = this.#driver(r);
    const plan = driver.plan(def);
    if (!plan.ok) throw new CoreError('conflict', plan.refused.join(' '));
    return { r, def, driver };
  }
  #tier(i: Input): 2 | 3 { return i.operation === 'rollback' ? 2 : promotionTier(this.#definition(this.#registration(i.cluster), i.service, i.version)); }
  networkTarget(target: string): NetworkTarget | null {
    const matches = this.#o.registrations().filter(r => r.networkTarget === target);
    if (!matches.length) return null;
    if (matches.length !== 1) throw new CoreError('conflict', 'A cluster network target must have exactly one binding.');
    const id = matches[0]!.id;
    this.#o.network.bindClusterTarget(target);
    const registration = () => {
      const r = this.#registration(id);
      if (r.networkTarget !== target) throw new CoreError('conflict', 'Cluster network target binding changed.');
      return r;
    };
    const port = () => {
      registration();
      const tools = this.#o.tools?.(id);
      if (!tools?.available().ok || !tools.network) throw new CoreError('conflict', 'The broker-backed cluster network capability is unavailable.');
      return tools.network;
    };
    port(); // Refuse before any legacy token read or adapter fallback.
    return clusterNetworkTarget(registration, port);
  }
  checkNetworkAuthority(target: string, binding: unknown, restore: boolean) {
    if (!closed(binding, ['cluster', 'namespace', 'registration', 'actor']) || !['cluster', 'namespace', 'registration', 'actor'].every(k => typeof binding[k] === 'string' && binding[k])) throw new CoreError('forbidden', 'Missing or invalid durable cluster network authority.');
    const r = this.#registration(binding.cluster as string);
    if (r.networkTarget !== target || r.namespace !== binding.namespace || digest(r) !== binding.registration) throw new CoreError('conflict', 'The approved cluster network registration changed.');
    // Automatic exact snapshot restoration was authorized with the original M10d change.
    // It still needs the current bound capability, but not a new requester/hub grant.
    if (!restore) this.#access(binding.actor as string);
    if (!this.networkTarget(target)) throw new CoreError('conflict', 'Cluster network capability unavailable.');
  }
  #body(body: Record<string, unknown>, operation: string) {
    if (!closed(body, operation === 'deploy' ? ['version', 'expected', 'network_change'] : ['version', 'expected']) || typeof body.version !== 'string' || !validServiceExpected(body.expected) || operation === 'deploy' && (typeof body.network_change !== 'string' || !/^c[0-9a-f]{10}$/.test(body.network_change))) throw new CoreError('validation', 'Use a registered version and exact expected state; deploy also requires its reviewed network change.');
  }
  propose(cluster: string, service: string, operation: Operation, body: Record<string, unknown>, principal: Principal): Task {
    this.#body(body, operation);
    const r = this.#registration(cluster);
    const def = this.#definition(r, service, body.version as string);
    const i: Input = { operation, cluster, namespace: r.namespace, service, version: def.version, artifact: digest(def), registration: digest(r), expected: structuredClone(body.expected as ServiceExpectedState), network_change: operation === 'deploy' ? body.network_change as string : null, actor: this.#actor(principal) };
    this.#check(i);
    if (operation === 'rollback' && i.expected.previous !== i.version) throw new CoreError('conflict', 'Rollback must name the approved previous version.');
    const task = this.#o.ledger.create({ title: `${operation}: ${service} ${def.version} on ${cluster}`, owner: workerId, goal: `Perform the fixed ${operation} operation against the approved cluster state, then verify actual observations.`, origin: i.actor === 'console' ? { kind: 'user' } : { kind: 'device', ref: i.actor }, approval_tier: this.#tier(i), evidence_required: [{ kind: 'confirmation', note: 'Task-bound cluster completion evidence' }], inputs: { ...i }, idempotency_key: i.network_change ? `k3s-network:${i.network_change}` : `k3s:${randomUUID()}` }, { as: this.#key });
    if (digest(task.brief.inputs) !== digest(i)) throw new CoreError('conflict', 'This network change is already bound to a different operation.');
    return task;
  }
  async network(cluster: string, service: string, body: Record<string, unknown>, principal: Principal) {
    this.#body(body, 'network');
    this.#access(this.#actor(principal));
    const r = this.#registration(cluster), def = this.#definition(r, service, body.version as string), driver = this.#driver(r);
    const plan = driver.plan(def);
    if (!plan.ok) throw new CoreError('conflict', plan.refused.join(' '));
    let values: K3sChartValues;
    try { values = await driver.preview(def, body.expected as ServiceExpectedState); } catch { throw new CoreError('conflict', 'The control plane or approved state is unavailable; no network change was created.'); }
    this.#access(this.#actor(principal));
    if (digest(this.#registration(cluster)) !== digest(r)) throw new CoreError('conflict', 'Cluster registration changed.');
    this.networkTarget(r.networkTarget);
    const actor = this.#actor(principal);
    return this.#o.network.start({ target: r.networkTarget, patch: clusterNetworkPatch(r, values, body.expected as ServiceExpectedState), title: `Network policy for ${cluster}/${service}@${def.version}` }, {
      origin: actor === 'console' ? { kind: 'user' } : { kind: 'device', ref: actor },
      cluster: { as: this.#o.networkKey, binding: { cluster, namespace: r.namespace, registration: digest(r), actor } },
    });
  }
  #committed(id: string) { return this.#o.ledger.events(id).some(e => e.kind === 'commit_point'); }
  retry(cluster: string, service: string, id: string, principal: Principal) {
    this.#access(this.#actor(principal));
    const t = this.#o.ledger.get(id), i = this.#input(t.brief.inputs);
    if (t.owner !== workerId || i.cluster !== cluster || i.service !== service) throw new CoreError('not_found', 'No matching cluster task.');
    this.#check(i);
    return this.#o.ledger.retry(id, 'Rechecking the same approved cluster target; uncertain effects are reconciled, never replayed.');
  }
  async #run(brief: Brief, signal: AbortSignal): Promise<Report> {
    const report = (status: Report['status'], summary: string): Report => ({ envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary, evidence: status === 'done' ? [{ kind: 'confirmation', system, id: brief.task_id }] : [], artifacts: [], blockers: status === 'blocked' ? [summary] : [], usage: { duration_ms: 0 }, follow_up_suggestions: [] });
    const blocked = (reason: string) => { if (!this.#committed(brief.task_id)) this.#o.ledger.notStarted(brief.task_id, reason); return report('blocked', reason); };
    try {
      const i = this.#input(brief.inputs), { r, def, driver } = this.#check(i);
      if (brief.approval_tier < this.#tier(i) || !this.#o.ledger.get(brief.task_id).approved_at) return report('failed', 'Current policy requires approval.');
      if (!(await driver.observe(i.service)).ok) return blocked('The control plane is unavailable. Waiting for the same approved target.');
      const s = driver.snapshot(i.service)!;
      if (this.#committed(brief.task_id)) {
        const recorded = this.#o.ledger.events(brief.task_id).some(e => e.kind === 'k3s_completed' && (e.detail as { input?: string }).input === digest(i));
        const own = s.last_mutation?.task_id === brief.task_id;
        const reconciled = own && (i.operation === 'deploy' && s.last_mutation?.operation === 'validate' && s.versions.some(v => v.version === i.version && v.status === 'ready' && v.ready) || i.operation === 'rollback' && s.last_mutation?.operation === 'rollback' && s.live === i.version);
        if (!recorded && !reconciled) return blocked('Effects may already have happened. Completion is unverified; an interrupted canary or preview is never replayed.');
        if (!recorded) this.#o.ledger.note(brief.task_id, 'k3s_completed', { input: digest(i), revision: s.revision, reconciled: true });
        return report('done', 'Reconciled task-bound cluster completion without replaying effects.');
      }
      if (!sameServiceExpected(i.expected, s)) return report('failed', SERVICE_CHANGED);
      const context: K3sExecution = { taskId: brief.task_id, signal,
        beforeMutation: () => { signal.throwIfAborted(); this.#check(i); if (!this.#committed(brief.task_id)) this.#o.ledger.committing(brief.task_id, `${i.operation} registered cluster resources`); },
        network: async request => ({ ok: !!i.network_change && await this.#o.network.appliedBinding(i.network_change, r.networkTarget, clusterNetworkPatch(r, request.values, request.expected), signal), said: 'The exact existing M10d change must be approved, applied and read back.' }),
      };
      const result = i.operation === 'deploy' ? await driver.apply(def, undefined, i.expected, context) : i.operation === 'promote' ? await driver.switch(i.service, i.version, undefined, i.expected, context) : await driver.rollback(i.service, { auto: false, reason: 'Approved manual rollback.', expected: i.expected }, undefined, context);
      if (!result.ok) return blocked(result.said);
      this.#o.ledger.note(brief.task_id, 'k3s_completed', { input: digest(i), revision: driver.snapshot(i.service)?.revision, canary_completed: i.operation === 'promote' });
      return report('done', result.said);
    } catch (e) {
      if (signal.aborted) throw e;
      return blocked(e instanceof CoreError ? e.message : 'Cluster operation could not be verified. No uncertain operation is replayed.');
    }
  }
  routes(): Route[] {
    const base = '/services/clusters/{cluster}/{service}';
    return [
      ...(['deploy', 'promote', 'rollback'] as const).map(operation => ({ method: 'POST' as const, path: `${base}/${operation}`, access: 'approver' as const, summary: `Propose registered cluster ${operation} through the Work Ledger.`, body: operation === 'deploy' ? '{version, expected, network_change}' : '{version, expected}', handle: ({ params, body, who }: Parameters<Route['handle']>[0]) => this.propose(params.cluster!, params.service!, operation, body, who.principal) })),
      { method: 'POST', path: `${base}/network`, access: 'approver', summary: 'Create the exact cluster NetworkPolicy snapshot/diff through the existing M10d authority.', body: '{version, expected}', handle: ({ params, body, who }) => this.network(params.cluster!, params.service!, body, who.principal) },
      { method: 'POST', path: `${base}/replicas`, access: 'approver', summary: 'General replica changes are unavailable through the current fixed cluster port.', handle: () => { throw new CoreError('conflict', 'General replica scaling is unsupported by the current fixed cluster port.'); } },
      { method: 'POST', path: `${base}/tasks/{task}/retry`, access: 'approver', summary: 'Retry an unchanged approved task or reconcile its uncertain effects without replay.', body: '{}', handle: ({ params, body, who }) => { if (!closed(body, [])) throw new CoreError('validation', 'Retry takes an empty object.'); return this.retry(params.cluster!, params.service!, params.task!, who.principal); } },
    ];
  }
  async collect(): Promise<ClusterObservation> {
    const machines: ClusterObservation['machines'] = [];
    for (const configured of this.#o.registrations()) {
      const r = this.#registration(configured.id), driver = this.#driver(r);
      const services = [...new Set(r.services.map(d => d.service))];
      for (const service of services) await driver.observe(service);
      const trusted = this.#o.placement().filter(d => r.deviceIds.includes(d.id) && d.trust === 'trusted');
      const identities = [...trusted.map(d => ({ id: d.id, name: d.name, kind: 'machine' as const, roles: [d.role, ...d.purposes] })), ...r.sites.map(s => ({ ...s, kind: 'cloud' as const, roles: [] }))];
      for (const identity of identities) {
        const snapshots = services.map(service => driver.snapshot(service)).filter((s): s is ClusterSnapshot => !!s);
        const nodes = snapshots.flatMap(s => s.nodes ?? []).filter(n => n.device_id === identity.id || n.device_id === k3sDeviceLabel(identity.id));
        const node = nodes.sort((a, b) => b.at.localeCompare(a.at))[0];
        const failure = driver.status().find(s => s.failure)?.failure;
        const attached: ServiceInput[] = [];
        for (const s of snapshots) {
          const observed = s.versions.filter(v => v.device_ids?.includes(identity.id));
          if (!observed.length) continue;
          const live = observed.find(v => v.version === s.live && v.replicas > 0);
          const health = live?.health;
          const observation = { source: 'workload' as const, health: health?.ok === true ? 'healthy' as const : health?.ok === false ? 'failed' as const : 'unknown' as const, at: health?.checked_at ?? null, reason: 'Actual cluster workload health measurement.' };
          const readiness = observed.filter(v => v.ready_at !== null).map(v => ({ source: 'workload' as const, health: v.ready ? 'healthy' as const : v.status === 'failed' ? 'failed' as const : 'unknown' as const, at: v.ready_at, reason: `Observed readiness of ${v.version}.` }));
          attached.push({ service: s.service, driver: 'k3s', placement: identity.id, live: live?.version ?? null, previous: s.previous, assigned: s.assigned, observation,
            observations: [...readiness, ...(failure ? [{ source: 'cluster' as const, health: 'unknown' as const, at: failure.at, reason: 'Control plane collection unavailable; workload evidence retains its own age.' }] : [])],
            versions: observed.map(v => ({ version: v.version, status: v.status, since: v.since, observed_at: v.ready_at, promotion_tier: null })), authority: null });
        }
        machines.push({ ...identity, observation: { health: node?.ready ? 'healthy' : node ? 'failed' : 'unknown', at: node?.at ?? null, reason: node ? 'Actual registered cluster node observation.' : 'No node observation is available.' }, observations: failure ? [{ health: 'unknown', at: failure.at, reason: 'Control plane unavailable; last node observation retained.' }] : [], services: attached });
      }
    }
    return { machines };
  }
  async close() { await Promise.all([...this.#drivers.values()].map(row => row.driver.close())); }
}
