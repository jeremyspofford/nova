export const API_BASE = "";
export const WS_URL = "/ws";

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const secret = localStorage.getItem("adminSecret");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-Admin-Secret"] = secret;
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k] = v;
    }
  }
  const { headers: _h, ...restInit } = init ?? {};
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', headers, ...restInit });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// Secret management (used by SecretsSection)
export interface SecretInfo {
  name: string;
  purpose?: string;
  created_at: string;
  updated_at: string;
  last_used: string | null;
  used_count: number;
}

export async function listSecrets(): Promise<SecretInfo[]> {
  return apiFetch<SecretInfo[]>("/api/v1/secrets");
}

export async function createSecret(params: {
  name: string;
  value: string;
  purpose?: string;
}): Promise<SecretInfo> {
  return apiFetch<SecretInfo>("/api/v1/secrets", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function updateSecret(
  name: string,
  data: { value?: string; purpose?: string }
): Promise<SecretInfo> {
  return apiFetch<SecretInfo>(`/api/v1/secrets/${name}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteSecret(name: string): Promise<void> {
  await apiFetch(`/api/v1/secrets/${name}`, { method: "DELETE" });
}

// MCP server management (used by ExtensionsSection)
export interface MCPServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  working_dir: string | null;
  transport: string;
  enabled: boolean;
  created_at: string | null;
  last_started: string | null;
  last_error: string | null;
}

export interface MCPTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  auto_tier: string;
  effective_tier: string;
}

export interface MCPServerCreate {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  working_dir?: string;
  enabled?: boolean;
  transport?: string;
}

export async function listMCPServers(): Promise<MCPServer[]> {
  return apiFetch<MCPServer[]>("/api/v1/mcp/servers");
}

export async function createMCPServer(body: MCPServerCreate): Promise<MCPServer> {
  return apiFetch<MCPServer>("/api/v1/mcp/servers", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteMCPServer(id: string): Promise<void> {
  await apiFetch(`/api/v1/mcp/servers/${id}`, { method: "DELETE" });
}

export async function listMCPTools(serverId: string): Promise<MCPTool[]> {
  return apiFetch<MCPTool[]>(`/api/v1/mcp/servers/${serverId}/tools`);
}

export async function setToolTierOverride(
  serverId: string,
  toolName: string,
  tierOverride: string | null
): Promise<{ server_id: string; tool_name: string; tier_override: string | null }> {
  return apiFetch(`/api/v1/mcp/servers/${serverId}/tools/${toolName}`, {
    method: "PATCH",
    body: JSON.stringify({ tier_override: tierOverride }),
  });
}

export async function restartMCPServer(
  serverId: string
): Promise<{ started: boolean; server_id: string }> {
  return apiFetch(`/api/v1/mcp/servers/${serverId}/restart`, { method: "POST" });
}

export async function toggleMCPServer(serverId: string, enabled: boolean): Promise<MCPServer> {
  return apiFetch<MCPServer>(`/api/v1/mcp/servers/${serverId}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export interface LLMProvider {
  name: string;
  model: string;
  available: boolean;
  local: boolean;
  supports_embed: boolean;
  url?: string;
}

export interface LLMProvidersResponse {
  providers: LLMProvider[];
  routing_strategy: string;
  local_backend: string;
  local_inference_url: string;
}

export async function getLLMProviders(): Promise<LLMProvidersResponse> {
  return apiFetch<LLMProvidersResponse>("/api/v1/llm/providers");
}

export async function patchLLMConfig(body: { routing_strategy?: string }): Promise<{ routing_strategy: string; local_backend: string }> {
  return apiFetch("/api/v1/llm/config", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export interface VoiceProvider {
  name: string;
  type: "stt" | "tts";
  status: "available" | "unconfigured";
}

export async function getVoiceProviders(): Promise<VoiceProvider[]> {
  return apiFetch<VoiceProvider[]>("/voice-api/providers");
}

// Auth helpers
export const getAdminSecret = () => localStorage.getItem("adminSecret") ?? ""
export const setAdminSecret = (s: string) => localStorage.setItem("adminSecret", s)

function getAccessToken(): string | null {
  try {
    const raw = localStorage.getItem('nova_auth_tokens')
    if (!raw) return null
    return JSON.parse(raw).accessToken ?? null
  } catch { return null }
}

export function getAuthHeaders(): Record<string, string> {
  const token = getAccessToken()
  if (token) return { 'Authorization': `Bearer ${token}` }
  return { 'X-Admin-Secret': getAdminSecret() }
}

// Conversations
export interface Conversation {
  id: string
  title: string
  created_at: string
  last_message_at: string | null
}

export async function listConversations(): Promise<Conversation[]> {
  return apiFetch<Conversation[]>('/api/v1/conversations')
}

export async function deleteConversation(id: string): Promise<void> {
  await apiFetch(`/api/v1/conversations/${id}`, { method: 'DELETE' })
}

export async function getOrCreateActiveConversation(): Promise<string> {
  const conversations = await apiFetch<{ id: string }[]>('/api/v1/conversations')
  if (conversations.length > 0) return conversations[0].id
  const newConv = await apiFetch<{ id: string }>('/api/v1/conversations', { method: 'POST' })
  return newConv.id
}

// Chat streaming types
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

export interface StreamMeta {
  model?: string
  category?: string
}

export interface EngramSummary {
  id: string
  type: string
  preview: string
  source_type?: string
}

export interface ActivityStep {
  step: string
  state: 'running' | 'done'
  detail?: string
  elapsed_ms?: number
  model?: string
  category?: string | null
  engram_summaries?: EngramSummary[]
}

export interface ToolApprovalRequest {
  tool_call_id: string
  name: string
  tier: string
  args: Record<string, unknown>
}

export type StreamEvent = string | { meta: StreamMeta } | { status: ActivityStep } | { approval: ToolApprovalRequest }

export async function* streamChat(
  messages: ChatMessage[],
  model?: string,
  sessionId?: string,
  options?: StreamChatOptions,
): AsyncGenerator<StreamEvent, void, unknown> {
  // Extract the latest user message — agent-core maintains conversation history
  // per task_id, so we only send the new turn, not the full history.
  let text = ''
  let contentBlocks: ContentBlock[] | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        text = m.content
      } else {
        const blocks = m.content as ContentBlock[]
        text = blocks.find(b => b.type === 'text')?.text ?? ''
        if (blocks.length > 1) contentBlocks = blocks  // multimodal: include non-text blocks
      }
      break
    }
  }
  if (!text) return

  const adminSecret = getAdminSecret()
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const qs = adminSecret ? `?secret=${encodeURIComponent(adminSecret)}` : ''
  const ws = new WebSocket(`${proto}://${location.host}/ws${qs}`)

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('WebSocket connection failed'))
  })

  ws.send(JSON.stringify({ type: 'connect', ...(sessionId ? { resume_task_id: sessionId } : {}) }))

  const taskId = await new Promise<string>((resolve, reject) => {
    const h = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>
        if (msg.type === 'connected') {
          ws.removeEventListener('message', h)
          resolve(msg.task_id as string)
        }
      } catch {
        ws.removeEventListener('message', h)
        reject(new Error('Unexpected WS message during connect'))
      }
    }
    ws.addEventListener('message', h)
    ws.addEventListener('error', () => reject(new Error('WS error during connect')), { once: true })
  })

  ws.send(JSON.stringify({
    type: 'message',
    text,
    task_id: taskId,
    ...(model ? { model } : {}),
    ...(contentBlocks ? { content: contentBlocks } : {}),
    ...(options?.web_search ? { web_search: true } : {}),
    ...(options?.deep_research ? { deep_research: true } : {}),
    ...(options?.output_style ? { output_style: options.output_style } : {}),
    ...(options?.custom_instructions ? { custom_instructions: options.custom_instructions } : {}),
  }))

  const queue: Array<StreamEvent | null> = []
  let finished = false
  let notify: (() => void) | null = null

  const onMsg = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data as string) as Record<string, unknown>
      if (msg.type === 'response_chunk' && msg.text) {
        queue.push(msg.text as string)
      } else if (msg.type === 'response_final') {
        finished = true
      } else if (msg.type === 'meta') {
        queue.push({ meta: { model: msg.model as string | undefined, category: msg.category as string | undefined } })
      } else if (msg.type === 'tool_approval_request') {
        queue.push({ approval: {
          tool_call_id: msg.tool_call_id as string,
          name: msg.name as string,
          tier: msg.tier as string,
          args: (msg.args ?? {}) as Record<string, unknown>,
        }})
      } else if (msg.type === 'task_status' && msg.status === 'error') {
        queue.push(null)
        finished = true
      }
    } catch { /* ignore malformed frames */ }
    const n = notify; notify = null; n?.()
  }
  const onClose = () => { finished = true; const n = notify; notify = null; n?.() }

  ws.addEventListener('message', onMsg)
  ws.addEventListener('close', onClose)

  try {
    while (!finished || queue.length > 0) {
      if (queue.length > 0) {
        const chunk = queue.shift()!
        if (chunk === null) throw new Error('Agent returned an error')
        yield chunk as StreamEvent
      } else {
        await new Promise<void>(r => {
          if (finished) { r(); return }
          notify = r
        })
      }
    }
  } finally {
    ws.removeEventListener('message', onMsg)
    ws.removeEventListener('close', onClose)
    if (ws.readyState < WebSocket.CLOSING) ws.close()
  }
}

// Model discovery
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

export const MODEL_CATALOG_CACHE_KEY = 'nova_model_catalog_v2'
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60_000

export async function discoverModels(refresh = false): Promise<ProviderModelList[]> {
  const data = await apiFetch<ProviderModelList[]>(`/v1/models/discover${refresh ? '?refresh=true' : ''}`)
  try { localStorage.setItem(MODEL_CATALOG_CACHE_KEY, JSON.stringify({ data, at: Date.now() })) } catch {}
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

export const resolveModel = () => apiFetch<ResolvedModel>('/v1/models/resolve')

// Identity
export interface NovaIdentity {
  name: string
  greeting: string
}

export const getNovaIdentity = () => apiFetch<NovaIdentity>('/api/v1/identity')
