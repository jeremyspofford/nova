// Thin client for the Hub API (contracts/hub-api.md; M1 shapes in @nova/shared api.ts). The
// session lives in an HttpOnly cookie, so the UI never sees or stores a credential (FR-125).
import type { z } from 'zod';
import type {
  addSourceSchema,
  createMemorySchema,
  createProjectSchema,
  CreateProviderRequest,
  CreateThreadRequest,
  DetectedServer,
  importMemorySchema,
  MemoryImportResult,
  MemoryItemView,
  ModelView,
  NodeEnrollToken,
  NodeView,
  Page,
  Preset,
  ProjectView,
  QueuedInputView,
  SideChatResponse,
  SourceView,
  ThreadTree,
  updateMemorySchema,
  updateProjectSchema,
  ProviderAccountView,
  ProviderTestResult,
  SearchHit,
  SendMessageRequest,
  SendMessageResponse,
  ThreadDetail,
  ThreadMode,
  ThreadView,
  UpdateThreadRequest,
} from '@nova/shared';

export type CreateProjectRequest = z.input<typeof createProjectSchema>;
export type UpdateProjectRequest = z.input<typeof updateProjectSchema>;
export type AddSourceRequest = z.input<typeof addSourceSchema>;
export type CreateMemoryRequest = z.input<typeof createMemorySchema>;
export type UpdateMemoryRequest = z.input<typeof updateMemorySchema>;
export type ImportMemoryRequest = z.input<typeof importMemorySchema>;

export interface ListMemoryQuery {
  scopeKind?: 'global' | 'project';
  scopeRef?: string;
  category?: string;
  q?: string;
  status?: 'active' | 'dismissed';
}

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export interface ResolvedSetting {
  key: string;
  value: unknown;
  source: 'default' | 'global' | 'project' | 'managed';
  locked: boolean;
}

export interface Hello {
  name: string;
  version: string;
  apiVersions: string[];
  setupRequired: boolean;
}

export interface Session {
  accountId: string | null;
  displayName: string | null;
}

export interface ListThreadsQuery {
  mode?: ThreadMode;
  archived?: boolean;
  projectId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

type Fetch = typeof fetch;

const V1 = '/api/v1';

function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

export function createApi(fetchImpl: Fetch = (...a) => fetch(...a)) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...init.headers, 'content-type': 'application/json' };
    }
    const res = await fetchImpl(path, init);
    const data = (await res.json().catch(() => ({}))) as { error?: ApiErrorBody } & T;
    if (!res.ok) {
      throw new ApiError(
        res.status,
        data.error ?? { code: 'server_error', message: res.statusText, retryable: true },
      );
    }
    return data;
  }

  return {
    hello: () => call<Hello>('GET', `${V1}/hello`),
    session: () => call<Session>('GET', `${V1}/session`),
    setup: (code: string, displayName?: string) =>
      call<{ accountId: string }>(
        'POST',
        `${V1}/auth/setup`,
        displayName ? { code, displayName } : { code },
      ),
    logout: () => call<{ ok: true }>('POST', `${V1}/auth/logout`),
    settings: () => call<{ settings: ResolvedSetting[] }>('GET', `${V1}/settings`),
    setSetting: (key: string, value: unknown) =>
      call<{ settings: ResolvedSetting[] }>('PATCH', `${V1}/settings`, { key, value }),

    // providers & models (FR-014, FR-023)
    listProviders: () => call<{ items: ProviderAccountView[] }>('GET', `${V1}/providers`),
    createProvider: (body: CreateProviderRequest) =>
      call<ProviderAccountView>('POST', `${V1}/providers`, body),
    deleteProvider: (id: string) => call<{ ok: true }>('DELETE', `${V1}/providers/${enc(id)}`),
    testProvider: (id: string) =>
      call<ProviderTestResult>('POST', `${V1}/providers/${enc(id)}/test`),
    listModels: () => call<{ items: ModelView[] }>('GET', `${V1}/models`),
    updateAccount: (body: { displayName?: string; avatar?: null }) =>
      call<{ accountId: string; displayName: string | null }>('PATCH', `${V1}/account`, body),

    // threads (FR-017, FR-018)
    listThreads: (q: ListThreadsQuery = {}) =>
      call<Page<ThreadView>>('GET', `${V1}/threads${query({ ...q })}`),
    createThread: (body: CreateThreadRequest) => call<ThreadView>('POST', `${V1}/threads`, body),
    getThread: (id: string) => call<ThreadDetail>('GET', `${V1}/threads/${enc(id)}`),
    updateThread: (id: string, body: UpdateThreadRequest) =>
      call<ThreadView>('PATCH', `${V1}/threads/${enc(id)}`, body),
    deleteThread: (id: string) => call<{ ok: true }>('DELETE', `${V1}/threads/${enc(id)}`),
    sendMessage: (id: string, body: SendMessageRequest) =>
      call<SendMessageResponse>('POST', `${V1}/threads/${enc(id)}/messages`, body),
    cancel: (id: string) =>
      call<{ ok: true; cancelled: boolean }>('POST', `${V1}/threads/${enc(id)}/cancel`),
    search: (q: string, limit = 20) =>
      call<{ items: SearchHit[] }>('GET', `${V1}/search${query({ q, limit })}`),

    // M2 conversation: follow-ups, versions, branches, side chats (FR-019, FR-020, FR-026, FR-033)
    listQueue: (id: string) =>
      call<{ items: QueuedInputView[] }>('GET', `${V1}/threads/${enc(id)}/queue`),
    cancelQueued: (id: string, queuedId: string) =>
      call<{ ok: true }>('DELETE', `${V1}/threads/${enc(id)}/queue/${enc(queuedId)}`),
    editMessage: (id: string, messageId: string, body: { text: string; model?: string }) =>
      call<SendMessageResponse>(
        'POST',
        `${V1}/threads/${enc(id)}/messages/${enc(messageId)}/edit`,
        body,
      ),
    regenerate: (id: string, messageId: string, body: { model?: string } = {}) =>
      call<SendMessageResponse>(
        'POST',
        `${V1}/threads/${enc(id)}/messages/${enc(messageId)}/regenerate`,
        body,
      ),
    selectVersion: (id: string, messageId: string) =>
      call<ThreadDetail>('POST', `${V1}/threads/${enc(id)}/active`, { messageId }),
    deleteMessage: (id: string, messageId: string) =>
      call<{ ok: true }>('DELETE', `${V1}/threads/${enc(id)}/messages/${enc(messageId)}`),
    branch: (id: string, fromMessageId: string, title?: string) =>
      call<ThreadView>(
        'POST',
        `${V1}/threads/${enc(id)}/branch`,
        title ? { fromMessageId, title } : { fromMessageId },
      ),
    threadTree: (id: string) => call<ThreadTree>('GET', `${V1}/threads/${enc(id)}/tree`),
    sideChat: (id: string, body: { text: string; model?: string }) =>
      call<SideChatResponse>('POST', `${V1}/threads/${enc(id)}/side`, body),

    // projects & sources (FR-034, FR-040)
    listProjects: () => call<{ items: ProjectView[] }>('GET', `${V1}/projects`),
    createProject: (body: CreateProjectRequest) =>
      call<ProjectView>('POST', `${V1}/projects`, body),
    getProject: (id: string) => call<ProjectView>('GET', `${V1}/projects/${enc(id)}`),
    updateProject: (id: string, body: UpdateProjectRequest) =>
      call<ProjectView>('PATCH', `${V1}/projects/${enc(id)}`, body),
    deleteProject: (id: string) => call<{ ok: true }>('DELETE', `${V1}/projects/${enc(id)}`),
    listSources: (projectId: string) =>
      call<{ items: SourceView[] }>('GET', `${V1}/projects/${enc(projectId)}/sources`),
    addSource: (projectId: string, body: AddSourceRequest) =>
      call<SourceView>('POST', `${V1}/projects/${enc(projectId)}/sources`, body),
    reindexSource: (id: string) => call<SourceView>('POST', `${V1}/sources/${enc(id)}/reindex`),
    deleteSource: (id: string) => call<{ ok: true }>('DELETE', `${V1}/sources/${enc(id)}`),

    // memory (FR-032)
    listMemory: (q: ListMemoryQuery = {}) =>
      call<{ items: MemoryItemView[] }>('GET', `${V1}/memory/items${query({ ...q })}`),
    createMemory: (body: CreateMemoryRequest) =>
      call<MemoryItemView>('POST', `${V1}/memory/items`, body),
    updateMemory: (id: string, body: UpdateMemoryRequest) =>
      call<MemoryItemView>('PATCH', `${V1}/memory/items/${enc(id)}`, body),
    deleteMemory: (id: string) => call<{ ok: true }>('DELETE', `${V1}/memory/items/${enc(id)}`),
    importMemory: (body: ImportMemoryRequest) =>
      call<MemoryImportResult>('POST', `${V1}/memory/import`, body),

    // presets, local servers, compute nodes (FR-221, docs/07 §12, FR-126)
    listPresets: () => call<{ items: Preset[]; builtIn: boolean }>('GET', `${V1}/presets`),
    savePresets: (items: Preset[]) =>
      call<{ items: Preset[]; builtIn: boolean }>('PUT', `${V1}/presets`, { items }),
    detectServers: () => call<{ items: DetectedServer[] }>('GET', `${V1}/providers/detect`),
    listNodes: () => call<{ items: NodeView[] }>('GET', `${V1}/devices?role=compute`),
    createNodeEnrollToken: () =>
      call<NodeEnrollToken>('POST', `${V1}/devices/add/start`, { role: 'compute' }),
    revokeNode: (id: string) => call<{ ok: true }>('POST', `${V1}/devices/${enc(id)}/revoke`),

    // attachments (FR-021)
    attachmentUrl: (id: string) => `${V1}/attachments/${enc(id)}`,
    fetchAttachment: async (id: string): Promise<Blob> => {
      const res = await fetchImpl(`${V1}/attachments/${enc(id)}`, { credentials: 'same-origin' });
      if (!res.ok)
        throw new ApiError(res.status, {
          code: 'not_found',
          message: 'Attachment unavailable',
          retryable: false,
        });
      return res.blob();
    },

    // streams (contracts/hub-api.md §5)
    threadStreamUrl: (id: string) => `${V1}/threads/${enc(id)}/stream`,
  };
}

export type Api = ReturnType<typeof createApi>;

/** A short, user-facing reason for a failed call. */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiError) return err.body.message || fallback;
  if (err instanceof Error && err.message) {
    return /failed to fetch|networkerror|load failed/i.test(err.message)
      ? 'Cannot reach the Hub. Check your connection and try again.'
      : err.message;
  }
  return fallback;
}
