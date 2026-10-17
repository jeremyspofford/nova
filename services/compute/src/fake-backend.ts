// A scripted OpenAI-compatible model server for tests and offline demos (local-first: a node can
// be exercised end to end with no model installed). It lists models, streams a reply word by word
// as chat-completion chunks, and records requests and early disconnects.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface FakeBackendOptions {
  models?: string[];
  /** The reply's pieces for a request (default: "Echo: <last user text>", word by word). */
  reply?: (body: FakeChatBody) => string[];
  /** Delay between pieces (default 5 ms). */
  delayMs?: number;
  host?: string;
}

export interface FakeChatBody {
  model?: string;
  messages?: { role: string; content: unknown }[];
}

export interface FakeBackend {
  url: string;
  /** Mutable: what /v1/models returns next. */
  models: string[];
  delayMs: number;
  requests: { method: string; path: string; body: FakeChatBody | null }[];
  /** Chat requests whose client disconnected before the reply finished. */
  aborted: number;
  /** Chat requests streaming right now. */
  active: number;
  close(): Promise<void>;
}

function lastUserText(body: FakeChatBody): string {
  const user = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

export async function startFakeBackend(opts: FakeBackendOptions = {}): Promise<FakeBackend> {
  const reply =
    opts.reply ??
    ((body: FakeChatBody) =>
      `Echo: ${lastUserText(body)}`.split(/(?<= )/).filter((p) => p.length > 0));
  const handle: FakeBackend = {
    url: '',
    models: [...(opts.models ?? ['llama3', 'qwen3:8b'])],
    delayMs: opts.delayMs ?? 5,
    requests: [],
    aborted: 0,
    active: 0,
    close: () => Promise.resolve(),
  };

  const chat = (body: FakeChatBody, res: ServerResponse) => {
    const pieces = reply(body);
    const id = `chatcmpl-${handle.requests.length}`;
    const model = body.model ?? 'unknown';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    handle.active++;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    res.on('close', () => {
      clearTimeout(timer);
      handle.active--;
      if (!finished) handle.aborted++;
    });
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const next = (i: number) => {
      if (res.destroyed) return;
      if (i < pieces.length) {
        send({ id, model, choices: [{ index: 0, delta: { content: pieces[i] } }] });
        timer = setTimeout(() => next(i + 1), handle.delayMs);
        return;
      }
      send({ id, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({
        id,
        model,
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: pieces.length },
      });
      finished = true;
      res.end('data: [DONE]\n\n');
    };
    next(0);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      let body: FakeChatBody | null;
      try {
        body = raw ? (JSON.parse(raw) as FakeChatBody) : null;
      } catch {
        body = null;
      }
      handle.requests.push({ method: req.method ?? 'GET', path, body });
      if (req.method === 'GET' && path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: handle.models.map((id) => ({ id, object: 'model' })) }));
        return;
      }
      if (req.method === 'GET' && path === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: handle.models.map((name) => ({ name, model: name })) }));
        return;
      }
      if (req.method === 'POST' && path === '/v1/chat/completions' && body) {
        if (body.model && !handle.models.includes(body.model)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `model ${body.model} not found` } }));
          return;
        }
        chat(body, res);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, opts.host ?? '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  handle.url = `http://${opts.host ?? '127.0.0.1'}:${addr.port}`;
  handle.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return handle;
}
