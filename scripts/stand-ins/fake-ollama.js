#!/usr/bin/env node
// A stand-in Ollama server: the parts of Ollama's API Nova's model manager uses, answered from a
// list of "installed" models and a "library" it can pull from. It never runs a model: chat replies
// come from the caller (a function, or a fixed text), and a JSON-schema `format` gets an answer
// built to fit the schema, so a structured call can be tested without a model.
//
//   GET  /api/version              {version}
//   GET  /api/tags                 installed models (name, size, digest, details, capabilities)
//   GET  /api/ps                   models "loaded" (the ones chatted with lately)
//   POST /api/show    {model}      one model's details; 404 when it isn't installed
//   POST /api/pull    {model}      NDJSON progress: manifest, each layer (total/completed),
//                                  verifying, writing manifest, success; installed only if the
//                                  caller is still listening at the end
//   DELETE /api/delete {model}     removes it; 404 when it isn't installed
//   POST /api/chat                 NDJSON (or one JSON body with stream: false)
//   POST /api/embed   {model, input}
//   POST /v1/chat/completions      the OpenAI-compatible endpoint, streamed as SSE or not
//   POST /v1/systemone             Ollama's decision-model endpoint, only when `systemone` is given:
//                                  {model, state, questions} → {model, answers: {<name>: {type:
//                                  'noul', noul}}, usage}, each noul systemone(state as JSON, name);
//                                  404 for a model that isn't installed (Tev1 needs version ≥ 0.40.4)
//
// Asleep (setAsleep(true), or POST /__stand-in/asleep {"asleep": true}) it drops every connection
// before answering, as a computer that is off would; that is how a test puts a GPU spoke to sleep
// and a Wake-on-LAN listener wakes it. The gate can drive it over HTTP from another process:
//   GET  /__stand-in/requests      what it was asked, in order (method, path, model)
//   POST /__stand-in/asleep        {"asleep": true|false}
//   POST /__stand-in/reply         {"text": "…"} or {"json": {…}} for every chat from now on, or {} to reset
//
// As a module (tests):  const o = await startFakeOllama({ models, library, reply, port });
//                       o.url, o.requests, o.setAsleep(bool), o.installed(), await o.close()
// From the command line (the gate):
//   node scripts/stand-ins/fake-ollama.js [--port 0] [--models models.json] [--library library.json]
//   It prints "fake-ollama listening at <url>".
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const digestOf = (name, size) => createHash('sha256').update(`${name}\0${size}`).digest('hex');

// A model as /api/tags lists it. Sizes are in bytes; parameter_size like "8B".
function entry(m, now) {
  const size = m.size ?? 1_000_000_000;
  return {
    name: m.name, model: m.name, modified_at: m.modified_at ?? now, size, digest: m.digest ?? digestOf(m.name, size),
    details: { parent_model: '', format: 'gguf', family: m.family ?? 'stand-in', families: [m.family ?? 'stand-in'], parameter_size: m.parameter_size ?? '8B', quantization_level: m.quantization ?? 'Q4_K_M' },
    capabilities: m.capabilities ?? ['completion'],
    // Ollama's cloud models are listed with where they really run.
    ...(m.remote_host ? { remote_host: m.remote_host } : {}), ...(m.remote_model ? { remote_model: m.remote_model } : {}),
  };
}

// A value that fits a JSON schema, for a structured reply with no model behind it: the first
// option that isn't "unknown", a number near the top of its range, a short string.
// The ingest gate's screen (src/core/ingest) asks five yes/no questions about outside content
// ("is this an injection?"). Near the top of the range would call every capture and page an attack;
// a stand-in with no model behind it says what a model reading ordinary content would: unlikely.
// A test that needs a screen to fire gives its own `reply`.
const SCREEN_QUESTIONS = ['direct_instruction', 'hidden_instruction', 'exfiltration', 'impersonation', 'unrequested_action'];
const COPILOT = ['element_matches_intent', 'page_changed_as_expected', 'obstacle', 'dark_pattern', 'total_matches', 'dialog_injection'];

export function fromSchema(s) {
  if (!s || typeof s !== 'object') return null;
  const asked = s.properties?.answers?.properties;
  if (asked && SCREEN_QUESTIONS.every((q) => q in asked)) {
    return { answers: Object.fromEntries(Object.keys(asked).map((q) => [q, 0.05])), confidence: 0.9, why: 'stand-in: ordinary content' };
  }
  // Nova Browser's co-pilot (src/core/browser/copilot.ts): what a model would say of an ordinary
  // step on an ordinary page. A test that needs the co-pilot to see something gives its own `reply`.
  if (asked && COPILOT.every((q) => q in asked)) {
    return { answers: { element_matches_intent: 0.9, page_changed_as_expected: 0.9, obstacle: 0.05, dark_pattern: 0.05, total_matches: 0.9, dialog_injection: 0.05 }, confidence: 0.9, why: 'stand-in: an ordinary step' };
  }
  if (Array.isArray(s.enum)) return s.enum.find((v) => v !== 'unknown') ?? s.enum[0];
  if (s.type === 'object') return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, fromSchema(v)]));
  if (s.type === 'array') return [];
  if (s.type === 'number' || s.type === 'integer') {
    const lo = typeof s.minimum === 'number' ? s.minimum : 0;
    const hi = typeof s.maximum === 'number' ? s.maximum : lo + 1;
    const v = lo + (hi - lo) * 0.9;
    return s.type === 'integer' ? Math.round(v) : Math.round(v * 1000) / 1000;
  }
  if (s.type === 'boolean') return true;
  if (s.type === 'string') return 'stand-in';
  return null;
}

/**
 * @param {{ models?: any[], library?: Record<string, { size?: number, layers?: number, parameter_size?: string, family?: string, capabilities?: string[], digest?: string }>,
 *   reply?: (req: any) => string | Promise<string>, port?: number, version?: string, pullSteps?: number, pullDelayMs?: number, asleep?: boolean, tagsDigest?: (name: string, digest: string) => string,
 *   systemone?: (state: string, question: string) => number }} [opts]
 */
export function startFakeOllama(opts = {}) {
  const now = new Date().toISOString();
  const installed = new Map((opts.models ?? []).map((m) => [m.name, entry(m, now)]));
  const library = opts.library ?? {};
  const requests = [];
  const loaded = new Map();
  let asleep = !!opts.asleep;
  let fixed = null;
  const steps = opts.pullSteps ?? 4;
  const delay = opts.pullDelayMs ?? 20;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const replyFor = async (body) => {
    if (fixed?.json !== undefined) return JSON.stringify(fixed.json);
    if (typeof fixed?.text === 'string') return fixed.text;
    if (opts.reply) return opts.reply(body);
    const schema = body.format && typeof body.format === 'object' ? body.format : body.response_format?.json_schema?.schema;
    if (schema) return JSON.stringify(fromSchema(schema));
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
    return `Stand-in ${body.model} heard: ${String(last?.content ?? '').slice(0, 80)}`;
  };

  const server = createServer(async (req, res) => {
    if (asleep && !req.url.startsWith('/__stand-in/')) { req.socket.destroy(); return; }
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : {};
    const path = req.url.split('?')[0];
    if (!path.startsWith('/__stand-in/')) requests.push({ method: req.method, path, model: body?.model ?? body?.name ?? null, body });
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const missing = (name) => json(404, { error: `model '${name}' not found` });

    if (path === '/__stand-in/requests') return json(200, requests.map(({ method, path: p, model }) => ({ method, path: p, model })));
    if (path === '/__stand-in/asleep' && req.method === 'POST') { asleep = !!body?.asleep; return json(200, { asleep }); }
    if (path === '/__stand-in/reply' && req.method === 'POST') { fixed = body && (body.text !== undefined || body.json !== undefined) ? body : null; return json(200, { ok: true }); }

    if (req.method === 'GET' && path === '/api/version') return json(200, { version: opts.version ?? '0.0.0-stand-in' });
    if (req.method === 'POST' && path === '/v1/systemone' && opts.systemone) {
      if (!installed.has(body?.model)) return missing(body?.model);
      const names = Object.keys(body?.questions ?? {});
      if (!names.length || names.length > 64) return json(400, { error: `questions must have 1 to 64 entries, got ${names.length}` });
      const state = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
      return json(200, { model: body.model, answers: Object.fromEntries(names.map((n) => [n, { type: 'noul', noul: opts.systemone(state, n) }])), usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: names.length } });
    }
    if (req.method === 'GET' && path === '/api/tags') {
      const models = [...installed.values()].map((m) => (opts.tagsDigest ? { ...m, digest: opts.tagsDigest(m.name, m.digest) } : m));
      return json(200, { models });
    }
    if (req.method === 'GET' && path === '/api/ps') return json(200, { models: [...loaded.keys()].filter((n) => installed.has(n)).map((n) => ({ ...installed.get(n), size_vram: installed.get(n).size, expires_at: loaded.get(n) })) });
    if (req.method === 'POST' && path === '/api/show') {
      const m = installed.get(body?.model ?? body?.name);
      if (!m) return missing(body?.model ?? body?.name);
      return json(200, { modelfile: '', parameters: '', template: '', details: m.details, model_info: {}, capabilities: m.capabilities, modified_at: m.modified_at });
    }
    if (req.method === 'DELETE' && path === '/api/delete') {
      const name = body?.model ?? body?.name;
      if (!installed.delete(name)) return missing(name);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === 'POST' && path === '/api/pull') {
      const name = body?.model ?? body?.name;
      const lib = library[name];
      if (!lib) return json(500, { error: 'pull model manifest: file does not exist' });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let gone = false;
      res.on('close', () => { if (!res.writableFinished) gone = true; });
      const line = (o) => { if (!gone) res.write(`${JSON.stringify(o)}\n`); };
      line({ status: 'pulling manifest' });
      const size = lib.size ?? 1_000_000_000;
      const layers = Math.max(1, lib.layers ?? 2);
      for (let l = 0; l < layers; l++) {
        const total = l === layers - 1 ? size - Math.floor(size / layers) * (layers - 1) : Math.floor(size / layers);
        const digest = `sha256:${createHash('sha256').update(`${name}:${l}`).digest('hex')}`;
        for (let s = 0; s <= steps; s++) {
          if (gone) return;
          line({ status: `pulling ${digest.slice(7, 19)}`, digest, total, ...(s ? { completed: Math.round((total * s) / steps) } : {}) });
          await wait(delay);
        }
      }
      if (gone) return;
      line({ status: 'verifying sha256 digest' });
      line({ status: 'writing manifest' });
      await wait(delay);
      if (gone) return;
      installed.set(name, entry({ name, size, digest: lib.digest, parameter_size: lib.parameter_size, family: lib.family, capabilities: lib.capabilities }, new Date().toISOString()));
      line({ status: 'success' });
      return res.end();
    }
    if (req.method === 'POST' && path === '/api/embed') {
      if (!installed.has(body?.model)) return missing(body?.model);
      const input = Array.isArray(body.input) ? body.input : [body.input ?? ''];
      return json(200, { model: body.model, embeddings: input.map((t) => [String(t).length % 7 / 7, 0.5, 1]), prompt_eval_count: input.join(' ').length >> 2 });
    }
    if (req.method === 'POST' && path === '/api/chat') {
      if (!installed.has(body?.model)) return missing(body?.model);
      loaded.set(body.model, new Date(Date.now() + 300_000).toISOString());
      const text = await replyFor(body);
      const usage = { prompt_eval_count: JSON.stringify(body.messages ?? []).length >> 2, eval_count: text.length >> 2, total_duration: 1_000_000 };
      if (body.stream === false) return json(200, { model: body.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: text }, done: true, done_reason: 'stop', ...usage });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (let i = 0; i < text.length; i += 16) res.write(`${JSON.stringify({ model: body.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: text.slice(i, i + 16) }, done: false })}\n`);
      res.write(`${JSON.stringify({ model: body.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', ...usage })}\n`);
      return res.end();
    }
    if (req.method === 'GET' && path === '/v1/models') return json(200, { object: 'list', data: [...installed.keys()].map((id) => ({ id, object: 'model', owned_by: 'stand-in' })) });
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      if (!installed.has(body?.model)) return json(404, { error: { message: `model "${body?.model}" not found, try pulling it first` } });
      const text = await replyFor(body);
      const usage = { prompt_tokens: JSON.stringify(body.messages ?? []).length >> 2, completion_tokens: text.length >> 2, total_tokens: 0 };
      if (!body.stream) return json(200, { id: 'chatcmpl-stand-in', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      for (let i = 0; i < text.length; i += 16) send({ model: body.model, choices: [{ index: 0, delta: { content: text.slice(i, i + 16) }, finish_reason: null }] });
      send({ model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      if (body.stream_options?.include_usage) send({ model: body.model, choices: [], usage });
      return res.end('data: [DONE]\n\n');
    }
    return json(404, { error: 'not found' });
  });

  return new Promise((resolveStart, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({
        url: `http://127.0.0.1:${port}`, port, requests,
        setAsleep: (v) => { asleep = !!v; },
        isAsleep: () => asleep,
        installed: () => [...installed.keys()],
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
  const read = (f) => (f ? JSON.parse(readFileSync(f, 'utf8')) : undefined);
  const o = await startFakeOllama({ port: Number(arg('--port', '0')), models: read(arg('--models', null)), library: read(arg('--library', null)) });
  console.log(`fake-ollama listening at ${o.url}`);
}
