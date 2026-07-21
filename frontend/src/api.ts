/** API client for the Nova backend.
 *
 * URLs are relative (same-origin) by default: the vite dev server proxies
 * /api to the backend, and the production `web` service (nginx) does the
 * same — one origin, so the PWA service worker and auth behave.
 */

const API_URL = import.meta.env.VITE_API_URL || '';

// ── auth: single admin token (NOVA_AUTH_TOKEN backend-side) ───────────────

export function getAuthToken(): string | null {
  return localStorage.getItem('nova.token');
}

export function setAuthToken(token: string | null) {
  if (token) localStorage.setItem('nova.token', token);
  else localStorage.removeItem('nova.token');
}

async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const r = await fetch(input, { ...init, headers });
  if (r.status === 401) window.dispatchEvent(new Event('nova:unauthorized'));
  return r;
}

/** Synthesize one sentence of speech; resolves to WAV bytes.
 *  `voice` overrides the saved setting (used to preview a candidate). */
export async function synthesizeSpeech(text: string, voice?: string): Promise<ArrayBuffer> {
  const r = await apiFetch(`${API_URL}/api/v1/voice/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(voice ? { text, voice } : { text }),
  });
  if (!r.ok) {
    const detail = await r.json().then(j => j.detail).catch(() => r.statusText);
    throw new Error(`TTS failed: ${detail}`);
  }
  return r.arrayBuffer();
}

/** Transcribe a recorded push-to-talk utterance; resolves to the text. */
export async function transcribeSpeech(blob: Blob): Promise<string> {
  const r = await apiFetch(`${API_URL}/api/v1/voice/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!r.ok) {
    const detail = await r.json().then(j => j.detail).catch(() => r.statusText);
    throw new Error(`Transcription failed: ${detail}`);
  }
  return (await r.json()).text ?? '';
}

export interface VoiceHealth { status: string; detail?: string | null; voices: string[] }

/** Kokoro status + available voice ids (for the Settings voice picker). */
export async function getVoiceHealth(): Promise<VoiceHealth> {
  const r = await apiFetch(`${API_URL}/api/v1/voice/health`);
  if (!r.ok) throw new Error(`voice health failed: ${r.status}`);
  return r.json();
}

/** true = authorized (or auth disabled); false = the token gate is up. */
export async function checkAuth(): Promise<boolean> {
  const r = await apiFetch(`${API_URL}/api/v1/settings`);
  return r.status !== 401;
}

/** The admin token from the server — only answers for already-trusted
 *  callers (this machine, or a device holding the token). Feeds the QR. */
export async function getServerToken(): Promise<string> {
  const r = await apiFetch(`${API_URL}/api/v1/auth/token`);
  if (!r.ok) return '';
  return (await r.json()).token ?? '';
}

export interface Activity {
  kind: 'tool_start' | 'tool_result' | 'dispatch' | 'narration' | 'agent_reply';
  name: string;
  agent?: string;
  detail?: string;
}

export type ChatEvent =
  | { type: 'meta'; conversationId: string; model: string; traceId?: string }
  | { type: 'text'; text: string }
  | { type: 'activity'; activity: Activity }
  | { type: 'error'; error: string }
  | { type: 'done' };

export async function* streamChat(message: string, conversationId?: string,
                                  source?: string, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const response = await apiFetch(`${API_URL}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversation_id: conversationId, source }),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Chat request failed: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);

        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.meta) {
          const meta = parsed.meta as { conversation_id: string; model: string; trace_id?: string };
          yield { type: 'meta', conversationId: meta.conversation_id, model: meta.model,
                  traceId: meta.trace_id };
        } else if (typeof parsed.t === 'string') {
          yield { type: 'text', text: parsed.t };
        } else if (parsed.activity) {
          yield { type: 'activity', activity: parsed.activity as Activity };
        } else if (typeof parsed.error === 'string') {
          yield { type: 'error', error: parsed.error };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function getActiveConversation(): Promise<{ id: string; title: string | null }> {
  const r = await apiFetch(`${API_URL}/api/v1/conversations/active`);
  if (!r.ok) throw new Error('Failed to load conversation');
  return r.json();
}

/** One turn's ledger summary — feeds the duration chip on assistant messages. */
export interface TraceSummary {
  id: string;
  status: string;
  secs: number | null;
  tools: number;
  dispatches: number;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: string;
  tool_calls?: { kind: Activity['kind']; name: string; agent?: string } | null;
  trace?: TraceSummary | null;
}

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  const r = await apiFetch(`${API_URL}/api/v1/conversations/${conversationId}/messages`);
  if (!r.ok) throw new Error('Failed to load messages');
  return r.json();
}

export interface TraceSpan {
  id: string;
  parent_span_id: string | null;
  seq: number;
  kind: 'stage' | 'llm_call' | 'tool' | 'dispatch';
  name: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  detail: Record<string, unknown>;
}

export interface TraceDetail {
  trace: {
    id: string;
    source: string;
    automation: string | null;
    conversation_id: string | null;
    model: string | null;
    status: string;
    error: string | null;
    started_at: string;
    finished_at: string | null;
  };
  spans: TraceSpan[];
}

/** The full turn ledger for one trace — the Turn Inspector's data source. */
export async function getTrace(id: string): Promise<TraceDetail> {
  const r = await apiFetch(`${API_URL}/api/v1/traces/${id}`);
  if (!r.ok) throw new Error('Failed to load trace');
  return r.json();
}

/** Recent turns across all sources — chat, automations, compaction. */
export interface TraceListItem {
  id: string;
  source: 'chat' | 'automation' | 'compaction';
  automation: string | null;
  model: string | null;
  status: string;
  started_at: string;
  secs: number | null;
  tools: number;
  dispatches: number;
  llm_calls: number;
}

export async function getTraces(limit = 50): Promise<TraceListItem[]> {
  const r = await apiFetch(`${API_URL}/api/v1/traces?limit=${limit}`);
  if (!r.ok) throw new Error('Failed to load traces');
  return r.json();
}

export async function getMemoryStats(): Promise<Record<string, number>> {
  const r = await apiFetch(`${API_URL}/api/v1/memory/stats`);
  if (!r.ok) throw new Error('Failed to load memory stats');
  return r.json();
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  mtime: number;
  description?: string;
  tags?: string[];
  source_url?: string;
  learned?: string;
  enabled?: boolean;
  /** Automations only: run cadence — the universe view log-scales comet periods from it. */
  interval_minutes?: number | null;
}
export interface GraphEdge { source: string; target: string; kind: string }

export async function getMemoryGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/memory/graph`);
  if (!r.ok) throw new Error('Failed to load memory graph');
  return r.json();
}

export interface StorageInfo {
  host_path: string;
  container_path: string;
  writable: boolean;
  counts: Record<string, number>;
  models: {
    host_path: string | null;   // null => default docker-managed volumes
    relocated: boolean;
  };
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const r = await apiFetch(`${API_URL}/api/v1/storage`);
  if (!r.ok) throw new Error('Failed to load storage info');
  return r.json();
}

export async function getBrainGraph(platform: boolean): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/brain/graph?platform=${platform}`);
  if (!r.ok) throw new Error('Failed to load brain graph');
  return r.json();
}

export interface SettingDef {
  key: string;
  type: 'number' | 'boolean' | 'string' | 'enum' | 'model';
  label: string;
  description: string;
  section: string;
  value: unknown;
  min?: number;
  max?: number;
  options?: string[];
  model_scope?: 'ollama' | 'any';
  allow_empty?: boolean;
}

export interface ModelInfo { id: string; provider: string; name: string }

export async function getModels(full = false): Promise<ModelInfo[]> {
  const r = await apiFetch(`${API_URL}/api/v1/models${full ? '?full=true' : ''}`);
  if (!r.ok) throw new Error('Failed to load models');
  return r.json();
}

export async function getSettings(): Promise<SettingDef[]> {
  const r = await apiFetch(`${API_URL}/api/v1/settings`);
  if (!r.ok) throw new Error('Failed to load settings');
  return r.json();
}

export async function patchSettings(changes: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Save failed');
}

export interface BundledInferenceStatus {
  available: boolean;
  present?: boolean;
  running?: boolean;
  state?: string;
  op?: 'start' | 'stop' | 'relocate' | null;
  error?: string | null;
  api_ok?: boolean;
  models_dir?: string;   // '' = default docker volume
}

export async function getBundledInference(): Promise<BundledInferenceStatus> {
  const r = await apiFetch(`${API_URL}/api/v1/inference/bundled`);
  if (!r.ok) throw new Error('Failed to load bundled inference status');
  return r.json();
}

export async function setBundledInference(action: 'start' | 'stop'): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/inference/bundled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? `${action} failed`);
}

export interface ModelsDirInfo {
  path: string | null;   // null = default docker volume
  relocated: boolean;
}

export async function getModelsDir(): Promise<ModelsDirInfo> {
  const r = await apiFetch(`${API_URL}/api/v1/inference/models-dir`);
  if (!r.ok) throw new Error('Failed to load model storage location');
  return r.json();
}

/** Relocate the bundled model store to an absolute host path (empty = reset to
 *  the default docker volume). The backend migrates + recreates ollama; poll
 *  bundled-inference status for the `relocate` op to finish. */
export async function setModelsDir(path: string): Promise<ModelsDirInfo> {
  const r = await apiFetch(`${API_URL}/api/v1/inference/models-dir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'relocation failed');
  return r.json();
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  instruction: string;
  agent_name: string;
  interval_minutes: number;
  timeout_seconds: number | null;
  enabled: boolean;
  is_system: boolean;
  consecutive_failures: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  last_summary: string | null;
}

export async function getAutomations(): Promise<Automation[]> {
  const r = await apiFetch(`${API_URL}/api/v1/automations`);
  if (!r.ok) throw new Error('Failed to load automations');
  return r.json();
}

export interface AutomationRun {
  id: string;
  status: string;
  summary: string;
  started_at: string;
  duration_seconds: number;
}

export async function getAutomationRuns(id: string): Promise<AutomationRun[]> {
  const r = await apiFetch(`${API_URL}/api/v1/automations/${id}/runs`);
  if (!r.ok) throw new Error('Failed to load run history');
  return r.json();
}

export async function createAutomation(body: {
  name: string; instruction: string; agent_name: string; interval_minutes: number;
}): Promise<Automation> {
  const r = await apiFetch(`${API_URL}/api/v1/automations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchAutomation(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/automations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Update failed');
}

export async function deleteAutomation(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/automations/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface Rule {
  id: string;
  name: string;
  description: string;
  pattern: string;
  target_tools: string[] | null;
  target_agents: string[] | null;
  action: 'block' | 'warn';
  enabled: boolean;
  is_system: boolean;
  hit_count: number;
  last_hit_at: string | null;
}

// ── operator consents (guarded destructive actions, roadmap #29) ─────────

export interface Consent {
  id: string;
  kind: string;
  subject: string;
  question: string;
  requested_by: string;
  conversation_id: string | null;
  status: string;
  chosen: string | null;
  created_at: string | null;
  /** Authoritative DB facts about the targeted rule — what approving
   *  actually touches. null = the rule no longer exists. */
  rule?: {
    description: string; pattern: string; action: string;
    target_tools: string[] | null; enabled: boolean;
    is_system: boolean; hit_count: number;
  } | null;
}

export async function getPendingConsents(conversationId?: string): Promise<Consent[]> {
  const q = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';
  const r = await apiFetch(`${API_URL}/api/v1/consents${q}`);
  if (!r.ok) throw new Error('Failed to load consents');
  return r.json();
}

export async function decideConsent(id: string, chosen: 'approve' | 'deny'): Promise<Consent> {
  const r = await apiFetch(`${API_URL}/api/v1/consents/${id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chosen }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Decide failed');
  return r.json();
}

export async function getRules(): Promise<Rule[]> {
  const r = await apiFetch(`${API_URL}/api/v1/rules`);
  if (!r.ok) throw new Error('Failed to load rules');
  return r.json();
}

export async function createRule(body: {
  name: string; pattern: string; action: string; description?: string;
  target_tools?: string[] | null;
}): Promise<Rule> {
  const r = await apiFetch(`${API_URL}/api/v1/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchRule(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/rules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteRule(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/rules/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface AgentInfo {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  system_prompt: string;
  model: string;
  allowed_tools: string[] | null;
  routing_keywords: string[] | null;
  is_system: boolean;
}

export async function getAgents(): Promise<AgentInfo[]> {
  const r = await apiFetch(`${API_URL}/api/v1/agents`);
  if (!r.ok) throw new Error('Failed to load agents');
  return r.json();
}

export async function patchAgent(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/agents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function createAgent(body: {
  name: string; description: string; system_prompt: string; model: string;
  allowed_tools?: string[] | null; routing_keywords?: string[] | null;
}): Promise<{ id: string; name: string }> {
  const r = await apiFetch(`${API_URL}/api/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function deleteAgent(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/agents/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface BuiltinToolInfo { name: string; description: string }
export interface DbToolInfo {
  id: string;
  name: string;
  description: string;
  execution_type: string;
  enabled: boolean;
  is_system: boolean;
  method?: string | null;
  url_template?: string | null;
}
export interface ToolsCatalog {
  builtins: BuiltinToolInfo[];
  db_tools: DbToolInfo[];
  allowed_hosts: string[];
}

export async function getTools(): Promise<ToolsCatalog> {
  const r = await apiFetch(`${API_URL}/api/v1/tools`);
  if (!r.ok) throw new Error('Failed to load tools');
  return r.json();
}

export async function createTool(body: {
  name: string; description: string; url_template: string; method?: string;
}): Promise<{ id: string; name: string }> {
  const r = await apiFetch(`${API_URL}/api/v1/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchTool(id: string, enabled: boolean): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/tools/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteTool(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/tools/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface SkillInfo {
  id: string;
  title: string;
  description: string;
  category: string | null;
  priority: number;
  updated: string;
}

export async function getSkills(): Promise<SkillInfo[]> {
  const r = await apiFetch(`${API_URL}/api/v1/skills`);
  if (!r.ok) throw new Error('Failed to load skills');
  return r.json();
}

export async function createSkill(body: {
  title: string; content: string; description?: string; category?: string;
}): Promise<{ id: string }> {
  const r = await apiFetch(`${API_URL}/api/v1/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function updateSkill(id: string, body: {
  title?: string; content?: string; description?: string;
}): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/skills/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteSkill(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/skills/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface MemoryItem {
  id: string;
  frontmatter: Record<string, string>;
  content: string;
}

export async function getMemoryItem(id: string): Promise<MemoryItem> {
  const r = await apiFetch(`${API_URL}/api/v1/memory/item/${id}`);
  if (!r.ok) throw new Error('Memory item not found');
  return r.json();
}

export async function deleteMemoryItem(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/memory/item/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

// ── model recommendations ─────────────────────────────────────────────────

export interface HardwareInfo {
  ram_gb: number | null;
  cpu_cores: number | null;
  platform: 'wsl2' | 'docker-desktop' | 'linux';
  memory_note: string | null;
  memory_override_gb: number | null;
  sizing_ram_gb: number | null;
  nvidia_runtime: boolean | null;
  gpu_name: string | null;
  vram_total_gb: number | null;
  vram_observed_gb: number | null;
  unified_gpu: boolean;
  detected_at: string;
}

export interface ModelRecommendation {
  agent: string;
  is_system: boolean;
  profile: string;
  current_model: string;
  current_valid: boolean | null;
  status: 'keep' | 'switch' | 'no_fit';
  suggested_model: string | null;
  reason: string;
  alternates: { model: string; note: string }[];
}

export interface BudgetItem {
  model: string;
  agents: string[];
  pool: 'vram' | 'ram' | 'cloud';
  gb: number | null;
  source: 'probe' | 'estimate' | 'unknown';
  pinned: boolean;
}

export interface ModelBudget {
  items: BudgetItem[];
  vram_used_gb: number;
  vram_total_gb: number | null;
  ram_used_gb: number;
  ram_total_gb: number | null;
  vram_over: boolean;
  ram_over: boolean;
  unknown_count: number;
}

export interface RecommendationsResponse {
  hardware: HardwareInfo;
  cloud_available: boolean;
  curated_count: number;
  recommendations: ModelRecommendation[];
  budget: ModelBudget;
  catalog_freshness?: { age_days: number | null; stale: boolean };
}

export async function getModelBudget(): Promise<ModelBudget & { hardware: HardwareInfo }> {
  const r = await apiFetch(`${API_URL}/api/v1/models/budget`);
  if (!r.ok) throw new Error('Failed to load model budget');
  return r.json();
}

export async function getRecommendations(): Promise<RecommendationsResponse> {
  const r = await apiFetch(`${API_URL}/api/v1/models/recommendations`);
  if (!r.ok) throw new Error('Failed to load recommendations');
  return r.json();
}

export interface ProbeResult {
  model: string;
  ok: boolean;
  tool_call_ok: boolean | null;
  agentic_ok?: boolean | null;
  ttft_ms: number | null;
  tok_s: number | null;
  gpu_active: boolean | null;
  vram_gb: number | null;
  error: string | null;
  ran_at: string;
}

export async function testModel(model: string): Promise<ProbeResult> {
  const r = await apiFetch(`${API_URL}/api/v1/models/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Probe failed');
  return r.json();
}

export interface CuratedModel {
  id: string;
  model: string;
  provider: 'ollama' | 'openrouter';
  min_ram_gb: number | null;
  min_vram_gb: number | null;
  tool_tier: 'A' | 'B' | 'C';
  speed: 'fast' | 'medium' | 'slow';
  roles: string[];
  notes: string;
  is_system: boolean;
  enabled: boolean;
  last_probe: ProbeResult | null;
  probed_at: string | null;
}

export async function getCuratedModels(): Promise<CuratedModel[]> {
  const r = await apiFetch(`${API_URL}/api/v1/models/curated`);
  if (!r.ok) throw new Error('Failed to load curated models');
  return r.json();
}

export async function createCuratedModel(body: Partial<CuratedModel>): Promise<CuratedModel> {
  const r = await apiFetch(`${API_URL}/api/v1/models/curated`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchCuratedModel(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/models/curated/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteCuratedModel(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/models/curated/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface McpTool {
  name: string;
  description: string;
  parameters_schema: Record<string, unknown>;
}

export interface McpServer {
  id: string;
  name: string;
  transport: 'http' | 'stdio';
  url: string | null;
  command: string | null;
  args: string[];
  headers: Record<string, string>;
  enabled: boolean;
  always_inject: boolean;
  tools_hash: string | null;
  status: 'connected' | 'error' | 'disabled';
  status_detail: string | null;
  last_seen: string | null;
}

export async function getMcpServers(): Promise<McpServer[]> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers`);
  if (!r.ok) throw new Error('Failed to load MCP servers');
  return r.json();
}

export async function getMcpServerTools(id: string): Promise<McpTool[]> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers/${id}/tools`);
  if (!r.ok) throw new Error('Failed to load MCP server tools');
  return r.json();
}

export async function createMcpServer(body: Partial<McpServer>): Promise<McpServer> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchMcpServer(id: string, body: Record<string, unknown>): Promise<McpServer> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
  return r.json();
}

export async function deleteMcpServer(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export async function approveMcpServer(id: string): Promise<McpServer> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers/${id}/approve`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Approve failed');
  return r.json();
}

export async function uninstallModel(name: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/models/uninstall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Uninstall failed');
}

export async function* pullModel(name: string): AsyncGenerator<Record<string, unknown>> {
  const r = await apiFetch(`${API_URL}/api/v1/models/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok || !r.body) throw new Error('Pull request failed');
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const f of frames) {
      const line = f.trim();
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch { /* skip */ }
    }
  }
}
