import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_LIMITS } from '@nova/shared';
import { dark, highContrastLight, light } from '@nova/ui';
import { ApiError, createApi, errorMessage } from '../src/api.ts';
import {
  applyAppearance,
  contrastWarnings,
  readCachedTheme,
  resolveAppearance,
  toggledTheme,
  writeCachedTheme,
  type AppearanceSettings,
} from '../src/appearance.ts';
import {
  acceptedMime,
  checkFiles,
  formatBytes,
  pendingFromText,
  readAsBase64,
  textToBase64,
} from '../src/chat/attachments.ts';
import { threadStatus } from '../src/chat/status.ts';
import {
  initialThreadState,
  isStreaming,
  messageText,
  threadReducer,
  type ThreadState,
} from '../src/chat/thread-state.ts';
import { chatPath, navigate, parseRoute, routeMode } from '../src/router.ts';
import { THREAD_EVENTS, openStream } from '../src/sse.ts';
import { FakeEventSource, message, thread } from './fakes.ts';

afterEach(() => {
  vi.useRealTimers();
  FakeEventSource.reset();
});

function fetchStub(status = 200, body: unknown = {}) {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

describe('api client', () => {
  it('sends every M1 call with the right method, path and body', async () => {
    const f = fetchStub();
    const api = createApi(f);
    await api.listProviders();
    await api.createProvider({ provider: 'openai', label: 'OpenAI', apiKey: 'sk-1' });
    await api.deleteProvider('p/1');
    await api.testProvider('p1');
    await api.listModels();
    await api.updateAccount({ displayName: 'Sam' });
    await api.listThreads({ mode: 'chat', archived: true, limit: 10 });
    await api.listThreads();
    await api.createThread({ mode: 'chat', title: 'Hi' });
    await api.getThread('t1');
    await api.updateThread('t1', { pinned: true });
    await api.deleteThread('t1');
    await api.sendMessage('t1', { text: 'hello' });
    await api.cancel('t1');
    await api.search('cats & dogs', 5);
    await api.logout();
    const calls = f.mock.calls.map((c) => {
      const [path, init] = c as unknown as [string, RequestInit];
      return `${init.method} ${path}${typeof init.body === 'string' ? ` ${init.body}` : ''}`;
    });
    expect(calls).toEqual([
      'GET /api/v1/providers',
      'POST /api/v1/providers {"provider":"openai","label":"OpenAI","apiKey":"sk-1"}',
      'DELETE /api/v1/providers/p%2F1',
      'POST /api/v1/providers/p1/test',
      'GET /api/v1/models',
      'PATCH /api/v1/account {"displayName":"Sam"}',
      'GET /api/v1/threads?mode=chat&archived=true&limit=10',
      'GET /api/v1/threads',
      'POST /api/v1/threads {"mode":"chat","title":"Hi"}',
      'GET /api/v1/threads/t1',
      'PATCH /api/v1/threads/t1 {"pinned":true}',
      'DELETE /api/v1/threads/t1',
      'POST /api/v1/threads/t1/messages {"text":"hello"}',
      'POST /api/v1/threads/t1/cancel',
      'GET /api/v1/search?q=cats+%26+dogs&limit=5',
      'POST /api/v1/auth/logout',
    ]);
    expect(api.threadStreamUrl('t 1')).toBe('/api/v1/threads/t%201/stream');
    expect(api.attachmentUrl('a1')).toBe('/api/v1/attachments/a1');
  });

  it('turns error bodies into ApiError and keeps a fallback for empty bodies', async () => {
    const api = createApi(
      fetchStub(409, { error: { code: 'conflict', message: 'busy', retryable: true } }),
    );
    const err = await api.sendMessage('t1', { text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    const bare = createApi(vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))));
    await expect(bare.listModels()).rejects.toMatchObject({ body: { code: 'server_error' } });
  });

  it('fetches attachment bytes and reports a missing one', async () => {
    const ok = createApi(vi.fn(() => Promise.resolve(new Response('bytes', { status: 200 }))));
    expect(await (await ok.fetchAttachment('a1')).text()).toBe('bytes');
    const missing = createApi(vi.fn(() => Promise.resolve(new Response('', { status: 404 }))));
    await expect(missing.fetchAttachment('a1')).rejects.toBeInstanceOf(ApiError);
  });

  it('words errors for people', () => {
    expect(errorMessage(new ApiError(400, { code: 'x', message: 'Bad', retryable: false }))).toBe(
      'Bad',
    );
    expect(errorMessage(new TypeError('Failed to fetch'))).toMatch(/Cannot reach the Hub/);
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('weird', 'Fallback')).toBe('Fallback');
  });
});

describe('SSE helper', () => {
  const env = (id: string, name = 'chat.delta') =>
    JSON.stringify({ id, name, schemaVersion: 1, ts: 'x', actor: 'system', payload: { n: id } });

  it('delivers named events once, skips malformed frames, and closes', () => {
    const got: string[] = [];
    const h = openStream(
      '/s',
      { onEvent: (e) => got.push(e.id), onOpen: vi.fn() },
      { names: THREAD_EVENTS, factory: (u) => new FakeEventSource(u) },
    );
    const es = FakeEventSource.for('/s');
    es.open();
    es.emitRaw('chat.delta', env('e1'), 'e1');
    es.emitRaw('chat.delta', env('e1'), 'e1');
    es.emitRaw('chat.delta', 'not json');
    es.emitRaw('chat.delta', JSON.stringify({ nope: true }));
    es.emitRaw('turn.started', env('e2', 'turn.started'));
    expect(got).toEqual(['e1', 'e2']);
    expect(h.lastEventId()).toBe('e2');
    h.close();
    expect(es.closed).toBe(true);
  });

  it('lets the browser retry, and reopens a closed stream after the last id with backoff', () => {
    vi.useFakeTimers();
    const reconnecting = vi.fn();
    const h = openStream(
      '/s?x=1',
      { onEvent: () => undefined, onReconnecting: reconnecting },
      { names: ['chat.delta'], factory: (u) => new FakeEventSource(u), baseDelayMs: 100 },
    );
    const first = FakeEventSource.for('/s');
    first.emitRaw('chat.delta', env('e9'), 'e9');
    first.fail(false);
    expect(reconnecting).toHaveBeenLastCalledWith(true);
    expect(FakeEventSource.all).toHaveLength(1);
    first.fail(true);
    vi.advanceTimersByTime(100);
    const second = FakeEventSource.for('after=');
    expect(second.url).toBe('/s?x=1&after=e9');
    second.open();
    expect(reconnecting).toHaveBeenLastCalledWith(false);
    second.fail(true);
    h.close();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.all).toHaveLength(2);
  });
});

describe('attachments (FR-021)', () => {
  const file = (name: string, type: string, size = 10) => {
    const f = new File(['x'.repeat(Math.min(size, 50))], name, { type });
    Object.defineProperty(f, 'size', { value: size });
    return f;
  };

  it('accepts allowed types and code files by extension', () => {
    expect(acceptedMime({ name: 'a.png', type: 'image/png' })).toBe('image/png');
    expect(acceptedMime({ name: 'main.ts', type: 'video/mp2t' })).toBe('text/plain');
    expect(acceptedMime({ name: 'README.md', type: '' })).toBe('text/markdown');
    expect(acceptedMime({ name: 'data.json', type: '' })).toBe('application/json');
    expect(acceptedMime({ name: 'rows.csv', type: '' })).toBe('text/csv');
    expect(acceptedMime({ name: 'tool.exe', type: 'application/x-msdownload' })).toBeNull();
    expect(acceptedMime({ name: 'noext', type: '' })).toBeNull();
  });

  it('rejects bad types, oversize files and too many files with specific messages', () => {
    const big = file('big.pdf', 'application/pdf', ATTACHMENT_LIMITS.maxBytes + 1);
    const { accepted, rejected } = checkFiles(
      [file('ok.txt', 'text/plain'), file('x.exe', ''), big],
      0,
    );
    expect(accepted.map((a) => a.file.name)).toEqual(['ok.txt']);
    expect(rejected[0]!.reason).toMatch(/not a supported file type/);
    expect(rejected[1]!.reason).toMatch(/big\.pdf is 20\.0 MB; the limit is 20\.0 MB/);
    const many = checkFiles([file('a.txt', 'text/plain'), file('b.txt', 'text/plain')], 9);
    expect(many.accepted).toHaveLength(1);
    expect(many.rejected[0]!.reason).toMatch(/up to 10 attachments/);
  });

  it('encodes files and text as base64', async () => {
    expect(await readAsBase64(new Blob(['hi']))).toBe('aGk=');
    expect(textToBase64('é')).toBe('w6k=');
    const p = pendingFromText('a.md', 'text/markdown', 'hi');
    expect(p).toMatchObject({ name: 'a.md', data: 'aGk=', size: 2 });
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(50 * 1024)).toBe('50 KB');
  });
});

describe('appearance (FR-010)', () => {
  const base: AppearanceSettings = {
    theme: 'dark',
    accent: null,
    background: null,
    foreground: null,
    uiFont: null,
    codeFont: null,
    fontScale: 1,
    reducedMotion: 'system',
  };

  it('uses the theme as-is without overrides', () => {
    const a = resolveAppearance(base, true);
    expect(a.theme.tokens).toEqual(dark.tokens);
    expect(a.motion).toBeNull();
    expect(resolveAppearance({ ...base, theme: 'system' }, false).theme.id).toBe(light.id);
  });

  it('applies color overrides and derives readable companions', () => {
    const a = resolveAppearance(
      { ...base, accent: '#ffd60a', background: '#ffffff', foreground: '#111111' },
      true,
    );
    expect(a.theme.tokens['--u-accent']).toBe('#ffd60a');
    expect(a.theme.tokens['--u-accent-contrast']).toBe('#000000');
    expect(a.theme.tokens['--u-bg']).toBe('#ffffff');
    expect(a.theme.tokens['--u-surface']).not.toBe(dark.tokens['--u-surface']);
    // A bad value from storage is ignored rather than applied.
    expect(resolveAppearance({ ...base, accent: 'red' }, true).theme.tokens['--u-accent']).toBe(
      dark.tokens['--u-accent'],
    );
  });

  it('writes tokens, fonts, scale and motion to the root element', () => {
    const el = document.createElement('div');
    applyAppearance(
      resolveAppearance(
        { ...base, uiFont: 'Inter, sans-serif', fontScale: 1.25, reducedMotion: 'on' },
        true,
      ),
      el,
    );
    expect(el.style.getPropertyValue('--u-font-ui')).toBe('Inter, sans-serif');
    expect(el.style.getPropertyValue('--u-font-scale')).toBe('1.25');
    expect(el.dataset.motion).toBe('reduce');
    applyAppearance(resolveAppearance({ ...base, reducedMotion: 'off' }, true), el);
    expect(el.style.getPropertyValue('--u-font-ui')).toBe('');
    expect(el.dataset.motion).toBe('full');
    applyAppearance(resolveAppearance(base, true), el);
    expect(el.dataset.motion).toBeUndefined();
  });

  it('warns when contrast is below WCAG AA', () => {
    expect(contrastWarnings(dark)).toEqual([]);
    const low = resolveAppearance({ ...base, background: '#777777', foreground: '#888888' }, true);
    const w = contrastWarnings(low.theme);
    expect(w[0]).toMatchObject({ pair: 'Text on background', minimum: 4.5 });
    expect(w[0]!.ratio).toBeLessThan(1.5);
  });

  it('toggles variants and caches the theme per device', () => {
    expect(toggledTheme('dark', true)).toBe('light');
    expect(toggledTheme('system', true)).toBe('light');
    expect(toggledTheme('light', true)).toBe('dark');
    expect(toggledTheme('high-contrast-dark', true)).toBe('high-contrast-light');
    expect(toggledTheme('high-contrast-light', true)).toBe('high-contrast-dark');
    writeCachedTheme('high-contrast-light');
    expect(readCachedTheme()).toBe('high-contrast-light');
    window.localStorage.setItem('nova.theme', 'bogus');
    expect(readCachedTheme()).toBe('system');
    expect(highContrastLight.variant).toBe('light');
  });
});

describe('routes', () => {
  it('parses every route and falls back to chat', () => {
    expect(parseRoute('/')).toEqual({ name: 'chat', threadId: null, messageId: null });
    expect(parseRoute('/chat/t%201', '?m=m1')).toEqual({
      name: 'chat',
      threadId: 't 1',
      messageId: 'm1',
    });
    expect(parseRoute('/work')).toEqual({ name: 'mode', mode: 'work' });
    expect(parseRoute('/settings/keyboard')).toEqual({ name: 'settings', section: 'keyboard' });
    expect(parseRoute('/settings/nope')).toEqual({ name: 'settings', section: 'general' });
    expect(parseRoute('/onboarding')).toEqual({ name: 'onboarding' });
    expect(parseRoute('/unknown')).toEqual({ name: 'chat', threadId: null, messageId: null });
    expect(routeMode(parseRoute('/agents'))).toBe('agents');
    expect(routeMode(parseRoute('/onboarding'))).toBeNull();
    expect(chatPath('a b', 'm')).toBe('/chat/a%20b?m=m');
  });

  it('pushes and replaces history entries and ignores no-op navigation', () => {
    const fn = vi.fn();
    window.addEventListener('nova:navigate', fn);
    navigate('/work');
    navigate('/work');
    navigate('/code', { replace: true });
    expect(window.location.pathname).toBe('/code');
    expect(fn).toHaveBeenCalledTimes(2);
    window.removeEventListener('nova:navigate', fn);
  });
});

describe('thread state (FR-018)', () => {
  const t = thread({ id: 't1' });
  const loaded = (s: ThreadState, messages = s.messages) =>
    threadReducer(s, { type: 'loaded', detail: { thread: t, messages } });

  it('merges optimistic sends with events that race the HTTP response', () => {
    let s = loaded(initialThreadState(t), []);
    s = threadReducer(s, {
      type: 'optimistic',
      message: { ...message('t1', { id: 'local-1' }), local: true },
    });
    // The created event for our user message arrives first and is ignored.
    s = threadReducer(s, { type: 'created', messageId: 'u1', role: 'user', turnId: 'x' });
    expect(s.messages.map((m) => m.id)).toEqual(['local-1']);
    // Deltas before the assistant placeholder exists are buffered.
    s = threadReducer(s, {
      type: 'delta',
      payload: { threadId: 't1', messageId: 'a1', type: 'text_delta', text: 'Hel' },
    });
    s = threadReducer(s, {
      type: 'accepted',
      tempId: 'local-1',
      res: { disposition: 'started', turnId: 'x', userMessageId: 'u1', assistantMessageId: 'a1' },
    });
    expect(s.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(isStreaming(s)).toBe(true);
    s = threadReducer(s, {
      type: 'delta',
      payload: { threadId: 't1', messageId: 'a1', type: 'reasoning_delta', text: 'think' },
    });
    expect(messageText(s.messages[1]!, s.streamed.a1)).toBe('Hel');
    expect(s.reasoning.a1).toBe('think');
    s = threadReducer(s, {
      type: 'completed',
      payload: { threadId: 't1', messageId: 'a1', status: 'incomplete', usage: null },
    });
    expect(s.messages[1]!.status).toBe('incomplete');
    expect(messageText(s.messages[1]!, undefined)).toBe('Hel');
    // A replayed delta after completion is ignored.
    s = threadReducer(s, {
      type: 'delta',
      payload: { threadId: 't1', messageId: 'a1', type: 'text_delta', text: 'XX' },
    });
    expect(s.streamed.a1).toBeUndefined();
    s = threadReducer(s, { type: 'turn', running: false });
    expect(isStreaming(s)).toBe(false);
  });

  it('fills a created placeholder when it beats the accept, and drops failed sends', () => {
    let s = loaded(initialThreadState(t), []);
    s = threadReducer(s, { type: 'created', messageId: 'u9', role: 'user', turnId: null });
    s = threadReducer(s, {
      type: 'optimistic',
      message: {
        ...message('t1', { id: 'local-2', parts: [{ type: 'text', text: 'hey' }] }),
        local: true,
      },
    });
    s = threadReducer(s, {
      type: 'accepted',
      tempId: 'local-2',
      res: { disposition: 'started', turnId: 'x', userMessageId: 'u9', assistantMessageId: 'a9' },
    });
    expect(s.messages.map((m) => m.id)).toEqual(['u9', 'a9']);
    expect(messageText(s.messages[0]!, undefined)).toBe('hey');
    s = threadReducer(s, {
      type: 'optimistic',
      message: { ...message('t1', { id: 'local-3' }), local: true },
    });
    s = threadReducer(s, { type: 'send_failed', tempId: 'local-3' });
    expect(s.messages.some((m) => m.id === 'local-3')).toBe(false);
    s = threadReducer(s, { type: 'created', messageId: 'a9', role: 'assistant', turnId: null });
    expect(s.messages).toHaveLength(2);
  });

  it('keeps in-flight bubbles and streamed text across reloads', () => {
    let s = initialThreadState(null);
    expect(s.status).toBe('ready');
    s = initialThreadState(thread({ id: 't1', state: 'streaming' }));
    expect(s.turnRunning).toBe(true);
    s = threadReducer(s, { type: 'created', messageId: 'a2', role: 'assistant', turnId: null });
    s = threadReducer(s, {
      type: 'delta',
      payload: { threadId: 't1', messageId: 'a2', type: 'text_delta', text: 'partial' },
    });
    s = loaded(s, [message('t1', { id: 'a2', role: 'assistant', status: 'streaming', parts: [] })]);
    expect(s.streamed.a2).toBe('partial');
    s = threadReducer(s, { type: 'load_failed', message: 'gone' });
    expect(s.status).toBe('error');
    s = threadReducer(s, { type: 'thread', thread: { ...t, title: 'New' } });
    expect(s.thread?.title).toBe('New');
  });

  it('never shows persisted partial text twice', () => {
    const m = message('t1', { parts: [{ type: 'text', text: 'Hello' }] });
    expect(messageText(m, 'Hello world')).toBe('Hello world');
    expect(messageText(m, ' more')).toBe('Hello more');
    expect(messageText({ ...m, parts: [] }, 'x')).toBe('x');
  });

  it('derives the status chip from runtime state (FR-215)', () => {
    expect(threadStatus({ state: 'idle' })).toBe('ready');
    expect(threadStatus({ state: 'idle' }, true)).toBe('running');
    expect(threadStatus({ state: 'streaming' })).toBe('running');
    expect(threadStatus({ state: 'waiting_approval' })).toBe('needs_input');
    expect(threadStatus({ state: 'waiting_input' })).toBe('needs_input');
    expect(threadStatus({ state: 'error' })).toBe('blocked');
  });
});
