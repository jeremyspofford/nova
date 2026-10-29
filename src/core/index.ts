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
import { Verifier } from './verify.ts';
import { Ledger, STATES, type State, type TaskInput } from './ledger.ts';
import { Setup } from './setup.ts';
import { Extensions } from './extensions.ts';
import { CHARTER, identityOf, render } from './identity.ts';
import { info } from './workers.ts';
import { createApi, type Route } from './api.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

export { render as renderIdentity } from './identity.ts';

export interface CoreOptions {
  home: string;
  version: string;
  trustedOrigin: (host: string) => boolean;
  detectedTimezone?: string;
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
  const ledger = new Ledger({ db, log, verifier, workers: [workspaceWorker(workspace)], defaultPrivacy: () => profile.privacyDefault(), now });
  const setup = new Setup({ profile, ledger, now, ...(o.detectedTimezone ? { detectedTimezone: o.detectedTimezone } : {}) });
  const extensions = new Extensions({ db, home: o.home, novaVersion: o.version, now });

  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  ledger.on('task', (t) => bus.emit('event', 'task', { id: t.id, title: t.title, state: t.state, reason: t.reason, user_visibility: t.user_visibility }));
  log.on('problem', (p) => bus.emit('event', 'problem', p));
  setup.on('change', (v) => bus.emit('event', 'setup', { step: v.step, done: v.done }));
  profile.on('change', (c) => bus.emit('event', 'profile', c));
  extensions.on('change', (c) => bus.emit('event', 'extension', c));
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
      problems: { ok: true, open: log.problems({ open: true }).length },
    };
    return { ok: Object.values(checks).every((c) => c.ok), version: o.version, uptime_s: Math.round((Date.now() - started) / 1000), setup: { done: setup.view().done }, checks };
  }

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
        return ledger.list({ ...(state ? { state: state as State } : {}), limit: Number(query.get('limit') ?? 50) });
      },
    },
    {
      method: 'POST', path: '/tasks', status: 201, summary: 'Delegate a task. It must name a worker and the evidence that will prove it done.',
      body: '{title, owner, goal, evidence_required[], privacy_mode?, approval_tier?, inputs?, context_refs?, constraints?, idempotency_key?}',
      handle: ({ body }) => ledger.create({ ...(body as unknown as TaskInput), origin: { kind: 'user' } }),
    },
    { method: 'GET', path: '/tasks/{id}', summary: 'One task, with its brief, report and verification.', handle: ({ params }) => ledger.get(params.id!) },
    { method: 'GET', path: '/tasks/{id}/events', summary: 'Everything that happened to a task, in order.', handle: ({ params }) => ledger.events(params.id!) },
    { method: 'POST', path: '/tasks/{id}/approve', summary: 'Give the OK a tier-2 or tier-3 task is waiting for. Tier 3 needs {confirm: true}.', body: '{confirm?}', handle: ({ params, body }) => ledger.approve(params.id!, { confirm: body.confirm === true }) },
    { method: 'POST', path: '/tasks/{id}/cancel', summary: 'Stop a task. It ends cancelled, with the reason.', body: '{reason?}', handle: ({ params, body }) => ledger.cancel(params.id!, typeof body.reason === 'string' && body.reason.trim() ? body.reason : 'Cancelled by you.') },
    { method: 'GET', path: '/workers', summary: 'Who can do delegated work, where their data goes, and whether they are healthy.', handle: () => [...ledger.workers.values()].map(info) },
    { method: 'GET', path: '/extensions', summary: 'Installed extensions and their state.', handle: () => extensions.list() },
    { method: 'POST', path: '/extensions', status: 201, summary: 'Install an extension from its manifest. It starts disabled; the reply lists what it asks for.', body: '{manifest}', handle: ({ body }) => extensions.install(body.manifest) },
    { method: 'POST', path: '/extensions/{id}/enable', summary: 'Enable an extension. Needs {approved: true} when it asks for permissions.', body: '{approved?}', handle: ({ params, body }) => extensions.enable(params.id!, { approved: body.approved === true }) },
    { method: 'POST', path: '/extensions/{id}/disable', summary: 'Disable an extension, keeping it installed.', handle: ({ params }) => extensions.disable(params.id!) },
    { method: 'DELETE', path: '/extensions/{id}', summary: 'Remove an extension, following its on_remove promise; nothing of it stays behind.', handle: ({ params }) => extensions.remove(params.id!) },
    { method: 'GET', path: '/problems', summary: 'Things that went wrong and matter to the person. ?open=1 for unresolved only.', handle: ({ query }) => log.problems({ open: query.get('open') === '1' }) },
    { method: 'POST', path: '/problems/{id}/resolve', summary: 'Mark a problem as dealt with.', handle: ({ params }) => { log.resolve(Number(params.id)); return { ok: true }; } },
  ];

  const api = createApi({
    routes, stream, version: o.version, trustedOrigin: o.trustedOrigin,
    onError: (e) => log.problem('api', 'Something went wrong inside Nova while answering a request.', { detail: (e as Error)?.stack ?? String(e) }),
  });

  return {
    db, log, profile, ledger, setup, extensions, workspace, migration, routes,
    health,
    openapi: api.doc,
    identity: () => identityOf(profile),
    persona: () => render(identityOf(profile)),
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) => api.handle(req, res, url),
    start: () => ledger.recover(),
    // Waits briefly for running work; anything still running is requeued on the next start.
    async close() {
      await Promise.race([ledger.idle(), new Promise((r) => setTimeout(r, 2000).unref())]);
      db.close();
    },
  };
}
