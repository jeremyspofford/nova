#!/usr/bin/env node
// A stand-in for Screenpipe as a native workload (M10h): one self-contained file a device agent installs
// and starts the way it would start Screenpipe, with Nova's own Node. It captures NOTHING from the
// machine it runs on: every item in it is made up, added by a test with POST /__items. It answers on
// 127.0.0.1 at the port it is given (PORT) and keeps its store in NOVA_SERVICE_STATE, as Screenpipe
// keeps its own, so a new version started on the same state finds what the old one held.
//
// The parts of Screenpipe's REST API the device agent's capture carrier reads:
//   GET  /health           {status: "healthy", version, shadow}, or 500 once sick
//   GET  /search           ?content_type=all|ocr|audio &start_time= &end_time= &limit= &offset=   newest first,
//                          {data: [{type: "OCR"|"Audio", content: {…}}], pagination}
//   GET  /frames/<id>      a screen item's original (here: made-up bytes, never an image of anything)
// And the stand-in's own, for tests (real Screenpipe's delete call is to be checked on a real device):
//   POST /__items {items: [{type: 'ocr'|'audio', at, app?, window?, text, url?, private?, raw?}]}
//   POST /__delete {items: [{type, id}]}   removes items (derived and raw) by their type and own id
//   GET  /__items          what it holds, by id
// Flags (part of a version's command, so each version behaves as its manifest says):
//   --sick                  /health answers 500 from the start (a version that fails its health)
//   --healthy-for-ms <n>    healthy for n ms after it starts, then sick
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const started = Date.now();
const healthyFor = flag('--sick') ? 0 : value('--healthy-for-ms') === undefined ? Infinity : Number(value('--healthy-for-ms'));
const state = process.env.NOVA_SERVICE_STATE ?? process.cwd();
const version = process.env.NOVA_SERVICE_VERSION ?? 'unknown';
const shadow = process.env.NOVA_SHADOW === '1';
const port = Number(process.env.PORT ?? 0);
mkdirSync(state, { recursive: true });
const file = join(state, 'stand-in-screenpipe.json');

let db = { next: 1, items: [] };
try { db = JSON.parse(readFileSync(file, 'utf8')); } catch { /* a new store */ }
const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(db)); renameSync(`${file}.tmp`, file); };

const toApi = (i) => i.type === 'audio'
  ? { type: 'Audio', content: { chunk_id: i.id, transcription: i.text ?? '', timestamp: i.at, file_path: `/data/audio/${i.id}.mp4`, offset_index: 0, tags: [], device_name: 'Stand-in microphone', device_type: 'Input' } }
  : { type: 'OCR', content: { frame_id: i.id, text: i.text ?? '', timestamp: i.at, file_path: `/data/frames/${i.id}.mp4`, offset_index: 0, app_name: i.app ?? '', window_name: i.window ?? '', tags: [], frame: null, ...(i.url ? { browser_url: i.url } : {}), ...(i.private ? { private: true } : {}), focused: true } };

const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const parts = [];
  for await (const c of req) parts.push(c);
  const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
  if (url.pathname === '/health') {
    const ok = Date.now() - started < healthyFor;
    return send(res, ok ? 200 : 500, { status: ok ? 'healthy' : 'unhealthy', version, shadow, frame_status: 'ok', audio_status: 'ok', last_frame_timestamp: db.items.at(-1)?.at ?? null });
  }
  if (url.pathname === '/search' && req.method === 'GET') {
    const want = (url.searchParams.get('content_type') ?? 'all').toLowerCase();
    const since = url.searchParams.get('start_time');
    const until = url.searchParams.get('end_time');
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const list = db.items.filter((i) => (want === 'all' || i.type === want) && (!since || i.at >= new Date(since).toISOString()) && (!until || i.at <= new Date(until).toISOString())).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
    return send(res, 200, { data: list.slice(offset, offset + limit).map(toApi), pagination: { limit, offset, total: list.length } });
  }
  const frame = /^\/frames\/(\d+)$/.exec(url.pathname);
  if (frame && req.method === 'GET') {
    const i = db.items.find((x) => String(x.id) === frame[1] && x.type === 'ocr');
    return i ? send(res, 200, Buffer.from(i.raw ?? `stand-in frame ${i.id}: made-up bytes, not an image of anything`), 'application/octet-stream') : send(res, 404, { error: 'no such frame' });
  }
  if (url.pathname === '/__items' && req.method === 'POST') {
    const added = [];
    for (const raw of body.items ?? []) {
      const i = { type: raw.type === 'audio' ? 'audio' : 'ocr', at: new Date(raw.at).toISOString(), app: raw.app ?? null, window: raw.window ?? null, text: raw.text ?? '', url: raw.url ?? null, private: raw.private === true, raw: raw.raw ?? null, id: db.next++ };
      db.items.push(i);
      added.push(i.id);
    }
    save();
    return send(res, 200, { added });
  }
  if (url.pathname === '/__items' && req.method === 'GET') return send(res, 200, { ids: db.items.map((i) => i.id), shadow, version });
  if (url.pathname === '/__delete' && req.method === 'POST') {
    // By type and id: frames and audio chunks are numbered apart in real Screenpipe.
    const gone = new Set((body.items ?? []).map((x) => `${x.type}:${x.id}`));
    const before = db.items.length;
    db.items = db.items.filter((i) => !gone.has(`${i.type}:${i.id}`));
    save();
    return send(res, 200, { removed: before - db.items.length });
  }
  send(res, 404, { error: 'not found' });
});
server.listen(port, '127.0.0.1');
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
