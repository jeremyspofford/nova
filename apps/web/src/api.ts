// Thin client for the Hub API (contracts/hub-api.md; M1 shapes in @nova/shared api.ts). The
// session lives in an HttpOnly cookie, so the UI never sees or stores a credential (FR-125).
import type { z } from 'zod';
import { defineMessages } from '@nova/i18n';
import type {
  AccountView,
  AppAuthorizationCreated,
  AppAuthorizationView,
  BundlePreview,
  CatalogEntryView,
  CatalogView,
  createAppAuthorizationSchema,
  createSkillSchema,
  createTerminalSchema,
  FileContentView,
  FileEntryView,
  HookView,
  ImportPreview,
  ImportRecordView,
  ImportResult,
  installBundleSchema,
  installPluginSchema,
  LibraryItemView,
  PluginPreview,
  PluginView,
  pluginSourceSchema,
  ProjectFolderView,
  SkillDetail,
  SkillView,
  SlashCommandView,
  TerminalView,
  UiEntryPointView,
  updateProfileSchema,
  UsageSummary,
  ActivityItemView,
  ApprovalView,
  ArtifactView,
  AuditEntryView,
  AuditVerifyResult,
  CommandRuleView,
  ConsolidationRunView,
  DecideApprovalRequest,
  DiagnosticsSnapshot,
  LogEntryView,
  McpLogLine,
  McpServerRequest,
  McpServerView,
  MemorySummaryView,
  MentionCandidate,
  NotificationView,
  PermissionGrantView,
  PermissionProfileView,
  PolicyPreview,
  PolicyRuleView,
  ToolDescriptor,
  ToolView,
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
  CodeChangeView,
  CodeReviewView,
  CodeSessionView,
  CodeSymbolView,
  CommitResult,
  DiffCommentView,
  EnvironmentView,
  ExecSessionView,
  GoalView,
  RunView,
  ScheduleFireView,
  ScheduleView,
  ServerRequestView,
  SubagentView,
  commitSchema,
  createCodeSessionSchema,
  createRunSchema,
  diffCommentsSchema,
  extendBudgetSchema,
  hunkDecisionSchema,
  scheduleSchema,
  setGoalSchema,
  updateCodeSessionSchema,
  updateGoalSchema,
  updatePlanSchema,
  updateScheduleSchema,
} from '@nova/shared';
import { agentsApi } from './agents/api.ts';
import { browserApi } from './browser/api.ts';
import { channelsApi } from './channels/api.ts';
import { codeM6Api } from './code/api-m6.ts';
import { computersApi } from './computers/api.ts';
import { addDeviceApi, devicesApi } from './devices/api.ts';
import { networkSurfaceApi } from './netsurface/api.ts';
import { hubFetch } from './relaytransport/transport.ts';
import { screenApi } from './screen/api.ts';
import { spacesApi } from './spaces/api.ts';
import { teamApi } from './team/api.ts';
import { pushApi } from './push/api.ts';
import { syncApi } from './replica/api.ts';
import { channelsM7Api } from './channels/api-m7.ts';
import { browserM7Api } from './browser/api-m7.ts';
import { deviceTlsApi } from './devices/api-m7.ts';
import { relayTokenApi } from './netsurface/api-m7.ts';
import { cloudApi } from './cloud/api.ts';
import { codeM7Api } from './code/api-m7.ts';
import { flaggedApi } from './flagged/api.ts';
import { imagesApi } from './images/api.ts';
import { oobApi } from './oob/api-m75.ts';
import { deviceOpsApi } from './devices/api-m75.ts';
import { browserDeviceApi } from './browserdevice/api-m75.ts';
import { firmwareApi } from './firmware/api-m75.ts';
import { bootApi } from './boot/api-m75.ts';
import { extensionsApi } from './extensions/api-m8.ts';
import { marketApi } from './market/api-m8.ts';
import { managedApi } from './managed/api-m8.ts';
import { datactlApi } from './datactl/api-m8.ts';
import { appAuthApi } from './appauth/api-m8.ts';
import { channelsM8Api } from './channels/api-m8.ts';
import { teamM8Api } from './team/api-m8.ts';

export type CreateProjectRequest = z.input<typeof createProjectSchema>;
export type UpdateProjectRequest = z.input<typeof updateProjectSchema>;
export type AddSourceRequest = z.input<typeof addSourceSchema>;
export type CreateMemoryRequest = z.input<typeof createMemorySchema>;
export type UpdateMemoryRequest = z.input<typeof updateMemorySchema>;
export type ImportMemoryRequest = z.input<typeof importMemorySchema>;

export type PluginSourceRequest = z.input<typeof pluginSourceSchema>;
export type InstallPluginRequest = z.input<typeof installPluginSchema>;
export type CreateSkillRequest = z.input<typeof createSkillSchema>;
export type CreateAppAuthorizationRequest = z.input<typeof createAppAuthorizationSchema>;
export type InstallBundleRequest = z.input<typeof installBundleSchema>;
export type CreateTerminalRequest = z.input<typeof createTerminalSchema>;
export type UpdateProfileRequest = z.input<typeof updateProfileSchema>;

export interface CreatePolicyRuleRequest {
  scopeKind: PolicyRuleView['scopeKind'];
  scopeRef?: string;
  match: PolicyRuleView['match'];
  effect: PolicyRuleView['effect'];
  label?: string;
  priority?: number;
}

export interface CreateCommandRuleRequest {
  scopeKind?: CommandRuleView['scopeKind'];
  scopeRef?: string;
  pattern: (string | string[])[];
  decision: CommandRuleView['decision'];
  justification?: string;
  matchExamples: string[];
  notMatchExamples: string[];
  priority?: number;
}

export interface ToolInvokeResult {
  ok: boolean;
  /** Text of the result, redacted. */
  text: string;
  error?: { code: string; message: string };
}

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
  /** A device session's device and scopes (Add Device); null for the owner's own browser. */
  deviceId?: string | null;
  scopes?: string[] | null;
  /** The person's role on this Hub (M7, decision 5). */
  role?: 'owner' | 'member' | null;
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

/** Per-request options of the low-level `call` (FR-112). */
export interface CallOptions {
  /** Sent as `Idempotency-Key`; a resend of queued work reuses it so the Hub applies it once. */
  idempotencyKey?: string;
  /** False: the offline layer never answers or takes over this request (its own resends). */
  offline?: boolean;
}

/** A request as the offline layer sees it. */
export interface HubRequest {
  method: string;
  path: string;
  body?: unknown;
  options: CallOptions;
}

/**
 * The offline layer (src/offline/, FR-112, FR-128, FR-129). It gets the request function, hears
 * every answer, and may answer a request the Hub could not be reached for: a read from this
 * device's offline copy, or a write it queues. Null lets the request fail as before; a rejection
 * fails it with that error instead.
 */
export interface OfflineHandler {
  attach(call: LowLevelCall): void;
  answered(req: HubRequest, status: number, data: unknown): void;
  unreachable(req: HubRequest, err: unknown): Promise<{ data: unknown } | null>;
}

export type LowLevelCall = <T>(
  method: string,
  path: string,
  body?: unknown,
  options?: CallOptions,
) => Promise<T>;

/** Proxy answers that mean the Hub behind it is down, when they carry no Hub error body. */
const GATEWAY_DOWN = new Set([502, 503, 504]);

const V1 = '/api/v1';

function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

// By default every call goes through the app's transport: the page's origin, or the Relay tunnel
// when this browser is paired through one and the origin does not answer (FR-137 client).
export function createApi(fetchImpl: Fetch = hubFetch, opts: { offline?: OfflineHandler } = {}) {
  const { offline } = opts;
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    options: CallOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    const init: RequestInit = { method, credentials: 'same-origin', headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const req: HubRequest = { method, path, ...(body !== undefined ? { body } : {}), options };
    // The Hub cannot be reached: the offline layer may answer from this device or queue it.
    const local = async (err: unknown): Promise<T> => {
      const answer = offline ? await offline.unreachable(req, err) : null;
      if (answer) return answer.data as T;
      throw err;
    };
    let res: Response;
    try {
      res = await fetchImpl(path, init);
    } catch (err) {
      return local(err);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: ApiErrorBody } & T;
    if (!res.ok && !data.error && GATEWAY_DOWN.has(res.status))
      return local(new TypeError(`Failed to fetch (${res.status})`));
    offline?.answered(req, res.status, data);
    if (!res.ok) {
      throw new ApiError(
        res.status,
        data.error ?? { code: 'server_error', message: res.statusText, retryable: true },
      );
    }
    return data;
  }
  offline?.attach(call);

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
    // `confirm` only when true: the Hub takes it for the consent switches (ADR-096 D3).
    setSetting: (key: string, value: unknown, opts: { confirm?: boolean } = {}) =>
      call<{ settings: ResolvedSetting[] }>('PATCH', `${V1}/settings`, {
        key,
        value,
        ...(opts.confirm ? { confirm: true } : {}),
      }),

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
    createNodeEnrollToken: () => call<NodeEnrollToken>('POST', `${V1}/devices/compute/enroll`),
    revokeNode: (id: string) => call<{ ok: true }>('POST', `${V1}/devices/${enc(id)}/revoke`),

    // M3: approvals, policy, tools, MCP, notifications, audit, diagnostics, artifacts, mentions
    listApprovals: (q: { status?: 'pending' | 'all'; threadId?: string } = {}) =>
      call<{ items: ApprovalView[] }>('GET', `${V1}/approvals${query({ ...q })}`),
    getApproval: (id: string) => call<ApprovalView>('GET', `${V1}/approvals/${enc(id)}`),
    decideApproval: (body: DecideApprovalRequest) =>
      call<ApprovalView>('POST', `${V1}/approvals`, body),
    handoffDone: (id: string, note?: string) =>
      call<ApprovalView>('POST', `${V1}/approvals/${enc(id)}/handoff-done`, note ? { note } : {}),
    listPolicyRules: () => call<{ items: PolicyRuleView[] }>('GET', `${V1}/policy/rules`),
    createPolicyRule: (body: CreatePolicyRuleRequest) =>
      call<PolicyRuleView>('POST', `${V1}/policy/rules`, body),
    updatePolicyRule: (
      id: string,
      body: Partial<CreatePolicyRuleRequest> & { enabled?: boolean },
    ) => call<PolicyRuleView>('PATCH', `${V1}/policy/rules/${enc(id)}`, body),
    deletePolicyRule: (id: string) => call<{ ok: true }>('DELETE', `${V1}/policy/rules/${enc(id)}`),
    previewPolicy: (body: {
      tool: string;
      args?: unknown;
      threadId?: string;
      userAsked?: boolean;
    }) => call<PolicyPreview>('POST', `${V1}/policy/evaluate`, body),
    listCommandRules: () => call<{ items: CommandRuleView[] }>('GET', `${V1}/command-rules`),
    createCommandRule: (body: CreateCommandRuleRequest) =>
      call<CommandRuleView>('POST', `${V1}/command-rules`, body),
    updateCommandRule: (
      id: string,
      body: Partial<CreateCommandRuleRequest> & { enabled?: boolean },
    ) => call<CommandRuleView>('PATCH', `${V1}/command-rules/${enc(id)}`, body),
    deleteCommandRule: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/command-rules/${enc(id)}`),
    testCommandRules: (command: string) =>
      call<{ decision: 'allow' | 'ask' | 'deny' | null; ruleId: string | null; reason: string }>(
        'POST',
        `${V1}/command-rules/test`,
        { command },
      ),
    listGrants: () => call<{ items: PermissionGrantView[] }>('GET', `${V1}/permission-grants`),
    revokeGrant: (id: string) => call<{ ok: true }>('DELETE', `${V1}/permission-grants/${enc(id)}`),
    listProfiles: () =>
      call<{ items: PermissionProfileView[] }>('GET', `${V1}/permission-profiles`),
    listTools: () => call<{ items: ToolView[] }>('GET', `${V1}/tools`),
    setToolDefault: (tool: string, value: 'allow' | 'ask' | 'deny' | null) =>
      call<{ tool: string; default: 'allow' | 'ask' | 'deny' | null }>(
        'PUT',
        `${V1}/tool-defaults`,
        { tool, default: value },
      ),
    invokeTool: (name: string, body: { args: unknown; threadId?: string }) =>
      call<ToolInvokeResult>('POST', `${V1}/tools/${enc(name)}/invoke`, body),
    listMcpServers: () => call<{ items: McpServerView[] }>('GET', `${V1}/mcp/servers`),
    createMcpServer: (body: McpServerRequest) =>
      call<McpServerView>('POST', `${V1}/mcp/servers`, body),
    updateMcpServer: (id: string, body: Partial<McpServerRequest>) =>
      call<McpServerView>('PATCH', `${V1}/mcp/servers/${enc(id)}`, body),
    deleteMcpServer: (id: string) => call<{ ok: true }>('DELETE', `${V1}/mcp/servers/${enc(id)}`),
    restartMcpServer: (id: string) =>
      call<McpServerView>('POST', `${V1}/mcp/servers/${enc(id)}/restart`),
    mcpServerLogs: (id: string) =>
      call<{ items: McpLogLine[] }>('GET', `${V1}/mcp/servers/${enc(id)}/logs`),
    mcpServerTools: (id: string) =>
      call<{ items: ToolDescriptor[] }>('GET', `${V1}/mcp/servers/${enc(id)}/tools`),
    listNotifications: (q: { unread?: boolean } = {}) =>
      call<{ items: NotificationView[]; unread: number }>(
        'GET',
        `${V1}/notifications${query({ ...q })}`,
      ),
    markNotificationsRead: (body: { ids?: string[]; all?: boolean }) =>
      call<{ unread: number }>('POST', `${V1}/notifications/read`, body),
    deleteNotification: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/notifications/${enc(id)}`),
    listAudit: (q: { kind?: string; threadId?: string; cursor?: string; limit?: number } = {}) =>
      call<Page<AuditEntryView>>('GET', `${V1}/audit${query({ ...q })}`),
    verifyAudit: () => call<AuditVerifyResult>('GET', `${V1}/audit/verify`),
    auditExportUrl: () => `${V1}/audit/export`,
    activity: (threadId: string) =>
      call<{ items: ActivityItemView[] }>('GET', `${V1}/activity${query({ ref: threadId })}`),
    diagnostics: () => call<DiagnosticsSnapshot>('GET', `${V1}/diagnostics`),
    logs: (q: { level?: string; module?: string; since?: string; limit?: number } = {}) =>
      call<{ items: LogEntryView[] }>('GET', `${V1}/diagnostics/logs${query({ ...q })}`),
    logsExportUrl: () => `${V1}/diagnostics/logs/export`,
    listArtifacts: (threadId: string) =>
      call<{ items: ArtifactView[] }>('GET', `${V1}/artifacts${query({ threadId })}`),
    getArtifact: (id: string) => call<ArtifactView>('GET', `${V1}/artifacts/${enc(id)}`),
    artifactContentUrl: (id: string) => `${V1}/artifacts/${enc(id)}/content`,
    mentions: (q: string, threadId?: string) =>
      call<{ items: MentionCandidate[] }>('GET', `${V1}/mentions${query({ q, threadId })}`),
    memorySummary: (q: { scopeKind?: 'global' | 'project'; scopeRef?: string } = {}) =>
      call<MemorySummaryView>('GET', `${V1}/memory/summary${query({ ...q })}`),
    consolidateMemory: (body: { scopeKind?: 'global' | 'project'; scopeRef?: string } = {}) =>
      call<ConsolidationRunView>('POST', `${V1}/memory/consolidate`, body),
    listConsolidations: () =>
      call<{ items: ConsolidationRunView[] }>('GET', `${V1}/memory/consolidations`),
    listMemoryTopics: () =>
      call<{ items: { topic: string; preference: 'more' | 'less' | 'default' }[] }>(
        'GET',
        `${V1}/memory/topics`,
      ),
    setMemoryTopic: (topic: string, preference: 'more' | 'less' | 'default') =>
      call<{ topic: string; preference: 'more' | 'less' | 'default' }>(
        'PATCH',
        `${V1}/memory/topics`,
        { topic, preference },
      ),

    // M4: plugins, skills, hooks, clients, bundles, OAuth, MCP Apps, workspace, profile, import
    listPlugins: () => call<{ items: PluginView[] }>('GET', `${V1}/plugins`),
    previewPlugin: (source: PluginSourceRequest) =>
      call<PluginPreview>('POST', `${V1}/plugins/preview`, { source }),
    installPlugin: (body: InstallPluginRequest) => call<PluginView>('POST', `${V1}/plugins`, body),
    updatePlugin: (id: string, body: { enabled: boolean }) =>
      call<PluginView>('PATCH', `${V1}/plugins/${enc(id)}`, body),
    uninstallPlugin: (id: string) => call<{ ok: true }>('DELETE', `${V1}/plugins/${enc(id)}`),
    listCatalogs: () => call<{ items: CatalogView[] }>('GET', `${V1}/plugins/catalogs`),
    searchCatalog: (q = '') =>
      call<{ items: CatalogEntryView[] }>('GET', `${V1}/plugins/catalog${query({ q })}`),
    listSkills: (q: { projectId?: string } = {}) =>
      call<{ items: SkillView[] }>('GET', `${V1}/skills${query({ ...q })}`),
    getSkill: (id: string) => call<SkillDetail>('GET', `${V1}/skills/${enc(id)}`),
    createSkill: (body: CreateSkillRequest) => call<SkillView>('POST', `${V1}/skills`, body),
    updateSkill: (id: string, body: { enabled: boolean }) =>
      call<SkillView>('PATCH', `${V1}/skills/${enc(id)}`, body),
    deleteSkill: (id: string) => call<{ ok: true }>('DELETE', `${V1}/skills/${enc(id)}`),
    slashCommands: (q: { projectId?: string } = {}) =>
      call<{ items: SlashCommandView[] }>('GET', `${V1}/slash-commands${query({ ...q })}`),
    listHooks: () => call<{ items: HookView[] }>('GET', `${V1}/hooks`),
    updateHook: (id: string, body: { enabled: boolean }) =>
      call<HookView>('PATCH', `${V1}/hooks/${enc(id)}`, body),
    deleteHook: (id: string) => call<{ ok: true }>('DELETE', `${V1}/hooks/${enc(id)}`),
    trustHook: (id: string, contentHash: string) =>
      call<HookView>('POST', `${V1}/hooks/${enc(id)}/trust`, { contentHash }),
    untrustHook: (id: string) => call<HookView>('POST', `${V1}/hooks/${enc(id)}/untrust`),
    listAppAuthorizations: () =>
      call<{ items: AppAuthorizationView[] }>('GET', `${V1}/app-authorizations`),
    createAppAuthorization: (body: CreateAppAuthorizationRequest) =>
      call<AppAuthorizationCreated>('POST', `${V1}/app-authorizations`, body),
    revokeAppAuthorization: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/app-authorizations/${enc(id)}`),
    previewBundle: (file: { name: string; data: string }) =>
      call<BundlePreview>('POST', `${V1}/mcp/bundles/preview`, file),
    installBundle: (body: InstallBundleRequest) =>
      call<McpServerView>('POST', `${V1}/mcp/bundles/install`, body),
    startMcpOAuth: (id: string) =>
      call<{ authorizeUrl: string }>('POST', `${V1}/mcp/servers/${enc(id)}/oauth/start`),
    revokeMcpOAuth: (id: string) =>
      call<McpServerView>('DELETE', `${V1}/mcp/servers/${enc(id)}/oauth`),
    uiEntryPoints: (kind?: UiEntryPointView['kind']) =>
      call<{ items: UiEntryPointView[] }>('GET', `${V1}/ui/entry-points${query({ kind })}`),
    uiResourceUrl: (entryId: string) => `${V1}/ui/resource${query({ entry: entryId })}`,
    /** Model-visible context an MCP App shares for its thread (FR-198; private entries never sent). */
    setUiContext: (body: {
      threadId: string;
      entryId: string;
      instanceId: string;
      text: string | null;
    }) => call<{ ok: true }>('PUT', `${V1}/ui/context`, body),
    fileRoots: (q: { threadId?: string; projectId?: string } = {}) =>
      call<{ items: { path: string; label: string; access: 'read' | 'write' }[] }>(
        'GET',
        `${V1}/files/roots${query({ ...q })}`,
      ),
    listFiles: (root: string, path = '') =>
      call<{ items: FileEntryView[] }>('GET', `${V1}/files/list${query({ root, path })}`),
    readFile: (root: string, path: string) =>
      call<FileContentView>('GET', `${V1}/files/content${query({ root, path })}`),
    rawFileUrl: (root: string, path: string) => `${V1}/files/raw${query({ root, path })}`,
    /** The saved file, or the approval a save waits for (202). */
    saveFile: (body: { root: string; path: string; text: string; baseSha256: string | null }) =>
      call<FileContentView | { approvalId: string }>('PUT', `${V1}/files/content`, body),
    createTerminal: (body: CreateTerminalRequest = {}) =>
      call<TerminalView>('POST', `${V1}/terminals`, body),
    listTerminals: () => call<{ items: TerminalView[] }>('GET', `${V1}/terminals`),
    closeTerminal: (id: string) => call<{ ok: true }>('DELETE', `${V1}/terminals/${enc(id)}`),
    terminalSocketUrl: (id: string) => `${V1}/terminals/${enc(id)}/ws`,
    library: (q: { kind?: string; q?: string; cursor?: string; limit?: number } = {}) =>
      call<Page<LibraryItemView>>('GET', `${V1}/library${query({ ...q })}`),
    listProjectFolders: (projectId: string) =>
      call<{ items: ProjectFolderView[] }>('GET', `${V1}/projects/${enc(projectId)}/folders`),
    addProjectFolder: (projectId: string, body: { path: string; access?: 'read' | 'write' }) =>
      call<ProjectFolderView>('POST', `${V1}/projects/${enc(projectId)}/folders`, body),
    reindexProjectFolder: (projectId: string, folderId: string) =>
      call<ProjectFolderView>(
        'POST',
        `${V1}/projects/${enc(projectId)}/folders/${enc(folderId)}/reindex`,
      ),
    removeProjectFolder: (projectId: string, folderId: string) =>
      call<{ ok: true }>('DELETE', `${V1}/projects/${enc(projectId)}/folders/${enc(folderId)}`),
    getAccount: () => call<AccountView>('GET', `${V1}/account`),
    updateProfile: (body: UpdateProfileRequest) =>
      call<AccountView>('PATCH', `${V1}/account`, body),
    avatarUrl: () => `${V1}/account/avatar`,
    usage: (q: { from?: string; to?: string } = {}) =>
      call<UsageSummary>('GET', `${V1}/usage${query({ ...q })}`),
    setActiveProvider: (id: string) =>
      call<ProviderAccountView>('PATCH', `${V1}/providers/${enc(id)}`, { active: true }),
    importPreview: (body: { paths: string[]; kinds: string[] }) =>
      call<ImportPreview>('POST', `${V1}/import/preview`, body),
    importApply: (previewId: string, items: string[]) =>
      call<ImportResult>('POST', `${V1}/import/apply`, { previewId, items }),
    importRecords: () => call<{ items: ImportRecordView[] }>('GET', `${V1}/import/records`),
    suggestions: (threadId: string) =>
      call<{ items: string[] }>('GET', `${V1}/threads/${enc(threadId)}/suggestions`),

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

    // ---- M5: Work runs, goals, schedules (FR-051..FR-058, FR-181, FR-182, FR-055) ----------
    listRuns: (q: { status?: 'active' | 'all'; projectId?: string; cursor?: string } = {}) =>
      call<Page<RunView>>('GET', `${V1}/runs${query({ ...q })}`),
    createRun: (body: z.input<typeof createRunSchema>) => call<RunView>('POST', `${V1}/runs`, body),
    getRun: (id: string) => call<RunView>('GET', `${V1}/runs/${enc(id)}`),
    /** pause, resume, cancel; redirect takes `{text}` (FR-019). */
    controlRun: (id: string, action: 'pause' | 'resume' | 'redirect' | 'cancel', text?: string) =>
      call<RunView>('POST', `${V1}/runs/${enc(id)}/${action}`, text ? { text } : {}),
    extendRunBudget: (id: string, body: z.input<typeof extendBudgetSchema>) =>
      call<RunView>('POST', `${V1}/runs/${enc(id)}/budget`, body),
    /** Edit the plan before or during the run (docs/09 §3). */
    updateRunPlan: (id: string, body: z.input<typeof updatePlanSchema>) =>
      call<RunView>('PUT', `${V1}/runs/${enc(id)}/plan`, body),
    /** Approve the plan of an `ask_first` run, or start a proposed run (FR-186). */
    startRun: (id: string) => call<RunView>('POST', `${V1}/runs/${enc(id)}/start`, {}),
    listSubagents: (runId: string) =>
      call<{ items: SubagentView[] }>('GET', `${V1}/runs/${enc(runId)}/subagents`),
    getRunGoal: (runId: string) => call<GoalView | null>('GET', `${V1}/runs/${enc(runId)}/goal`),
    setRunGoal: (runId: string, body: z.input<typeof setGoalSchema>) =>
      call<GoalView>('PUT', `${V1}/runs/${enc(runId)}/goal`, body),
    clearRunGoal: (runId: string) => call<{ ok: true }>('DELETE', `${V1}/runs/${enc(runId)}/goal`),
    listGoals: (status?: GoalView['status']) =>
      call<{ items: GoalView[] }>('GET', `${V1}/goals${query({ status })}`),
    updateGoal: (id: string, body: z.input<typeof updateGoalSchema>) =>
      call<GoalView>('PATCH', `${V1}/goals/${enc(id)}`, body),
    goalAction: (id: string, action: 'pause' | 'resume' | 'complete') =>
      call<GoalView>('POST', `${V1}/goals/${enc(id)}/${action}`, {}),
    listSchedules: () => call<{ items: ScheduleView[] }>('GET', `${V1}/schedules`),
    createSchedule: (body: z.input<typeof scheduleSchema>) =>
      call<ScheduleView>('POST', `${V1}/schedules`, body),
    updateSchedule: (id: string, body: z.input<typeof updateScheduleSchema>) =>
      call<ScheduleView>('PATCH', `${V1}/schedules/${enc(id)}`, body),
    deleteSchedule: (id: string) => call<{ ok: true }>('DELETE', `${V1}/schedules/${enc(id)}`),
    scheduleHistory: (id: string) =>
      call<{ items: ScheduleFireView[] }>('GET', `${V1}/schedules/${enc(id)}/fires`),
    /** Fire a schedule now, outside its rule (a test run). */
    runScheduleNow: (id: string) =>
      call<{ runId: string }>('POST', `${V1}/schedules/${enc(id)}/run`, {}),

    // ---- M5: Code sessions (FR-061..FR-066, FR-069, FR-074) ---------------------------------
    listEnvironments: () => call<{ items: EnvironmentView[] }>('GET', `${V1}/environments`),
    listCodeSessions: () => call<{ items: CodeSessionView[] }>('GET', `${V1}/code/sessions`),
    createCodeSession: (body: z.input<typeof createCodeSessionSchema>) =>
      call<CodeSessionView>('POST', `${V1}/code/sessions`, body),
    getCodeSession: (id: string) => call<CodeSessionView>('GET', `${V1}/code/sessions/${enc(id)}`),
    updateCodeSession: (id: string, body: z.input<typeof updateCodeSessionSchema>) =>
      call<CodeSessionView>('PATCH', `${V1}/code/sessions/${enc(id)}`, body),
    listChanges: (id: string) =>
      call<{ items: CodeChangeView[] }>('GET', `${V1}/code/sessions/${enc(id)}/changes`),
    decideHunks: (id: string, changeId: string, body: z.input<typeof hunkDecisionSchema>) =>
      call<CodeChangeView>(
        'POST',
        `${V1}/code/sessions/${enc(id)}/changes/${enc(changeId)}/hunks`,
        body,
      ),
    /** Accept or reject every pending hunk (of the given changes, or all). */
    decideAll: (id: string, accept: boolean, changeIds?: string[]) =>
      call<{ items: CodeChangeView[] }>(
        'POST',
        `${V1}/code/sessions/${enc(id)}/changes/${accept ? 'accept' : 'reject'}`,
        changeIds ? { changeIds } : {},
      ),
    listComments: (id: string) =>
      call<{ items: DiffCommentView[] }>('GET', `${V1}/code/sessions/${enc(id)}/comments`),
    addComments: (id: string, body: z.input<typeof diffCommentsSchema>) =>
      call<{ items: DiffCommentView[] }>('POST', `${V1}/code/sessions/${enc(id)}/comments`, body),
    resolveComment: (id: string, commentId: string) =>
      call<DiffCommentView>(
        'POST',
        `${V1}/code/sessions/${enc(id)}/comments/${enc(commentId)}/resolve`,
        {},
      ),
    startReview: (id: string) =>
      call<CodeReviewView>('POST', `${V1}/code/sessions/${enc(id)}/review`, {}),
    getReview: (id: string, reviewId: string) =>
      call<CodeReviewView>('GET', `${V1}/code/sessions/${enc(id)}/reviews/${enc(reviewId)}`),
    commit: (id: string, body: z.input<typeof commitSchema>) =>
      call<CommitResult>('POST', `${V1}/code/sessions/${enc(id)}/commit`, body),
    /** A terminal in the session's folder (FR-066). */
    createSessionTerminal: (
      id: string,
      size: { cols: number; rows: number } = { cols: 80, rows: 24 },
    ) => call<TerminalView>('POST', `${V1}/code/sessions/${enc(id)}/terminal`, size),
    /** The agent's interactive exec sessions of a thread (FR-184). */
    listExecSessions: (threadId: string) =>
      call<{ items: ExecSessionView[] }>('GET', `${V1}/exec/sessions${query({ threadId })}`),
    killExecSession: (id: string) => call<{ ok: true }>('DELETE', `${V1}/exec/sessions/${enc(id)}`),
    codeSymbols: (id: string, q: string) =>
      call<{ items: CodeSymbolView[] }>(
        'GET',
        `${V1}/code/sessions/${enc(id)}/symbols${query({ q })}`,
      ),

    // ---- M5: server-to-client requests (FR-188) ------------------------------------------------
    listRequests: (status: 'pending' | 'all' = 'pending') =>
      call<{ items: ServerRequestView[] }>('GET', `${V1}/requests${query({ status })}`),
    respondRequest: (id: string, result: unknown) =>
      call<ServerRequestView>('POST', `${V1}/requests/${enc(id)}/respond`, { result }),

    // streams (contracts/hub-api.md §5)
    threadStreamUrl: (id: string) => `${V1}/threads/${enc(id)}/stream`,

    // ---- M6 areas (each in its own module) -----------------------------------------------------
    ...spacesApi(call),
    ...agentsApi(call),
    ...computersApi(call),
    ...devicesApi(call),
    ...addDeviceApi(call),
    ...networkSurfaceApi(call),
    ...codeM6Api(call),
    ...channelsApi(call),
    ...browserApi(call),
    ...screenApi(call),
    // M7: members and teams, push, the sync replica, channels, browser, device TLS, Relay token.
    ...teamApi(call),
    ...pushApi(call),
    ...syncApi(call),
    ...channelsM7Api(call),
    ...browserM7Api(call),
    ...deviceTlsApi(call),
    ...relayTokenApi(call),
    ...cloudApi(call),
    ...codeM7Api(call),
    ...flaggedApi(call),
    ...imagesApi(call),
    ...oobApi(call),
    ...deviceOpsApi(call),
    ...browserDeviceApi(call),
    ...firmwareApi(call),
    ...bootApi(call),
    // M8: extensions, marketplace, managed policy, data controls, app authorization.
    ...extensionsApi(call),
    ...marketApi(call),
    ...managedApi(call),
    ...datactlApi(call, fetchImpl),
    ...appAuthApi(call),
    ...channelsM8Api(call),
    ...teamM8Api(call),
  };
}

export type Api = ReturnType<typeof createApi>;

const API_TEXT = defineMessages('api', {
  generic: 'Something went wrong.',
  unreachable: 'Cannot reach the Hub. Check your connection and try again.',
});

/** A short, user-facing reason for a failed call (the Hub's own message stays English, D9). */
export function errorMessage(err: unknown, fallback: string = API_TEXT.generic): string {
  if (err instanceof ApiError) return err.body.message || fallback;
  if (err instanceof Error && err.message) {
    return /failed to fetch|networkerror|load failed/i.test(err.message)
      ? API_TEXT.unreachable
      : err.message;
  }
  return fallback;
}
