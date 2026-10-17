// Test doubles: an in-memory Hub behind the Api interface, and a scriptable EventSource. No
// network is used; tests drive streaming by emitting events on the fake source.
// The fake mirrors an async API without doing real I/O, so its methods need not await.
/* eslint-disable @typescript-eslint/require-await */
import { act } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  checkSettingWrite,
  resolveAll,
  type EventEnvelope,
  type MessageView,
  type ModelView,
  type ProviderAccountView,
  type SearchHit,
  type ThreadView,
} from '@nova/shared';
import { ApiError, type Api } from '../src/api.ts';
import { CommandRegistry } from '../src/commands.ts';
import type { EventSourceLike } from '../src/sse.ts';

let seq = 0;
const id = (p: string) => `${p}${(++seq).toString().padStart(4, '0')}`;
const ts = (n = 0) => new Date(Date.UTC(2026, 9, 1, 12, 0, n)).toISOString();

export const MODELS: ModelView[] = [
  {
    ref: 'pa1/mock-fast',
    kind: 'model',
    source: 'account',
    providerAccountId: 'pa1',
    provider: 'mock',
    modelId: 'mock-fast',
    label: 'Mock fast',
    reasoning: false,
  },
  {
    ref: 'pa1/mock-smart',
    kind: 'model',
    source: 'account',
    providerAccountId: 'pa1',
    provider: 'mock',
    modelId: 'mock-smart',
    label: 'Mock smart',
    reasoning: true,
  },
];

export function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: id('t'),
    mode: 'chat',
    title: 'A chat',
    projectId: null,
    pinned: false,
    archived: false,
    unread: false,
    temporary: false,
    state: 'idle',
    model: 'pa1/mock-fast',
    reasoningLevel: null,
    parentThreadId: null,
    branchFromMessageId: null,
    side: false,
    memoryOptOut: false,
    createdAt: ts(),
    updatedAt: ts(),
    ...over,
  };
}

export function message(threadId: string, over: Partial<MessageView> = {}): MessageView {
  return {
    id: id('m'),
    threadId,
    turnId: null,
    role: 'user',
    status: 'complete',
    parts: [{ type: 'text', text: 'hello' }],
    model: null,
    usage: null,
    createdAt: ts(),
    ...over,
  };
}

export interface HubState {
  threads: ThreadView[];
  messages: Map<string, MessageView[]>;
  settings: Record<string, unknown>;
  managed: Record<string, unknown>;
  providers: ProviderAccountView[];
  models: ModelView[];
  displayName: string | null;
  searchHits: SearchHit[];
  /** Make the next call to a method fail. */
  failNext: Partial<Record<keyof Api, ApiError | Error>>;
  testResult: { ok: boolean; detail?: string; models?: number };
}

export const DONE_ONBOARDING = { step: 'done', completed: true, skipped: false };

export function createHub(init: Partial<HubState> = {}) {
  const state: HubState = {
    threads: [],
    messages: new Map(),
    settings: { 'onboarding.state': DONE_ONBOARDING },
    managed: {},
    providers: [],
    models: MODELS,
    displayName: 'Sam',
    searchHits: [],
    failNext: {},
    testResult: { ok: true, models: 2 },
    ...init,
  };

  const maybeFail = (name: keyof Api) => {
    const err = state.failNext[name];
    if (err) {
      delete state.failNext[name];
      throw err;
    }
  };
  const notFound = () =>
    new ApiError(404, { code: 'not_found', message: 'Not found', retryable: false });
  const find = (tid: string) => {
    const t = state.threads.find((x) => x.id === tid);
    if (!t) throw notFound();
    return t;
  };
  const layers = () => ({ global: state.settings, managed: state.managed });

  const impl: Api = {
    hello: async () => ({
      name: 'nova-hub',
      version: '0.1.0',
      apiVersions: ['v1'],
      setupRequired: false,
    }),
    session: async () => {
      maybeFail('session');
      return { accountId: 'a1', displayName: state.displayName };
    },
    setup: async () => ({ accountId: 'a1' }),
    logout: async () => ({ ok: true }) as const,
    settings: async () => ({ settings: resolveAll(layers()) }),
    setSetting: async (key, value) => {
      maybeFail('setSetting');
      const check = checkSettingWrite(key, value, 'global', layers());
      if (!check.ok)
        throw new ApiError(check.error === 'managed' ? 403 : 400, {
          code: check.error === 'managed' ? 'policy_denied' : 'validation',
          message: check.message,
          retryable: false,
        });
      state.settings = { ...state.settings, [key]: check.value };
      return { settings: resolveAll(layers()) };
    },
    listProviders: async () => ({ items: state.providers }),
    createProvider: async (body) => {
      maybeFail('createProvider');
      const p: ProviderAccountView = {
        id: id('pa'),
        provider: body.provider,
        label: body.label,
        authKind: body.apiKey ? 'api_key' : 'none',
        baseUrl: body.baseUrl ?? null,
        status: 'active',
        hasSecret: !!body.apiKey,
        lastCheckAt: null,
        createdAt: ts(),
      };
      state.providers = [...state.providers, p];
      return p;
    },
    deleteProvider: async (pid) => {
      state.providers = state.providers.filter((p) => p.id !== pid);
      return { ok: true } as const;
    },
    testProvider: async () => state.testResult,
    listModels: async () => ({ items: state.models }),
    updateAccount: async (body) => {
      maybeFail('updateAccount');
      if (body.displayName !== undefined) state.displayName = body.displayName;
      return { accountId: 'a1', displayName: state.displayName };
    },
    listThreads: async (q = {}) => {
      maybeFail('listThreads');
      const items = state.threads
        .filter((t) => (q.archived ? true : !t.archived))
        .sort(
          (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
        );
      return { items, nextCursor: null };
    },
    createThread: async (body) => {
      maybeFail('createThread');
      const t = thread({
        title: body.title ?? null,
        model: body.model ?? state.models[0]?.ref ?? null,
        updatedAt: ts(59),
      });
      state.threads = [t, ...state.threads];
      state.messages.set(t.id, []);
      return t;
    },
    getThread: async (tid) => {
      maybeFail('getThread');
      return { thread: { ...find(tid) }, messages: [...(state.messages.get(tid) ?? [])] };
    },
    updateThread: async (tid, body) => {
      maybeFail('updateThread');
      const t = find(tid);
      const next: ThreadView = { ...t, ...body };
      state.threads = state.threads.map((x) => (x.id === tid ? next : x));
      return next;
    },
    deleteThread: async (tid) => {
      maybeFail('deleteThread');
      state.threads = state.threads.filter((t) => t.id !== tid);
      return { ok: true } as const;
    },
    sendMessage: async (tid, body) => {
      maybeFail('sendMessage');
      find(tid);
      const turnId = id('turn');
      const user = message(tid, {
        role: 'user',
        turnId,
        parts: [
          { type: 'text', text: body.text },
          ...(body.attachments ?? []).map((a) => ({
            type: 'file' as const,
            attachmentId: id('att'),
            name: a.name,
            mime: a.mime,
            size: a.data.length,
          })),
        ],
      });
      const assistant = message(tid, { role: 'assistant', turnId, status: 'streaming', parts: [] });
      state.messages.set(tid, [...(state.messages.get(tid) ?? []), user, assistant]);
      return {
        disposition: 'started' as const,
        turnId,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
      };
    },
    cancel: async () => ({ ok: true, cancelled: true }) as const,
    search: async () => {
      maybeFail('search');
      return { items: state.searchHits };
    },
    attachmentUrl: (aid) => `/api/v1/attachments/${aid}`,
    fetchAttachment: async () => new Blob(['file-bytes'], { type: 'text/plain' }),
    threadStreamUrl: (tid) => `/api/v1/threads/${tid}/stream`,
  };

  // Every method is a spy so tests can assert calls.
  const api = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as Api & Record<keyof Api, Mock<(...args: never[]) => unknown>>;

  /** Finish an assistant message in the store (what the Hub persists on completion). */
  const persist = (tid: string, mid: string, patch: Partial<MessageView>) => {
    state.messages.set(
      tid,
      (state.messages.get(tid) ?? []).map((m) => (m.id === mid ? { ...m, ...patch } : m)),
    );
  };

  return { api, state, persist };
}

// ---- EventSource --------------------------------------------------------------------------------

export class FakeEventSource implements EventSourceLike {
  static all: FakeEventSource[] = [];
  readyState = 0;
  onopen: EventSourceLike['onopen'] = null;
  onerror: EventSourceLike['onerror'] = null;
  readonly url: string;
  readonly listeners = new Map<string, Set<(ev: MessageEvent<string>) => void>>();
  closed = false;
  #n = 0;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.all.push(this);
  }

  static reset() {
    FakeEventSource.all = [];
  }

  /** The newest open source whose URL contains `part`. */
  static for(part: string): FakeEventSource {
    const s = [...FakeEventSource.all].reverse().find((x) => !x.closed && x.url.includes(part));
    if (!s) throw new Error(`no open event source for ${part}`);
    return s;
  }

  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.onopen?.call(this, new Event('open'));
  }

  emitRaw(name: string, data: string, lastEventId = '') {
    for (const l of this.listeners.get(name) ?? [])
      l(new MessageEvent(name, { data, lastEventId }));
  }

  emit(name: string, payload: Record<string, unknown>, threadId?: string): EventEnvelope {
    const env: EventEnvelope = {
      id: `ev-${this.url.length}-${++this.#n}`,
      name,
      schemaVersion: 1,
      ts: ts(),
      actor: 'system',
      payload,
      ...(threadId ? { correlation: { threadId } } : {}),
    };
    act(() => this.emitRaw(name, JSON.stringify(env), env.id));
    return env;
  }

  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.call(this, new Event('error'));
  }
}

export const fakeEventSource = (url: string) => new FakeEventSource(url);

export function testRegistry(mac = false, browserTab = false) {
  return new CommandRegistry({ mac, browserTab });
}

/** Simulate a full assistant reply on a thread's stream. */
export function streamReply(
  es: FakeEventSource,
  tid: string,
  mid: string,
  chunks: string[],
  end: 'complete' | 'incomplete' | 'error' | null = 'complete',
) {
  es.emit('turn.started', { threadId: tid, turnId: 'turn' }, tid);
  for (const text of chunks)
    es.emit('chat.delta', { threadId: tid, messageId: mid, type: 'text_delta', text }, tid);
  if (end) {
    es.emit(
      'chat.message.completed',
      { threadId: tid, messageId: mid, status: end, usage: null },
      tid,
    );
    es.emit(end === 'incomplete' ? 'turn.interrupted' : 'turn.completed', { threadId: tid }, tid);
  }
}
