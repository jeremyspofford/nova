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
  type QueuedInputView,
  type SearchHit,
  type ThreadView,
} from '@nova/shared';
import { ApiError, type Api } from '../src/api.ts';
import { CommandRegistry } from '../src/commands.ts';
import type { EventSourceLike } from '../src/sse.ts';
import type { SocketLike, TerminalScreen } from '../src/terminal/session.ts';
import { m3Impl, m3State, type M3State } from './fakes-m3.ts';
import { m4Impl, m4State, type M4State } from './fakes-m4.ts';
import { workspaceImpl, workspaceState, type WorkspaceState } from './fakes-workspace.ts';

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
  /** Queued follow-ups per thread (FR-019). */
  queues: Map<string, QueuedInputView[]>;
  /** The active path selectVersion switches to, per selected message id (FR-020). */
  paths: Map<string, MessageView[]>;
  /** Projects, sources, memory, presets and nodes (test/fakes-workspace.ts). */
  workspace: WorkspaceState;
  /** Approvals, policy, tools, MCP, notifications, audit, artifacts (test/fakes-m3.ts). */
  m3: M3State;
  /** Plugins, skills, hooks, clients, workspace, profile and import (test/fakes-m4.ts). */
  m4: M4State;
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
    queues: new Map(),
    paths: new Map(),
    workspace: workspaceState(),
    m3: m3State(),
    m4: m4State(),
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
      // Side chats are never listed (FR-026).
      const items = state.threads
        .filter((t) => (q.archived ? true : !t.archived))
        .filter((t) => !t.side && (!q.projectId || t.projectId === q.projectId))
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
        temporary: body.temporary ?? false,
        memoryOptOut: body.memoryOptOut ?? false,
        projectId: body.projectId ?? null,
        updatedAt: ts(59),
      });
      state.threads = [t, ...state.threads];
      state.messages.set(t.id, []);
      return t;
    },
    getThread: async (tid) => {
      maybeFail('getThread');
      return {
        thread: { ...find(tid) },
        messages: [...(state.messages.get(tid) ?? [])],
        queue: [...(state.queues.get(tid) ?? [])],
      };
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
      // While a reply streams, the message steers it or waits in the queue (FR-019).
      const running = (state.messages.get(tid) ?? []).find(
        (m) => m.role === 'assistant' && m.status === 'streaming',
      );
      if (running) {
        const mode = body.inputMode ?? (state.settings['general.followUp'] as string) ?? 'queue';
        if (mode === 'steer') {
          const steer = message(tid, {
            role: 'user',
            turnId: running.turnId,
            provenance: 'steer',
            parts: [{ type: 'text', text: body.text }],
          });
          state.messages.set(tid, [...(state.messages.get(tid) ?? []), steer]);
          return {
            disposition: 'steered' as const,
            turnId: running.turnId,
            userMessageId: steer.id,
            assistantMessageId: null,
          };
        }
        const list = state.queues.get(tid) ?? [];
        const item: QueuedInputView = {
          id: id('q'),
          threadId: tid,
          text: body.text,
          attachmentCount: body.attachments?.length ?? 0,
          position: list.length + 1,
          createdAt: ts(),
        };
        state.queues.set(tid, [...list, item]);
        return {
          disposition: 'queued' as const,
          turnId: null,
          userMessageId: item.id,
          assistantMessageId: null,
          queuePosition: item.position,
        };
      }
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
    listQueue: async (tid) => {
      maybeFail('listQueue');
      return { items: state.queues.get(tid) ?? [] };
    },
    cancelQueued: async (tid, qid) => {
      maybeFail('cancelQueued');
      state.queues.set(
        tid,
        (state.queues.get(tid) ?? []).filter((q) => q.id !== qid),
      );
      return { ok: true } as const;
    },
    editMessage: async (tid, mid, body) => {
      maybeFail('editMessage');
      find(tid);
      const turnId = id('turn');
      const msgs = state.messages.get(tid) ?? [];
      const at = msgs.findIndex((m) => m.id === mid);
      if (at < 0) throw notFound();
      const original = msgs[at]!;
      const user = message(tid, {
        role: 'user',
        turnId,
        parentId: original.parentId ?? null,
        parts: [{ type: 'text', text: body.text }],
      });
      user.siblingIds = [...(original.siblingIds ?? [original.id]), user.id];
      const assistant = message(tid, {
        role: 'assistant',
        turnId,
        parentId: user.id,
        status: 'streaming',
        parts: [],
      });
      state.messages.set(tid, [...msgs.slice(0, at), user, assistant]);
      return {
        disposition: 'started' as const,
        turnId,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
      };
    },
    regenerate: async (tid, mid) => {
      maybeFail('regenerate');
      find(tid);
      const turnId = id('turn');
      const msgs = state.messages.get(tid) ?? [];
      const at = msgs.findIndex((m) => m.id === mid);
      if (at < 0) throw notFound();
      const parent = msgs[at]!.parentId ?? msgs[at - 1]?.id ?? null;
      const assistant = message(tid, {
        role: 'assistant',
        turnId,
        parentId: parent,
        status: 'streaming',
        parts: [],
      });
      state.messages.set(tid, [...msgs.slice(0, at), assistant]);
      return {
        disposition: 'started' as const,
        turnId,
        userMessageId: parent ?? '',
        assistantMessageId: assistant.id,
      };
    },
    selectVersion: async (tid, mid) => {
      maybeFail('selectVersion');
      const path = state.paths.get(mid);
      if (path) state.messages.set(tid, [...path]);
      return { thread: { ...find(tid) }, messages: [...(state.messages.get(tid) ?? [])] };
    },
    deleteMessage: async (tid, mid) => {
      maybeFail('deleteMessage');
      // A user message takes the reply in its turn with it (FR-020).
      const msgs = state.messages.get(tid) ?? [];
      const target = msgs.find((m) => m.id === mid);
      if (!target) throw notFound();
      state.messages.set(
        tid,
        msgs.filter(
          (m) =>
            m.id !== mid &&
            !(target.role === 'user' && target.turnId && m.turnId === target.turnId),
        ),
      );
      return { ok: true } as const;
    },
    branch: async (tid, fromMessageId, title) => {
      maybeFail('branch');
      const parent = find(tid);
      const t = thread({
        title: title ?? `Branch of ${parent.title ?? 'chat'}`,
        parentThreadId: tid,
        branchFromMessageId: fromMessageId,
        model: parent.model,
      });
      state.threads = [t, ...state.threads];
      const msgs = state.messages.get(tid) ?? [];
      const at = msgs.findIndex((m) => m.id === fromMessageId);
      state.messages.set(t.id, at < 0 ? [] : msgs.slice(0, at + 1));
      return t;
    },
    threadTree: async (tid) => {
      maybeFail('threadTree');
      let root = find(tid);
      while (root.parentThreadId) root = find(root.parentThreadId);
      const inTree = (t: ThreadView): boolean =>
        t.id === root.id || (!!t.parentThreadId && inTree(find(t.parentThreadId)));
      return {
        rootThreadId: root.id,
        nodes: state.threads.filter(inTree).map((t) => ({
          threadId: t.id,
          parentThreadId: t.parentThreadId,
          branchFromMessageId: t.branchFromMessageId,
          title: t.title,
          side: t.side,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          messageCount: (state.messages.get(t.id) ?? []).length,
        })),
      };
    },
    sideChat: async (tid, body) => {
      maybeFail('sideChat');
      const parent = find(tid);
      const t = thread({
        title: body.text.slice(0, 60),
        parentThreadId: tid,
        side: true,
        model: body.model ?? parent.model,
      });
      state.threads = [t, ...state.threads];
      const turnId = id('turn');
      const user = message(t.id, {
        role: 'user',
        turnId,
        parts: [{ type: 'text', text: body.text }],
      });
      const assistant = message(t.id, {
        role: 'assistant',
        turnId,
        status: 'streaming',
        parts: [],
      });
      state.messages.set(t.id, [user, assistant]);
      return {
        thread: t,
        send: {
          disposition: 'started' as const,
          turnId,
          userMessageId: user.id,
          assistantMessageId: assistant.id,
        },
      };
    },
    ...workspaceImpl(state.workspace, { id, ts: () => ts(), maybeFail }),
    ...m3Impl(state.m3, { id, ts: () => ts(), maybeFail }),
    ...m4Impl(state.m4, {
      id,
      ts: () => ts(),
      maybeFail,
      providers: () => state.providers,
      setProviders: (p) => {
        state.providers = p;
      },
      mcpServers: () => state.m3.mcpServers,
    }),
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

  /** Start the oldest queued follow-up as its own turn, as the Hub does when a turn ends. */
  const startQueued = (tid: string) => {
    const [first, ...rest] = state.queues.get(tid) ?? [];
    if (!first) throw new Error(`nothing queued on ${tid}`);
    state.queues.set(
      tid,
      rest.map((q, i) => ({ ...q, position: i + 1 })),
    );
    const turnId = id('turn');
    const user = message(tid, {
      role: 'user',
      turnId,
      provenance: 'queued',
      parts: [{ type: 'text', text: first.text }],
    });
    const assistant = message(tid, { role: 'assistant', turnId, status: 'streaming', parts: [] });
    state.messages.set(tid, [...(state.messages.get(tid) ?? []), user, assistant]);
    return { queuedId: first.id, turnId, user, assistant };
  };

  return { api, state, persist, startQueued };
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

/**
 * Simulate an assistant reply on a thread's stream. With `end`, persist the final message with
 * `hub.persist` first: the client refetches the thread on completion, as it does from the Hub.
 */
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

// ---- terminals (FR-006): a scriptable WebSocket and a screen that records what it draws ----------

export class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly url: string;
  readonly sent: unknown[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }

  static reset() {
    FakeSocket.all = [];
  }

  /** The newest socket whose URL contains `part`. */
  static for(part: string): FakeSocket {
    const s = [...FakeSocket.all].reverse().find((x) => x.url.includes(part));
    if (!s) throw new Error(`no socket for ${part}`);
    return s;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
  }

  open() {
    act(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    });
  }

  frame(f: Record<string, unknown>) {
    act(() => {
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(f) }));
    });
  }

  raw(data: unknown) {
    act(() => {
      this.onmessage?.(new MessageEvent('message', { data }));
    });
  }

  /** The Hub (or the network) closed the connection. */
  drop() {
    act(() => {
      this.closed = true;
      this.readyState = 3;
      this.onclose?.(new CloseEvent('close'));
    });
  }
}

export const fakeWebSocket = (url: string) => new FakeSocket(url);

export class FakeScreen implements TerminalScreen {
  static all: FakeScreen[] = [];
  cols = 80;
  rows = 24;
  written = '';
  parent: HTMLElement | null = null;
  focused = 0;
  cleared = 0;
  disposed = false;
  keyFilter: ((e: KeyboardEvent) => boolean) | null = null;
  #data: ((d: string) => void) | null = null;

  constructor() {
    FakeScreen.all.push(this);
  }

  static reset() {
    FakeScreen.all = [];
  }

  open(parent: HTMLElement) {
    this.parent = parent;
    const input = document.createElement('textarea');
    input.setAttribute('aria-label', 'Terminal input');
    input.className = 'fake-terminal-input';
    parent.appendChild(input);
  }

  write(data: string) {
    this.written += data;
  }

  onData(fn: (d: string) => void) {
    this.#data = fn;
  }

  /** The user typed into the terminal. */
  type(data: string) {
    act(() => this.#data?.(data));
  }

  fit() {
    // Sizes change only when a test sets cols/rows.
  }

  focus() {
    this.focused++;
    this.parent?.querySelector<HTMLElement>('.fake-terminal-input')?.focus();
  }

  clear() {
    this.cleared++;
  }

  setKeyFilter(fn: (e: KeyboardEvent) => boolean) {
    this.keyFilter = fn;
  }

  dispose() {
    this.disposed = true;
  }
}

export const fakeTerminalScreen = () => Promise.resolve(new FakeScreen());
