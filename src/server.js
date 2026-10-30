// Nova's local web server: the UI, a small JSON API, and a server-sent event
// stream per conversation. Binds to 127.0.0.1 by default. A second listener, the
// mesh listener, serves paired devices when one is configured (src/core/mesh/access.ts
// says who may do what on either).
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { createReadStream, existsSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { ensureGit, seedHome } from './home.js';
import { SessionStore, validId } from './sessions.js';
import { Runner, BusyError } from './runner.js';
import { SkillError } from './skills.js';
import { GmailError } from './connectors/gmail.js';
import { gmailConnector } from './connectors/gmail-connector.js';
import { ZipError, unzip } from './zip.js';
import { ScheduleError } from './schedules.js';
import { Scheduler } from './scheduler.js';
import { HelperError, Helpers } from './helpers.js';
import { buildActivity, notStarted } from './activity.js';
import { ChatRun, SYSTEM } from './chat-run.js';
import { render as renderPermissions } from './permissions.js';
import { createCore, fromBrowserTask, ipcLink, originHost } from './core/index.ts';
import { AgentError } from './agent.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

// The local model manager's settings from the environment (M6b): NOVA_OLLAMA_URL is where the
// hub's Ollama answers when the profile doesn't say; NOVA_HARDWARE_FILE (JSON, tests and the gate's
// stand-in run) replaces reading this machine's hardware; NOVA_MODELS_WATCH_MS and
// NOVA_MODELS_WAKE_POLL_MS shorten how often waiting work and a waking computer are checked.
function modelOptions(env) {
  const o = {};
  if (env.NOVA_OLLAMA_URL) o.ollamaUrl = env.NOVA_OLLAMA_URL;
  if (env.NOVA_HARDWARE_FILE) { const file = env.NOVA_HARDWARE_FILE; o.hardware = async () => JSON.parse(readFileSync(file, 'utf8')); }
  if (Number(env.NOVA_MODELS_WATCH_MS) > 0) o.watchMs = Number(env.NOVA_MODELS_WATCH_MS);
  if (Number(env.NOVA_MODELS_WAKE_POLL_MS) > 0) o.wakePollMs = Number(env.NOVA_MODELS_WAKE_POLL_MS);
  return o;
}

export function createNova(config = loadConfig(), deps = {}) {
  const started = performance.now();
  const seeded = seedHome(config.home, join(config.root, 'templates', 'home'));
  // The core (src/core): database, Work Ledger, profile, identity, setup, extensions, /api/v1.
  const { version } = JSON.parse(readFileSync(join(config.root, 'package.json'), 'utf8'));
  const program = config.agentCmd.trim().split(/\s+/).find((w) => !w.includes('=')) ?? 'the model command';
  // Scheduled runs and helpers are Work Ledger tasks for the chat-run worker, which runs them
  // through the runner (bound below, once it exists). Its evidence is checked by reading the
  // conversation the report went to.
  const chatRun = new ChatRun({ program, egress: config.agentEgress, privacy: () => core.profile.privacyDefault() });
  // Shared with the core by reference: with port 0 in NOVA_MESH_URL, the real port is filled in
  // once the mesh listener is bound (tests use that, so no other process can take the port first).
  const meshInfo = config.mesh ? { publicUrl: config.mesh.publicUrl, transport: config.mesh.transport } : null;
  const core = createCore({
    home: config.home, version, detectedTimezone: config.timezone, trustedOrigin: (host) => allowedHost(host), chat: { program, egress: config.agentEgress },
    mesh: meshInfo,
    // Nova's own listeners, which a browser task never reaches (browser/plan.ts). Read when a
    // task is checked or run, by then both are listening (port 0 means the port they got).
    hubPorts: () => {
      let bound = [];
      try { bound = [server, mesh].map((s) => s?.address()?.port); } catch { /* not created yet */ }
      return [config.port, config.mesh?.port, ...bound].filter((p) => Number.isInteger(p) && p > 0);
    },
    workers: [chatRun], confirmations: { [SYSTEM]: (e, brief) => chatRun.confirm(e, brief) },
    // Era 2's model command is the custom-cli provider (M5a). A provider's secret://NAME comes from
    // the vault (PUT /api/v1/vault/NAME). NOVA_SECRET_<NAME> in the environment is a fallback for
    // development and tests only: the vault wins, and such a value is redacted like a vault one.
    agent: { command: config.agentCmd, egress: config.agentEgress },
    secrets: deps.secrets ?? ((name) => process.env[`NOVA_SECRET_${name}`] ?? null),
    models: modelOptions(process.env),
    // Started by the supervisor (src/supervisor), it can ask for a deploy or rollback (M7b).
    supervisor: deps.supervisor ?? ipcLink(process),
    // A sandbox copy started by the change pipeline (M7a): no outside work, no changes taken.
    sandbox: process.env.NOVA_SANDBOX === '1',
  });
  // Chat goes through the registry: the provider the profile names for chat, or agent_cmd (the
  // default), which the runner runs exactly as before. Scheduled runs and helpers follow it.
  const chatProvider = () => {
    const h = core.providers.chat();
    return h && { ...h, call: (o) => h.call(o).catch((e) => { throw e instanceof AgentError ? e : new AgentError(e.message, `provider=${h.id}`); }) };
  };
  Object.defineProperty(chatRun, 'egress', { get: () => core.providers.chat()?.egress ?? config.agentEgress });
  if (!config.timezonePinned && core.identity().timezone) config.timezone = core.identity().timezone;
  const store = new SessionStore(config.home, config.timezone);
  // Curated memory lives in the core; MEMORY.md is rendered from it. The first start imports
  // an existing MEMORY.md once, and every start takes in hand edits made while Nova was off.
  const runner = new Runner(config, store, { ...deps, records: core.memory, vault: core.vault });
  // Era 2's Gmail as a connector: its secrets in the vault, Settings › Connections, mail events.
  core.connectors.register(gmailConnector(runner.gmail));
  // Forgetting through the core's API reaches MEMORY.md and the day notes as well.
  core.memory.onForget((records) => runner.memory.forgotten(records));
  runner.memory.readOnly = () => !!core.mesh.role.replica();
  runner.memory.sync();
  runner.chatProvider = chatProvider;
  runner.identity = { persona: core.persona, name: () => core.identity().name, privacy: () => core.profile.privacyDefault(), receipt: (r) => core.receipts.record(r) };
  runner.ensureMain();
  // permissions.md is written once, so it can be read and edited by hand; Settings keeps it current.
  if (!existsSync(runner.permissions.file)) writeFileSync(runner.permissions.file, renderPermissions(runner.permissions.list()));
  const scheduler = new Scheduler({ schedules: runner.schedules, runner, store, timezone: config.timezone, ledger: core.ledger, triggers: core.triggers });
  const helpers = new Helpers({ runner, store, ledger: core.ledger });
  runner.helpers = helpers;
  chatRun.bind({ runner, store, ledger: core.ledger, kinds: { schedule: scheduler, helper: helpers } });
  chatRun.problem = (message, opts) => core.log.problem('chat-run', message, opts);
  const ui = join(config.root, 'ui');
  const subscribers = new Map(); // sessionId → Set<res>

  const broadcast = (sessionId, event, data) => {
    for (const res of subscribers.get(sessionId) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  runner.on('event', (id, ev) => broadcast(id, 'event', ev));
  runner.on('live', (id, live) => broadcast(id, 'live', live));
  runner.on('delta', (id, d) => broadcast(id, 'delta', d));

  // One stream for things that aren't a single conversation: memory changes
  // and the conversation list.
  const watchers = new Set();
  const announce = (event, data = {}) => { for (const res of watchers) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  runner.on('memory', () => announce('memory'));
  runner.on('event', (_, ev) => { if (ev.type === 'session' || ev.type === 'title') announce('sessions'); });
  const memory = runner.memory;
  const titles = () => Object.fromEntries(store.list().map((s) => [s.id, s.title]));
  const saved = () => announce('memory'); // memory isn't in git history, so there's nothing to commit
  const { skills, gmail } = runner;
  scheduler.on('change', () => announce('schedules'));
  runner.on('schedules', () => { scheduler.tick(); announce('schedules'); });
  scheduler.on('ran', ({ target, handoff }) => { announce('schedules'); announce('handoff', { target, handoff }); });
  helpers.on('ran', ({ target, handoff }) => announce('handoff', { target, handoff }));

  // Activity: a nudge, a few times a second at most, whenever Nova's work
  // moves; open pages fetch the timeline again. The nudge says how much is
  // working and how much is waiting for the person, for the sidebar.
  const busy = () => {
    const live = [...runner.active.keys()].map((id) => runner.liveState(id));
    const queued = notStarted(core.ledger, store, 'helper').length + notStarted(core.ledger, store, 'schedule').length;
    return { working: live.length + queued, waiting: live.filter((l) => l?.approval).length };
  };
  let nudge = null;
  // Only open pages need it; and once Nova is shutting down, the ledger may already be closed.
  const moved = () => {
    nudge ??= setTimeout(() => {
      nudge = null;
      if (!watchers.size) return;
      try { announce('activity', busy()); } catch { /* closing */ }
    }, 150);
  };
  const STEPS = new Set(['session', 'user', 'tool_call', 'approval', 'tool_result', 'skill', 'memory', 'done', 'error', 'stopped', 'delivered']);
  runner.on('event', (_, ev) => { if (STEPS.has(ev.type)) moved(); });
  runner.on('live', moved);
  helpers.on('change', moved);
  scheduler.on('change', moved);
  core.ledger.on('task', (t) => {
    if (t.owner !== 'chat-run') return;
    moved();
    if (t.brief.inputs?.kind === 'schedule') announce('schedules');
  });
  const activity = (before) => buildActivity({ store, runner, ledger: core.ledger, schedules: runner.schedules, timezone: config.timezone, before });
  const { schedules } = runner;
  const schedulesView = () => {
    const latest = schedules.latest();
    return {
      set: schedules.list().map((s) => {
        const st = scheduler.status(s.id);
        return {
          ...s,
          next: schedules.next(s)?.toISOString() ?? null,
          last: latest.get(s.id) ?? null,
          running: st.running ?? null,
          queued: !!st.queued,
        };
      }),
      available: schedules.available(),
      timezone: config.timezone,
    };
  };
  const skillsView = () => ({
    installed: skills.installed(),
    available: skills.available(),
    connectors: { gmail: gmail.status() },
  });

  // Google sends the person back to the address they're using Nova at, so a
  // sign-in returns to the same page. Only this machine can receive it.
  const loopback = (host) => ['localhost', '127.0.0.1', '::1'].includes(String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req, limit = 1_000_000) => new Promise((ok, fail) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { fail(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { fail(new Error('bad json')); } });
    req.on('error', fail);
  });

  // Requests must come from Nova's own page. The Host check stops DNS
  // rebinding; the custom header makes cross-site POSTs impossible without a
  // CORS preflight, which this server never grants. Devices address Nova by its
  // mesh address.
  const meshHosts = config.mesh ? [new URL(config.mesh.publicUrl).hostname.replace(/^\[|\]$/g, ''), config.mesh.bindHost] : [];
  const allowedHost = (host) => {
    const name = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1', config.host, ...meshHosts].includes(name);
  };

  // npm run dev: watch ui/ and tell open pages to refresh.
  const devClients = new Set();
  if (config.dev) {
    let timer = null;
    watch(ui, { recursive: true }, (_, name) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const kind = String(name).endsWith('.css') ? 'css' : 'reload';
        for (const res of devClients) res.write(`event: change\ndata: ${JSON.stringify({ kind, name })}\n\n`);
      }, 40);
    });
  }

  function serveFile(res, file) {
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    if (config.dev && file.endsWith('.html')) {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return res.end(readFileSync(file, 'utf8').replace('</body>', '<script type="module" src="/js/dev-reload.js"></script></body>'));
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    createReadStream(file).pipe(res);
  }

  function serveStatic(req, res, path) {
    // The PWA's places (ui/js/nav.js); Era 2's paths keep working.
    if (path === '/pair') return serveFile(res, join(ui, 'pair.html'));
    if (['/', '/chat', '/new', '/tasks', '/memory', '/automations', '/skills', '/schedules', '/activity', '/health', '/settings', '/capture'].includes(path) || path.startsWith('/c/')) return serveFile(res, join(ui, 'index.html'));
    if (path === '/styleguide') return serveFile(res, join(ui, 'styleguide.html'));
    const file = resolve(ui, normalize(`.${decodeURIComponent(path)}`));
    if (!file.startsWith(ui + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    serveFile(res, file);
  }

  async function api(req, res, parts) {
    const [, , resource, id, action, sub] = parts; // ['', 'api', ...]
    if (req.method === 'POST') {
      if (req.headers['x-nova'] !== '1') return json(res, 403, { error: 'Missing X-Nova header' });
      const origin = req.headers.origin;
      // `Origin: null` or a malformed one names no host: refused, never a 500.
      const host = origin ? originHost(origin) : null;
      if (origin && (!host || !allowedHost(host))) return json(res, 403, { error: 'Cross-origin request refused' });
    }

    if (resource === 'health') return json(res, 200, { ok: true, agent: config.agentCmd.trim().split(/\s+/)[0] });
    if (resource === 'config') return json(res, 200, { theme: config.theme, timezone: config.timezone });

    if (resource === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': nova\n\n');
      watchers.add(res);
      const beat = setInterval(() => res.write(': beat\n\n'), 20_000);
      req.on('close', () => { clearInterval(beat); watchers.delete(res); });
      return;
    }

    if (resource === 'memory') {
      if (req.method === 'GET' && !id) return json(res, 200, { ...memory.read(), titles: titles() });
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (id === 'restore') {
        const { items } = await readBody(req);
        if (!Array.isArray(items)) return json(res, 400, { error: 'items must be a list' });
        memory.restore(items);
        saved();
        return json(res, 200, { ok: true });
      }
      // Ids from Era 2 (m…, n…, h…) and the core's own (a UUID).
      if (!/^([mnh][0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(String(id))) return json(res, 404, { error: 'No such memory' });
      if (action === 'forget') {
        const removed = memory.forget(id, { by: 'person' });
        if (!removed.length) return json(res, 404, { error: 'That was already forgotten.' });
        saved();
        return json(res, 200, { removed });
      }
      if (!action) {
        const { text } = await readBody(req);
        let entry;
        try { entry = memory.edit(id, text); } catch (e) { return json(res, 400, { error: e.message }); }
        if (!entry) return json(res, 404, { error: 'That memory is gone. It may have been forgotten.' });
        saved();
        return json(res, 200, { entry });
      }
      return json(res, 404, { error: 'Not found' });
    }

    if (resource === 'skills') {
      if (req.method === 'GET' && !id) return json(res, 200, skillsView());
      if (req.method !== 'POST' || !id) return json(res, 405, { error: 'Method not allowed' });
      // A skill the person brings: a folder's files, or a .zip.
      if (id === 'add' && !action) {
        let body;
        try { body = await readBody(req, 8_000_000); } catch { return json(res, 413, { error: 'That skill is too big to add. Skills can be up to 5 MB.' }); }
        try {
          const skill = skills.add(body.zip ? unzip(Buffer.from(String(body.zip), 'base64')) : body.files);
          announce('skills');
          return json(res, 200, { skill });
        } catch (e) {
          if (e instanceof SkillError) return json(res, e.status, { error: e.message });
          if (e instanceof ZipError) return json(res, 400, { error: e.message });
          throw e;
        }
      }
      try {
        let skill = null;
        let files;
        if (action === 'install') skill = skills.install(id);
        else if (action === 'remove') files = skills.remove(id);
        else if (action === 'restore') skill = skills.restore(id, (await readBody(req)).files);
        else return json(res, 404, { error: 'Not found' });
        announce('skills');
        return json(res, 200, files ? { files } : { skill });
      } catch (e) {
        if (e instanceof SkillError) return json(res, e.status, { error: e.message });
        throw e;
      }
    }

    if (resource === 'schedules') {
      if (req.method === 'GET' && !id) return json(res, 200, schedulesView());
      if (req.method !== 'POST' || !id || !action) return json(res, 405, { error: 'Method not allowed' });
      try {
        let body;
        if (action === 'run') {
          if (!schedules.get(id)) return json(res, 404, { error: 'That schedule is gone. It may have been removed.' });
          body = { queued: scheduler.runNow(id) };
        } else if (action === 'pause') body = { schedule: schedules.setPaused(id, true) };
        else if (action === 'resume') body = { schedule: schedules.setPaused(id, false) };
        else if (action === 'remove') body = { text: schedules.remove(id).text };
        else if (action === 'restore') body = { schedule: schedules.restore(id, (await readBody(req)).text) };
        else if (action === 'setup') body = { schedule: schedules.setup(id, await readBody(req)) };
        else return json(res, 404, { error: 'Not found' });
        scheduler.tick();
        announce('schedules');
        return json(res, 200, body);
      } catch (e) {
        if (e instanceof ScheduleError) return json(res, e.status, { error: e.message });
        throw e;
      }
    }

    if (resource === 'permissions') {
      const { permissions } = runner;
      if (req.method === 'GET' && !id) return json(res, 200, { permissions: permissions.list() });
      if (req.method !== 'POST' || !id || !['allow', 'ask'].includes(action)) return json(res, 405, { error: 'Method not allowed' });
      if (!permissions.list().some((p) => p.id === id)) return json(res, 404, { error: "That permission doesn't exist any more." });
      const list = permissions.set(id, action === 'allow');
      announce('permissions');
      return json(res, 200, { permissions: list });
    }

    if (resource === 'activity') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      const before = new URL(req.url, 'http://nova.local').searchParams.get('before');
      if (before && !/^\d{4}-\d{2}-\d{2}$/.test(before)) return json(res, 400, { error: 'before must be a day, such as 2026-10-21' });
      return json(res, 200, { ...activity(before), busy: busy() });
    }

    if (resource === 'helpers') {
      if (req.method !== 'POST' || !id || !action) return json(res, 405, { error: 'Method not allowed' });
      if (!validId(id)) return json(res, 404, { error: 'That helper is gone.' });
      try {
        if (action === 'stop') return helpers.stop(id) ? json(res, 200, { stopped: true }) : json(res, 409, { error: 'That helper has already finished.' });
        if (action === 'retry') return json(res, 200, helpers.retry(id));
      } catch (e) {
        if (e instanceof HelperError) return json(res, e.status, { error: e.message });
        throw e;
      }
      return json(res, 404, { error: 'Not found' });
    }

    if (resource === 'connectors') {
      if (id !== 'gmail') return json(res, 404, { error: 'Not found' });
      if (req.method === 'GET' && !action) return json(res, 200, gmail.status());
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      try {
        let body;
        if (action === 'password') {
          const { email, password } = await readBody(req);
          body = await gmail.connectPassword({ email, password });
        } else if (action === 'client') body = gmail.setClient((await readBody(req)).json);
        else if (action === 'forget-client') body = gmail.forgetClient();
        else if (action === 'disconnect') body = await gmail.disconnect();
        else if (action === 'connect') {
          if (!loopback(req.headers.host) || fromBrowserTask(req.headers)) return json(res, 400, { error: 'Open Nova on this computer, at localhost, to connect Gmail. Google sends you back to this computer only.' });
          return json(res, 200, { url: gmail.authUrl(`http://${req.headers.host}/oauth/gmail`) });
        } else return json(res, 404, { error: 'Not found' });
        announce('skills');
        core.connectors.touched('gmail');
        return json(res, 200, body);
      } catch (e) {
        if (e instanceof GmailError) return json(res, 400, { error: e.message });
        throw e;
      }
    }

    if (resource !== 'sessions') return json(res, 404, { error: 'Not found' });
    if (!id) {
      if (req.method === 'GET') return json(res, 200, store.list());
      if (req.method === 'POST') {
        const { text } = await readBody(req);
        if (!String(text ?? '').trim()) return json(res, 400, { error: 'Write a message first.' });
        const sessionId = runner.createSession(text);
        const turn = runner.send(sessionId, String(text));
        return json(res, 201, { id: sessionId, turn });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }

    if (!validId(id) || !store.exists(id)) return json(res, 404, { error: 'No such conversation' });

    if (req.method === 'GET' && !action) return json(res, 200, runner.snapshot(id));
    if (req.method === 'GET' && action === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(runner.snapshot(id))}\n\n`);
      if (!subscribers.has(id)) subscribers.set(id, new Set());
      subscribers.get(id).add(res);
      const beat = setInterval(() => res.write(': beat\n\n'), 20_000);
      req.on('close', () => { clearInterval(beat); subscribers.get(id)?.delete(res); });
      return;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    try {
      if (action === 'messages') {
        const { text } = await readBody(req);
        if (!String(text ?? '').trim()) return json(res, 400, { error: 'Write a message first.' });
        return json(res, 202, { turn: runner.send(id, String(text)) });
      }
      if (action === 'regenerate') {
        try { return json(res, 202, { turn: runner.regenerate(id) }); } catch (e) {
          if (e.message === 'Nothing to regenerate') return json(res, 409, { error: 'There is no reply to regenerate.' });
          throw e;
        }
      }
      if (action === 'stop') return json(res, 200, { stopped: runner.stop(id) });
      if (action === 'approvals' && sub) {
        const { decision } = await readBody(req);
        if (!['allow', 'deny'].includes(decision)) return json(res, 400, { error: 'decision must be allow or deny' });
        return runner.decide(id, sub, decision) ? json(res, 200, { ok: true }) : json(res, 409, { error: 'That request is no longer waiting.' });
      }
    } catch (e) {
      if (e instanceof BusyError) return json(res, 409, { error: e.message });
      throw e;
    }
    return json(res, 404, { error: 'Not found' });
  }

  // One handler for both listeners; the listener is part of who is asking.
  const handler = (listener) => async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) { res.writeHead(421); return res.end('Misdirected request'); }
      const url = new URL(req.url, 'http://nova.local');
      const parts = url.pathname.split('/');
      // The console, a paired device, or no one yet: a refusal is sent here and nothing below runs.
      const principal = core.gate(req, res, url, listener);
      if (!principal) return;
      if (config.dev && url.pathname === '/__dev/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': dev\n\n');
        devClients.add(res);
        return req.on('close', () => devClients.delete(res));
      }
      if (await core.handle(req, res, url, principal, listener)) return;
      // The active design system as CSS variables (?device= for a device's own choice). Pages
      // fetch it again on the core's design-system event, so a change needs no reload.
      if (url.pathname === '/design-system.css' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(core.design.css(url.searchParams.get('device')));
      }
      if (parts[1] === 'api') return await api(req, res, parts);
      if (url.pathname === '/oauth/gmail' && req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        await runner.gmail.finish({ code: q.code, state: q.state, error: q.error });
        announce('skills');
        core.connectors.touched('gmail');
        res.writeHead(303, { location: '/skills#gmail', 'cache-control': 'no-store' });
        return res.end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      serveStatic(req, res, url.pathname);
    } catch (e) {
      if (!res.headersSent) json(res, e.message === 'bad json' || e.message === 'too large' ? 400 : 500, { error: e.message });
      else res.end();
    }
  };
  const server = createServer(handler('console'));
  const m = config.mesh;
  const mesh = !m ? null : m.tls
    ? createTlsServer({ cert: readFileSync(m.tls.cert), key: readFileSync(m.tls.key) }, handler('mesh'))
    : createServer(handler('mesh'));

  return { server, mesh, meshInfo, runner, store, scheduler, helpers, chatRun, config, seeded, started, core };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let nova;
  try {
    nova = createNova();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`Nova didn't start: ${e.message}`);
    process.exit(1);
  }
  const { config } = nova;
  // Said once per open problem, not once per start: it stays open until the keys are replaced.
  ensureGit(config.home, {
    problem: (m) => { if (!nova.core.log.problems({ open: true }).some((p) => p.message === m)) nova.core.log.problem('mesh', m); },
    // The keys were replaced since: the warning has done its job.
    resolved: (m) => { for (const p of nova.core.log.problems({ open: true })) if (p.message === m) nova.core.log.resolve(p.id); },
  });
  // A hub first asks its roster peers whether one of them became hub while it was away (fencing).
  const { role } = nova.core.mesh;
  // A sandbox (a release on a copy of the home, a restore drill) runs no work and asks no peer
  // anything: it is never the hub anyone uses (M7b).
  const sandbox = process.env.NOVA_SANDBOX === '1';
  if (!sandbox) await role.fence();
  // Only the hub runs work. A standby copies the hub and starts all of this when it is promoted.
  const runWork = () => {
    nova.helpers.recover(); // helper logs from before the ledger; the rest is the ledger's recovery
    nova.chatRun.recover();
    nova.scheduler.start();
  };
  const hub = !role.replica() && !sandbox;
  if (hub) nova.helpers.recover();
  const recovered = nova.core.start();
  if (hub) {
    nova.chatRun.recover();
    nova.scheduler.start();
  }
  if (recovered.requeued.length) console.log(`Resumed ${recovered.requeued.length} task(s) that were running when Nova stopped.`);
  if (!hub && !sandbox) console.log(role.replica().reason);
  role.on('promoted', ({ epoch }) => { runWork(); console.log(`This node is the hub now (epoch ${epoch}).`); });
  role.on('demoted', ({ reason }) => { nova.scheduler.stop(); for (const id of nova.runner.active.keys()) nova.runner.stop(id); console.log(reason); });
  nova.server.listen(config.port, config.host, () => {
    const ms = Math.round(performance.now() - nova.started);
    // Who is running this home, so tools that must only run while Nova is stopped (replacing the
    // hub's keys) can tell. Removed on a clean stop; a stale one names a pid that is gone.
    writeFileSync(join(config.home, 'nova.pid'), String(process.pid));
    if (nova.seeded.length) console.log(`Seeded ${nova.seeded.length} files into ${config.home}`);
    // The real port, so NOVA_PORT=0 (any free port) still says where Nova is.
    console.log(`Nova is ready at http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${nova.server.address().port}  (${ms} ms)`);
    console.log(`Home: ${config.home}`);
    // The console is "a request from this machine, to this machine, through no proxy". A program
    // here that passes connections on to this port without saying so (no X-Forwarded-For) makes
    // whoever reaches it look exactly like that. Nova can't tell, so the person must know.
    console.log(`Warning: whoever reaches port ${nova.server.address().port} from this computer controls Nova completely. Don’t point a port forward, tunnel or proxy at it; other devices pair at the mesh address (NOVA_MESH_URL) instead.`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
      console.log('Note: the console port is listening beyond this machine. Only requests from this machine get the console; anything else must pair first, and pairing needs a mesh address (NOVA_MESH_URL).');
    }
  });
  if (nova.mesh) {
    const m = config.mesh;
    nova.mesh.on('error', (e) => {
      console.error(`Nova couldn’t listen for devices at ${m.bindHost}:${m.port}: ${e.message}`);
      process.exit(1);
    });
    nova.mesh.listen(m.port, m.bindHost, () => {
      const how = { tls: 'over TLS', proxy: 'through a TLS proxy, as you said', network: 'over an encrypted network, as you said' }[m.transport];
      const port = nova.mesh.address().port;
      const pub = new URL(nova.meshInfo.publicUrl);
      if (pub.port === '0') {
        pub.port = String(port);
        nova.meshInfo.publicUrl = config.mesh.publicUrl = pub.origin;
      }
      console.log(`Devices pair and connect at ${nova.meshInfo.publicUrl} (listening on ${m.bindHost}:${port}, ${how}).`);
    });
  }
  // On a stop, nothing Nova started lives on after it (a command in a process group of its own).
  const quit = async () => { rmSync(join(config.home, 'nova.pid'), { force: true }); nova.scheduler.stop(); for (const id of nova.runner.active.keys()) nova.runner.stop(id); nova.server.close(); nova.mesh?.close(); await nova.core.stopWork(2000); await nova.core.close(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  // Restarting in place (core resilience/restart.ts), for a restore: stop listening, close the core,
  // and tell the fresh start which ports to take again (the ones it has now, even if it was given 0).
  nova.core.restarter.attach(async () => {
    nova.scheduler.stop();
    for (const id of nova.runner.active.keys()) nova.runner.stop(id);
    // Nothing Nova started may write into the restored home: running tasks stop, and every process
    // it started (in its own process group or not) is ended, within a bound.
    await nova.core.stopWork(5000);
    const closed = (s) => new Promise((r) => { if (!s?.listening) return r(); s.close(() => r()); s.closeAllConnections(); });
    const port = nova.server.address()?.port;
    const meshPort = nova.mesh?.address()?.port;
    await Promise.all([closed(nova.server), closed(nova.mesh)]);
    await nova.core.close();
    const env = {};
    if (port) env.NOVA_PORT = String(port);
    for (const name of ['NOVA_MESH_URL', 'NOVA_MESH_PUBLIC_URL']) {
      if (!meshPort || !process.env[name]) continue;
      const u = new URL(process.env[name]);
      if (u.port === '0') { u.port = String(meshPort); env[name] = u.origin; }
    }
    console.log('Nova is restarting to finish a restore.');
    return env;
  });
}
