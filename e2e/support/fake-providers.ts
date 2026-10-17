// Fake model servers for E2E journeys: an Anthropic-style Messages API and an Ollama-style
// local server (OpenAI-compatible /v1 plus /api/tags). Replies describe what the server was
// sent, so a journey can check context, memory and which model answered.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeServer {
  url: string;
  /** Request bodies received on the chat endpoint, oldest first. */
  requests: unknown[];
  stop(): Promise<void>;
}

interface Turn {
  role: string;
  text: string;
}

/** The reply every fake sends: model, how many user messages it saw, the first one, memory. */
export function describeRequest(model: string, system: string, turns: Turn[]): string {
  const users = turns.filter((t) => t.role === 'user');
  const first = users[0]?.text.replace(/\s+/g, ' ').slice(0, 80) ?? '';
  const memory = /know about the user/i.test(system) ? 'yes' : 'none';
  return `[${model}] Seen ${users.length} user messages. First: "${first}". Memory: ${memory}.`;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
      .join('');
  return '';
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sse(res: ServerResponse): (event: string | null, data: unknown) => void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  return (event, data) =>
    res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}

/** A reply streams slowly (250 ms per chunk) when the newest user message contains `[slow]`. */
export function isSlow(turns: Turn[]): boolean {
  return (
    turns
      .filter((t) => t.role === 'user')
      .at(-1)
      ?.text.includes('[slow]') ?? false
  );
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Split into a few chunks so the client sees a real stream. */
function chunks(text: string): string[] {
  const words = text.split(/(?<= )/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 4) out.push(words.slice(i, i + 4).join(''));
  return out;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function stopper(server: Server): () => Promise<void> {
  return () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
}

export async function startFakeAnthropic(model = 'claude-test-1'): Promise<FakeServer> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').replace(/\?.*$/, '');
      if (req.method === 'GET' && path.endsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [{ id: model, display_name: 'Test Claude', type: 'model' }],
            has_more: false,
            first_id: model,
            last_id: model,
          }),
        );
        return;
      }
      if (req.method === 'POST' && path.endsWith('/v1/messages')) {
        const body = await readJson(req);
        requests.push(body);
        const system = textOf(body.system);
        const turns = ((body.messages as { role: string; content: unknown }[]) ?? []).map((m) => ({
          role: m.role,
          text: textOf(m.content),
        }));
        const reply = describeRequest(
          typeof body.model === 'string' ? body.model : model,
          system,
          turns,
        );
        const send = sse(res);
        send('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_fake',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        for (const c of chunks(reply))
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: c },
          });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 20 },
        });
        send('message_stop', { type: 'message_stop' });
        res.end();
        return;
      }
      res.writeHead(404).end();
    })();
  });
  const url = await listen(server);
  return { url, requests, stop: stopper(server) };
}

export async function startFakeOllama(model = 'local-test:1b'): Promise<FakeServer> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').replace(/\?.*$/, '');
      if (req.method === 'GET' && path === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: model, model, size: 1 }] }));
        return;
      }
      if (req.method === 'GET' && path.endsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
        return;
      }
      if (req.method === 'POST' && path.endsWith('/v1/chat/completions')) {
        const body = await readJson(req);
        requests.push(body);
        const msgs = (body.messages as { role: string; content: unknown }[]) ?? [];
        const system = msgs
          .filter((m) => m.role === 'system')
          .map((m) => textOf(m.content))
          .join('\n');
        const turns = msgs
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, text: textOf(m.content) }));
        const reply = describeRequest(
          typeof body.model === 'string' ? body.model : model,
          system,
          turns,
        );
        const slow = isSlow(turns);
        const send = sse(res);
        for (const c of chunks(reply)) {
          if (slow) await pause(250);
          send(null, {
            id: 'chatcmpl-fake',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta: { content: c }, finish_reason: null }],
          });
        }
        send(null, {
          id: 'chatcmpl-fake',
          object: 'chat.completion.chunk',
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404).end();
    })();
  });
  const url = await listen(server);
  return { url, requests, stop: stopper(server) };
}
