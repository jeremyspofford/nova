#!/usr/bin/env node
// A stand-in OpenAI-compatible server (the API Ollama, llama.cpp and hosted services speak):
// GET /v1/models, and POST /v1/chat/completions streamed as Server-Sent Events
// (chat.completion.chunk deltas, a finish_reason, a usage chunk, then `data: [DONE]`), or as one JSON
// body when stream is false. What it answers is up to the caller; it never calls a model.
//
// As a module (tests):   const s = await startFakeOpenAI({ reply: (req) => '…', model, key });
//                        s.url → http://127.0.0.1:<port>/v1; s.requests; await s.close()
// From the command line (the gate):
//   node scripts/stand-ins/fake-openai.js [--port 0] [--model m] [--reply reply.json] [--key K]
//   reply.json is {"text": "…"} or {"files": [{"path", "content"}], "notes": "…"} (sent as the JSON
//   files contract). It prints "fake-openai listening at <url>".
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {{ reply?: (req: any) => string | Promise<string>, model?: string, key?: string | null, chunk?: number, delayMs?: number, status?: number }} [opts]
 * @returns {Promise<{ url: string, port: number, requests: { method: string, url: string, headers: Record<string, any>, body: any }[], close: () => Promise<void> }>}
 */
export function startFakeOpenAI({ reply = () => 'Hello from the stand-in.', model = 'stand-in-model', key = null, chunk = 12, delayMs = 0, status = 200 } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? (() => { try { return JSON.parse(body); } catch { return null; } })() : null;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: json });
    if (key && req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }));
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'stand-in' }] }));
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'not found' } }));
    }
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `stand-in answering ${status}` } }));
    }
    if (json?.model !== model) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `model "${json?.model}" not found, try pulling it first` }));
    }
    const text = await reply(json);
    const id = `chatcmpl-${requests.length}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: JSON.stringify(json.messages ?? []).length >> 2, completion_tokens: text.length >> 2, total_tokens: 0 };
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    for (let i = 0; i < text.length; i += chunk) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text.slice(i, i + chunk) }, finish_reason: null }] });
    }
    send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    if (json.stream_options?.include_usage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({ url: `http://127.0.0.1:${port}/v1`, port, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

// A reply in the JSON files contract.
export const filesReply = (files, notes = 'Done.') => JSON.stringify({ files, notes });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
  const replyFile = arg('--reply', null);
  const fixed = replyFile ? JSON.parse(readFileSync(replyFile, 'utf8')) : null;
  const s = await startFakeOpenAI({
    model: arg('--model', 'stand-in-model'), key: arg('--key', null),
    reply: () => (fixed?.files ? filesReply(fixed.files, fixed.notes) : fixed?.text ?? 'Hello from the stand-in.'),
  });
  console.log(`fake-openai listening at ${s.url}`);
}
