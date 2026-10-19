// The few Hub API calls the shell makes itself (contracts/hub-api.md): the status list for the
// tray and quick overlay (FR-215), quick chat and window-capture sends (FR-008, FR-214), and the
// notification behind an event (FR-013). In the app the fetch is the Hub session's own, so the
// calls carry the web UI's session cookie and pass the same pinned certificate check.
import type {
  AgentView,
  CodeSessionView,
  NotificationView,
  Page,
  RunView,
  SendMessageRequest,
  SendMessageResponse,
  ThreadView,
} from '@nova/shared';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class HubError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
  }
}

export interface StatusSources {
  threads: ThreadView[];
  runs: RunView[];
  sessions: CodeSessionView[];
  agents: AgentView[];
}

export class HubClient {
  readonly origin: string;
  readonly #fetch: FetchLike;

  constructor(origin: string, fetch: FetchLike) {
    this.origin = origin;
    this.#fetch = fetch;
  }

  async json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.#fetch(`${this.origin}${path}`, {
      method: init.method ?? 'GET',
      headers,
      credentials: 'include',
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw new HubError(
        res.status,
        typeof err?.code === 'string' ? err.code : null,
        typeof err?.message === 'string' ? err.message : `HTTP ${res.status}`,
      );
    }
    return body as T;
  }

  /** Whether the shell's Hub session is signed in. */
  async signedIn(): Promise<boolean> {
    try {
      await this.json('/api/v1/session');
      return true;
    } catch (err) {
      if (err instanceof HubError && err.status === 401) return false;
      throw err;
    }
  }

  /**
   * Everything the status list shows. A source the Hub does not offer (an area that is off) or
   * that fails is left out rather than failing the list; signed-out (401) fails it.
   */
  async statusSources(): Promise<StatusSources> {
    const settle = async <T>(p: Promise<{ items: T[] }>): Promise<T[]> => {
      try {
        return (await p).items;
      } catch (err) {
        if (err instanceof HubError && err.status === 401) throw err;
        return [];
      }
    };
    const [threads, runs, sessions, agents] = await Promise.all([
      settle(this.json<Page<ThreadView>>('/api/v1/threads?limit=30')),
      settle(this.json<Page<RunView>>('/api/v1/runs?limit=30')),
      settle(this.json<{ items: CodeSessionView[] }>('/api/v1/code/sessions')),
      settle(this.json<{ items: AgentView[] }>('/api/v1/agents')),
    ]);
    return { threads, runs, sessions, agents };
  }

  async createThread(title?: string): Promise<ThreadView> {
    return this.json<ThreadView>('/api/v1/threads', {
      method: 'POST',
      body: { mode: 'chat', ...(title ? { title } : {}) },
    });
  }

  async send(threadId: string, body: SendMessageRequest): Promise<SendMessageResponse> {
    return this.json<SendMessageResponse>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: 'POST',
        body,
      },
    );
  }

  async thread(threadId: string): Promise<ThreadView> {
    const detail = await this.json<{ thread: ThreadView }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`,
    );
    return detail.thread;
  }

  /** The notification behind a `notification.created` event, or null when it is gone. */
  async notification(id: string): Promise<NotificationView | null> {
    const page = await this.json<{ items: NotificationView[] }>(
      '/api/v1/notifications?unread=true',
    );
    return page.items.find((n) => n.id === id) ?? null;
  }
}
