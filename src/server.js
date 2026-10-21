// Nova's local web server: the UI, a small JSON API, and a server-sent event
// stream per conversation. Binds to 127.0.0.1 by default.
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, watch } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { loadConfig } from './config.js';
import { ensureGit, seedHome } from './home.js';
import { SessionStore, validId } from './sessions.js';
import { Runner, BusyError } from './runner.js';
import { SkillError } from './skills.js';
import { GmailError } from './connectors/gmail.js';
import { ZipError, unzip } from './zip.js';
import { ScheduleError } from './schedules.js';
import { Scheduler } from './scheduler.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

export function createNova(config = loadConfig(), deps = {}) {
  const started = performance.now();
  const seeded = seedHome(config.home, join(config.root, 'templates', 'home'));
  const store = new SessionStore(config.home, config.timezone);
  const runner = new Runner(config, store, deps);
  runner.ensureMain();
  const scheduler = new Scheduler({ schedules: runner.schedules, runner, store, timezone: config.timezone });
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
  const { schedules } = runner;
  const schedulesView = () => {
    const latest = schedules.latest();
    const queued = new Set(scheduler.queue.map((q) => q.id));
    return {
      set: schedules.list().map((s) => ({
        ...s,
        next: schedules.next(s)?.toISOString() ?? null,
        last: latest.get(s.id) ?? null,
        running: scheduler.running?.id === s.id ? scheduler.running : null,
        queued: queued.has(s.id),
      })),
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
  // CORS preflight, which this server never grants.
  const allowedHost = (host) => {
    const name = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1', config.host].includes(name);
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
    if (['/', '/new', '/memory', '/skills', '/schedules'].includes(path) || path.startsWith('/c/')) return serveFile(res, join(ui, 'index.html'));
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
      if (origin && !allowedHost(new URL(origin).host)) return json(res, 403, { error: 'Cross-origin request refused' });
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
      if (!/^[mnh][0-9a-f]{8}$/.test(String(id))) return json(res, 404, { error: 'No such memory' });
      if (action === 'forget') {
        const removed = memory.forget(id);
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
          if (!loopback(req.headers.host)) return json(res, 400, { error: 'Open Nova on this computer, at localhost, to connect Gmail. Google sends you back to this computer only.' });
          return json(res, 200, { url: gmail.authUrl(`http://${req.headers.host}/oauth/gmail`) });
        } else return json(res, 404, { error: 'Not found' });
        announce('skills');
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

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) { res.writeHead(421); return res.end('Misdirected request'); }
      const url = new URL(req.url, 'http://nova.local');
      const parts = url.pathname.split('/');
      if (config.dev && url.pathname === '/__dev/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': dev\n\n');
        devClients.add(res);
        return req.on('close', () => devClients.delete(res));
      }
      if (parts[1] === 'api') return await api(req, res, parts);
      if (url.pathname === '/oauth/gmail' && req.method === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        await runner.gmail.finish({ code: q.code, state: q.state, error: q.error });
        announce('skills');
        res.writeHead(303, { location: '/skills#gmail', 'cache-control': 'no-store' });
        return res.end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      serveStatic(req, res, url.pathname);
    } catch (e) {
      if (!res.headersSent) json(res, e.message === 'bad json' || e.message === 'too large' ? 400 : 500, { error: e.message });
      else res.end();
    }
  });

  return { server, runner, store, scheduler, config, seeded, started };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const nova = createNova();
  const { config } = nova;
  ensureGit(config.home);
  nova.scheduler.start();
  nova.server.listen(config.port, config.host, () => {
    const ms = Math.round(performance.now() - nova.started);
    if (nova.seeded.length) console.log(`Seeded ${nova.seeded.length} files into ${config.home}`);
    console.log(`Nova is ready at http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port}  (${ms} ms)`);
    console.log(`Home: ${config.home}`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
      console.log('Warning: Nova is listening beyond this machine. Anyone who can reach it can talk to Nova and approve commands.');
    }
  });
  const quit = () => { nova.scheduler.stop(); for (const id of nova.runner.active.keys()) nova.runner.stop(id); nova.server.close(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}
