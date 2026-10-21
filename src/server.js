// Nova's local web server: the UI, a small JSON API, and a server-sent event
// stream per conversation. Binds to 127.0.0.1 by default.
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, watch } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { loadConfig } from './config.js';
import { ensureGit, seedHome } from './home.js';
import { SessionStore, validId } from './sessions.js';
import { Runner, BusyError } from './runner.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

export function createNova(config = loadConfig(), deps = {}) {
  const started = performance.now();
  const seeded = seedHome(config.home, join(config.root, 'templates', 'home'));
  const store = new SessionStore(config.home, config.timezone);
  const runner = new Runner(config, store, deps);
  const ui = join(config.root, 'ui');
  const subscribers = new Map(); // sessionId → Set<res>

  const broadcast = (sessionId, event, data) => {
    for (const res of subscribers.get(sessionId) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  runner.on('event', (id, ev) => broadcast(id, 'event', ev));
  runner.on('live', (id, live) => broadcast(id, 'live', live));
  runner.on('delta', (id, d) => broadcast(id, 'delta', d));

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((ok, fail) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => { size += c.length; if (size > 1_000_000) { fail(new Error('too large')); req.destroy(); } else parts.push(c); });
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
    if (path === '/' || path.startsWith('/c/')) return serveFile(res, join(ui, 'index.html'));
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
      if (action === 'regenerate') return json(res, 202, { turn: runner.regenerate(id) });
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
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      serveStatic(req, res, url.pathname);
    } catch (e) {
      if (!res.headersSent) json(res, e.message === 'bad json' || e.message === 'too large' ? 400 : 500, { error: e.message });
      else res.end();
    }
  });

  return { server, runner, store, config, seeded, started };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const nova = createNova();
  const { config } = nova;
  ensureGit(config.home);
  nova.server.listen(config.port, config.host, () => {
    const ms = Math.round(performance.now() - nova.started);
    if (nova.seeded.length) console.log(`Seeded ${nova.seeded.length} files into ${config.home}`);
    console.log(`Nova is ready at http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port}  (${ms} ms)`);
    console.log(`Home: ${config.home}`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
      console.log('Warning: Nova is listening beyond this machine. Anyone who can reach it can talk to Nova and approve commands.');
    }
  });
  const quit = () => { for (const id of nova.runner.active.keys()) nova.runner.stop(id); nova.server.close(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}
