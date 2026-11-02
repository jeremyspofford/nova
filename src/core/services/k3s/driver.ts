import { AsyncLocalStorage } from 'node:async_hooks';
import { get } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { promotionTier, validate, type ServiceDefinition } from '../definition.ts';
import type { Outcome, Plan, Say, ServiceDriver } from '../driver.ts';
import { sameServiceExpected, serviceExpected, SERVICE_CHANGED, validServiceExpected, type ServiceExpectedState } from '../expected.ts';
import { resolvePlacement } from '../placement.ts';
import { buildK3sValues, type K3sChartValues } from './values.ts';
import { K3sRegistry } from './registry.ts';
import { unavailableClusterTools, type ClusterOperation, type ClusterSnapshot, type ClusterTools, type K3sCluster, type K3sStatus } from './tools.ts';

export interface K3sClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  schedule(callback: () => void, ms: number): () => void;
}
const realClock: K3sClock = {
  now: Date.now,
  sleep: (ms, signal) => sleep(ms, undefined, { signal }),
  schedule: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return () => clearTimeout(timer); },
};
export interface K3sExecution {
  taskId: string; signal: AbortSignal;
  // Rechecked under serialization before EVERY effect, including automatic rollback.
  beforeMutation(operation: ClusterOperation): void | Promise<void>;
  network(request: { values: K3sChartValues; expected: ServiceExpectedState }): Promise<Outcome>;
}
const execution = new AsyncLocalStorage<K3sExecution>();

export interface K3sDriverOptions {
  cluster: K3sCluster;
  directory: string;
  workloadOnly?: boolean;
  devices?: () => K3sCluster['devices'];
  tools?: ClusterTools;
  clock?: K3sClock;
  // Trusted fixture/broker-owned forwarding origin, never a URL from tool output.
  probeOrigin?: string;
  // This is a capability hook, not a grant registry. Task3 connects existing M10d authority.
  authorizeNetwork?: (request: { cluster: K3sCluster; definition: ServiceDefinition; values: K3sChartValues; expected: ServiceExpectedState }, signal: AbortSignal) => Promise<Outcome>;
  problem?: (problem: { source: 'k3s'; subject: string; said: string }) => void;
  say?: Say;
}
const queues = new Map<string, Promise<unknown>>();
const fail = (said: string): Outcome => ({ ok: false, said });
// Three default polling intervals. Snapshot freshness and measured-health freshness are
// independent; only a timely measurement may authorize automatic workload changes.
const OBSERVATION_FRESHNESS_MS = 15_000;
const iso = (n: number) => new Date(n).toISOString();
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && iso(Date.parse(v)) === v;
const safePath = (path: string) => /^\/(?!\/)[^\s\\#]*$/.test(path) && !/%(?:2f|5c|2e)/i.test(path) && !path.split(/[/?]/).includes('..');
const statuses = new Set(['alongside', 'ready', 'live', 'kept', 'failed', 'removed', 'rolled_back']);
export class K3sDriver implements ServiceDriver {
  readonly name = 'k3s';
  readonly registry: K3sRegistry;
  readonly #o: K3sDriverOptions;
  readonly #tools: ClusterTools;
  readonly #clock: K3sClock;
  readonly #abort = new AbortController();
  readonly #cache = new Map<string, ClusterSnapshot>();
  readonly #failures = new Map<string, { at: string; said: string }>();
  readonly #timers = new Map<string, () => void>();
  #closed = false;
  constructor(options: K3sDriverOptions) {
    this.#o = { ...options, cluster: structuredClone(options.cluster) };
    this.#tools = options.tools ?? unavailableClusterTools;
    this.#clock = options.clock ?? realClock;
    this.registry = new K3sRegistry(options.directory);
    if (options.probeOrigin) {
      const url = new URL(options.probeOrigin);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('A trusted loopback forwarding origin is required.');
    }
  }
  available(): Outcome { return this.#closed ? fail('K3s driver is closed.') : this.#tools.available(); }
  plan(def: ServiceDefinition): Plan {
    const refused: string[] = [];
    if (!this.available().ok) refused.push(this.available().said);
    const checked = validate(def);
    if (!checked.ok) refused.push('Invalid K3s service definition.');
    else {
      if (def.alongside !== 'full' || def.state) refused.push('This cluster port cannot prove singleton preview readiness or safe state storage; state and non-full alongside modes are refused.');
      if (def.secrets.length) refused.push('Secret references require the missing broker handoff.');
      if (!this.#o.authorizeNetwork && !this.#o.workloadOnly && !execution.getStore()) refused.push('NetworkPolicy changes require the existing network authority capability.');
      if (!this.#o.probeOrigin) refused.push('A trusted forwarding origin is missing.');
      if (!safePath(def.health.http) || def.contract_tests.some(p => !p.startsWith('http:') || !safePath(p.slice(5)))) refused.push('Only confined HTTP probe paths are supported.');
      try { this.#values([def], null, []); } catch { refused.push('The definition or Linux/role/hardware placement cannot be represented safely by this cluster.'); }
    }
    return { driver: this.name, service: def.service, version: def.version, tier: checked.ok ? promotionTier(def) : 3, ok: refused.length === 0, refused, where: this.#o.cluster.id,
      steps: ['prepare', 'alongside', 'tests', 'health', 'approval', 'switch', 'canary', 'promote'].map(step => ({ step: step as Plan['steps'][number]['step'], said: ({ prepare: 'Validate immutable pinned image values.', alongside: 'Start a preview without changing stable traffic.', tests: 'Run HTTP contract checks.', health: 'Require three successful readiness probes.', approval: 'Require the existing approval authority.', switch: 'Atomically compare approved state and change the selector.', canary: 'Observe health for 120 seconds at five-second intervals.', promote: 'Keep the stopped prior version for rollback.' } as Record<string, string>)[step]! })) };
  }
  #values(defs: ServiceDefinition[], live: string | null, kept: string[], replicas: Record<string, number> = {}) {
    const placements = Object.fromEntries(defs.map(def => [def.version, resolvePlacement(def, (this.#o.devices?.() ?? this.#o.cluster.devices), { hubId: this.#o.cluster.hubId, now: new Date(this.#clock.now()) })]));
    if (Object.values(placements).some(p => !p.ok)) throw new Error('Placement refused.');
    return buildK3sValues(defs, { namespace: this.#o.cluster.namespace, hubId: this.#o.cluster.hubId, live, kept, placements, replicas });
  }
  #target(service: string) { return { cluster: this.#o.cluster.id, namespace: this.#o.cluster.namespace, service }; }
  #expected(s: ClusterSnapshot) { return { revision: s.revision, state: serviceExpected(s) }; }
  #accept(raw: ClusterSnapshot, service: string): ClusterSnapshot {
    const old = this.#cache.get(service);
    if (!raw || raw.schema !== 1 || raw.cluster !== this.#o.cluster.id || raw.namespace !== this.#o.cluster.namespace || raw.service !== service || !validServiceExpected(serviceExpected(raw)) || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1 || !date(raw.observed_at) || Date.parse(raw.observed_at) > this.#clock.now() + 1000 || this.#clock.now() - Date.parse(raw.observed_at) > OBSERVATION_FRESHNESS_MS || (old && (raw.sequence <= old.sequence || raw.revision < old.revision || raw.observed_at < old.observed_at)) || !Array.isArray(raw.versions) || raw.versions.length > 64 || new Set(raw.versions.map(v => v.version)).size !== raw.versions.length || (raw.soak_until !== null && !date(raw.soak_until)) || (raw.held !== null && (!raw.held || typeof raw.held.reason !== 'string' || !date(raw.held.at)))) throw new Error('Invalid, stale or out-of-order cluster observation.');
    if (raw.nodes !== undefined && (!Array.isArray(raw.nodes) || raw.nodes.length > 256 || raw.nodes.some(n => !n || typeof n.device_id !== 'string' || n.device_id.length > 256 || typeof n.ready !== 'boolean' || !date(n.at) || n.at > raw.observed_at))) throw new Error('Invalid node evidence.');
    if (raw.nodes && (new Set(raw.nodes.map(n => n.device_id)).size !== raw.nodes.length || raw.nodes.some(n => { const previous = old?.nodes?.find(p => p.device_id === n.device_id); return previous && n.at < previous.at; }))) throw new Error('Regressed or duplicate node evidence.');
    if (raw.last_mutation !== undefined && (!raw.last_mutation || !/^[0-9a-f-]{36}$/.test(raw.last_mutation.task_id) || !['prepare-workload', 'validate', 'switch', 'rollback'].includes(raw.last_mutation.operation))) throw new Error('Invalid task evidence.');
    for (const v of raw.versions) {
      if (v.device_ids !== undefined && (!Array.isArray(v.device_ids) || v.device_ids.length > 64 || v.device_ids.some(id => typeof id !== 'string' || id.length > 256))) throw new Error('Invalid resource placement evidence.');
      if (!v || typeof v.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v.version) || !statuses.has(v.status) || !Number.isInteger(v.replicas) || v.replicas < 0 || v.replicas > 64 || typeof v.ready !== 'boolean' || (v.ready && (!v.replicas || !date(v.ready_at))) || (v.ready_at !== null && (!date(v.ready_at) || v.ready_at > raw.observed_at)) || !date(v.since) || !v.health || ![true, false, null].includes(v.health.ok) || (v.health.ok !== null && !date(v.health.checked_at)) || (v.health.checked_at !== null && (!date(v.health.checked_at) || v.health.checked_at > raw.observed_at)) || !v.ports || !Object.values(v.ports).every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) || !Array.isArray(v.state_refs) || v.state_refs.some(r => typeof r !== 'string')) throw new Error('Invalid cluster version observation.');
      const previous = old?.versions.find(p => p.version === v.version);
      if (previous && ((previous.ready_at !== null && (v.ready_at === null || v.ready_at < previous.ready_at)) || (previous.health.checked_at !== null && (v.health.checked_at === null || v.health.checked_at < previous.health.checked_at)))) throw new Error('Regressed readiness or health observation.');
    }
    if ([raw.live, raw.previous].some(v => v !== null && !raw.versions.some(r => r.version === v)) || raw.live !== null && raw.live === raw.previous) throw new Error('Invalid cluster routing observation.');
    const snapshot = structuredClone(raw);
    this.#cache.set(service, snapshot);
    this.#failures.delete(service);
    return snapshot;
  }
  async #read(service: string) { return this.#accept(await this.#tools.execute({ ...this.#target(service), operation: 'status' }, this.#signal()), service); }
  #signal() { const e = execution.getStore(); return e ? AbortSignal.any([e.signal, this.#abort.signal]) : this.#abort.signal; }
  async #mutate(operation: ClusterOperation) {
    const e = execution.getStore();
    this.#signal().throwIfAborted();
    if (e) {
      // A preflight may await network readback. Re-resolve placement here, inside this service's
      // serialized write, so another eligible node cannot hide revocation of the approved node.
      if (operation.operation === 'prepare-workload') {
        const old = operation.values;
        const defs = old.versions.map(v => this.registry.get(operation.service, v.identity)!);
        const current = this.#values(defs, old.live, this.#cache.get(operation.service)?.previous ? [this.#cache.get(operation.service)!.previous!] : [], Object.fromEntries(old.versions.map(v => [v.identity, v.replicas])));
        if (JSON.stringify(current) !== JSON.stringify(old)) throw new Error('Approved placement changed.');
      } else if ('version' in operation && operation.version !== null) {
        const version = operation.version;
        const def = this.registry.get(operation.service, version);
        const row = this.#cache.get(operation.service)?.versions.find(v => v.version === version);
        if (!def || !row?.device_ids?.length) throw new Error('Actual resource placement is unavailable.');
        const allowed = this.#values([def], null, []).versions[0]!.placement.allowedDevices;
        if (row.device_ids.some(id => !allowed.includes(id))) throw new Error('Observed resource placement is no longer eligible.');
      }
      await e.beforeMutation(operation);
      this.#signal().throwIfAborted();
      operation = { ...operation, task_id: e.taskId } as ClusterOperation;
    }
    return this.#accept(await this.#tools.execute(operation, this.#signal()), operation.service);
  }
  #queue(service: string, work: () => Promise<Outcome>, context?: K3sExecution): Promise<Outcome> {
    const key = JSON.stringify([this.#o.cluster.id, this.#o.cluster.namespace, service]);
    const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const available = this.available();
      if (!available.ok) {
        if (!this.#failures.has(service)) this.#failures.set(service, { at: iso(this.#clock.now()), said: 'Cluster capability unavailable; cached observations have not been refreshed.' });
        return available;
      }
      try { return await (context ? execution.run(context, work) : work()); }
      catch { const said = 'The cluster operation failed or its completion is unknown. Refresh before any new action.'; if (!this.#failures.has(service)) this.#failures.set(service, { at: iso(this.#clock.now()), said }); return fail(said); }
    });
    queues.set(key, pending);
    void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); });
    return pending;
  }
  async #probe(service: string, version: string, path: string): Promise<boolean> {
    if (!this.#o.probeOrigin || !safePath(path) || this.#closed) return false;
    const url = new URL(`/preview/${encodeURIComponent(service)}/${encodeURIComponent(version)}${path}`, this.#o.probeOrigin);
    if (url.origin !== new URL(this.#o.probeOrigin).origin) return false;
    return new Promise(resolve => {
      let finished = false;
      const done = (ok: boolean) => { if (!finished) { finished = true; clearTimeout(timer); resolve(ok); } };
      const req = get(url, { signal: this.#signal(), agent: false }, res => {
        let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 65_536) { req.destroy(); done(false); } });
        res.on('end', () => done((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300));
        res.on('error', () => done(false));
      });
      const timer = setTimeout(() => { req.destroy(); done(false); }, 2000);
      req.on('error', () => done(false));
    });
  }
  apply(def: ServiceDefinition, say: Say = this.#o.say ?? (() => {}), expected?: ServiceExpectedState, context?: K3sExecution): Promise<Outcome> {
    const copy = structuredClone(def);
    return this.#queue(copy.service, async () => {
      if (this.#o.workloadOnly && !context) return fail('Cluster workloads require their internal ledger execution context.');
      const plan = this.plan(copy);
      if (!plan.ok) return fail(plan.refused.join(' '));
      let s = await this.#read(copy.service);
      if (expected !== undefined && !sameServiceExpected(expected, s)) return fail(SERVICE_CHANGED);
      this.registry.register(copy);
      if (s.versions.some(v => v.version === copy.version)) return fail('This version already has cluster state; refresh instead of replaying apply.');
      const defs = s.versions.filter(v => v.status !== 'removed').map(v => { const d = this.registry.get(copy.service, v.version); if (!d) throw new Error('Definition missing.'); return d; });
      const values = this.#values([...defs, copy], s.live, s.previous ? [s.previous] : [], Object.fromEntries(s.versions.filter(v => v.status !== 'removed').map(v => [v.version, v.replicas])));
      const permission = execution.getStore() ? await execution.getStore()!.network({ values: structuredClone(values), expected: serviceExpected(s) }) : await this.#o.authorizeNetwork!({ cluster: structuredClone(this.#o.cluster), definition: structuredClone(copy), values: structuredClone(values), expected: serviceExpected(s) }, this.#abort.signal);
      if (!permission.ok) return fail('Network authority refused the chart change.');
      s = await this.#mutate({ ...this.#target(copy.service), operation: context ? 'prepare-workload' : 'prepare', expected: this.#expected(s), values });
      let passed = true;
      for (const path of copy.contract_tests) if (!await this.#probe(copy.service, copy.version, path.slice(5))) passed = false;
      for (let i = 0; i < 3 && passed; i++) {
        if (i) await this.#clock.sleep(5000, this.#signal());
        passed = await this.#probe(copy.service, copy.version, copy.health.http);
        s = await this.#read(copy.service);
        passed &&= s.versions.some(v => v.version === copy.version && v.replicas > 0 && v.health.ok === true);
      }
      await this.#mutate({ ...this.#target(copy.service), operation: 'validate', expected: this.#expected(s), version: copy.version, passed });
      say(passed ? 'Preview passed contracts and three health probes; stable traffic is unchanged.' : 'Preview failed; it was never offered.');
      return { ok: passed, said: passed ? 'Ready alongside; stable traffic is unchanged.' : 'Contract or readiness checks failed.' };
    }, context);
  }
  switch(service: string, version: string, say: Say = this.#o.say ?? (() => {}), expected?: ServiceExpectedState, context?: K3sExecution): Promise<Outcome> {
    return this.#queue(service, async () => {
      let s = await this.#read(service);
      if (expected !== undefined && !sameServiceExpected(expected, s)) return fail(SERVICE_CHANGED);
      if (!s.versions.some(v => v.version === version && v.ready && v.status === 'ready')) return fail(`${version} isn’t ready.`);
      const def = this.registry.get(service, version);
      if (!def || !await this.#probe(service, version, def.health.http)) return fail(`${version} isn’t ready.`);
      const from = s.live;
      s = await this.#mutate({ ...this.#target(service), operation: 'switch', expected: this.#expected(s), version, soak_until: from && def.soak_s !== undefined ? iso(this.#clock.now() + 120_000 + def.soak_s * 1000) : null });
      const until = this.#clock.now() + 120_000;
      while (this.#clock.now() < until) {
        await this.#clock.sleep(5000, this.#signal());
        s = await this.#read(service);
        if (s.live !== version || s.previous !== from) return fail(SERVICE_CHANGED);
        if (!await this.#probe(service, version, def.health.http) || s.versions.find(v => v.version === version)?.health.ok !== true) {
          await this.#back(s, from, 'Canary health failed.');
          return fail('Canary failed; restored the kept version or stopped safely.');
        }
      }
      say('Canary passed; previous version retained stopped.');
      if (!context) this.#arm(service);
      return { ok: true, said: 'Promoted after the 120-second canary.' };
    }, context);
  }
  async #back(s: ClusterSnapshot, target: string | null, reason: string) {
    const out = await this.#mutate({ ...this.#target(s.service), operation: 'rollback', expected: this.#expected(s), version: target, reason });
    this.#o.problem?.({ source: 'k3s', subject: s.service, said: target ? 'Returned to the kept version.' : 'No kept version; service stopped and held.' });
    return out;
  }
  rollback(service: string, options: { auto: boolean; reason: string; expected?: ServiceExpectedState }, say: Say = this.#o.say ?? (() => {}), context?: K3sExecution): Promise<Outcome> {
    const target = options.expected?.previous ?? this.#cache.get(service)?.previous ?? null;
    return this.#queue(service, async () => {
      const s = await this.#read(service);
      if (options.expected !== undefined && !sameServiceExpected(options.expected, s) || s.previous !== target) return fail(SERVICE_CHANGED);
      if (!target) return fail('There is no kept version to return to.');
      await this.#back(s, target, 'Requested rollback.');
      say('Returned to the kept version without installing anything.');
      return { ok: true, said: 'Returned to the kept version.' };
    }, context);
  }
  // Collection is deliberately read-only: no monitor, removal or health rollback is armed.
  observe(service: string): Promise<Outcome> {
    return this.#queue(service, async () => { await this.#read(service); return { ok: true, said: 'Read actual cluster observations.' }; });
  }
  snapshot(service: string): ClusterSnapshot | null { return structuredClone(this.#cache.get(service) ?? null); }
  async preview(def: ServiceDefinition, expected: ServiceExpectedState): Promise<K3sChartValues> {
    let values: K3sChartValues | null = null;
    const out = await this.#queue(def.service, async () => {
      const s = await this.#read(def.service);
      if (!sameServiceExpected(expected, s)) return fail(SERVICE_CHANGED);
      const defs = s.versions.filter(v => v.status !== 'removed').map(v => this.registry.get(def.service, v.version)!);
      values = this.#values([...defs, def], s.live, s.previous ? [s.previous] : [], Object.fromEntries(s.versions.filter(v => v.status !== 'removed').map(v => [v.version, v.replicas])));
      return { ok: true, said: 'Prepared the public network document without effects.' };
    });
    if (!out.ok || !values) throw new Error(out.said);
    return values;
  }
  refresh(service: string): Promise<Outcome> {
    return this.#queue(service, async () => {
      let s = await this.#read(service);
      if (s.live) {
        const live = s.versions.find(v => v.version === s.live)!;
        const healthAge = live.health.checked_at === null ? Infinity : this.#clock.now() - Date.parse(live.health.checked_at);
        const currentHealth = healthAge >= 0 && healthAge <= OBSERVATION_FRESHNESS_MS;
        if (currentHealth && live.health.ok === false) s = await this.#back(s, s.previous, 'Observed live health failed.');
        else if (currentHealth && live.health.ok === true && s.previous && s.soak_until && Date.parse(s.soak_until) <= this.#clock.now()) {
          s = await this.#mutate({ ...this.#target(service), operation: 'remove', expected: this.#expected(s), version: s.previous });
        }
      }
      return { ok: true, said: 'Collected actual cluster observations.' };
    }).finally(() => this.#arm(service));
  }
  #arm(service: string) {
    this.#timers.get(service)?.();
    if (!this.#closed && this.#cache.get(service)?.live) this.#timers.set(service, this.#clock.schedule(() => { this.#timers.delete(service); void this.refresh(service); }, 5000));
  }
  status(service?: string): K3sStatus[] {
    return [...this.#cache.values()].filter(s => !service || s.service === service).map(s => {
      const live = s.versions.find(v => v.version === s.live);
      return structuredClone({ service: s.service, driver: this.name, cluster: s.cluster, revision: s.revision, observed_at: s.observed_at, failure: this.#failures.get(s.service) ?? null, live: s.live, previous: s.previous, assigned: s.assigned, soak_until: s.soak_until, held: s.held, health: live?.health ?? { ok: null, checked_at: null, said: null }, stable: live?.ports ?? {}, readiness: s.versions.map(v => ({ version: v.version, ready: v.ready, checked_at: v.ready_at })), versions: s.versions.map(v => ({ version: v.version, status: v.status, since: v.since, said: null, ports: v.replicas ? v.ports : null, pid: null })), history: [] });
    });
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    for (const cancel of this.#timers.values()) cancel();
    this.#timers.clear();
  }
}
