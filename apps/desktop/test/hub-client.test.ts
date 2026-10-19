// The shell's own Hub calls against a small HTTP server that speaks the Hub's routes
// (contracts/hub-api.md): the status sources, quick chat and window-capture sends.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isHubSender, isLocalSender, quickSend, sendCapture } from '../src/actions.ts';
import type { CaptureDraft } from '../src/capture/index.ts';
import { HubClient, HubError } from '../src/hub-client.ts';

interface Seen {
  method: string;
  url: string;
  body: unknown;
}
const seen: Seen[] = [];
let signedIn = true;
let failRuns = false;

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    const url = req.url ?? '';
    seen.push({ method: req.method ?? '', url, body: raw ? (JSON.parse(raw) as unknown) : null });
    if (!signedIn)
      return reply(res, 401, { error: { code: 'token_required', message: 'sign in' } });
    const path = url.split('?')[0];
    if (path === '/api/v1/session') return reply(res, 200, { accountId: 'a' });
    if (path === '/api/v1/threads' && req.method === 'GET')
      return reply(res, 200, {
        items: [
          {
            id: 't1',
            mode: 'chat',
            title: 'Hello',
            archived: false,
            temporary: false,
            side: false,
            derived: { status: 'ready', reason: null },
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      });
    if (path === '/api/v1/threads' && req.method === 'POST')
      return reply(res, 201, { id: 'new-thread', title: null });
    if (path === '/api/v1/runs')
      return failRuns
        ? reply(res, 500, { oops: true })
        : reply(res, 200, { items: [], nextCursor: null });
    if (path === '/api/v1/code/sessions') return reply(res, 404, 'not json');
    if (path === '/api/v1/agents') return reply(res, 200, { items: [] });
    if (path === '/api/v1/threads/t1')
      return reply(res, 200, { thread: { id: 't1', title: 'Hello' }, messages: [] });
    if (path?.endsWith('/messages'))
      return reply(res, 202, {
        disposition: 'started',
        turnId: 'u',
        userMessageId: 'm',
        assistantMessageId: 'x',
      });
    if (path === '/api/v1/notifications')
      return reply(res, 200, {
        items: [{ id: 'n1', title: 'T', body: 'B', href: '/chat/t1' }],
        unread: 1,
      });
    if (path === '/api/v1/broken') {
      res.writeHead(500).end('nope');
      return;
    }
    return reply(res, 404, { error: { code: 'not_found', message: 'no such route' } });
  });
}

let server: Server;
let client: HubClient;

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  client = new HubClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, fetch);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  seen.length = 0;
  signedIn = true;
  failRuns = false;
});

describe('HubClient', () => {
  it('collects the status sources and leaves out the ones that fail', async () => {
    failRuns = true;
    const src = await client.statusSources();
    expect(src.threads.map((t) => t.id)).toEqual(['t1']);
    expect(src.runs).toEqual([]);
    expect(src.sessions).toEqual([]);
    expect(seen.map((s) => s.url).sort()).toEqual([
      '/api/v1/agents',
      '/api/v1/code/sessions',
      '/api/v1/runs?limit=30',
      '/api/v1/threads?limit=30',
    ]);
  });

  it('fails the list when signed out, and says so', async () => {
    signedIn = false;
    await expect(client.statusSources()).rejects.toMatchObject({
      status: 401,
      code: 'token_required',
    });
    expect(await client.signedIn()).toBe(false);
    signedIn = true;
    expect(await client.signedIn()).toBe(true);
  });

  it('turns Hub errors into HubError with the code and message', async () => {
    await expect(client.json('/api/v1/missing')).rejects.toEqual(
      new HubError(404, 'not_found', 'no such route'),
    );
    await expect(client.json('/api/v1/broken')).rejects.toMatchObject({
      status: 500,
      code: null,
      message: 'HTTP 500',
    });
  });

  it('reads a thread and the notification behind an event', async () => {
    expect((await client.thread('t1')).title).toBe('Hello');
    expect(await client.notification('n1')).toMatchObject({ href: '/chat/t1' });
    expect(await client.notification('gone')).toBeNull();
  });

  it('rethrows unexpected failures when checking the session', async () => {
    const broken = new HubClient('http://127.0.0.1:1', fetch);
    await expect(broken.signedIn()).rejects.toThrow();
  });
});

describe('quick chat and attach window (FR-008, FR-214)', () => {
  it('sends to the current chat when there is one, else to a new one', async () => {
    expect(await quickSend(client, { text: 'hi', target: 'current' }, 't1')).toEqual({
      threadId: 't1',
      path: '/chat/t1',
      disposition: 'started',
    });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /api/v1/threads/t1/messages']);
    seen.length = 0;
    expect((await quickSend(client, { text: 'hi', target: 'current' }, null)).threadId).toBe(
      'new-thread',
    );
    expect((await quickSend(client, { text: 'hi', target: 'new' }, 't1')).threadId).toBe(
      'new-thread',
    );
    expect(seen.filter((s) => s.method === 'POST' && s.url === '/api/v1/threads')).toHaveLength(2);
    expect(seen.at(-1)?.body).toEqual({ text: 'hi' });
  });

  const draft: CaptureDraft = {
    id: 'd1',
    appName: 'editor',
    windowTitle: 'Report',
    image: { png: Buffer.from('img'), width: 1, height: 1 },
    text: 'some text',
    textNote: null,
    redactions: [],
    passwordFieldsSkipped: 0,
    capturedAt: '2026-10-19T10:00:00.000Z',
  };

  it('attaches the parts the user kept, with the note or a line naming the window', async () => {
    await sendCapture(
      client,
      draft,
      { draftId: 'd1', includeImage: true, includeText: false, note: '  ', target: 'current' },
      't1',
    );
    const body = seen.at(-1)?.body as {
      text: string;
      attachments: { name: string; mime: string }[];
    };
    expect(body.text).toBe('Attached window: Report');
    expect(body.attachments.map((a) => a.mime)).toEqual(['image/png']);
    await sendCapture(
      client,
      draft,
      { draftId: 'd1', includeImage: true, includeText: true, note: 'Look', target: 'new' },
      't1',
    );
    const second = seen.at(-1)?.body as { text: string; attachments: unknown[] };
    expect(second.text).toBe('Look');
    expect(second.attachments).toHaveLength(2);
    expect(seen.at(-1)?.url).toBe('/api/v1/threads/new-thread/messages');
  });

  it('sends nothing when nothing is left to attach', async () => {
    await expect(
      sendCapture(
        client,
        { ...draft, image: null },
        { draftId: 'd1', includeImage: true, includeText: false, note: '', target: 'new' },
        null,
      ),
    ).rejects.toThrow('Nothing is left to attach.');
    expect(seen).toEqual([]);
  });
});

describe('who may call the shell (contracts/ipc-channels.md)', () => {
  it("accepts the shell's own pages and the Hub's top frame only", () => {
    const dir = 'file:///opt/nova/src/renderer';
    expect(isLocalSender('file:///opt/nova/src/renderer/quick.html', dir)).toBe(true);
    expect(isLocalSender('file:///opt/nova/src/other.html', dir)).toBe(false);
    expect(isLocalSender('https://hub.local/quick.html', `${dir}/`)).toBe(false);
    expect(isLocalSender('::', dir)).toBe(false);
    // The frame's real origin, not its URL (review finding 3).
    expect(isHubSender('https://hub.local:7443', 'https://hub.local:7443', true)).toBe(true);
    expect(isHubSender('https://hub.local:7443', 'https://hub.local:7443', false)).toBe(false);
    expect(isHubSender('https://evil.example', 'https://hub.local:7443', true)).toBe(false);
    expect(isHubSender('https://hub.local:7443', null, true)).toBe(false);
    // A sandboxed document served at a Hub URL (a site preview) has the opaque origin "null".
    expect(isHubSender('null', 'https://hub.local:7443', true)).toBe(false);
    expect(isHubSender('null', 'null', true)).toBe(false);
  });
});
