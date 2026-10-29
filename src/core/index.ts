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
import { Decisions, RulesProvider, Templates } from './decide.ts';
import { Triggers, type Policy, type RuleInput } from './triggers.ts';
import { Memory, KINDS as MEMORY_KINDS, type Kind as MemoryKind, type MemoryInput, type UserState } from './memory.ts';
import { Receipts } from './receipts.ts';
import { Backups } from './backups.ts';
import { CHARTER, identityOf, render } from './identity.ts';
import { info, permits, stricter, type Egress } from './workers.ts';
import { createApi, type Route } from './api.ts';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

export { render as renderIdentity } from './identity.ts';
export { permits } from './workers.ts';
export { ENVELOPE_VERSION } from './envelope.ts';
export { TERMINAL } from './ledger.ts';
export type { Brief, Evidence, Report } from './envelope.ts';
export type { Worker, Egress } from './workers.ts';
export type { Checker } from './verify.ts';
export type { Lane, LanedWorker, Task } from './ledger.ts';

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
  now?: () => Date;
}

export type Core = ReturnType<typeof createCore>;

export function createCore(o: CoreOptions) {
  const started = Date.now();
  const now = o.now ?? (() => new Date());
  const db = new Db(join(o.home, 'nova.db'));
  const migration = db.migrate({ backupDir: join(o.home, 'backups'), now });
  const log = new Log(db, join(o.home, 'logs', 'nova.log'), now);
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
  const backups = new Backups({ dir: join(o.home, 'backups'), log });
  const memory = new Memory({ db, home: o.home, now, afterForget: (ids) => backups.forget('memory', ids) });
  const receipts = new Receipts({ db, log, now });

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
  triggers.on('trigger', (t) => bus.emit('event', 'trigger', { trigger_id: t.trigger_id, rule_id: t.rule_id, class: t.class, decision: t.triage.decision, reason: t.triage.reason, ledger_task_id: t.ledger_task_id, message_id: t.message_id }));
  triggers.on('message', (m) => bus.emit('event', 'message', m));
  const stream = {
    on(listener: (event: string, data: unknown) => void) {
      const fn = (event: string, data: unknown) => listener(event, data);
      bus.on('event', fn);
      return () => bus.off('event', fn);
    },
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
      triggers: { ok: true, counts: triggers.counts() },
      problems: { ok: true, open: log.problems({ open: true }).length },
      memory: { ok: true, counts: memory.counts() },
      receipts: { ok: true, counts: receipts.counts() },
    };
    return { ok: Object.values(checks).every((c) => c.ok), version: o.version, uptime_s: Math.round((Date.now() - started) / 1000), setup: { done: setup.view().done }, checks };
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
    ticking = triggers.tick().catch((e) => log.problem('triggers', 'The heartbeat couldn’t check the schedules.', { detail: (e as Error)?.stack ?? String(e) }));
  };

  const api = createApi({
    routes, stream, version: o.version, trustedOrigin: o.trustedOrigin,
    onError: (e) => log.problem('api', 'Something went wrong inside Nova while answering a request.', { detail: (e as Error)?.stack ?? String(e) }),
  });

  return {
    db, log, profile, ledger, setup, extensions, workspace, migration, routes, templates, decisions, triggers, memory, receipts, backups,
    health,
    openapi: api.doc,
    identity: () => identityOf(profile),
    persona: () => render(identityOf(profile)),
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) => api.handle(req, res, url),
    // Recovers the ledger, then starts the heartbeat: once now (to catch up), then every 30 s.
    start() {
      const recovered = ledger.recover();
      if (!heartbeat) {
        heartbeat = setInterval(beat, 30_000);
        heartbeat.unref();
        beat();
      }
      return recovered;
    },
    // Waits briefly for running work; anything still running is requeued on the next start.
    async close() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      await Promise.race([ticking.then(() => ledger.idle()), new Promise((r) => setTimeout(r, 2000).unref())]);
      db.close();
    },
  };
}
