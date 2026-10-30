// A stand-in for Screenpipe, for tests, screenshots and the M6 gate. Everything in it is made up;
// nothing is captured from this machine. It speaks the parts of Screenpipe's REST API that Nova's
// adapter reads (src/core/capture/screenpipe.ts):
//   GET /health   {status: "healthy", frame_status, audio_status, last_frame_timestamp, …}
//   GET /search   ?content_type=ocr|audio|ui|all &start_time= &end_time= &app_name= &limit= &offset=
//                 → {data: [{type: "OCR"|"Audio"|"UI", content: {…}}], pagination: {limit, offset, total}},
//                 newest first, as Screenpipe answers.
// And, for driving it from another process (the gate), POST /__items {items: [...]} adds items
// (the same shapes as add() below) and POST /__reset empties it.
//
//   startFakeScreenpipe({ port? }) → { base, port, add(...items), clear(), down(), up(), requests, auths, requireKey(key), close() }
//   item: { type: 'ocr', at, app, window, text, url?, private? } | { type: 'audio', at, text, device? } | { type: 'ui', at, app, window, text }
// down() stops listening (connections are refused, as when Screenpipe isn't running); up() listens
// again on the same port. requireKey(key) makes /search answer 403 without "Authorization: Bearer
// <key>", as Screenpipe 0.4 does once its API key is on (null turns that off); `auths` holds each
// request's Authorization header, or null. `node scripts/fake-screenpipe.js [--port N]` runs one and prints its address.
import { createServer } from 'node:http';

export async function startFakeScreenpipe({ port = 0 } = {}) {
  const items = [];
  const requests = [];
  const auths = [];
  let key = null;
  let nextId = 1;
  const sockets = new Set();

  const toApi = (i) => {
    if (i.type === 'audio') {
      return { type: 'Audio', content: { chunk_id: i.id, transcription: i.text ?? '', timestamp: i.at, file_path: `/data/audio/${i.id}.mp4`, offset_index: 0, tags: [], device_name: i.device ?? 'Built-in microphone (input)', device_type: 'Input', speaker: null, start_time: 0, end_time: 5 } };
    }
    if (i.type === 'ui') {
      return { type: 'UI', content: { id: i.id, text: i.text ?? '', timestamp: i.at, app_name: i.app ?? '', window_name: i.window ?? '', initial_traversal_at: i.at, file_path: '', offset_index: 0 } };
    }
    return {
      type: 'OCR',
      content: {
        frame_id: i.id, text: i.text ?? '', timestamp: i.at, file_path: `/data/frames/${i.id}.mp4`, offset_index: 0, app_name: i.app ?? '', window_name: i.window ?? '', tags: [], frame: null,
        ...(i.url ? { browser_url: i.url } : {}), ...(i.private ? { private: true } : {}), focused: true,
      },
    };
  };

  function add(...list) {
    const out = [];
    for (const raw of list.flat()) {
      const i = { type: 'ocr', ...raw, id: raw.id ?? nextId++ };
      if (typeof i.at !== 'string' || Number.isNaN(Date.parse(i.at))) throw new Error('every item needs at: an ISO time');
      i.at = new Date(i.at).toISOString();
      items.push(i);
      out.push(i);
    }
    return out;
  }

  function search(q) {
    const want = (q.get('content_type') ?? 'all').toLowerCase();
    const types = want === 'all' ? ['ocr', 'audio', 'ui'] : want.split('+');
    const start = q.get('start_time');
    const end = q.get('end_time');
    const app = q.get('app_name');
    const limit = Math.max(1, Math.min(1000, Number(q.get('limit') ?? 20) || 20));
    const offset = Math.max(0, Number(q.get('offset') ?? 0) || 0);
    const hits = items
      .filter((i) => types.includes(i.type) && (!start || i.at >= new Date(start).toISOString()) && (!end || i.at <= new Date(end).toISOString()) && (!app || i.app === app))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
    return { data: hits.slice(offset, offset + limit).map(toApi), pagination: { limit, offset, total: hits.length } };
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    auths.push(req.headers.authorization ?? null);
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && url.pathname === '/health') {
      const last = items.length ? items.map((i) => i.at).sort().at(-1) : null;
      return json(200, { status: 'healthy', status_code: 200, frame_status: 'ok', audio_status: 'ok', ui_status: 'ok', last_frame_timestamp: last, last_audio_timestamp: last, message: 'all systems are functioning normally.' });
    }
    if (req.method === 'GET' && url.pathname === '/search') {
      if (key !== null && req.headers.authorization !== `Bearer ${key}`) return json(403, { error: 'forbidden' });
      return json(200, search(url.searchParams));
    }
    if (req.method === 'POST' && (url.pathname === '/__items' || url.pathname === '/__reset')) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        if (url.pathname === '/__reset') { items.length = 0; return json(200, { ok: true }); }
        try { return json(200, { added: add(JSON.parse(body || '{}').items ?? []).map((i) => i.id) }); } catch (e) { return json(400, { error: e.message }); }
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  const listen = (p) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); }); });
  const bound = await listen(port);
  const stopListening = () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); });

  return {
    base: `http://127.0.0.1:${bound}`,
    port: bound,
    items,
    requests,
    auths,
    requireKey: (k) => { key = k; },
    add,
    clear: () => { items.length = 0; },
    down: () => (server.listening ? stopListening() : Promise.resolve()),
    up: async () => { if (!server.listening) await listen(bound); },
    close: () => (server.listening ? stopListening() : Promise.resolve()),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--port');
  const sp = await startFakeScreenpipe({ port: i > 0 ? Number(process.argv[i + 1]) : 0 });
  console.log(`Fake Screenpipe at ${sp.base} (POST /__items to add items)`);
}
