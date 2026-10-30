// Nova's core (ADR-1): one deployable, internally modular. This is the composition root and the
// only module that knows about all the others; each module gets what it needs passed in, and
// nothing outside src/core imports anything but this file.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { CoreError } from './errors.ts';
import { Db } from './db.ts';
import { Log } from './log.ts';
import { Profile, SECTIONS, type Section } from './profile.ts';
import { Workspace, workspaceWorker } from './workspace.ts';
import { Verifier, type Checker } from './verify.ts';
import { Ledger, STATES, type LanedWorker, type State, type TaskInput } from './ledger.ts';
import { Setup } from './setup.ts';
import { Extensions } from './extensions.ts';
import { Design, type Scope } from './design.ts';
import { Decisions, RulesProvider, Templates } from './decide.ts';
import { Triggers, type Policy, type RuleInput } from './triggers.ts';
import { Memory, KINDS as MEMORY_KINDS, type Kind as MemoryKind, type MemoryInput, type UserState } from './memory.ts';
import { Receipts } from './receipts.ts';
import { Backups } from './backups.ts';
import { CHARTER, identityOf, render } from './identity.ts';
import { info, permits, stricter, type Egress } from './workers.ts';
import { createApi, Raw, Reply, type Route, type Who } from './api.ts';
import { loadIdentity, replaceIdentityKeys } from './mesh/identity.ts';
import { Devices, ONLINE_WINDOW_MS, SESSION_TTL_MS, type Device } from './mesh/devices.ts';
import { Enrollment } from './mesh/enroll.ts';
import { Access, allows, sessionCookie, type Listener, type MeshListenerInfo, type Principal } from './mesh/access.ts';
import { SyncLog } from './mesh/sync.ts';
import { MeshRole, nodeRole } from './mesh/promote.ts';
import { Spokes } from './mesh/spokes.ts';
import { agentTar, joinScript } from './mesh/agent.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

export { render as renderIdentity } from './identity.ts';
export { permits } from './workers.ts';
export { ENVELOPE_VERSION } from './envelope.ts';
export { TERMINAL } from './ledger.ts';
export type { Brief, Evidence, Report } from './envelope.ts';
export type { Worker, Egress } from './workers.ts';
export type { Checker } from './verify.ts';
export type { Lane, LanedWorker, Task } from './ledger.ts';
// The design-system schema and its checks, for the token lint and the package check (scripts/).
// The mesh's wire format and the limiter, shared with the device agent (src/device) and sync.
export * from './mesh/wire.ts';
export { SlidingWindowLimiter } from './mesh/limiter.ts';
export { KINDS as DEVICE_KINDS, ROLE_OF, SESSION_TTL_MS } from './mesh/devices.ts';
export { JOIN_REVEAL_TTL_MS, JOIN_APPROVE_TTL_MS } from './mesh/enroll.ts';
export { PUBLIC_PATHS, SESSION_COOKIE, allows, isConsole, loopbackAddress, loopbackHost } from './mesh/access.ts';
export { DEVICE_CONFIG_SECTIONS, INBOX_KINDS, MAX_BATCH as INBOX_MAX_BATCH } from './mesh/spokes.ts';
export { RUNTIME_FILES, agentFiles, agentTar, joinScript, tar } from './mesh/agent.ts';
export type { Device, Kind as DeviceKind, Role as DeviceRole, MeshState } from './mesh/devices.ts';
export type { JoinRequest, Pairing } from './mesh/enroll.ts';
export type { Listener, MeshListenerInfo, Principal, Scope } from './mesh/access.ts';
export type { MeshIdentity } from './mesh/identity.ts';
// Hub, standby and sync (M4c): the role file a standby is enrolled with, and this node's keys.
export { loadIdentity } from './mesh/identity.ts';
export { ROLE_FILE, readRole, writeRole } from './mesh/replica.ts';
export type { RoleFile } from './mesh/replica.ts';
export { REPLICATED, NOT_JOURNALLED } from './mesh/sync.ts';
export type { Who } from './api.ts';
export { TOKENS, TOKEN_NAMES, cssVar, contrast, validatePackage, generateCss, BUILTIN_DIR, DEFAULT_DESIGN_SYSTEM } from './design.ts';

export interface CoreOptions {
  home: string;
  version: string;
  trustedOrigin: (host: string) => boolean;
  detectedTimezone?: string;
  // Where the chat model sends conversations, so setup can say so truthfully.
  chat?: { program: string; egress: Egress };
  // Workers from outside the core (Era 2's chat-run), run through the same ledger and gates.
  workers?: LanedWorker[];
  // Confirmation checkers by system, for systems Nova can read itself ("nova-sessions").
  confirmations?: Record<string, Checker>;
  // Where the built-in design systems live; defaults to design-systems/ in the repo.
  designSystems?: string;
  // The mesh listener, when there is one: where devices reach Nova, and what carries it.
  mesh?: MeshListenerInfo | null;
  now?: () => Date;
}

export type Core = ReturnType<typeof createCore>;

export function createCore(o: CoreOptions) {
  const started = Date.now();
  const now = o.now ?? (() => new Date());
  const db = new Db(join(o.home, 'nova.db'));
  const migration = db.migrate({ backupDir: join(o.home, 'backups'), now });
  const log = new Log(db, join(o.home, 'logs', 'nova.log'), now);
  // Hub or standby, decided before anything writes: a standby copies the hub's sync log instead
  // of recording its own writes (mesh/promote.ts).
  const place = nodeRole(db, o.home);
  let meshRole: MeshRole | null = null;
  log.local = () => (meshRole ? meshRole.role() : place.role) !== 'hub';
  const profile = new Profile(db, now);
  const workspace = new Workspace(join(o.home, 'workspace'));
  const verifier = new Verifier(workspace, now);
  for (const [system, check] of Object.entries(o.confirmations ?? {})) verifier.registerConfirmation(system, check);
  const rules = new RulesProvider();
  const templates = new Templates({ db, verifier, rules, now });
  const ledger = new Ledger({ db, log, verifier, workers: [workspaceWorker(workspace, join(o.home, 'workers', 'workspace')), templates.worker, ...(o.workers ?? [])], defaultPrivacy: () => profile.privacyDefault(), now });
  templates.bind(ledger);
  // Remote decision providers (JevProvider) are registered only once configured; local-only skips them anyway.
  const decisions = new Decisions({ templates, providers: [rules], privacy: () => profile.privacyDefault(), log });
  const triggers = new Triggers({
    db, log, ledger, templates, rules, decisions, now,
    policy: () => profile.section('policy') as Policy,
    timezone: () => profile.get<string>('user', 'timezone') ?? o.detectedTimezone ?? 'UTC',
  });
  const setup = new Setup({ profile, ledger, now, ...(o.detectedTimezone ? { detectedTimezone: o.detectedTimezone } : {}), ...(o.chat ? { chat: o.chat } : {}) });
  const extensions = new Extensions({ db, home: o.home, novaVersion: o.version, now });
  const design = new Design({ extensions, profile, ...(o.designSystems ? { dir: o.designSystems } : {}) });
  const backups = new Backups({ dir: join(o.home, 'backups'), log });
  const memory = new Memory({ db, home: o.home, now, afterForget: (ids, records) => backups.forget('memory', ids, records.map((r) => r.content)) });
  const receipts = new Receipts({ db, log, now });
  for (const p of design.ensureBuiltins()) log.problem('design', p);
  // The device mesh: this node's keys, the registry, enrollment, and who may do what.
  const meshInfo = o.mesh ?? null;
  const publicUrl = () => meshInfo?.publicUrl ?? null;
  const meshIdentity = loadIdentity(o.home, { now, warn: (m) => log.problem('mesh', m), adopt: place.file?.device_id ?? null });
  const devices = new Devices({ db, log, identity: meshIdentity, now, publicUrl });
  if (place.role === 'hub') devices.ensureHub();
  const enroll = new Enrollment({ db, log, devices, identity: meshIdentity, now, publicUrl });
  const access = new Access({ devices, mesh: meshInfo });
  // Hub, standby and sync (M4 plan §3).
  const sync = new SyncLog({ db, log, home: o.home, node: meshIdentity.id, now });
  memory.onForgetDone((records) => sync.forgotten(records.map((r) => r.content)));
  meshRole = new MeshRole({
    db, log, home: o.home, now, publicUrl, identity: meshIdentity, devices, access, sync, ledger, verifier, file: place.file,
    becameHub: () => startHub(), becameStandby: () => stopHub(),
    forgotten: (rows) => memory.forgottenElsewhere(rows),
    failoverAfterS: () => { const v = profile.get<number>('mesh', 'auto_failover_after_s'); return typeof v === 'number' && v > 0 ? v : null; },
  });
  const role = meshRole;
  // Computers' device agents (M4b): heartbeats, the inbox their queues flush into, the runtime.
  const configRow = (section: string, key: string) => db.get<{ value: string; updated_at: string }>('SELECT value, updated_at FROM profile WHERE section = ? AND key = ?', section, key);
  // A setting's version: its time and value together, so two changes in one millisecond differ.
  const configVersion = (r: { value: string; updated_at: string }) => createHash('sha256').update(`${r.updated_at}\0${r.value}`).digest('hex').slice(0, 16);
  const spokes = new Spokes({
    db, log, devices, identity: meshIdentity, now, version: o.version,
    effects: {
      task: (d, key, body) => {
        const task = ledger.create({ ...(body as unknown as TaskInput), origin: { kind: 'device', ref: d.id }, idempotency_key: `device:${d.id}:${key}` });
        triggers.reactive(task, `device:${d.id}`);
        return task;
      },
      memory: (d, body) => memory.remember({ ...(body as unknown as MemoryInput), kind: (body.kind ?? 'fact') as MemoryKind, recorded_by: `device:${d.id}` }),
      config: {
        read: (section, key) => { const r = configRow(section, key); return r ? { value: JSON.parse(r.value), version: configVersion(r) } : null; },
        write: (section, key, value) => { profile.set(section as Section, key, value, 'settings'); return configVersion(configRow(section, key)!); },
      },
    },
  });

  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  ledger.on('task', (t) => bus.emit('event', 'task', { id: t.id, title: t.title, state: t.state, reason: t.reason, user_visibility: t.user_visibility }));
  log.on('problem', (p) => bus.emit('event', 'problem', p));
  setup.on('change', (v) => bus.emit('event', 'setup', { step: v.step, done: v.done }));
  profile.on('change', (c) => bus.emit('event', 'profile', c));
  // Loosening the privacy setting releases work that was waiting on local capacity, if its worker
  // is now allowed under the stricter of the task's own mode and the new setting.
  profile.on('change', ({ section, key }) => {
    if (section !== 'privacy' || key !== 'default') return;
    for (const t of ledger.list({ state: 'waiting', limit: 500 })) {
      const w = ledger.workers.get(t.owner);
      if (!w || !t.reason?.includes('local capacity')) continue;
      if (permits(stricter(t.privacy_mode, profile.privacyDefault()), w.egress)) ledger.retry(t.id, 'Your privacy setting changed, so this can run now.');
    }
  });
  extensions.on('change', (c) => bus.emit('event', 'extension', c));
  // The UI swaps its design-system stylesheet when this arrives: no reload, no restart.
  design.on('change', (c) => bus.emit('event', 'design-system', c));
  triggers.on('trigger', (t) => bus.emit('event', 'trigger', { trigger_id: t.trigger_id, rule_id: t.rule_id, class: t.class, decision: t.triage.decision, reason: t.triage.reason, ledger_task_id: t.ledger_task_id, message_id: t.message_id }));
  triggers.on('message', (m) => bus.emit('event', 'message', m));
  devices.on('change', (c: { action: string; device: Device }) => bus.emit('event', 'device', { action: c.action, device: deviceView(c.device) }));
  spokes.on('change', (d: Device) => bus.emit('event', 'device', { action: 'heartbeat', device: deviceView(d) }));
  spokes.on('event', (e) => bus.emit('event', 'device_event', e));
  enroll.on('change', (r) => bus.emit('event', 'join_request', r));
  role.on('change', (s) => bus.emit('event', 'mesh', s));
  role.on('applied', (a) => bus.emit('event', 'sync', a));
  const stream = {
    on(listener: (event: string, data: unknown) => void) {
      const fn = (event: string, data: unknown) => listener(event, data);
      bus.on('event', fn);
      return () => bus.off('event', fn);
    },
  };

  // A device as the API shows it. Online: the hub always; others when heard from lately or holding
  // a stream open. `this`: the device asking (the hub, for the console).
  function deviceView(d: Device, p?: Principal) {
    const { public_key: _pk, x25519_public_key: _xk, ...rest } = d;
    const recent = d.last_seen ? now().getTime() - Date.parse(d.last_seen) < ONLINE_WINDOW_MS : false;
    const agent = d.kind === 'computer' && d.role !== 'hub' ? spokes.agent(d.id) : null;
    return {
      ...rest,
      ...(agent ? { agent } : {}),
      online: d.trust === 'trusted' && (d.role === 'hub' || access.isLive(d.id) || recent),
      this: p ? (p.kind === 'device' ? p.device.id === d.id : p.kind === 'console' && d.id === meshIdentity.id) : false,
    };
  }
  const by = (w: Who) => (w.principal.kind === 'device' ? `device:${w.principal.device.id}` : w.principal.kind);
  // Joining and sessions happen only over the mesh listener, the transport §0 accepts.
  const meshOnly = (w: Who) => {
    if (w.listener !== 'mesh') throw new CoreError('forbidden', meshInfo ? `Devices join and sign in at ${meshInfo.publicUrl}, not at this address.` : 'Other devices can’t reach this Nova: it has no mesh address.');
  };
  // The computer asking, for routes only a device agent calls.
  const me = (w: Who): Device => {
    if (w.principal.kind !== 'device') throw new CoreError('forbidden', 'Only a paired computer’s device agent sends this.');
    return w.principal.device;
  };

  function health() {
    let database: { ok: boolean; detail: string };
    try {
      db.get('SELECT 1');
      database = { ok: true, detail: `Schema version ${db.version()}.` };
    } catch (e) {
      database = { ok: false, detail: `The database isn't answering: ${(e as Error).message}` };
    }
    const workers = [...ledger.workers.values()].map(info);
    const checks = {
      database,
      workers: { ok: workers.every((w) => w.health.ok), detail: workers.filter((w) => !w.health.ok).map((w) => w.health.detail).join(' ') || `${workers.length} ready.`, workers },
      ledger: { ok: true, counts: ledger.counts() },
      extensions: { ok: true, counts: extensions.counts() },
      design: { ok: true, active: design.active().id },
      triggers: { ok: true, counts: triggers.counts() },
      problems: { ok: true, open: log.problems({ open: true }).length },
      memory: { ok: true, counts: memory.counts() },
      receipts: { ok: true, counts: receipts.counts() },
      mesh: { ok: true, ...meshHealth() },
    };
    return { ok: Object.values(checks).every((c) => c.ok), version: o.version, uptime_s: Math.round((Date.now() - started) / 1000), setup: { done: setup.view().done }, checks };
  }

  function meshHealth() {
    const s = role.status();
    return { role: s.role, epoch: s.epoch, listening: !!meshInfo, counts: devices.counts(), standby: s.standby, replica: s.replica };
  }

  // The one mesh setting: automatic failover, off unless the person sets a number of seconds.
  function meshSetting(key: string, value: unknown) {
    if (key !== 'auto_failover_after_s') throw new CoreError('validation', 'The mesh section has one setting: auto_failover_after_s.');
    if (value !== null && !(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 86_400)) {
      throw new CoreError('validation', 'auto_failover_after_s is the number of seconds the hub must be unreachable before the standby takes over (1 to 86400), or null to leave it off.');
    }
  }

  const header = (h: IncomingHttpHeaders, name: string) => { const v = h[name]; return Array.isArray(v) ? v[0] : v; };
  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new CoreError('validation', `${what} is required.`);
    return v;
  };

  const routes: Route[] = [
    { method: 'GET', path: '/health', summary: 'Whether each part of the core is working, in plain words.', handle: () => health() },
    { method: 'GET', path: '/identity', summary: 'Who Nova is for this person: name, tuning, and the fixed charter.', handle: () => ({ identity: identityOf(profile), charter: CHARTER, rendered: render(identityOf(profile)) }) },
    { method: 'GET', path: '/profile', summary: 'The whole profile (no secrets; those are referenced by name only).', handle: () => profile.all() },
    {
      method: 'PUT', path: '/profile/{section}/{key}', summary: 'Change one profile record, as a settings screen would.', body: '{value}',
      handle: ({ params, body }) => {
        const section = params.section as Section;
        if (!SECTIONS.includes(section) || section === 'setup') throw new CoreError('validation', `There is no profile section called "${params.section}".`);
        if (section === 'mesh') meshSetting(params.key!, body.value);
        if (section === 'appearance') {
          if (params.key !== 'mode') throw new CoreError('validation', 'Choose a design system with POST /api/v1/design-systems/{id}/apply, so it is checked and can be rolled back.');
          design.setMode(body.value);
          return profile.section(section);
        }
        profile.set(section, str(params.key, 'key'), body.value, 'settings');
        return profile.section(section);
      },
    },
    { method: 'GET', path: '/setup', summary: 'The setup conversation so far, and the question Nova is asking.', handle: () => setup.view() },
    { method: 'POST', path: '/setup/messages', summary: 'Answer Nova in the setup conversation.', body: '{text}', handle: ({ body }) => setup.answer(str(body.text, 'text')) },
    {
      method: 'GET', path: '/tasks', summary: 'Work Ledger tasks, newest first. Filter with ?state=.',
      handle: ({ query }) => {
        const state = query.get('state');
        if (state && !STATES.includes(state as State)) throw new CoreError('validation', `state must be one of ${STATES.join(', ')}.`);
        const limit = Number(query.get('limit') ?? 50);
        if (!Number.isInteger(limit)) throw new CoreError('validation', 'limit must be a whole number.');
        return ledger.list({ ...(state ? { state: state as State } : {}), limit });
      },
    },
    {
      method: 'POST', path: '/tasks', status: 201, summary: 'Delegate a task. It must name a worker and the evidence that will prove it done.',
      body: '{title, owner, goal, evidence_required[], privacy_mode?, approval_tier?, inputs?, context_refs?, constraints?, idempotency_key?}',
      handle: ({ body }) => {
        const task = ledger.create({ ...(body as unknown as TaskInput), origin: { kind: 'user' } });
        triggers.reactive(task);
        return task;
      },
    },
    { method: 'GET', path: '/tasks/{id}', summary: 'One task, with its brief, report and verification.', handle: ({ params }) => ledger.get(params.id!) },
    { method: 'GET', path: '/tasks/{id}/events', summary: 'Everything that happened to a task, in order.', handle: ({ params }) => ledger.events(params.id!) },
    { method: 'POST', path: '/tasks/{id}/approve', summary: 'Give the OK a tier-2 or tier-3 task is waiting for. Tier 3 needs {confirm: true}.', body: '{confirm?}', handle: ({ params, body }) => ledger.approve(params.id!, { confirm: body.confirm === true }) },
    { method: 'POST', path: '/tasks/{id}/retry', summary: 'Try a blocked or partly done task again.', handle: ({ params }) => ledger.retry(params.id!) },
    { method: 'POST', path: '/tasks/{id}/cancel', summary: 'Stop a task. It ends cancelled, with the reason.', body: '{reason?}', handle: ({ params, body }) => ledger.cancel(params.id!, typeof body.reason === 'string' && body.reason.trim() ? body.reason : 'Cancelled by you.') },
    { method: 'GET', path: '/workers', summary: 'Who can do delegated work, where their data goes, and whether they are healthy.', handle: () => [...ledger.workers.values()].map(info) },
    { method: 'GET', path: '/extensions', summary: 'Installed extensions and their state.', handle: () => extensions.list() },
    { method: 'POST', path: '/extensions', status: 201, summary: 'Install an extension from its manifest. It starts disabled; the reply lists what it asks for.', body: '{manifest}', handle: ({ body }) => extensions.install(body.manifest) },
    { method: 'POST', path: '/extensions/{id}/enable', summary: 'Enable an extension. Needs {approved: true} when it asks for permissions.', body: '{approved?}', handle: ({ params, body }) => extensions.enable(params.id!, { approved: body.approved === true }) },
    { method: 'POST', path: '/extensions/{id}/disable', summary: 'Disable an extension, keeping it installed.', handle: ({ params }) => extensions.disable(params.id!) },
    { method: 'DELETE', path: '/extensions/{id}', summary: 'Remove an extension, following its on_remove promise; nothing of it stays behind.', handle: ({ params }) => extensions.remove(params.id!) },
    { method: 'GET', path: '/design-systems', summary: 'Installed design systems, each with whether it is valid and, if not, its problems in plain words.', handle: () => design.list() },
    { method: 'GET', path: '/design-systems/schema', summary: 'The token schema every design system implements: names, CSS variables, value rules, contrast pairs, content rules.', handle: () => design.schema() },
    { method: 'GET', path: '/design-systems/active', summary: 'The design system this device shows (?device=), and whether that is its own choice, the person’s, or the default.', handle: ({ query }) => design.active(query.get('device')) },
    {
      method: 'POST', path: '/design-systems', status: 201, summary: 'Install a design system from its manifest, through the extension host. It is validated before it can be applied.', body: '{manifest}',
      handle: ({ body }) => design.install(body.manifest),
    },
    {
      method: 'POST', path: '/design-systems/rollback', summary: 'Go back to the design system shown before the last change, for the person or one device.', body: '{scope: user | device, device_id?}',
      handle: ({ body }) => design.rollback({ scope: body.scope as Scope, device_id: typeof body.device_id === 'string' ? body.device_id : null }),
    },
    { method: 'GET', path: '/design-systems/{id}', summary: 'One design system, with its manifest and validation.', handle: ({ params }) => design.get(params.id!) },
    { method: 'POST', path: '/design-systems/{id}/validate', summary: 'Check a design system against the schema: completeness, value syntax, contrast, reduced motion, content rules, extras.', handle: ({ params }) => design.validate(params.id!) },
    {
      method: 'GET', path: '/design-systems/{id}/preview.css', summary: 'A design system as CSS variables, for a sandboxed preview frame, without applying it. ?mode=light|dark|auto.',
      handle: ({ params, query }) => new Raw('text/css; charset=utf-8', design.previewCss(params.id!, query.get('mode'))),
    },
    {
      method: 'POST', path: '/design-systems/{id}/apply', summary: 'Apply a valid design system for the person (every device) or one device. The previous one is kept for rollback.', body: '{scope: user | device, device_id?}',
      handle: ({ params, body }) => design.apply(params.id!, { scope: body.scope as Scope, device_id: typeof body.device_id === 'string' ? body.device_id : null }),
    },
    { method: 'GET', path: '/triggers/rules', summary: 'Every automation Nova runs: event, heartbeat and proactive rules. Nothing runs that isn’t listed here.', handle: () => triggers.listRules() },
    {
      method: 'POST', path: '/triggers/rules', status: 201, summary: 'Add a rule. For an event rule the reply carries its webhook token, shown this once only.',
      body: '{name, class: proactive|event|heartbeat, hook? (event), cron? (heartbeat), action: {kind: task, task} | {kind: message, text}, dedup_window_s?, cooldown_s?}',
      handle: ({ body }) => {
        const { rule, token } = triggers.createRule(body as unknown as RuleInput, 'person');
        return token ? { rule, token, note: 'Keep this token somewhere safe. Nova keeps only a hash of it and won’t show it again.' } : { rule };
      },
    },
    { method: 'GET', path: '/triggers/rules/{id}', summary: 'One rule, with every change made to it.', handle: ({ params }) => ({ ...triggers.rule(params.id!), changes: triggers.ruleEvents(params.id!) }) },
    { method: 'PUT', path: '/triggers/rules/{id}', summary: 'Change a rule’s name, schedule, action, dedup window or cooldown.', body: '{name?, cron?, action?, dedup_window_s?, cooldown_s?}', handle: ({ params, body }) => triggers.updateRule(params.id!, body) },
    { method: 'POST', path: '/triggers/rules/{id}/pause', summary: 'Pause a rule. Its firings are recorded and dropped until it is resumed.', handle: ({ params }) => triggers.pause(params.id!) },
    { method: 'POST', path: '/triggers/rules/{id}/resume', summary: 'Resume a paused rule. A schedule starts again from now.', handle: ({ params }) => triggers.resume(params.id!) },
    { method: 'POST', path: '/triggers/rules/{id}/fire', summary: 'Run a proactive or heartbeat rule now.', body: '{payload?}', handle: ({ params, body }) => triggers.fireRule(params.id!, body.payload ?? {}) },
    { method: 'DELETE', path: '/triggers/rules/{id}', summary: 'Remove a rule. Its past firings stay in the record.', handle: ({ params }) => { triggers.deleteRule(params.id!); return { ok: true }; } },
    {
      method: 'GET', path: '/triggers', summary: 'Trigger records, newest first: what fired, how it was triaged and why, and what it led to. Filter with ?rule=.',
      handle: ({ query }) => triggers.list({ ...(query.get('rule') ? { rule: query.get('rule')! } : {}) }),
    },
    { method: 'GET', path: '/triggers/{id}', summary: 'One trigger record.', handle: ({ params }) => triggers.get(params.id!) },
    {
      method: 'POST', path: '/hooks/{name}', status: 202, auth: 'hook-token',
      summary: 'Call an event rule’s webhook. Authenticated by the x-nova-hook-token header instead of X-Nova, so automations can call it. The body is kept only as a hash; x-nova-dedup-key is optional.',
      body: 'any JSON object',
      handle: async ({ params, body, headers }) => {
        const t = await triggers.hook(params.name!, header(headers, 'x-nova-hook-token'), body, header(headers, 'x-nova-dedup-key'));
        return { trigger_id: t.trigger_id, decision: t.triage.decision, reason: t.triage.reason };
      },
    },
    {
      method: 'GET', path: '/messages', summary: 'Messages Nova started, newest first. ?state=held for those waiting for quiet hours to end.',
      handle: ({ query }) => triggers.messages(query.get('state') === 'held' ? { state: 'held' } : {}),
    },
    { method: 'POST', path: '/messages/{id}/approve', summary: 'Send a message Nova held because it wasn’t sure; only you can release it.', handle: ({ params }) => triggers.approveMessage(params.id!) },
    { method: 'POST', path: '/messages/{id}/read', summary: 'Mark a message as read.', handle: ({ params }) => triggers.read(params.id!) },
    { method: 'GET', path: '/problems', summary: 'Things that went wrong and matter to the person. ?open=1 for unresolved only.', handle: ({ query }) => log.problems({ open: query.get('open') === '1' }) },
    { method: 'POST', path: '/problems/{id}/resolve', summary: 'Mark a problem as dealt with.', handle: ({ params }) => { log.resolve(Number(params.id)); return { ok: true }; } },
    {
      method: 'GET', path: '/memory', summary: 'Everything Nova remembers, newest first, corrected and expired records included and marked. Filter with ?kind=&scope=&state=.',
      handle: ({ query }) => memory.list({
        ...(query.get('kind') ? { kind: query.get('kind') as MemoryKind } : {}),
        ...(query.get('scope') ? { scope: query.get('scope')! } : {}),
        ...(query.get('state') ? { state: query.get('state') as UserState } : {}),
      }),
    },
    {
      method: 'POST', path: '/memory', status: 201, summary: `Remember something, as the person. kind is one of ${MEMORY_KINDS.join(', ')}.`,
      body: '{kind, content, source?, observed_at?, confidence?, scope?, expires?}',
      handle: ({ body }) => memory.remember({ ...(body as unknown as MemoryInput), recorded_by: 'person' }),
    },
    { method: 'GET', path: '/memory/search', summary: 'Find active memories that share words with ?q=, with the list of what was retrieved. Also ?scope=&limit=.', handle: ({ query }) => memory.search(str(query.get('q'), 'q'), { ...(query.get('scope') ? { scope: query.get('scope')! } : {}), ...(query.get('limit') ? { limit: Number(query.get('limit')) } : {}) }) },
    { method: 'POST', path: '/memory/export', summary: 'Write the active memories as plain files (memory.json and memory.md) and return where they are.', handle: () => memory.export() },
    { method: 'POST', path: '/memory/{id}/correct', summary: 'Correct a memory. The correction supersedes it; the old record is kept, marked corrected.', body: '{content}', handle: ({ params, body }) => memory.correct(params.id!, str(body.content, 'content'), 'person') },
    { method: 'POST', path: '/memory/{id}/confirm', summary: 'Confirm a memory is right.', handle: ({ params }) => memory.confirm(params.id!, 'person') },
    { method: 'DELETE', path: '/memory/{id}', summary: 'Forget a memory for real: it and every correction of it are deleted, leaving only a note that something was forgotten.', handle: ({ params }) => memory.forget(params.id!, 'person') },
    {
      method: 'GET', path: '/receipts', summary: 'What each model call was told and where it went, newest first. ?egress=remote is the egress log; also ?task_id=&session_id=.',
      handle: ({ query }) => receipts.list({
        ...(query.get('task_id') ? { task_id: query.get('task_id')! } : {}),
        ...(query.get('session_id') ? { session_id: query.get('session_id')! } : {}),
        ...(query.get('egress') ? { egress: query.get('egress') as 'local' | 'remote' } : {}),
      }),
    },
    // ---- the device mesh (M4 plan §0–§1) ----
    {
      method: 'GET', path: '/mesh/hello', access: 'public', summary: 'The hub’s fingerprint, epoch, role and public keys. No person data; anyone may ask.',
      handle: () => {
        const s = devices.state();
        const self = devices.find(meshIdentity.id);
        // The hub's signed roster too, so a hub that was away can tell it was replaced (fencing).
        return {
          name: self?.name ?? 'Nova', id: meshIdentity.id, fingerprint: meshIdentity.fingerprint, epoch: s.epoch, role: s.role, public_key: meshIdentity.publicKey, x25519_public_key: meshIdentity.x25519PublicKey,
          ...(s.role === 'hub' ? { roster: devices.roster() } : {}),
        };
      },
    },
    {
      method: 'GET', path: '/mesh/status', access: 'mesh', summary: 'Whether other devices can reach this Nova, where, and who is asking.',
      handle: ({ who }) => {
        const p = who.principal;
        return {
          public_url: publicUrl(), transport: meshInfo?.transport ?? null, fingerprint: meshIdentity.fingerprint, ...meshHealth(),
          you: p.kind === 'device' ? { console: false, device_id: p.device.id, kind: p.device.kind, can_approve: p.device.can_approve } : { console: true, device_id: meshIdentity.id, kind: 'computer', can_approve: true },
        };
      },
    },
    { method: 'GET', path: '/mesh/devices', summary: 'The device registry, the hub first. The device asking is marked `this`.', handle: ({ who }) => devices.list().map((d) => deviceView(d, who.principal)) },
    {
      method: 'PATCH', path: '/mesh/devices/{id}', summary: 'Rename a device, or let it approve new devices (tier 3: needs {confirm: true}, and only an approver may grant it).', body: '{name?, can_approve?, confirm?}',
      handle: ({ params, body, who }) => {
        if (body.can_approve !== undefined && allows('approver', who.principal) !== 'ok') throw new CoreError('forbidden', 'Only the hub’s own screen, or a device you’ve allowed to approve, can change who approves.');
        if (body.name !== undefined) devices.rename(params.id!, body.name);
        if (body.can_approve !== undefined) devices.setCanApprove(params.id!, body.can_approve, body.confirm === true);
        return deviceView(devices.get(params.id!), who.principal);
      },
    },
    {
      method: 'POST', path: '/mesh/devices/{id}/revoke', summary: 'Revoke a device (tier 3: needs {confirm: true}). Its sessions end and its open streams close at once; its key can never sign in or enroll again.', body: '{confirm, reason?}',
      handle: ({ params, body, who }) => deviceView(devices.revoke(params.id!, { confirm: body.confirm === true, reason: body.reason, by: by(who) }), who.principal),
    },
    { method: 'POST', path: '/mesh/pairings', status: 201, access: 'approver', summary: 'Make a pairing code: single use, five minutes. The reply has the QR address, the one-line command and the hub’s fingerprint.', handle: ({ who }) => enroll.createPairing(by(who)) },
    { method: 'GET', path: '/mesh/requests', access: 'approver', summary: 'Devices waiting for your OK, each with the six digits it shows.', handle: () => enroll.requests() },
    {
      method: 'POST', path: '/mesh/requests/{id}/approve', access: 'approver', summary: 'Approve a device (tier 3: needs {confirm: true}) once its digits match. This creates its device record.', body: '{confirm}',
      handle: ({ params, body, who }) => { const r = enroll.approve(params.id!, { confirm: body.confirm === true, by: by(who) }); return { request: r.request, device: deviceView(r.device, who.principal) }; },
    },
    { method: 'POST', path: '/mesh/requests/{id}/deny', access: 'approver', summary: 'Turn a device away.', handle: ({ params, who }) => enroll.deny(params.id!, by(who)) },
    {
      method: 'POST', path: '/mesh/join', status: 201, access: 'public', summary: 'A device asks to join with a code, its public keys, and a commitment to its nonce. A wrong or spent code is a 400 with no detail.',
      body: '{code, public_key, x25519_public_key, x25519_sig, claims: {name, platform, kind, capabilities[], address?}, commitment}',
      handle: ({ body, who }) => { meshOnly(who); enroll.limit('calls', who.address); return enroll.join(body, who.address); },
    },
    {
      method: 'POST', path: '/mesh/join/{id}/reveal', access: 'public', summary: 'The device reveals its nonce, signed over nova-add-device-reveal-v1.<id>.<time>; the reply is the six digits.', body: '{device_nonce, time, signature}',
      handle: ({ params, body, who }) => { meshOnly(who); enroll.limit('calls', who.address); return enroll.reveal(params.id!, body); },
    },
    {
      method: 'GET', path: '/mesh/join/{id}', access: 'public', summary: 'The device polls its request: ?time=&signature= over nova-add-device-status-v1.<id>.<time>. Approved, it gets its device id and the signed roster.',
      handle: ({ params, query, who }) => { meshOnly(who); enroll.limit('polls', who.address); return enroll.status(params.id!, { time: query.get('time'), signature: query.get('signature') }); },
    },
    {
      method: 'POST', path: '/mesh/session', access: 'public', summary: 'A trusted device starts a 12-hour session, signed over nova-session-v1.<device_id>.<time>. {cookie: true} sets an HttpOnly cookie instead of returning a token.',
      body: '{device_id, time, signature, cookie?}',
      handle: ({ body, who }) => {
        meshOnly(who);
        enroll.limit('calls', who.address);
        const s = devices.startSession(body);
        const out = { device_id: s.device.id, kind: s.device.kind, expires_at: s.expires_at };
        if (body.cookie !== true) return { ...out, token: s.token };
        return new Reply(out, { 'set-cookie': sessionCookie(s.token, { secure: publicUrl()?.startsWith('https:') ?? false, maxAgeS: SESSION_TTL_MS / 1000 }) });
      },
    },
    { method: 'GET', path: '/mesh/roster', access: 'mesh', summary: 'Who the hub and the standby are, signed by this node: devices pin both keys from it.', handle: () => devices.roster() },
    // ---- computers' device agents (M4 plan §2) ----
    {
      method: 'GET', path: '/mesh/hello/proof', access: 'public', summary: 'This node signs a device’s ?challenge= over nova-hello-v1.<challenge>.<{id, role, epoch, public_key}>, so a device agent knows it holds a pinned key before signing in.',
      handle: ({ query, who }) => { enroll.limit('polls', who.address); return spokes.proof(query.get('challenge')); },
    },
    {
      method: 'POST', path: '/mesh/devices/me/heartbeat', access: 'device', summary: 'A device agent is alive: last seen now, with its capabilities, versions and whether it is in safe mode. The reply names the runtime this node ships.',
      body: '{capabilities?, version?, runtime_version?, safe_mode?}',
      handle: ({ body, who }) => spokes.heartbeat(me(who), body),
    },
    {
      method: 'POST', path: '/mesh/devices/me/report', access: 'device', summary: 'A device agent reports a problem the person should know about (a runtime update it refused).', body: '{problem: runtime_update_refused | runtime_install_failed, detail?}',
      handle: ({ body, who }) => spokes.report(me(who), body),
    },
    {
      method: 'POST', path: '/mesh/inbox', access: 'device', summary: 'A device agent’s queued items, in order, each taken in exactly once by its key: events, task requests (a task, or a refusal kept with its reason), memory notes (recorded_by device:<id>), config changes (server wins: a stale base_version is rejected).',
      body: '{items: [{key, kind: event | task_request | memory_note | config_change, body, created_at?}]}',
      handle: ({ body, who }) => spokes.inbox(me(who), body),
    },
    { method: 'GET', path: '/mesh/inbox/refusals', summary: 'What devices sent that was refused or rejected, with the reasons, newest first. ?device= for one.', handle: ({ query }) => spokes.refusals(query.get('device') ?? undefined) },
    {
      method: 'GET', path: '/mesh/config/{section}/{key}', access: 'device', summary: 'A setting a device agent may change, with its version, which a change must name as base_version.',
      handle: ({ params }) => {
        const r = configRow(params.section!, params.key!);
        return { section: params.section, key: params.key, value: r ? JSON.parse(r.value) : null, version: r ? configVersion(r) : null };
      },
    },
    { method: 'GET', path: '/mesh/runtime', access: 'device', summary: 'The runtime agent this node ships, {manifest: {version, sha256, files}, signature, signer, files}, signed over nova-runtime-v1.<manifest>.', handle: () => spokes.runtime() },
    ...role.routes(),
  ];

  // Tests drive the heartbeat's clock through the API; this route doesn't exist otherwise.
  if (process.env.NOVA_TEST_CLOCK === '1') {
    routes.push({
      method: 'POST', path: '/triggers/tick', summary: 'Test only: run the heartbeat as if it were the given time.', body: '{now?}',
      handle: ({ body }) => {
        const at = body.now === undefined ? now() : new Date(String(body.now));
        if (Number.isNaN(at.getTime())) throw new CoreError('validation', 'now must be an ISO time.');
        return triggers.tick(at);
      },
    });
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let ticking: Promise<unknown> = Promise.resolve();
  const beat = () => {
    try { enroll.sweep(); } catch (e) { log.problem('mesh', 'Nova couldn’t tidy up old requests to join.', { detail: (e as Error)?.stack ?? String(e) }); }
    ticking = triggers.tick().catch((e) => log.problem('triggers', 'The heartbeat couldn’t check the schedules.', { detail: (e as Error)?.stack ?? String(e) }));
  };
  // The hub's own work: the ledger, recovered, and the heartbeat. A standby runs neither.
  function startHub() {
    const recovered = ledger.recover();
    if (!heartbeat) {
      heartbeat = setInterval(beat, 30_000);
      heartbeat.unref();
      beat();
    }
    return recovered;
  }
  function stopHub() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }
  // On a standby (or a hub that stepped down) every change is refused, saying which node is hub;
  // the only change it takes is becoming the hub.
  const REPLICA_WRITES = new Set(['/api/v1/mesh/promote']);

  // GET /join.sh and GET /device-agent.tar: the one-line command's script, and the agent it unpacks.
  let tarCache: Buffer | null = null;
  function agentDownload(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if ((url.pathname !== '/join.sh' && url.pathname !== '/device-agent.tar') || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const sh = url.pathname === '/join.sh';
    const body = sh ? Buffer.from(joinScript(publicUrl())) : (tarCache ??= agentTar(o.version));
    res.writeHead(200, {
      'content-type': sh ? 'text/x-shellscript; charset=utf-8' : 'application/x-tar', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      ...(sh ? {} : { 'content-disposition': 'attachment; filename="device-agent.tar"' }),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  const api = createApi({
    routes, stream, version: o.version, trustedOrigin: o.trustedOrigin,
    // The approval prompt goes only where it can be answered.
    visible: (event, p) => event !== 'join_request' || allows('approver', p) === 'ok',
    onError: (e) => log.problem('api', 'Something went wrong inside Nova while answering a request.', { detail: (e as Error)?.stack ?? String(e) }),
  });

  return {
    db, log, profile, ledger, setup, extensions, design, workspace, migration, routes, templates, decisions, triggers, memory, receipts, backups,
    health,
    openapi: api.doc,
    identity: () => identityOf(profile),
    persona: () => render(identityOf(profile)),
    mesh: { identity: meshIdentity, devices, enroll, access, spokes, info: meshInfo, role, sync },
    // Who is asking, for a request outside /api/v1, or null once a refusal was sent (mesh/access.ts).
    gate: (req: IncomingMessage, res: ServerResponse, url: URL, listener: Listener) => {
      const p = access.gate(req, res, url, listener);
      const replica = p && req.method !== 'GET' && req.method !== 'HEAD' && !REPLICA_WRITES.has(url.pathname) ? role.replica() : null;
      if (!replica) return p;
      res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: replica.reason, replica: true }));
      return null;
    },
    // The core's routes, for the principal the gate found.
    // Also the device agent's installer and archive (public; mesh/access.ts PUBLIC_PATHS).
    handle: async (req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal, listener: Listener) =>
      agentDownload(req, res, url) || api.handle(req, res, url, { principal, listener, address: access.address(req, listener) }),
    // A hub recovers the ledger, then starts the heartbeat: once now (to catch up), then every
    // 30 s. A standby starts copying the hub instead, and runs nothing else.
    start() {
      const recovered = role.role() === 'hub' ? startHub() : { requeued: [], reverified: [] };
      role.start();
      return recovered;
    },
    // Waits briefly for running work; anything still running is requeued on the next start.
    async close() {
      stopHub();
      await role.close();
      await Promise.race([ticking.then(() => ledger.idle()), new Promise((r) => setTimeout(r, 2000).unref())]);
      db.close();
    },
  };
}

// Replaces the hub's keys after they were exposed (the README's “If the hub’s keys were exposed”):
// new keys under the same id, a higher epoch, and the computers and standby that pinned the old key
// revoked, to be added again. Run with Nova stopped (scripts/rotate-hub-keys.js).
export async function rotateHubKeys(home: string, o: { now?: () => Date } = {}) {
  // A mistyped home must not become a new, empty one.
  if (!existsSync(join(home, 'mesh', 'identity.json'))) throw new CoreError('not_found', `${home} has no keys to replace (no mesh/identity.json). Is that Nova’s home?`);
  const open =() => createCore({ home, version: 'rotate', trustedOrigin: () => false, ...(o.now ? { now: o.now } : {}) });
  const probe = open();
  const hub = probe.mesh.role.role() === 'hub';
  await probe.close();
  if (!hub) throw new CoreError('conflict', 'This node is a standby, not the hub. Enroll it again with a new home instead of replacing its keys.');
  replaceIdentityKeys(home, o);
  const core = open();
  try {
    const r = core.mesh.devices.rekeyHub('console');
    return { epoch: r.epoch, fingerprint: core.mesh.identity.fingerprint, revoked: r.revoked.map((d) => ({ id: d.id, name: d.name, kind: d.kind })) };
  } finally {
    await core.close();
  }
}
