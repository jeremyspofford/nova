import type { AgentInfo, AgentSession, ApiKey, CodeReviewVerdict, EngramDetail, GuardrailFinding, OAIModel, PipelineTask, Pod, PodAgent, UsageEvent } from './types'

// Admin secret is stored in localStorage so you can change it without
// rebuilding the dashboard. Falls back to empty string when unset — setup.sh
// auto-rotates the deployed secret on first run, so the placeholder default
// from previous versions is no longer valid. An empty header will 401 and the
// existing auth flow (JWT login, trusted-network bypass) handles the rest.
export const getAdminSecret = () =>
  localStorage.getItem('nova_admin_secret') ?? ''

export const setAdminSecret = (s: string) =>
  localStorage.setItem('nova_admin_secret', s)

/** Get the current JWT access token if available. */
function getAccessToken(): string | null {
  try {
    const raw = localStorage.getItem('nova_auth_tokens')
    if (!raw) return null
    return JSON.parse(raw).accessToken ?? null
  } catch {
    return null
  }
}

/**
 * Build auth headers.
 *
 * When JWT auth is active (user logged in), only send the Bearer token.
 * The admin secret is a bootstrap/local-dev mechanism — it must NOT be sent
 * alongside JWT because it grants full admin access regardless of user role.
 * Fallback to admin secret only when no JWT exists (pre-auth local dev).
 */
export function getAuthHeaders(): Record<string, string> {
  const token = getAccessToken()
  if (token) {
    return { 'Authorization': `Bearer ${token}` }
  }
  return { 'X-Admin-Secret': getAdminSecret() }
}

/** Try to refresh the access token using the stored refresh token. */
async function tryRefreshToken(): Promise<boolean> {
  try {
    const raw = localStorage.getItem('nova_auth_tokens')
    if (!raw) return false
    const { refreshToken } = JSON.parse(raw)
    if (!refreshToken) return false

    const resp = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (!resp.ok) return false
    const data = await resp.json()
    localStorage.setItem('nova_auth_tokens', JSON.stringify({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    }))
    return true
  } catch {
    return false
  }
}

/**
 * Fetch with auth headers and one-shot JWT refresh-and-retry on 401/403.
 *
 * Shared between apiFetch (orchestrator/etc.) and recoveryFetch. Without this,
 * any call made just after a JWT expires fails permanently — the auth-store's
 * scheduled refresh runs at +14m, but a 15m token can age past that if the tab
 * was throttled or the laptop slept. On 401/403 we try the refresh endpoint
 * once; if that succeeds, getAuthHeaders() picks up the new token from
 * localStorage on the retry.
 *
 * Refresh failures fall through — the caller sees the original failure, just
 * as it would today without retry. That keeps the contract simple and lets
 * the auth-store's own validation cycle eventually clear dead tokens.
 */
export async function fetchWithAuthRetry(url: string, options: RequestInit = {}): Promise<Response> {
  const buildRequest = () => fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...(options.headers ?? {}),
    },
  })

  let resp = await buildRequest()

  // 401 = UserDep auth failure, 403 = AdminDep auth failure (expired JWT)
  if ((resp.status === 401 || resp.status === 403) && getAccessToken()) {
    const refreshed = await tryRefreshToken()
    if (refreshed) {
      resp = await buildRequest()
    }
  }

  return resp
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const resp = await fetchWithAuthRetry(url, options)

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText)
    throw new Error(`${resp.status}: ${text}`)
  }
  // 204 No Content — return undefined
  if (resp.status === 204) return undefined as T
  return resp.json() as Promise<T>
}

// ── Conversations ──────────────────────────────────────────────────────────────

export async function getOrCreateActiveConversation(): Promise<string> {
  const conversations = await apiFetch<any[]>('/api/v1/conversations')
  if (conversations.length > 0) {
    return conversations[0].id
  }
  const newConv = await apiFetch<any>('/api/v1/conversations', { method: 'POST' })
  return newConv.id
}

// ── Agents ────────────────────────────────────────────────────────────────────
export const getAgents = () => apiFetch<AgentInfo[]>('/api/v1/agents')

// ── Usage ─────────────────────────────────────────────────────────────────────
export const getUsage = (limit = 500) =>
  apiFetch<UsageEvent[]>(`/api/v1/usage?limit=${limit}`)

// ── Keys ──────────────────────────────────────────────────────────────────────
export const getKeys = () => apiFetch<ApiKey[]>('/api/v1/keys')

export const createKey = (name: string, rate_limit_rpm: number) =>
  apiFetch<ApiKey & { raw_key: string }>('/api/v1/keys', {
    method: 'POST',
    body: JSON.stringify({ name, rate_limit_rpm }),
  })

export const revokeKey = (id: string) =>
  apiFetch<void>(`/api/v1/keys/${id}`, { method: 'DELETE' })

// ── Models ────────────────────────────────────────────────────────────────────
export const getModels = () =>
  apiFetch<{ data: OAIModel[] }>('/v1/models')

// ── Pipeline Tasks ─────────────────────────────────────────────────────────────

export const submitPipelineTask = (
  user_input: string,
  pod_name?: string,
  model_override?: string,
  metadata: Record<string, unknown> = {},
) =>
  apiFetch<{ task_id: string; status: string; pod_name: string; queued_at: string }>(
    '/api/v1/pipeline/tasks',
    {
      method: 'POST',
      body: JSON.stringify({
        user_input,
        pod_name,
        metadata: { ...metadata, ...(model_override ? { model_override } : {}) },
      }),
    },
  )

export const getPipelineTasks = (params: { status?: string; pod_id?: string; goal_id?: string; limit?: number } = {}) => {
  const qs = new URLSearchParams()
  if (params.status)  qs.set('status', params.status)
  if (params.pod_id)  qs.set('pod_id', params.pod_id)
  if (params.goal_id) qs.set('goal_id', params.goal_id)
  if (params.limit)   qs.set('limit', String(params.limit))
  return apiFetch<PipelineTask[]>(`/api/v1/pipeline/tasks?${qs}`)
}

export const getPipelineTask = (task_id: string) =>
  apiFetch<PipelineTask>(`/api/v1/pipeline/tasks/${task_id}`)

export const cancelPipelineTask = (task_id: string) =>
  apiFetch<{ task_id: string; status: string }>(
    `/api/v1/pipeline/tasks/${task_id}/cancel`,
    { method: 'POST' },
  )

export const reviewPipelineTask = (task_id: string, decision: 'approve' | 'reject', comment?: string) =>
  apiFetch<{ task_id: string; status: string; decision: string }>(
    `/api/v1/pipeline/tasks/${task_id}/review`,
    { method: 'POST', body: JSON.stringify({ decision, comment }) },
  )

export const getQueueStats = () =>
  apiFetch<{ queue_depth: number; dead_letter_depth: number }>('/api/v1/pipeline/queue-stats')

export const getTaskFindings = (task_id: string) =>
  apiFetch<GuardrailFinding[]>(`/api/v1/pipeline/tasks/${task_id}/findings`)

export const getTaskReviews = (task_id: string) =>
  apiFetch<CodeReviewVerdict[]>(`/api/v1/pipeline/tasks/${task_id}/reviews`)

export const getTaskSessions = (task_id: string) =>
  apiFetch<AgentSession[]>(`/api/v1/pipeline/tasks/${task_id}/sessions`)

export interface Artifact {
  id: string
  task_id: string
  agent_session_id: string | null
  artifact_type: string
  name: string
  content: string
  content_hash: string
  file_path: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  attempt?: number
}

export interface WorkspaceFile {
  path: string
  content: string | null
  size_bytes: number
  modified_at: string
  truncated?: boolean
  error?: string
}

export interface TaskSummary {
  headline: string
  files_created: string[]
  files_modified: string[]
  commands_run: string[]
  findings_count: number
  review_verdict: string | null
  cost_usd: number
  duration_s: number | null
}

export const getTaskArtifacts = (task_id: string) =>
  apiFetch<Artifact[]>(`/api/v1/pipeline/tasks/${task_id}/artifacts`)

export const getWorkspaceFile = (path: string) =>
  apiFetch<WorkspaceFile>(`/api/v1/workspace/files?path=${encodeURIComponent(path)}`)

export const deletePipelineTask = (task_id: string) =>
  apiFetch<void>(`/api/v1/pipeline/tasks/${task_id}?force=true`, { method: 'DELETE' })

export const bulkDeletePipelineTasks = (statuses = 'complete,failed,cancelled,pending_human_review,clarification_needed') =>
  apiFetch<{ deleted: number; statuses: string[] }>(
    `/api/v1/pipeline/tasks?status=${encodeURIComponent(statuses)}&force=true`,
    { method: 'DELETE' },
  )

export const bulkDeletePipelineTasksByIds = (ids: string[]) =>
  apiFetch<{ deleted: number; ids: string[] }>(
    `/api/v1/pipeline/tasks?ids=${encodeURIComponent(ids.join(','))}&force=true`,
    { method: 'DELETE' },
  )

export const clarifyPipelineTask = (task_id: string, answers: string[]) =>
  apiFetch<{ task_id: string; status: string }>(
    `/api/v1/pipeline/tasks/${task_id}/clarify`,
    { method: 'POST', body: JSON.stringify({ answers }) },
  )

// ── Pods ───────────────────────────────────────────────────────────────────────

export const getPods = () => apiFetch<Pod[]>('/api/v1/pods')

export const getPod = (pod_id: string) => apiFetch<Pod>(`/api/v1/pods/${pod_id}`)

export const createPod = (data: Partial<Pod>) =>
  apiFetch<Pod>('/api/v1/pods', { method: 'POST', body: JSON.stringify(data) })

export const updatePod = (pod_id: string, data: Partial<Pod>) =>
  apiFetch<Pod>(`/api/v1/pods/${pod_id}`, { method: 'PATCH', body: JSON.stringify(data) })

export const deletePod = (pod_id: string) =>
  apiFetch<void>(`/api/v1/pods/${pod_id}`, { method: 'DELETE' })

export const getPodAgents = (pod_id: string) =>
  apiFetch<PodAgent[]>(`/api/v1/pods/${pod_id}/agents`)

export const updatePodAgent = (pod_id: string, agent_id: string, data: Partial<PodAgent>) =>
  apiFetch<PodAgent>(`/api/v1/pods/${pod_id}/agents/${agent_id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })

export const patchAgentConfig = (
  agent_id: string,
  data: { model?: string | null; system_prompt?: string | null; fallback_models?: string[] },
) =>
  apiFetch<AgentInfo>(`/api/v1/agents/${agent_id}/config`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })

// ── Direct chat (admin stream) ────────────────────────────────────────────────

export interface ContentBlock {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
}

export interface StreamChatOptions {
  output_style?: string
  custom_instructions?: string
  web_search?: boolean
  deep_research?: boolean
  conversation_id?: string
}

/** Metadata emitted by intelligent routing before content deltas. */
export interface StreamMeta {
  model?: string
  category?: string
}

/** Activity step emitted during processing (before content deltas). */
export interface EngramSummary {
  id: string
  type: string
  preview: string
  source_type?: string
}

export interface ActivityStep {
  step: string       // "classifying" | "memory" | "model" | "generating" | tool names
  state: 'running' | 'done'
  detail?: string
  elapsed_ms?: number
  model?: string
  category?: string | null
  engram_summaries?: EngramSummary[]
}

export type StreamEvent =
  | string
  | { meta: StreamMeta }
  | { status: ActivityStep }
  | { heartbeat: number }  // elapsed_ms since the turn started — proof-of-life during long work
  | { think: string }      // the model's planning prose from a tool round, shown live

/**
 * Stream a chat turn directly with the primary Nova agent.
 * Uses the admin secret — no API key required.
 *
 * Yields text deltas (strings) and optional routing metadata events.
 * Pass the sessionId back on the next call to continue the same conversation thread.
 */
export async function* streamChat(
  messages: ChatMessage[],
  model?: string,
  sessionId?: string,
  options?: StreamChatOptions,
): AsyncGenerator<StreamEvent, void, unknown> {
  const resp = await fetch('/api/v1/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify({
      messages,
      model,
      session_id: sessionId,
      ...options,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText)
    throw new Error(`${resp.status}: ${text}`)
  }

  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const event of events) {
      const line = event.trim()
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') return
      if (data.startsWith('{')) {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>
          if (parsed.error) throw new Error(String(parsed.error))
          if (parsed.t !== undefined) {
            yield parsed.t as string
            continue
          }
          if (parsed.status) {
            yield { status: parsed.status as ActivityStep }
            continue
          }
          if (parsed.meta) {
            yield { meta: parsed.meta as StreamMeta }
            continue
          }
          if (parsed.hb !== undefined) {
            yield { heartbeat: parsed.hb as number }
            continue
          }
          if (parsed.think !== undefined) {
            yield { think: parsed.think as string }
            continue
          }
        } catch {
          if (data) yield data
        }
      } else if (data) {
        yield data
      }
    }
  }
}

// ── MCP Servers ────────────────────────────────────────────────────────────────

export interface MCPServer {
  id: string
  name: string
  description: string
  transport: 'stdio' | 'http'
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  enabled: boolean
  created_at: string
  metadata: Record<string, unknown>
  // Runtime status fields (populated by list endpoint, not in DB)
  connected?: boolean
  tool_count?: number
  active_tools?: string[]
}

export const getMCPServers = () =>
  apiFetch<MCPServer[]>('/api/v1/mcp-servers')

export const createMCPServer = (data: Partial<MCPServer>) =>
  apiFetch<MCPServer & { connected: boolean }>('/api/v1/mcp-servers', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const updateMCPServer = (id: string, data: Partial<MCPServer>) =>
  apiFetch<MCPServer & { connected: boolean }>(`/api/v1/mcp-servers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })

export const deleteMCPServer = (id: string) =>
  apiFetch<void>(`/api/v1/mcp-servers/${id}`, { method: 'DELETE' })

export const reloadMCPServer = (id: string) =>
  apiFetch<{ name: string; connected: boolean; tool_count: number; tools: string[] }>(
    `/api/v1/mcp-servers/${id}/reload`,
    { method: 'POST' },
  )

// ── Agent Endpoints (ACP/A2A outbound delegation) ────────────────────────────

export interface AgentEndpoint {
  id: string
  name: string
  description: string
  url: string
  protocol: 'a2a' | 'acp' | 'generic'
  input_schema: Record<string, unknown>
  output_schema: Record<string, unknown>
  enabled: boolean
  created_at: string
  metadata: Record<string, unknown>
  // auth_token is never returned by the API; pass it only on create/update
}

export interface AgentEndpointWrite extends Omit<AgentEndpoint, 'id' | 'created_at'> {
  auth_token?: string
}

export const getAgentEndpoints = () =>
  apiFetch<AgentEndpoint[]>('/api/v1/agent-endpoints')

export const createAgentEndpoint = (data: Partial<AgentEndpointWrite>) =>
  apiFetch<AgentEndpoint>('/api/v1/agent-endpoints', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const updateAgentEndpoint = (id: string, data: Partial<AgentEndpointWrite>) =>
  apiFetch<AgentEndpoint>(`/api/v1/agent-endpoints/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })

export const deleteAgentEndpoint = (id: string) =>
  apiFetch<void>(`/api/v1/agent-endpoints/${id}`, { method: 'DELETE' })

// ── Goals ────────────────────────────────────────────────────────────────────

export interface Goal {
  id: string
  title: string
  description: string | null
  success_criteria: string | null
  status: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled'
  priority: number
  progress: number
  current_plan: unknown | null
  iteration: number
  max_iterations: number | null
  max_cost_usd: number | null
  cost_so_far_usd: number
  check_interval_seconds: number | null
  last_checked_at: string | null
  parent_goal_id: string | null
  created_by: string
  created_at: string
  updated_at: string
  // Recurring schedule (cron). schedule_next_at is the next fire time.
  schedule_cron?: string | null
  schedule_next_at?: string | null
  schedule_last_ran_at?: string | null
  max_completions?: number | null
  completion_count?: number
  // Maturation fields (populated when goal maturation is active)
  maturation_status?: string | null
  scope_analysis?: unknown | null
  spec?: string | null
  spec_children?: Array<{
    title: string
    description?: string
    hint?: string
    estimated_cost_usd?: number
    depends_on?: number[]
    estimated_complexity?: string
  }> | null
  verification_commands?: Array<{ cmd: string; cwd?: string | null; timeout_s?: number }> | null
  success_criteria_structured?: Array<{ statement: string; check: string; check_arg: string }> | null
  review_policy?: string
  depth?: number
  max_depth?: number
  max_retries?: number
  retry_count?: number
  spec_approved_at?: string | null
  spec_approved_by?: string | null
}

export interface GoalIteration {
  id: string
  goal_id: string
  attempt: number
  cycle_number: number
  plan_text: string | null
  task_id: string | null
  task_status: string | null
  task_summary: string | null
  cost_usd: number
  files_touched: string[]
  plan_adjustment: string | null
  created_at: string
}

export const getGoalIterations = (goal_id: string) =>
  apiFetch<GoalIteration[]>(`/api/v1/goals/${goal_id}/iterations`)

export const getGoalArtifacts = (goal_id: string) =>
  apiFetch<Artifact[]>(`/api/v1/goals/${goal_id}/artifacts`)

export const getGoals = (status?: string) => {
  const qs = status ? `?status=${status}` : ''
  return apiFetch<Goal[]>(`/api/v1/goals${qs}`)
}

export const getGoal = (id: string) =>
  apiFetch<Goal>(`/api/v1/goals/${id}`)

export const createGoal = (data: { title: string; description?: string; success_criteria?: string; priority?: number; max_iterations?: number | null; max_cost_usd?: number; check_interval_seconds?: number; schedule_cron?: string | null; max_completions?: number | null }) =>
  apiFetch<Goal>('/api/v1/goals', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const updateGoal = (id: string, data: Partial<Goal>) =>
  apiFetch<Goal>(`/api/v1/goals/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })

export const deleteGoal = (id: string) =>
  apiFetch<void>(`/api/v1/goals/${id}`, { method: 'DELETE' })

// ── Cortex ───────────────────────────────────────────────────────────────────

export interface CortexStatus {
  status: string
  current_drive: string | null
  cycle_count: number
  last_cycle_at: string | null
}

export interface CortexDrive {
  name: string
  priority: number
  urgency: number
  description: string
}

export const getCortexStatus = () =>
  apiFetch<CortexStatus>('/cortex-api/api/v1/cortex/status')

export const triggerGoal = (goalId: string) =>
  apiFetch<{ status: string; task_id?: string }>(`/cortex-api/api/v1/cortex/trigger/${goalId}`, { method: 'POST' })

export const getCortexDrives = () =>
  apiFetch<{ drives: CortexDrive[] }>('/cortex-api/api/v1/cortex/drives')

export interface BudgetStatus {
  daily_budget_usd: number
  daily_spend_usd: number
  remaining_usd: number
  percent_used: number
  budget_exceeded: boolean
  tier: string
}

export const getCortexBudget = () =>
  apiFetch<BudgetStatus>('/cortex-api/api/v1/cortex/budget')

export interface JournalEntry {
  id: string
  role: string
  content: string
  metadata: Record<string, unknown>
  created_at: string
}

export const getCortexJournal = (limit = 20) =>
  apiFetch<{ entries: JournalEntry[] }>(`/cortex-api/api/v1/cortex/journal?limit=${limit}`)

// ── Provider status ──────────────────────────────────────────────────────────

export interface ProviderStatus {
  slug: string
  name: string
  type: 'subscription' | 'free' | 'paid' | 'local'
  available: boolean
  model_count: number
  default_model: string
}

export const getProviderStatus = () =>
  apiFetch<ProviderStatus[]>('/v1/health/providers')

export const testProvider = (slug: string) =>
  apiFetch<{ ok: boolean; latency_ms: number; error?: string }>(
    `/v1/health/providers/${slug}/test`, { method: 'POST' })

export interface OllamaStatus {
  healthy: boolean
  base_url: string
  routing_strategy: string
  wol_configured: boolean
  wol_last_sent_seconds_ago: number | null
  gpu_available: boolean
}

export const getOllamaStatus = () =>
  apiFetch<OllamaStatus>('/v1/health/providers/ollama/status')

export interface LMStudioStatus {
  healthy: boolean
  base_url: string
  model_count: number
  active_model: string | null
  models: string[]
}

export const getLMStudioStatus = () =>
  apiFetch<LMStudioStatus>('/v1/health/providers/lmstudio/status')

// ── Model Discovery ──────────────────────────────────────────────────────────

export interface DiscoveredModel {
  id: string
  registered: boolean
}

export interface ProviderModelList {
  slug: string
  name: string
  type: 'local' | 'subscription' | 'free' | 'paid'
  available: boolean
  auth_methods: string[]
  models: DiscoveredModel[]
}

export interface OllamaPulledModel {
  name: string
  size: number
  parameter_size: string
  quantization_level: string
  digest: string
  modified_at: string
}

export const MODEL_CATALOG_CACHE_KEY = 'nova_model_catalog_v1'
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000

export async function discoverModels(refresh = false): Promise<ProviderModelList[]> {
  const data = await apiFetch<ProviderModelList[]>(`/v1/models/discover${refresh ? '?refresh=true' : ''}`)
  try {
    localStorage.setItem(MODEL_CATALOG_CACHE_KEY, JSON.stringify({ data, at: Date.now() }))
  } catch {}
  return data
}

export function readCachedModelCatalog(): { data: ProviderModelList[]; at: number } | null {
  try {
    const raw = localStorage.getItem(MODEL_CATALOG_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { data: ProviderModelList[]; at: number }
    if (!parsed.data || Date.now() - parsed.at > MODEL_CATALOG_MAX_AGE_MS) return null
    return parsed
  } catch { return null }
}

export interface ResolvedModel {
  model: string
  source: 'auto' | 'explicit'
}

export const resolveModel = () =>
  apiFetch<ResolvedModel>('/v1/models/resolve')

export const getOllamaPulled = () =>
  apiFetch<OllamaPulledModel[]>('/v1/models/ollama/pulled')

export const pullOllamaModel = (name: string) =>
  apiFetch<{ status: string; model: string }>('/v1/models/ollama/pull', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })

export const deleteOllamaModel = (name: string) =>
  apiFetch<{ status: string; model: string }>(`/v1/models/ollama/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })

// ── LM Studio downloaded-model library ───────────────────────────────────────

export interface LMStudioDownloadedModel {
  key: string
  type: 'llm' | 'embedding'
  publisher: string
  display_name: string
  architecture: string | null
  quantization: string | null
  bits_per_weight: number | null
  size_bytes: number
  params_string: string | null
  loaded: boolean
  loaded_instances: string[]
  max_context_length: number | null
  format: string | null
  supports_vision: boolean
  supports_tools: boolean
  variants: string[]
  selected_variant: string | null
}

export const getLMStudioDownloaded = () =>
  apiFetch<LMStudioDownloadedModel[]>('/v1/models/lmstudio/downloaded')

export const loadLMStudioModel = (
  model: string,
  context_length?: number,
) =>
  apiFetch<{ status: string; instance_id: string; load_time_seconds?: number }>(
    '/v1/models/lmstudio/load',
    { method: 'POST', body: JSON.stringify({ model, context_length }) },
  )

export const unloadLMStudioModel = (instance_id: string) =>
  apiFetch<{ status: string; instance_id: string }>(
    '/v1/models/lmstudio/unload',
    { method: 'POST', body: JSON.stringify({ instance_id }) },
  )

// ── Tool catalog ──────────────────────────────────────────────────────────────

export interface ToolInfo { name: string; description: string }
export interface ToolCategory { category: string; source: 'builtin' | 'mcp'; tools: ToolInfo[] }

export const getAvailableTools = () => apiFetch<ToolCategory[]>('/api/v1/tools')

// ── Platform configuration ────────────────────────────────────────────────────

export interface PlatformConfigEntry {
  key: string
  /** Decoded value — string, number, boolean, or null */
  value: string | number | boolean | null
  description: string
  is_secret: boolean
  updated_at: string | null
  /**
   * Present when this DB-owned key ALSO has a legacy .env variable set.
   * `ignored` is true when the .env value disagrees with the effective DB
   * value — i.e. the operator has dead weight in .env they should remove.
   */
  env_override?: { var: string; value: string; ignored: boolean }
}

/** One row of a config key's change history (from platform_config_audit). */
export interface PlatformConfigHistoryEntry {
  old_value: string | number | boolean | null
  new_value: string | number | boolean | null
  changed_by: string | null
  changed_at: string | null
}

export const getPlatformConfig = () =>
  apiFetch<PlatformConfigEntry[]>('/api/v1/config')

/** Change history for a single config key, newest first. */
export const getPlatformConfigHistory = (key: string) =>
  apiFetch<PlatformConfigHistoryEntry[]>(
    `/api/v1/config/${encodeURIComponent(key)}/history`,
  )

/**
 * Update a single platform config entry.
 * Pass the value as a JSON-encoded string:
 *   updatePlatformConfig('nova.persona', '"My custom persona"')
 *   updatePlatformConfig('nova.default_model', 'null')
 */
export const updatePlatformConfig = (key: string, value: string) =>
  apiFetch<PlatformConfigEntry>(`/api/v1/config/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: JSON.stringify({ value }),
  })

// ── Tool Permissions ─────────────────────────────────────────────────────────

export interface ToolGroupStatus {
  name: string
  display_name: string
  description: string
  tools: string[]
  tool_count: number
  enabled: boolean
  is_mcp: boolean
}

export const getToolPermissions = () =>
  apiFetch<ToolGroupStatus[]>('/api/v1/tool-permissions')

export const updateToolPermissions = (groups: Record<string, boolean>) =>
  apiFetch<ToolGroupStatus[]>('/api/v1/tool-permissions', {
    method: 'PATCH',
    body: JSON.stringify({ groups }),
  })

// ── Friction Log ─────────────────────────────────────────────────────────────

export interface FrictionEntry {
  id: string
  description: string
  severity: 'blocker' | 'annoyance' | 'idea'
  status: 'open' | 'in_progress' | 'fixed'
  source: 'manual' | 'auto'
  task_id: string | null
  user_id: string | null
  has_screenshot: boolean
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface FrictionStats {
  open_count: number
  in_progress_count: number
  fixed_count: number
  total_count: number
  blocker_count: number
}

export const getFrictionEntries = (params?: { severity?: string; status?: string; limit?: number; offset?: number }) => {
  const query = new URLSearchParams()
  if (params?.severity) query.set('severity', params.severity)
  if (params?.status) query.set('status', params.status)
  if (params?.limit) query.set('limit', String(params.limit))
  if (params?.offset) query.set('offset', String(params.offset))
  const qs = query.toString()
  return apiFetch<FrictionEntry[]>(`/api/v1/friction${qs ? `?${qs}` : ''}`)
}

export const createFrictionEntry = (data: { description: string; severity: string; screenshot?: string; screenshot_thumb?: string }) =>
  apiFetch<FrictionEntry>('/api/v1/friction', { method: 'POST', body: JSON.stringify(data) })

export const updateFrictionEntry = (id: string, data: { status?: string; severity?: string }) =>
  apiFetch<FrictionEntry>(`/api/v1/friction/${id}`, { method: 'PATCH', body: JSON.stringify(data) })

export const deleteFrictionEntry = (id: string) =>
  apiFetch<void>(`/api/v1/friction/${id}`, { method: 'DELETE' })

export const bulkDeleteFrictionEntries = () =>
  apiFetch<{ deleted: number }>('/api/v1/friction', { method: 'DELETE' })

export const fixFrictionEntry = (id: string) =>
  apiFetch<{ task_id: string }>(`/api/v1/friction/${id}/fix`, { method: 'POST' })

export const getFrictionStats = () =>
  apiFetch<FrictionStats>('/api/v1/friction/stats')

// ── Identity ─────────────────────────────────────────────────────────────────

export interface NovaIdentity {
  name: string
  greeting: string
}

export const getNovaIdentity = () =>
  apiFetch<NovaIdentity>('/api/v1/identity')

// ── Dashboard overview endpoints ─────────────────────────────────────────────

export interface PipelineStats {
  active_count: number
  queued_count: number
  completed_today: number
  completed_this_week: number
  failed_today: number
  failed_this_week: number
  submitted_today: number
  success_rate_7d: number
  avg_duration_ms: number
}

export interface UsageSummary {
  total_cost_usd: number
  total_requests: number
  by_model: Array<{ model: string; cost_usd: number; requests: number }>
  by_day: Array<{ date: string; cost_usd: number; requests: number }>
  vs_previous_period_pct: number
}

export interface HealthOverview {
  services: Array<{ name: string; status: string; latency_ms: number }>
  avg_latency_ms: number
  overall_status: string
}

export interface ActivityEvent {
  id: number
  event_type: string
  service: string
  severity: string
  summary: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface PipelineLatency {
  avg_total_ms: number
  p50_ms: number
  p95_ms: number
  by_stage: Array<{ stage: string; avg_ms: number }>
}

export interface GoalStats {
  active: number
  completed: number
  failed: number
  paused: number
  success_rate: number
  avg_iterations: number
  avg_cost_usd: number
  total_cost_usd: number
}

export interface RoutingStats {
  by_model: Array<{ model: string; requests: number; avg_tokens: number; avg_latency_ms: number; cost_usd: number }>
  fallback_rate_pct: number
  category_distribution: Record<string, number>
}

export const getPipelineStats = () =>
  apiFetch<PipelineStats>('/api/v1/pipeline/stats')

export const getUsageSummary = (period: string) =>
  apiFetch<UsageSummary>(`/api/v1/usage/summary?period=${period}`)

export const getHealthOverview = () =>
  apiFetch<HealthOverview>('/api/v1/health/overview')

export const getActivityFeed = (limit = 20) =>
  apiFetch<ActivityEvent[]>(`/api/v1/activity?limit=${limit}`)

export const getPipelineLatency = () =>
  apiFetch<PipelineLatency>('/api/v1/pipeline/stats/latency')

export const getGoalStats = () =>
  apiFetch<GoalStats>('/api/v1/goals/stats')

export const getRoutingStats = (period = '7d') =>
  apiFetch<RoutingStats>(`/api/v1/models/routing-stats?period=${period}`)

// ── Intelligence types ──────────────────────────────────────────────────────

export interface IntelFeed {
  id: string
  name: string
  url: string
  feed_type: string
  category: string | null
  check_interval_seconds: number
  last_checked_at: string | null
  last_hash: string | null
  error_count: number
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface IntelContentItem {
  id: string
  title: string | null
  url: string | null
  body: string | null
  author: string | null
  score: number | null
  published_at: string | null
  content_hash: string
  metadata: Record<string, unknown>
}

export interface IntelRecommendation {
  id: string
  title: string
  summary: string
  rationale: string | null
  features: string[]
  grade: string
  confidence: number
  category: string | null
  status: string
  auto_implementable: boolean
  complexity: string | null
  implementation_plan: string | null
  goal_id: string | null
  sources?: IntelContentItem[]
  engrams?: { engram_id: string; activation_score: number }[]
  comments?: Comment[]
  source_count?: number
  memory_count?: number
  comment_count?: number
  created_at: string
  updated_at: string
}

export interface Comment {
  id: string
  entity_type: string
  entity_id: string
  author_type: string
  author_name: string
  body: string
  created_at: string
}

export interface IntelStats {
  items_this_week: number
  active_feeds: number
  grade_a: number
  grade_b: number
  grade_c: number
  total_recommendations: number
}

// ── Intelligence API functions ──────────────────────────────────────────────

export const getIntelFeeds = () =>
  apiFetch<IntelFeed[]>('/api/v1/intel/feeds')

export const createIntelFeed = (data: { url: string; name?: string; check_interval_seconds?: number }) =>
  apiFetch<IntelFeed>('/api/v1/intel/feeds', { method: 'POST', body: JSON.stringify(data) })

export const updateIntelFeed = (id: string, data: Partial<Pick<IntelFeed, 'url' | 'name' | 'check_interval_seconds' | 'enabled'>>) =>
  apiFetch<IntelFeed>(`/api/v1/intel/feeds/${id}`, { method: 'PATCH', body: JSON.stringify(data) })

export const deleteIntelFeed = (id: string) =>
  apiFetch<void>(`/api/v1/intel/feeds/${id}`, { method: 'DELETE' })

export const getIntelRecommendations = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : ''
  return apiFetch<IntelRecommendation[]>(`/api/v1/intel/recommendations${qs}`)
}

export const getIntelRecommendation = (id: string) =>
  apiFetch<IntelRecommendation>(`/api/v1/intel/recommendations/${id}`)

export const updateRecommendation = (id: string, data: { status: string; decided_by?: string }) =>
  apiFetch<IntelRecommendation>(`/api/v1/intel/recommendations/${id}`, { method: 'PATCH', body: JSON.stringify(data) })

export const getIntelStats = () =>
  apiFetch<IntelStats>('/api/v1/intel/stats')

// ── Comment API functions (unified for recommendations + goals) ─────────────

export const getComments = (entityType: 'recommendation' | 'goal', entityId: string) => {
  const base = entityType === 'goal' ? 'goals' : 'intel/recommendations'
  return apiFetch<Comment[]>(`/api/v1/${base}/${entityId}/comments`)
}

export const addComment = (entityType: 'recommendation' | 'goal', entityId: string, body: string, authorName: string) => {
  const base = entityType === 'goal' ? 'goals' : 'intel/recommendations'
  return apiFetch<Comment>(`/api/v1/${base}/${entityId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body, author_name: authorName, author_type: 'human' }),
  })
}

export const deleteComment = (entityType: 'recommendation' | 'goal', entityId: string, commentId: string) => {
  const base = entityType === 'goal' ? 'goals' : 'intel/recommendations'
  return apiFetch<void>(`/api/v1/${base}/${entityId}/comments/${commentId}`, { method: 'DELETE' })
}

// ── Knowledge Sources ────────────────────────────────────────────────────────

export interface KnowledgeSource {
  id: string
  tenant_id: string
  name: string
  source_type: string
  url: string
  scope: string
  crawl_config: Record<string, unknown>
  credential_id: string | null
  status: string
  last_crawl_at: string | null
  last_crawl_summary: Record<string, unknown> | null
  error_count: number
  created_at: string
  updated_at: string
}

export interface KnowledgeCredential {
  id: string
  label: string
  provider: string
  scopes: Record<string, unknown> | null
  last_validated_at: string | null
  created_at: string
}

export interface KnowledgeStats {
  sources_by_status: Record<string, number>
  total_credentials: number
  total_sources: number
}

export const getKnowledgeSources = (params?: { scope?: string; status?: string }) => {
  const searchParams = new URLSearchParams()
  if (params?.scope) searchParams.set('scope', params.scope)
  if (params?.status) searchParams.set('status', params.status)
  const query = searchParams.toString()
  return apiFetch<KnowledgeSource[]>(`/api/v1/knowledge/sources${query ? `?${query}` : ''}`)
}

export const createKnowledgeSource = (data: { name: string; url: string; source_type: string; scope?: string; credential_id?: string }) =>
  apiFetch<KnowledgeSource>('/api/v1/knowledge/sources', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const deleteKnowledgeSource = (id: string) =>
  apiFetch<void>(`/api/v1/knowledge/sources/${id}`, { method: 'DELETE' })

export const triggerCrawl = (id: string) =>
  apiFetch<void>(`/api/v1/knowledge/sources/${id}/crawl`, { method: 'POST' })

export const pauseKnowledgeSource = (id: string) =>
  apiFetch<KnowledgeSource>(`/api/v1/knowledge/sources/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'paused' }),
  })

export const resumeKnowledgeSource = (id: string) =>
  apiFetch<KnowledgeSource>(`/api/v1/knowledge/sources/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'active' }),
  })

export const pasteContent = (id: string, content: string) =>
  apiFetch<void>(`/api/v1/knowledge/sources/${id}/paste`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })

export const getKnowledgeCredentials = () =>
  apiFetch<KnowledgeCredential[]>('/api/v1/knowledge/credentials')

export const createKnowledgeCredential = (data: { label: string; credential_data: string; scopes?: Record<string, unknown> }) =>
  apiFetch<KnowledgeCredential>('/api/v1/knowledge/credentials', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const deleteKnowledgeCredential = (id: string) =>
  apiFetch<void>(`/api/v1/knowledge/credentials/${id}`, { method: 'DELETE' })

export const getKnowledgeStats = () =>
  apiFetch<KnowledgeStats>('/api/v1/knowledge/stats')

export interface DomainSummary {
  source_count: number
  engram_count: number
  by_kind: Record<string, { count: number; stale_count: number }>
  domains: string[]
  recent_sources: { title: string; kind: string }[]
  gaps: { title: string; kind: string; coverage: string | null }[]
  stale_sources: { title: string; kind: string }[]
}

export const getDomainSummary = () =>
  apiFetch<DomainSummary>('/mem/api/v1/engrams/sources/domain-summary')

export const getEngramDetail = (engramId: string) =>
  apiFetch<EngramDetail>(`/mem/api/v1/engrams/engrams/${engramId}`)

export const deleteEngram = (engramId: string) =>
  apiFetch<void>(`/mem/api/v1/engrams/engrams/${engramId}`, { method: 'DELETE' })

// ── Engram Reindex ──────────────────────────────────────────────────────────

export interface ReindexResponse {
  status: string
  queued: Record<string, number>
  total: number
  dry_run: boolean
  message: string
}

export interface ReindexStatusResponse {
  queue_depth: number
  total_queued: number
  processed: number
  progress_pct: number
  engram_count: number | null
  active: boolean
  sources: string[]
  started_at: string | null
  message: string
}

export const reindexMemory = (sources: string[], dryRun = false, since?: string) =>
  apiFetch<ReindexResponse>('/api/v1/engrams/reindex', {
    method: 'POST',
    body: JSON.stringify({ sources, dry_run: dryRun, ...(since ? { since } : {}) }),
  })

export const getReindexStatus = () =>
  apiFetch<ReindexStatusResponse>('/api/v1/engrams/reindex/status')

// ── Skills ──────────────────────────────────────────────────────────────────

export const getSkills = () => apiFetch<any[]>('/api/v1/skills')
export const createSkill = (data: Record<string, unknown>) =>
  apiFetch('/api/v1/skills', { method: 'POST', body: JSON.stringify(data) })
export const updateSkill = (id: string, data: Record<string, unknown>) =>
  apiFetch(`/api/v1/skills/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
export const deleteSkill = (id: string) =>
  apiFetch(`/api/v1/skills/${id}`, { method: 'DELETE' })

// ── Rules ───────────────────────────────────────────────────────────────────

export const getRules = () => apiFetch<any[]>('/api/v1/rules')
export const createRule = (data: Record<string, unknown>) =>
  apiFetch('/api/v1/rules', { method: 'POST', body: JSON.stringify(data) })
export const updateRule = (id: string, data: Record<string, unknown>) =>
  apiFetch(`/api/v1/rules/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
export const deleteRule = (id: string) =>
  apiFetch(`/api/v1/rules/${id}`, { method: 'DELETE' })

// ── Self-Modification ──────────────────────────────────────────────────────

export interface SelfModStatus {
  enabled: boolean
  pat_configured: boolean
  repo: string
  rate_limit_per_hour: number
  prs_this_hour: number
}

export interface SelfModPR {
  id: string
  pr_number: number
  branch_name: string
  title: string
  body: string
  status: string
  ci_status: string
  files_changed: number
  goal_id: string | null
  task_id: string | null
  created_at: string
  updated_at: string
  merged_at: string | null
  closed_at: string | null
}

export async function getSelfModStatus(): Promise<SelfModStatus> {
  return apiFetch<SelfModStatus>('/api/v1/selfmod/status')
}

export async function getSelfModPRs(): Promise<SelfModPR[]> {
  return apiFetch<SelfModPR[]>('/api/v1/selfmod/prs')
}

// ── Capability credentials & watched repos ──────────────────────────────────

export type CredentialBackend = 'builtin' | 'vault' | 'onepassword' | 'bitwarden'
export type AuthMethod = 'pat' | 'github_app' | 'oauth'
export type CredentialHealth = 'healthy' | 'expired' | 'revoked' | 'invalid' | 'unknown'
export type TriggerMode = 'webhook_with_polling_fallback' | 'webhook_only' | 'polling_only'

export interface Credential {
  id: string
  tenant_id: string
  user_id: string | null
  provider_kind: string
  auth_method: AuthMethod
  label: string
  backend: CredentialBackend
  scopes: Record<string, unknown> | null
  expires_at: string | null
  last_validated_at: string | null
  health: CredentialHealth
  created_at: string
}

export interface CredentialCreatePayload {
  provider_kind: string
  auth_method: AuthMethod
  label: string
  secret: string
  scopes?: Record<string, unknown>
  backend?: CredentialBackend
}

export interface WatchedRepo {
  id: string
  tenant_id: string
  user_id: string | null
  credential_id: string
  repo: string
  trigger_mode: TriggerMode
  polling_interval_min: number
  workflow_pattern: string | null
  // Server returns TIME columns as ISO time strings ("HH:MM:SS"), or null.
  active_hours_start: string | null
  active_hours_end: string | null
  daily_budget: number
  enabled: boolean
  created_at: string
}

export interface WatchedRepoCreatePayload {
  repo: string
  trigger_mode?: TriggerMode
  polling_interval_min?: number
  workflow_pattern?: string | null
  active_hours_start?: string | null
  active_hours_end?: string | null
  daily_budget?: number
  enabled?: boolean
}

export type WatchedRepoUpdatePayload = Partial<Omit<WatchedRepoCreatePayload, 'repo'>>

export const listCredentials = (provider_kind?: string) => {
  const qs = provider_kind ? `?provider_kind=${encodeURIComponent(provider_kind)}` : ''
  return apiFetch<Credential[]>(`/api/v1/capabilities/credentials${qs}`)
}

export const createCredential = (payload: CredentialCreatePayload) =>
  apiFetch<Credential>('/api/v1/capabilities/credentials', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const deleteCredential = (id: string) =>
  apiFetch<void>(`/api/v1/capabilities/credentials/${id}`, { method: 'DELETE' })

export const testCredential = (id: string) =>
  apiFetch<{ health: CredentialHealth }>(
    `/api/v1/capabilities/credentials/${id}/test`,
    { method: 'POST', body: JSON.stringify({}) },
  )

export const listWatchedRepos = (credentialId: string) =>
  apiFetch<WatchedRepo[]>(
    `/api/v1/capabilities/credentials/${credentialId}/watched-repos`,
  )

export const createWatchedRepo = (
  credentialId: string,
  payload: WatchedRepoCreatePayload,
) =>
  apiFetch<WatchedRepo>(
    `/api/v1/capabilities/credentials/${credentialId}/watched-repos`,
    { method: 'POST', body: JSON.stringify(payload) },
  )

export const updateWatchedRepo = (id: string, payload: WatchedRepoUpdatePayload) =>
  apiFetch<WatchedRepo>(`/api/v1/capabilities/watched-repos/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })

export const deleteWatchedRepo = (id: string) =>
  apiFetch<void>(`/api/v1/capabilities/watched-repos/${id}`, { method: 'DELETE' })

// ── Webhook registration ────────────────────────────────────────────────────
// Today this is the admin-only direct path. A future revision will route this
// through the executor + consent gate so a pending approval card appears.

export interface WebhookRegisterPayload {
  credential_id: string
  repo: string
  target_url: string
  events?: string[]
}

// Two response shapes after T1-02:
//  - Auto-approved (matching consent_rule exists) → 201 with hook fields
//  - Pending consent → 202 with {status:"consent_pending", approval_id}
// Callers must check `status` before reading hook_id.
export type WebhookRegisterResult =
  | { status: 'consent_pending'; approval_id: string }
  | { status: string; hook_id: number; row_id?: string; ping_delivery_id?: string }

export const registerGithubWebhook = (payload: WebhookRegisterPayload) =>
  apiFetch<WebhookRegisterResult>('/api/v1/webhooks/github/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

// ── Approvals (consent gate queue) ──────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout' | 'superseded'
export type ToolKind = 'native' | 'mcp_http' | 'mcp_stdio'
export type BlastRadius = 'read' | 'propose' | 'mutate' | 'destruct'

export interface Approval {
  id: string
  tenant_id: string
  task_id: string | null
  requested_by: string
  tool_name: string
  tool_kind: ToolKind
  blast_radius: BlastRadius
  args_redacted: Record<string, unknown>
  diff_preview: string | null
  status: ApprovalStatus
  decided_by: string | null
  decided_via: string | null
  decided_at: string | null
  rule_id: string | null
  created_at: string
  expires_at: string
}

export interface ApprovalDecisionPayload {
  decision: 'approve' | 'reject'
  remember?: boolean
  rule_scope?: Record<string, unknown>
}

export const listApprovals = () =>
  apiFetch<Approval[]>('/api/v1/capabilities/approvals')

export const getApproval = (id: string) =>
  apiFetch<Approval>(`/api/v1/capabilities/approvals/${id}`)

export const decideApproval = (id: string, payload: ApprovalDecisionPayload) =>
  apiFetch<{ status: string }>(
    `/api/v1/capabilities/approvals/${id}/decide`,
    { method: 'POST', body: JSON.stringify(payload) },
  )

// ── Consent rules (auto-approve policies) ───────────────────────────────────

export type ConsentRuleSource = 'user_remember' | 'cortex_proposed'

export interface ConsentRule {
  id: string
  tenant_id: string
  user_id: string
  tool_name: string
  provider_kind: string
  scope_match: Record<string, unknown>
  source: ConsentRuleSource
  proposed_at: string | null
  accepted_at: string
  enabled: boolean
  last_applied_at: string | null
  apply_count: number
}

export interface ConsentRuleCreatePayload {
  tool_name: string
  provider_kind: string
  scope_match: Record<string, unknown>
  source?: ConsentRuleSource
}

export const listConsentRules = (filters: { tool_name?: string; provider_kind?: string } = {}) => {
  const qs = new URLSearchParams()
  if (filters.tool_name) qs.set('tool_name', filters.tool_name)
  if (filters.provider_kind) qs.set('provider_kind', filters.provider_kind)
  const suffix = qs.toString()
  return apiFetch<ConsentRule[]>(
    `/api/v1/capabilities/consent-rules${suffix ? `?${suffix}` : ''}`,
  )
}

export const createConsentRule = (payload: ConsentRuleCreatePayload) =>
  apiFetch<ConsentRule>('/api/v1/capabilities/consent-rules', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const updateConsentRule = (id: string, payload: { enabled: boolean }) =>
  apiFetch<ConsentRule>(`/api/v1/capabilities/consent-rules/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })

export const deleteConsentRule = (id: string) =>
  apiFetch<void>(`/api/v1/capabilities/consent-rules/${id}`, { method: 'DELETE' })

// ── Audit log query ─────────────────────────────────────────────────────────

export interface AuditEvent {
  id: string
  tenant_id: string
  user_id: string | null
  timestamp: string
  actor_kind: string
  actor_id: string
  task_id: string | null
  event_type: string
  tool_name: string | null
  tool_kind: string | null
  blast_radius: string | null
  provider_kind: string | null
  target: string | null
  credential_id: string | null
  args_redacted: Record<string, unknown> | null
  response_status: string
  response_summary: string | null
  error_class: string | null
  duration_ms: number | null
}

export interface AuditFilters {
  from_ts?: string
  to_ts?: string
  actor_id?: string
  actor_kind?: string
  event_type?: string
  tool_name?: string
  target?: string
  blast_radius?: string
  provider_kind?: string
  credential_id?: string
  task_id?: string
  response_status?: string
  limit?: number
  offset?: number
}

export const queryAudit = (filters: AuditFilters = {}) => {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== '' && v !== null) qs.set(k, String(v))
  }
  const suffix = qs.toString()
  return apiFetch<AuditEvent[]>(
    `/api/v1/capabilities/audit${suffix ? `?${suffix}` : ''}`,
  )
}

export const countAudit = (filters: { from_ts?: string; to_ts?: string } = {}) => {
  const qs = new URLSearchParams()
  if (filters.from_ts) qs.set('from_ts', filters.from_ts)
  if (filters.to_ts) qs.set('to_ts', filters.to_ts)
  const suffix = qs.toString()
  return apiFetch<{ count: number }>(
    `/api/v1/capabilities/audit/count${suffix ? `?${suffix}` : ''}`,
  )
}

// ── Screenpipe ─────────────────────────────────────────────────────────────────

export interface ScreenpipeConnectionTest {
  ok: boolean
  message?: string
  sample_event_count?: number
  error?: string
}

export async function testScreenpipeConnection(): Promise<ScreenpipeConnectionTest> {
  return apiFetch<ScreenpipeConnectionTest>('/screenpipe-api/test-connection')
}

export interface CaptureSession {
  id: string
  source_kind: string
  uri: string
  title: string
  metadata: Record<string, any>
  trust_score: number
  ingested_at: string
}

export interface CaptureTodayStats {
  sessions_count: number
  captured_seconds: number
  dropped_count: number
  top_apps: Array<{ app: string; captured_seconds: number }>
}

export async function getCaptureSessions(limit = 50): Promise<{ sessions: CaptureSession[] }> {
  return apiFetch<{ sessions: CaptureSession[] }>(`/api/v1/capture/sessions?limit=${limit}`)
}

export async function getCaptureTodayStats(): Promise<CaptureTodayStats> {
  return apiFetch<CaptureTodayStats>('/api/v1/capture/today-stats')
}

export async function getSourceContent(id: string): Promise<{ content: string; title?: string }> {
  return apiFetch<{ content: string; title?: string }>(`/mem/api/v1/engrams/sources/${id}/content`)
}

export type ExcludeScope = 'app' | 'url_pattern' | 'window_title'

export async function addCaptureExclude(scope: ExcludeScope, value: string): Promise<{
  ok: boolean
  added: boolean
  items: string[]
}> {
  return apiFetch('/api/v1/capture/exclude', {
    method: 'POST',
    body: JSON.stringify({ scope, value }),
  })
}

// ── Platform secrets (SEC-006a) ──────────────────────────────────────────────
// Encrypted at-rest store for instance-level secrets (provider keys, bridge
// tokens, OAuth secrets, GitHub PAT). Replaces the recovery /env path —
// values flow through orchestrator and are never round-tripped to the UI.

export interface PlatformSecretListEntry {
  key: string
  updated_at: string
}

export const listPlatformSecrets = () =>
  apiFetch<{ keys: PlatformSecretListEntry[] }>('/api/v1/admin/secrets')

export const patchPlatformSecrets = (updates: Record<string, string>) =>
  apiFetch<{ updated: string[] }>('/api/v1/admin/secrets', {
    method: 'PATCH',
    body: JSON.stringify({ updates }),
  })

export const deletePlatformSecret = (key: string) =>
  apiFetch<void>(`/api/v1/admin/secrets/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })

// ── Feature Flags (B-Task 8) ────────────────────────────────────────────────

export type FeatureFlagRow = {
  key: string
  type: 'bool' | 'enum' | null
  default: boolean | string | null
  current_value: boolean | string | null
  is_override: boolean
  is_orphan?: boolean
  set_by: string | null
  set_at: string | null
  notes: string | null
  variants?: unknown[] | null
}

export type FeatureFlagAuditRow = {
  id: string
  key: string
  action: 'set' | 'reset'
  old_value: unknown
  new_value: unknown
  actor: string
  actor_ip: string | null
  actor_user_agent: string | null
  request_id: string | null
  occurred_at: string
  notes: string | null
}

export const listFeatureFlags = () =>
  apiFetch<FeatureFlagRow[]>('/api/v1/feature-flags/')

export const patchFeatureFlag = (
  key: string,
  body: { value: unknown; notes?: string | null; confirm?: string },
) =>
  apiFetch<FeatureFlagRow>(`/api/v1/feature-flags/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

export const resetFeatureFlag = (key: string) =>
  apiFetch<{ deleted: boolean; key: string }>(
    `/api/v1/feature-flags/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  )

export const getFeatureFlagAudit = (key?: string, limit = 50) => {
  const path = key
    ? `/api/v1/feature-flags/${encodeURIComponent(key)}/audit?limit=${limit}`
    : `/api/v1/feature-flags/audit?limit=${limit}`
  return apiFetch<FeatureFlagAuditRow[]>(path)
}

/**
 * Fetch the public-readable flag values. No auth — the endpoint is
 * deliberately small and allowlisted server-side.
 */
export async function getPublicFlags(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/v1/feature-flags/public')
  if (!res.ok) throw new Error(`getPublicFlags ${res.status}`)
  return res.json()
}
