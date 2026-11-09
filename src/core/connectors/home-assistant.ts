// Home Assistant as a connector (M5 plan §2). Set up with the address of the person's Home Assistant
// and a long-lived access token, which goes into the vault. Through Home Assistant's own APIs:
//  - reading entity states (REST, tier 0: Nova just looks);
//  - calling a service (REST): changing devices or home state. A call the person asks for is tier 1,
//    act and report (owner ruling 2026-11-09, docs/builder-packet/INPUT-2026-11-09-TIER-RULING.md,
//    overriding NOVA-SPEC §6's tier 2 for the home): it runs without an approval and the ledger
//    records it with what changed. The service tier is a setting (2 asks first again), and domains
//    the person marks are tier 3, confirmed every time (none by default). It runs as a Work Ledger
//    task for this connector's worker, so the ledger's gate holds whatever tier applies, and Nova
//    reads the entity back from Home Assistant itself as the evidence; a read-back that doesn't show
//    the change holds the task for the person. From chat (home_call) it is a guarded step: after the
//    run read outside content it asks first, whatever the tier (src/runner.js, GUARDED);
//  - state changes (WebSocket, subscribe_events state_changed), which become event trigger records
//    for the entities a rule listens to. A dropped socket is reopened with growing pauses.
// Egress is local for an address on this network or the mesh, remote otherwise; local-only never
// contacts a remote Home Assistant. Disconnecting deletes the token from Home Assistant itself
// (auth/delete_refresh_token, named by the token's own issuer) and then from the vault.
import { CoreError } from '../errors.ts';
import { reportOf, type Brief, type Evidence, type Tier } from '../envelope.ts';
import type { Task } from '../ledger.ts';
import type { Egress } from '../workers.ts';
import type { Route } from '../api.ts';
import type { ManifestApproval } from '../approvals/index.ts';
import type { Connector, ConnectorContext, ConnectorStatus } from './index.ts';
import { lookup as dnsLookup } from 'node:dns/promises';
import { addressEgress, needsResolving, resolvesLocal } from './index.ts';
import { NO_REDIRECT, reachProblem } from '../providers/types.ts';

export const HA_ID = 'home-assistant';
const TOKEN = 'HA_TOKEN';
// Domains that need an explicit confirmation every time. None by default (owner ruling 2026-11-09:
// "If I ask nova to unlock the door, it should just do it."); the person can mark any, locks and
// alarms included, in its settings.
export const DEFAULT_TIER3: readonly string[] = [];
// Every other service call: 1, act and report, by default; the person can make it 2, ask first.
export const DEFAULT_SERVICE_TIER = 1;
const SERVICE_TIERS = [1, 2] as const;
type ServiceTier = (typeof SERVICE_TIERS)[number];
const DOMAIN = /^[a-z_][a-z0-9_]{0,63}$/;
const ENTITY = /^[a-z_][a-z0-9_]{0,63}\.[a-z0-9_]{1,128}$/;
// What a service should leave its entity showing, when that is certain.
const EXPECT: Record<string, string> = { turn_on: 'on', turn_off: 'off', lock: 'locked', unlock: 'unlocked', open_cover: 'open', close_cover: 'closed' };

export const HA_MANIFEST = {
  id: HA_ID,
  version: '1.0.0',
  kind: 'connector' as const,
  name: 'Home Assistant',
  capabilities: ['home.states.read', 'home.services.call', 'home.events'],
  permissions: [
    { kind: 'network' as const, target: 'your Home Assistant, at the address you give', why: 'to read your devices and hear when they change' },
    { kind: 'device' as const, target: 'devices Home Assistant controls', why: 'to change them when you ask, telling you what changed' },
  ],
  secrets: [TOKEN],
  config_schema: { type: 'object', properties: { url: { type: 'string' }, tier3_domains: { type: 'array', items: { type: 'string' } }, service_tier: { type: 'integer', enum: [1, 2] } } },
  setup_flow: { fields: ['url', 'token'] },
  health_check: { kind: 'http', path: '/api/' },
  nova_compat: '>=0.1.0 <1.0.0',
  on_remove: { delete: ['config.json'], keep: [], export: [] },
  // Its one capability that acts, for the approvals registry, declared like any extension's: a
  // device change (irreversible class); the owner's ruling makes Nova's own default 1 (act and
  // report), and it is 1 or 2, since tier 3 is per domain (the targets the person marks).
  approvals: [{
    id: 'service', name: 'Change your home through Home Assistant', effect: 'irreversible', default: 1, tiers: [1, 2],
    tools: ['home_call'], guard: 'change your home', targets: 'Home Assistant domains (lock, alarm_control_panel) marked to confirm every time',
  }] as ManifestApproval[],
};

interface State { entity_id: string; state: string; attributes?: Record<string, unknown>; last_changed?: string; last_updated?: string }
// resolved_local: a bare name in the address that resolved to this network when it was connected.
interface Config { url?: string; since?: string; name?: string | null; broken?: boolean; tier3_domains?: string[]; service_tier?: ServiceTier; resolved_local?: string }

// What a call through home_call (chat) or the API asks for.
export interface ServiceCall { entity_id?: unknown; data?: unknown }
// The connector, with the service call chat's home_call makes (src/tools.js).
export type HomeAssistantConnector = Connector & { callService(domain: string, service: string, body: ServiceCall): Task };

export interface HomeAssistantOptions {
  // Pauses between reconnects: the first, and the most it grows to.
  reconnectMs?: { first: number; max: number };
  fetch?: typeof fetch;
  timeoutMs?: number;
  // How a bare name is resolved, to tell whether it is on this network (tests inject one).
  lookup?: (host: string) => Promise<string[]>;
}

// Service data: plain keys, and plain values (or short lists of them), small enough to read in an
// approval. Entities are named like light.kitchen.
const DATA_KEY = /^[a-z_][a-z0-9_]{0,63}$/;
const plainValue = (v: unknown) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200);
export function checkServiceData(raw: unknown, entity: unknown): { data: Record<string, unknown>; entities: string[] } {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) throw new CoreError('validation', 'data is an object of the service’s settings, like {"brightness": 120}.');
  const data = { ...(raw as Record<string, unknown> | undefined) };
  for (const [k, v] of Object.entries(data)) {
    if (!DATA_KEY.test(k)) throw new CoreError('validation', `“${k.slice(0, 40)}” isn’t a setting name Home Assistant uses (lowercase letters, digits and _).`);
    if (!(plainValue(v) || (Array.isArray(v) && v.length <= 50 && v.every(plainValue)))) throw new CoreError('validation', `${k} must be a plain value (text, a number, true or false) or a short list of them.`);
  }
  if (JSON.stringify(data).length > 2000) throw new CoreError('validation', 'That service data is too long to show you in an approval; send less.');
  if (entity !== undefined) {
    if (typeof entity !== 'string' || !ENTITY.test(entity)) throw new CoreError('validation', 'An entity is named like light.kitchen.');
    if (data.entity_id !== undefined && data.entity_id !== entity) throw new CoreError('validation', 'entity_id and data.entity_id name different entities; name it once.');
    data.entity_id = entity;
  }
  const ids = data.entity_id === undefined ? [] : Array.isArray(data.entity_id) ? data.entity_id : [data.entity_id];
  if (!ids.every((e) => typeof e === 'string' && ENTITY.test(e))) throw new CoreError('validation', 'data.entity_id names entities like light.kitchen.');
  return { data, entities: ids as string[] };
}

const wsUrl = (base: string) => `${base.replace(/^http/, 'ws')}/api/websocket`;

// The id Home Assistant knows a long-lived token by: its JWT issuer.
export function tokenIssuer(token: string): string | null {
  try {
    const body = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8')) as { iss?: unknown };
    return typeof body.iss === 'string' && body.iss ? body.iss : null;
  } catch { return null; }
}

// One WebSocket exchange: open, sign in, send one command, read its result, close.
async function wsCommand(base: string, token: string, command: Record<string, unknown>, timeoutMs: number): Promise<{ success: boolean; error?: { message?: string } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(base));
    const timer = setTimeout(() => { ws.close(); reject(new Error('Home Assistant didn’t answer in time.')); }, timeoutMs);
    const done = (fn: () => void) => { clearTimeout(timer); try { ws.close(); } catch { /* closing */ } fn(); };
    ws.addEventListener('error', () => done(() => reject(new Error('Couldn’t reach Home Assistant.'))));
    ws.addEventListener('message', (e) => {
      let m: { type?: string; id?: number; success?: boolean; error?: { message?: string } };
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (m.type === 'auth_invalid') done(() => reject(new Error('Home Assistant doesn’t accept the token any more.')));
      else if (m.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, ...command }));
      else if (m.type === 'result' && m.id === 1) done(() => resolve({ success: !!m.success, ...(m.error ? { error: m.error } : {}) }));
    });
  });
}

export function homeAssistant(o: HomeAssistantOptions = {}) {
  return (ctx: ConnectorContext): HomeAssistantConnector => {
    const f = o.fetch ?? globalThis.fetch;
    const timeoutMs = o.timeoutMs ?? 15_000;
    const backoff = o.reconnectMs ?? { first: 1000, max: 60_000 };
    const cfg = () => ctx.config.get() as Config;
    const token = () => ctx.secrets.get(TOKEN);
    const lookup = o.lookup ?? (async (h: string) => (await dnsLookup(h, { all: true })).map((a) => a.address));
    const localNames = () => (cfg().resolved_local ? [cfg().resolved_local!] : []);
    const egress = (): Egress => (cfg().url ? addressEgress(cfg().url!, ctx.meshHosts(), localNames()) : 'local');
    const host = () => { try { return new URL(cfg().url!).host; } catch { return 'your Home Assistant'; } };
    // Readings Nova took itself after a service call, by confirmation id, for the verifier.
    const observed = new Map<string, State>();

    // ---- live events -----------------------------------------------------------------------
    let ws: WebSocket | null = null;
    let live: ConnectorStatus['live'] = 'off';
    let wanted = false;
    let pause = backoff.first;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const setLive = (v: ConnectorStatus['live']) => { if (live !== v) { live = v; ctx.changed(); } };

    function open(): void {
      const t = token();
      const url = cfg().url;
      if (!wanted || !t || !url || cfg().broken) return;
      if (!ctx.permits(egress())) { setLive('off'); return; }
      let socket: WebSocket;
      try { socket = new WebSocket(wsUrl(url)); } catch { again(); return; }
      ws = socket;
      socket.addEventListener('message', (e) => {
        let m: { type?: string; id?: number; success?: boolean; event?: { event_type?: string; data?: { entity_id?: string; old_state?: State | null; new_state?: State | null }; time_fired?: string } };
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: t }));
        else if (m.type === 'auth_invalid') { wanted = false; broken('Home Assistant no longer accepts Nova’s token. Make a new long-lived token and connect again.'); socket.close(); }
        else if (m.type === 'auth_ok') socket.send(JSON.stringify({ id: 1, type: 'subscribe_events', event_type: 'state_changed' }));
        else if (m.type === 'result' && m.id === 1 && m.success) { pause = backoff.first; setLive('listening'); }
        else if (m.type === 'event' && m.event?.event_type === 'state_changed') changed(m.event.data ?? {}, m.event.time_fired);
      });
      socket.addEventListener('close', () => { if (ws === socket) { ws = null; again(); } });
      socket.addEventListener('error', () => { /* close follows */ });
    }

    function again(): void {
      if (!wanted) { setLive('off'); return; }
      // Reconnecting is contacting it again: only while the privacy setting allows it.
      if (!ctx.permits(egress())) { setLive('off'); return; }
      setLive('reconnecting');
      if (retry) return;
      retry = setTimeout(() => { retry = null; open(); }, pause);
      retry.unref?.();
      pause = Math.min(pause * 2, backoff.max);
    }

    // A state change becomes a trigger record only when a rule listens to that entity, and only
    // when the state itself changed (not just an attribute).
    function changed(d: { entity_id?: string; old_state?: State | null; new_state?: State | null }, at?: string): void {
      const entity = d.entity_id;
      if (!entity || !d.new_state || d.old_state?.state === d.new_state.state) return;
      if (!ctx.topics().includes(entity)) return;
      const payload = { entity_id: entity, from: d.old_state?.state ?? null, to: d.new_state.state, at: d.new_state.last_changed ?? at ?? null };
      ctx.emit(entity, payload, `${entity}@${payload.at}`).catch((e) => ctx.problem('A change in Home Assistant couldn’t be recorded.', (e as Error)?.stack));
    }

    // The privacy setting (or where Home Assistant counts as being) changed: a socket it no longer
    // allows closes now, and one it allows again opens.
    function recheck(): void {
      if (!wanted) return;
      if (ctx.permits(egress())) { if (!ws && !retry) { pause = backoff.first; open(); } return; }
      if (retry) clearTimeout(retry);
      retry = null;
      const s = ws;
      ws = null;
      try { s?.close(); } catch { /* already closed */ }
      setLive('off');
    }

    function stopLive(): void {
      wanted = false;
      if (retry) clearTimeout(retry);
      retry = null;
      pause = backoff.first;
      const s = ws;
      ws = null;
      try { s?.close(); } catch { /* already closed */ }
      setLive('off');
    }

    function broken(message: string): void {
      if (!cfg().broken) {
        ctx.config.set({ broken: true });
        ctx.problem(message);
      }
      setLive('off');
      ctx.changed();
    }

    // ---- REST -----------------------------------------------------------------------------
    async function api<T>(path: string, init: { method?: string; body?: unknown; base?: string; token?: string; local?: string[] } = {}): Promise<T> {
      const base = init.base ?? cfg().url;
      const t = init.token ?? token();
      if (!base || !t) throw new CoreError('conflict', 'Home Assistant isn’t connected. Connect it in Settings, under Connections.');
      if (!init.base && cfg().broken) throw new CoreError('conflict', 'Home Assistant needs reconnecting: it no longer accepts Nova’s token.');
      const e = init.base ? addressEgress(base, ctx.meshHosts(), init.local ?? []) : egress();
      if (!ctx.permits(e)) throw new CoreError('forbidden', `Your Home Assistant is outside your network (${new URL(base).host}), and Nova is set to local-only, so Nova doesn’t contact it.`);
      let res: Response;
      try {
        res = await f(`${base}${path}`, {
          method: init.method ?? 'GET',
          headers: { authorization: `Bearer ${t}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
          ...NO_REDIRECT,
        });
      } catch (e) {
        const why = reachProblem(e);
        if (/redirect/.test(why)) throw new CoreError('conflict', `Home Assistant at ${new URL(base).host} ${why.replace(/^it /, '')}. Use the address it redirects to, if that is where it is.`);
        throw new CoreError('conflict', `Couldn’t reach Home Assistant at ${new URL(base).host}. Check that it is running and the address is right.`);
      }
      if (res.status === 401 || res.status === 403) {
        if (!init.base) broken('Home Assistant no longer accepts Nova’s token. Make a new long-lived token and connect again.');
        throw new CoreError('conflict', init.base ? 'Home Assistant didn’t accept that token. Make a long-lived access token in your Home Assistant profile and paste all of it.' : 'Home Assistant needs reconnecting: it no longer accepts Nova’s token.');
      }
      if (res.status === 404) throw new CoreError('not_found', 'Home Assistant has no such thing.');
      if (!res.ok) throw new CoreError('conflict', `Home Assistant answered with an error (HTTP ${res.status}).`);
      return (await res.json().catch(() => ({}))) as T;
    }

    const view = (s: State) => ({
      entity_id: s.entity_id, domain: s.entity_id.split('.')[0], name: typeof s.attributes?.friendly_name === 'string' ? s.attributes.friendly_name : s.entity_id,
      state: s.state, last_changed: s.last_changed ?? null,
    });
    const tier3 = (): readonly string[] => cfg().tier3_domains ?? DEFAULT_TIER3;
    // The service tier is an ordinary capability in the approvals registry (home-assistant.service,
    // declared in the manifest below, stored in policy.approvals like every other). A tier kept in
    // this connector's own settings file before that moves there once, as it was.
    const serviceTier = (): ServiceTier => {
      const c = cfg();
      if (c.service_tier !== undefined && ctx.adoptTier) {
        if (SERVICE_TIERS.includes(c.service_tier)) ctx.adoptTier('service', c.service_tier);
        ctx.config.set({ service_tier: undefined });
      }
      if (ctx.tier) return (ctx.tier('service') >= 2 ? 2 : 1) as ServiceTier;
      return SERVICE_TIERS.includes(c.service_tier as ServiceTier) ? c.service_tier! : DEFAULT_SERVICE_TIER as ServiceTier;
    };
    const tierFor = (domain: string): Tier => (tier3().includes(domain) ? 3 : serviceTier());
    // From the domain and every entity the call names: homeassistant.turn_off on a lock is a lock.
    const tierOf = (domain: string, entities: string[]): Tier => (entities.some((e) => tierFor(e.split('.')[0]!) === 3) ? 3 : tierFor(domain));

    // A service call as a task for the worker below, at the tier its domain and entities need.
    function callService(domain: string, service: string, body: ServiceCall): Task {
      if (!DOMAIN.test(domain) || !DOMAIN.test(service)) throw new CoreError('validation', 'A service is named by its domain and service, like light and turn_on.');
      if (!cfg().url || !token()) throw new CoreError('conflict', 'Home Assistant isn’t connected. Connect it in Settings, under Connections.');
      const { data, entities } = checkServiceData(body.data, body.entity_id);
      const entity = entities.length === 1 ? entities[0] : undefined;
      const tier = tierOf(domain, entities);
      // Everything the call carries is in the task's goal, in words.
      const settings = Object.entries(data).filter(([k]) => k !== 'entity_id').map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`);
      const expect = entity && EXPECT[service] ? EXPECT[service] : undefined;
      return ctx.delegate({
        title: `${service.replace(/_/g, ' ')}${entities.length ? ` ${entities.join(', ')}` : ''} (Home Assistant)`.slice(0, 200),
        goal: `Home Assistant runs ${domain}.${service}${entities.length ? ` on ${entities.join(', ')}` : ''}${settings.length ? `, with ${settings.join('; ')}` : ''}${expect ? `, and ${entity} shows ${expect}` : ''}.`,
        approval_tier: tier,
        evidence_required: [{ kind: 'confirmation' }],
        inputs: { domain, service, data, ...(expect ? { expect } : {}) },
      });
    }

    // ---- the worker: one service call per task, at its tier --------------------------------
    const worker = {
      id: HA_ID,
      name: 'Home Assistant',
      // Its words follow the service tier: at 2 it asks first.
      get about() { return serviceTier() >= 2 ? 'Changes things in your home through Home Assistant when you ask, after your OK, and reports what changed. Domains you mark confirm every time.' : 'Changes things in your home through Home Assistant when you ask, and reports what changed. Domains you mark confirm every time.'; },
      get egress() { return egress(); },
      evidence: ['confirmation' as const],
      // A service call changes the home (and `toggle` a second time undoes the first): after a
      // failure the ledger asks the person rather than calling again (workers.ts, Effects).
      effects: () => 'external' as const,
      health: () => (cfg().broken ? { ok: false, detail: 'Home Assistant needs reconnecting: it no longer accepts Nova’s token.' } : { ok: true, detail: cfg().url ? `Connected to ${host()}.` : 'Not connected.' }),
      async run(brief: Brief, signal: AbortSignal) {
        const started = Date.now();
        const i = (brief.inputs ?? {}) as { domain?: string; service?: string; data?: Record<string, unknown>; expect?: string };
        const report = (status: 'done' | 'blocked' | 'failed', summary: string, evidence: Evidence[] = [], blockers: string[] = []) => reportOf(brief.task_id, status, summary, { evidence, blockers, usage: { duration_ms: Date.now() - started } });
        if (!i.domain || !DOMAIN.test(i.domain) || !i.service || !DOMAIN.test(i.service)) return report('failed', 'The task doesn’t name a Home Assistant service.');
        // The tier comes from the domain, whatever the task asked for: a call can't lower its own gate.
        let entities: string[];
        try { entities = checkServiceData(i.data, undefined).entities; } catch (e) { return report('failed', (e as Error).message); }
        const need = tierOf(i.domain, entities);
        if (brief.approval_tier < need) return report('blocked', need === 1 ? 'This changes your home, so it runs as a task Nova reports on (tier 1), not silently.' : `This changes your home, so it needs your OK first (tier ${need}).`, [], [`Tier ${need} is needed for ${i.domain}.`]);
        if (signal.aborted) return report('failed', 'Stopped before calling Home Assistant.');
        const changed = await api<State[]>(`/api/services/${i.domain}/${i.service}`, { method: 'POST', body: i.data ?? {} });
        const entity = typeof i.data?.entity_id === 'string' ? i.data.entity_id : null;
        // Nova reads the result back itself rather than trusting the call's answer.
        const after = entity ? await api<State>(`/api/states/${entity}`) : (Array.isArray(changed) ? changed[0] : null);
        if (!after) return report('done', `Home Assistant ran ${i.domain}.${i.service}.`, [{ kind: 'confirmation', system: HA_ID, id: `service:${i.domain}.${i.service}@${brief.task_id}` }]);
        const id = `${after.entity_id}@${after.last_changed ?? after.last_updated ?? ''}`;
        observed.set(id, after);
        if (observed.size > 200) observed.delete(observed.keys().next().value!);
        return report('done', `${i.domain}.${i.service}: ${after.entity_id} is ${after.state} now.`, [{ kind: 'confirmation', system: HA_ID, id }]);
      },
    };

    // The verifier's check: a reading Nova took itself, showing what the service should have done.
    const confirm = (e: Evidence, brief: Brief) => {
      if (e.kind !== 'confirmation') return { ok: false, why: 'Not a confirmation.' };
      if (e.id.startsWith('service:')) return { ok: true, why: 'Home Assistant ran the service; it changed no single entity to read back.' };
      const s = observed.get(e.id);
      if (!s) return { ok: false, why: 'Nova didn’t read that state from Home Assistant itself, so it can’t count as proof.' };
      const expect = (brief.inputs as { expect?: string } | undefined)?.expect;
      if (expect && s.state !== expect) return { ok: false, why: `Nova read ${s.entity_id} from Home Assistant itself: it is ${s.state}, not ${expect}.` };
      return { ok: true, why: `Nova read ${s.entity_id} from Home Assistant itself after the call: ${s.state}.` };
    };

    const routes: Route[] = [
      {
        method: 'GET', path: '/states', summary: 'Home Assistant: every entity’s state (tier 0: Nova only looks). ?domain= for one kind.',
        handle: async ({ query }) => {
          const all = (await api<State[]>('/api/states')).map(view);
          const d = query.get('domain');
          return d ? all.filter((s) => s.domain === d) : all;
        },
      },
      {
        method: 'GET', path: '/states/{entity}', summary: 'Home Assistant: one entity’s state.',
        handle: async ({ params }) => {
          if (!ENTITY.test(params.entity!)) throw new CoreError('validation', 'An entity is named like light.kitchen.');
          return view(await api<State>(`/api/states/${params.entity}`));
        },
      },
      {
        method: 'POST', path: '/services/{domain}/{service}', status: 201,
        summary: 'Home Assistant: call a service, as a task. It runs and is reported, with Nova’s own read-back as the evidence (tier 1, act and report); it waits for your OK when the service tier setting is 2, and needs an explicit confirmation every time for the domains you marked (tier 3).',
        body: '{entity_id?, data?}',
        handle: ({ params, body }) => callService(params.domain!, params.service!, body),
      },
      {
        // The service tier here is the approvals registry's home-assistant.service, read through this
        // older route; the domains are this connector's targets marked "confirm every time".
        method: 'GET', path: '/settings', summary: 'Home Assistant: the tier a service call runs at (service_tier: 1, act and report, or 2, ask first; the same setting as PUT /approvals/home-assistant.service), and which domains need an explicit confirmation every time (tier3_domains, tier 3).',
        handle: () => ({ tier3_domains: tier3(), default: DEFAULT_TIER3, service_tier: serviceTier(), default_service_tier: DEFAULT_SERVICE_TIER }),
      },
      {
        method: 'PUT', path: '/settings', summary: 'Set the service tier (1, act and report, or 2, ask first) and mark which domains need an explicit confirmation every time. Lowering the service tier or taking a domain off the list loosens a gate, so it needs {confirm: true}.',
        body: '{tier3_domains?: [], service_tier?: 1 | 2, confirm?}',
        handle: ({ body }) => {
          const list = body.tier3_domains;
          const st = body.service_tier;
          if (list === undefined && st === undefined) throw new CoreError('validation', 'Send tier3_domains, service_tier, or both.');
          if (list !== undefined && (!Array.isArray(list) || !list.every((d) => typeof d === 'string' && DOMAIN.test(d)))) throw new CoreError('validation', 'tier3_domains is a list of domains, like lock.');
          if (st !== undefined && !SERVICE_TIERS.includes(st as ServiceTier)) throw new CoreError('validation', 'service_tier is 1 (act and report) or 2 (ask first). A domain that needs a confirmation every time goes in tier3_domains.');
          const loosened = list === undefined ? [] : tier3().filter((d) => !(list as string[]).includes(d));
          if (loosened.length && body.confirm !== true) throw new CoreError('validation', `Taking ${loosened.join(', ')} off the list means Nova no longer asks for a confirmation every time. Send confirm: true to do that.`);
          if (st !== undefined && (st as number) < serviceTier() && body.confirm !== true) throw new CoreError('validation', 'Lowering the service tier to 1 means Nova changes your home when you ask, without waiting for your OK, and tells you what it did. Send confirm: true to do that.');
          if (!cfg().url) throw new CoreError('conflict', 'Connect Home Assistant first.');
          if (list !== undefined) ctx.config.set({ tier3_domains: [...new Set(list as string[])] });
          // The service tier goes to the approvals registry; this route checked the confirmation above.
          if (st !== undefined) {
            if (ctx.setTier) ctx.setTier('service', st as Tier, { confirm: true, by: 'home-assistant settings' });
            else ctx.config.set({ service_tier: st });
          }
          return { tier3_domains: tier3(), default: DEFAULT_TIER3, service_tier: serviceTier(), default_service_tier: DEFAULT_SERVICE_TIER };
        },
      },
    ];

    return {
      manifest: HA_MANIFEST,
      callService,
      // Its targets marked "confirm every time" (approvals/index.ts): the domains.
      marked: (capability: string) => (capability === 'service' ? tier3() : []),
      summary: 'Your smart home: Nova can see what your devices are doing, hear when they change, and change them when you ask.',
      // The third line follows the service tier: at 2 it asks first.
      get can() {
        return [
          'See the state of your lights, sensors, locks and other devices.',
          'Notice when something changes, for the rules you set up.',
          serviceTier() >= 2 ? 'Turn things on and off when you ask, after your OK, and tell you what changed.' : 'Turn things on and off when you ask, and tell you what changed.',
        ];
      },
      never: ['Change anything unless you, or a rule you set up, asks.', 'Change anything from a chat that has read something from outside, without asking you first.'],
      setup: {
        kind: 'form',
        fields: [
          { key: 'url', label: 'Home Assistant address', placeholder: 'http://homeassistant.local:8123' },
          { key: 'token', label: 'Long-lived access token', secret: true, hint: 'Make one in Home Assistant: your profile, Security, Long-lived access tokens.' },
        ],
      },
      egress,
      host: () => { try { return cfg().url ? new URL(cfg().url!).hostname : null; } catch { return null; } },
      status: () => {
        const c = cfg();
        const t = c.url ? ctx.secrets.has(TOKEN) : false;
        if (!c.url || !t) return { connected: false, live: null };
        if (c.broken) return { connected: false, broken: true, account: c.name ?? host(), since: c.since ?? null, live: 'off', detail: 'Home Assistant no longer accepts Nova’s token. Make a new one and connect again.' };
        return { connected: true, account: c.name ?? host(), since: c.since ?? null, live, detail: ctx.permits(egress()) ? null : 'Paused: it’s outside your network and Nova is set to local-only.' };
      },
      async connect(input) {
        const raw = String(input.url ?? '').trim().replace(/\/+$/, '');
        let url: URL;
        try { url = new URL(raw); } catch { throw new CoreError('validation', 'Enter your Home Assistant’s address, like http://homeassistant.local:8123.'); }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CoreError('validation', 'The address starts with http:// or https://.');
        if (url.username || url.password) throw new CoreError('validation', 'Leave the name and password out of the address; the token is what signs Nova in.');
        const base = url.origin + url.pathname.replace(/\/+$/, '');
        // A bare name is local only if it resolves to this network; that is checked now, and kept.
        const bare = needsResolving(base);
        const local = bare && await resolvesLocal(bare, lookup) ? [bare] : [];
        const t = String(input.token ?? '').trim();
        if (!t) throw new CoreError('validation', 'Paste a long-lived access token from your Home Assistant profile.');
        const hello = await api<{ message?: string }>('/api/', { base, token: t, local });
        if (!hello?.message) throw new CoreError('validation', 'That address answers, but not like Home Assistant does.');
        const info = await api<{ location_name?: string; version?: string }>('/api/config', { base, token: t, local }).catch(() => ({} as { location_name?: string }));
        // Connecting again (a new token): the old socket goes; the registry starts a new one.
        stopLive();
        ctx.secrets.put(TOKEN, t);
        const keep = cfg().url === base ? cfg().tier3_domains : undefined;
        ctx.config.clear();
        ctx.config.set({ url: base, since: ctx.now().toISOString(), name: info.location_name ?? null, ...(keep ? { tier3_domains: keep } : {}), ...(local.length ? { resolved_local: local[0] } : {}) });
        return this.status();
      },
      async disconnect() {
        const t = token();
        const base = cfg().url;
        let revoked = false;
        let note: string | undefined;
        if (t && base) {
          const iss = tokenIssuer(t);
          if (!iss) note = 'Home Assistant’s token isn’t one Nova can revoke itself; delete it in your Home Assistant profile, under Long-lived access tokens.';
          else if (!ctx.permits(addressEgress(base, ctx.meshHosts(), localNames()))) note = 'Nova is local-only and your Home Assistant is outside your network, so Nova didn’t contact it: delete the token in your Home Assistant profile.';
          else {
            try {
              const r = await wsCommand(base, t, { type: 'auth/delete_refresh_token', refresh_token_id: iss }, timeoutMs);
              revoked = r.success;
              if (!revoked) note = `Home Assistant didn’t delete the token (${r.error?.message ?? 'no reason given'}); delete it in your profile there.`;
            } catch (e) {
              note = `${(e as Error).message} Delete the token in your Home Assistant profile, under Long-lived access tokens.`;
            }
          }
        }
        return note ? { revoked, note } : { revoked };
      },
      start() {
        wanted = true;
        if (!ws && !retry) open();
      },
      stop: stopLive,
      recheck,
      topic: (t) => (ENTITY.test(t) ? null : 'Home Assistant rules listen to one entity, named like binary_sensor.front_door.'),
      worker,
      confirm,
      routes,
    };
  };
}
