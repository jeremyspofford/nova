// Home Assistant as a connector (M5 plan §2). Set up with the address of the person's Home Assistant
// and a long-lived access token, which goes into the vault. Through Home Assistant's own APIs:
//  - reading entity states (REST, tier 0: Nova just looks);
//  - calling a service (REST): changing devices or home state, so tier 2, asked first
//    (NOVA-SPEC §6), and tier 3 for domains the person marks (locks and alarms to start with). It
//    runs as a Work Ledger task for this connector's worker, so the ledger's approval gate holds it,
//    and Nova reads the entity back from Home Assistant itself as the evidence;
//  - state changes (WebSocket, subscribe_events state_changed), which become event trigger records
//    for the entities a rule listens to. A dropped socket is reopened with growing pauses.
// Egress is local for an address on this network or the mesh, remote otherwise; local-only never
// contacts a remote Home Assistant. Disconnecting deletes the token from Home Assistant itself
// (auth/delete_refresh_token, named by the token's own issuer) and then from the vault.
import { CoreError } from '../errors.ts';
import type { Brief, Evidence } from '../envelope.ts';
import type { Egress } from '../workers.ts';
import type { Route } from '../api.ts';
import type { Connector, ConnectorContext, ConnectorStatus } from './index.ts';
import { addressEgress } from './index.ts';

export const HA_ID = 'home-assistant';
const TOKEN = 'HA_TOKEN';
// Locks and alarms always need an explicit confirmation, until the person says otherwise.
export const DEFAULT_TIER3 = ['lock', 'alarm_control_panel'];
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
    { kind: 'device' as const, target: 'devices Home Assistant controls', why: 'to change them, only after you say yes each time' },
  ],
  secrets: [TOKEN],
  config_schema: { type: 'object', properties: { url: { type: 'string' }, tier3_domains: { type: 'array', items: { type: 'string' } } } },
  setup_flow: { fields: ['url', 'token'] },
  health_check: { kind: 'http', path: '/api/' },
  nova_compat: '>=0.1.0 <1.0.0',
  on_remove: { delete: ['config.json'], keep: [], export: [] },
};

interface State { entity_id: string; state: string; attributes?: Record<string, unknown>; last_changed?: string; last_updated?: string }
interface Config { url?: string; since?: string; name?: string | null; broken?: boolean; tier3_domains?: string[] }

export interface HomeAssistantOptions {
  // Pauses between reconnects: the first, and the most it grows to.
  reconnectMs?: { first: number; max: number };
  fetch?: typeof fetch;
  timeoutMs?: number;
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
  return (ctx: ConnectorContext): Connector => {
    const f = o.fetch ?? globalThis.fetch;
    const timeoutMs = o.timeoutMs ?? 15_000;
    const backoff = o.reconnectMs ?? { first: 1000, max: 60_000 };
    const cfg = () => ctx.config.get() as Config;
    const token = () => ctx.secrets.get(TOKEN);
    const egress = (): Egress => (cfg().url ? addressEgress(cfg().url!, ctx.meshHosts()) : 'local');
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
    async function api<T>(path: string, init: { method?: string; body?: unknown; base?: string; token?: string } = {}): Promise<T> {
      const base = init.base ?? cfg().url;
      const t = init.token ?? token();
      if (!base || !t) throw new CoreError('conflict', 'Home Assistant isn’t connected. Connect it in Settings, under Connections.');
      if (!init.base && cfg().broken) throw new CoreError('conflict', 'Home Assistant needs reconnecting: it no longer accepts Nova’s token.');
      const e = init.base ? addressEgress(base, ctx.meshHosts()) : egress();
      if (!ctx.permits(e)) throw new CoreError('forbidden', `Your Home Assistant is outside your network (${new URL(base).host}), and Nova is set to local-only, so Nova doesn’t contact it.`);
      let res: Response;
      try {
        res = await f(`${base}${path}`, {
          method: init.method ?? 'GET',
          headers: { authorization: `Bearer ${t}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
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
    const tier3 = () => cfg().tier3_domains ?? DEFAULT_TIER3;
    const tierFor = (domain: string): 2 | 3 => (tier3().includes(domain) ? 3 : 2);

    // ---- the worker: one service call per task, after the ledger's approval ----------------
    const worker = {
      id: HA_ID,
      name: 'Home Assistant',
      about: 'Changes things in your home through Home Assistant, after your OK.',
      get egress() { return egress(); },
      evidence: ['confirmation' as const],
      health: () => (cfg().broken ? { ok: false, detail: 'Home Assistant needs reconnecting: it no longer accepts Nova’s token.' } : { ok: true, detail: cfg().url ? `Connected to ${host()}.` : 'Not connected.' }),
      async run(brief: Brief, signal: AbortSignal) {
        const started = Date.now();
        const i = (brief.inputs ?? {}) as { domain?: string; service?: string; data?: Record<string, unknown>; expect?: string };
        const report = (status: 'done' | 'blocked' | 'failed', summary: string, evidence: Evidence[] = [], blockers: string[] = []) => ({
          envelope: '1', task_id: brief.task_id, status, summary, evidence, artifacts: [], blockers, usage: { duration_ms: Date.now() - started }, follow_up_suggestions: [],
        });
        if (!i.domain || !DOMAIN.test(i.domain) || !i.service || !DOMAIN.test(i.service)) return report('failed', 'The task doesn’t name a Home Assistant service.');
        // The tier comes from the domain, whatever the task asked for: a call can't lower its own gate.
        const need = tierFor(i.domain);
        if (brief.approval_tier < need) return report('blocked', `This changes your home, so it needs your OK first (tier ${need}).`, [], [`Tier ${need} is needed for ${i.domain}.`]);
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
        summary: 'Home Assistant: call a service. It changes your home, so it becomes a task that waits for your OK (tier 2; tier 3 for the domains you marked).',
        body: '{entity_id?, data?}',
        handle: ({ params, body }) => {
          const { domain, service } = params as { domain: string; service: string };
          if (!DOMAIN.test(domain) || !DOMAIN.test(service)) throw new CoreError('validation', 'A service is named by its domain and service, like light and turn_on.');
          if (!cfg().url || !token()) throw new CoreError('conflict', 'Home Assistant isn’t connected. Connect it in Settings, under Connections.');
          const entity = body.entity_id;
          if (entity !== undefined && (typeof entity !== 'string' || !ENTITY.test(entity))) throw new CoreError('validation', 'An entity is named like light.kitchen.');
          const data = { ...(typeof body.data === 'object' && body.data && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {}), ...(entity ? { entity_id: entity } : {}) };
          const tier = tierFor(domain);
          const expect = entity && EXPECT[service] ? EXPECT[service] : undefined;
          return ctx.delegate({
            title: `${service.replace(/_/g, ' ')}${entity ? ` ${entity}` : ''} (Home Assistant)`,
            goal: `Home Assistant runs ${domain}.${service}${entity ? ` on ${entity}` : ''}${expect ? `, and ${entity} shows ${expect}` : ''}.`,
            approval_tier: tier,
            evidence_required: [{ kind: 'confirmation' }],
            inputs: { domain, service, data, ...(expect ? { expect } : {}) },
          });
        },
      },
      {
        method: 'GET', path: '/settings', summary: 'Home Assistant: which domains need an explicit confirmation every time (tier 3).',
        handle: () => ({ tier3_domains: tier3(), default: DEFAULT_TIER3 }),
      },
      {
        method: 'PUT', path: '/settings', summary: 'Mark which domains need an explicit confirmation every time. Taking a domain off the list loosens a gate, so it needs {confirm: true}.',
        body: '{tier3_domains: [], confirm?}',
        handle: ({ body }) => {
          const list = body.tier3_domains;
          if (!Array.isArray(list) || !list.every((d) => typeof d === 'string' && DOMAIN.test(d))) throw new CoreError('validation', 'tier3_domains is a list of domains, like lock.');
          const loosened = tier3().filter((d) => !list.includes(d));
          if (loosened.length && body.confirm !== true) throw new CoreError('validation', `Taking ${loosened.join(', ')} off the list means Nova asks just once, not with a confirmation every time. Send confirm: true to do that.`);
          if (!cfg().url) throw new CoreError('conflict', 'Connect Home Assistant first.');
          ctx.config.set({ tier3_domains: [...new Set(list as string[])] });
          return { tier3_domains: tier3(), default: DEFAULT_TIER3 };
        },
      },
    ];

    return {
      manifest: HA_MANIFEST,
      summary: 'Your smart home: Nova can see what your devices are doing, hear when they change, and change them when you say yes.',
      can: [
        'See the state of your lights, sensors, locks and other devices.',
        'Notice when something changes, for the rules you set up.',
        'Turn things on and off, after asking you first, every time.',
      ],
      never: ['Change anything without your OK.', 'Unlock or disarm without an explicit confirmation.'],
      setup: {
        kind: 'form',
        fields: [
          { key: 'url', label: 'Home Assistant address', placeholder: 'http://homeassistant.local:8123' },
          { key: 'token', label: 'Long-lived access token', secret: true, hint: 'Make one in Home Assistant: your profile, Security, Long-lived access tokens.' },
        ],
      },
      egress,
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
        const t = String(input.token ?? '').trim();
        if (!t) throw new CoreError('validation', 'Paste a long-lived access token from your Home Assistant profile.');
        const hello = await api<{ message?: string }>('/api/', { base, token: t });
        if (!hello?.message) throw new CoreError('validation', 'That address answers, but not like Home Assistant does.');
        const info = await api<{ location_name?: string; version?: string }>('/api/config', { base, token: t }).catch(() => ({} as { location_name?: string }));
        // Connecting again (a new token): the old socket goes; the registry starts a new one.
        stopLive();
        ctx.secrets.put(TOKEN, t);
        const keep = cfg().url === base ? cfg().tier3_domains : undefined;
        ctx.config.clear();
        ctx.config.set({ url: base, since: ctx.now().toISOString(), name: info.location_name ?? null, ...(keep ? { tier3_domains: keep } : {}) });
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
          else if (!ctx.permits(addressEgress(base, ctx.meshHosts()))) note = 'Nova is local-only and your Home Assistant is outside your network, so Nova didn’t contact it: delete the token in your Home Assistant profile.';
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
      topic: (t) => (ENTITY.test(t) ? null : 'Home Assistant rules listen to one entity, named like binary_sensor.front_door.'),
      worker,
      confirm,
      routes,
    };
  };
}
