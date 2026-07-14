/** API client for the Nova backend. */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export interface Activity {
  kind: 'tool_start' | 'tool_result' | 'dispatch' | 'narration';
  name: string;
  agent?: string;
  detail?: string;
}

export type ChatEvent =
  | { type: 'meta'; conversationId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'activity'; activity: Activity }
  | { type: 'error'; error: string }
  | { type: 'done' };

export async function* streamChat(message: string, conversationId?: string): AsyncGenerator<ChatEvent> {
  const response = await fetch(`${API_URL}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversation_id: conversationId }),
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
          const meta = parsed.meta as { conversation_id: string; model: string };
          yield { type: 'meta', conversationId: meta.conversation_id, model: meta.model };
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
  const r = await fetch(`${API_URL}/api/v1/conversations/active`);
  if (!r.ok) throw new Error('Failed to load conversation');
  return r.json();
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: string;
  tool_calls?: { kind: Activity['kind']; name: string; agent?: string } | null;
}

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  const r = await fetch(`${API_URL}/api/v1/conversations/${conversationId}/messages`);
  if (!r.ok) throw new Error('Failed to load messages');
  return r.json();
}

export async function getMemoryStats(): Promise<Record<string, number>> {
  const r = await fetch(`${API_URL}/api/v1/memory/stats`);
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
}
export interface GraphEdge { source: string; target: string; kind: string }

export async function getMemoryGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const r = await fetch(`${API_URL}/api/v1/memory/graph`);
  if (!r.ok) throw new Error('Failed to load memory graph');
  return r.json();
}

export interface StorageInfo {
  host_path: string;
  container_path: string;
  writable: boolean;
  counts: Record<string, number>;
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const r = await fetch(`${API_URL}/api/v1/storage`);
  if (!r.ok) throw new Error('Failed to load storage info');
  return r.json();
}

export async function getBrainGraph(platform: boolean): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const r = await fetch(`${API_URL}/api/v1/brain/graph?platform=${platform}`);
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
  const r = await fetch(`${API_URL}/api/v1/models${full ? '?full=true' : ''}`);
  if (!r.ok) throw new Error('Failed to load models');
  return r.json();
}

export async function getSettings(): Promise<SettingDef[]> {
  const r = await fetch(`${API_URL}/api/v1/settings`);
  if (!r.ok) throw new Error('Failed to load settings');
  return r.json();
}

export async function patchSettings(changes: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/settings`, {
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
  op?: 'start' | 'stop' | null;
  error?: string | null;
  api_ok?: boolean;
}

export async function getBundledInference(): Promise<BundledInferenceStatus> {
  const r = await fetch(`${API_URL}/api/v1/inference/bundled`);
  if (!r.ok) throw new Error('Failed to load bundled inference status');
  return r.json();
}

export async function setBundledInference(action: 'start' | 'stop'): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/inference/bundled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? `${action} failed`);
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  instruction: string;
  agent_name: string;
  interval_minutes: number;
  enabled: boolean;
  is_system: boolean;
  consecutive_failures: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  last_summary: string | null;
}

export async function getAutomations(): Promise<Automation[]> {
  const r = await fetch(`${API_URL}/api/v1/automations`);
  if (!r.ok) throw new Error('Failed to load automations');
  return r.json();
}

export async function createAutomation(body: {
  name: string; instruction: string; agent_name: string; interval_minutes: number;
}): Promise<Automation> {
  const r = await fetch(`${API_URL}/api/v1/automations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchAutomation(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/automations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Update failed');
}

export async function deleteAutomation(id: string): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/automations/${id}`, { method: 'DELETE' });
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

export async function getRules(): Promise<Rule[]> {
  const r = await fetch(`${API_URL}/api/v1/rules`);
  if (!r.ok) throw new Error('Failed to load rules');
  return r.json();
}

export async function createRule(body: {
  name: string; pattern: string; action: string; description?: string;
  target_tools?: string[] | null;
}): Promise<Rule> {
  const r = await fetch(`${API_URL}/api/v1/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchRule(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/rules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteRule(id: string): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/rules/${id}`, { method: 'DELETE' });
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
  const r = await fetch(`${API_URL}/api/v1/agents`);
  if (!r.ok) throw new Error('Failed to load agents');
  return r.json();
}

export async function patchAgent(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/agents/${id}`, {
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
  const r = await fetch(`${API_URL}/api/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function deleteAgent(id: string): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/agents/${id}`, { method: 'DELETE' });
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
  const r = await fetch(`${API_URL}/api/v1/tools`);
  if (!r.ok) throw new Error('Failed to load tools');
  return r.json();
}

export async function createTool(body: {
  name: string; description: string; url_template: string; method?: string;
}): Promise<{ id: string; name: string }> {
  const r = await fetch(`${API_URL}/api/v1/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchTool(id: string, enabled: boolean): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/tools/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteTool(id: string): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/tools/${id}`, { method: 'DELETE' });
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
  const r = await fetch(`${API_URL}/api/v1/skills`);
  if (!r.ok) throw new Error('Failed to load skills');
  return r.json();
}

export async function createSkill(body: {
  title: string; content: string; description?: string; category?: string;
}): Promise<{ id: string }> {
  const r = await fetch(`${API_URL}/api/v1/skills`, {
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
  const r = await fetch(`${API_URL}/api/v1/skills/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteSkill(id: string): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/skills/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface MemoryItem {
  id: string;
  frontmatter: Record<string, string>;
  content: string;
}

export async function getMemoryItem(id: string): Promise<MemoryItem> {
  const r = await fetch(`${API_URL}/api/v1/memory/item/${id}`);
  if (!r.ok) throw new Error('Memory item not found');
  return r.json();
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
}

export async function getModelBudget(): Promise<ModelBudget & { hardware: HardwareInfo }> {
  const r = await fetch(`${API_URL}/api/v1/models/budget`);
  if (!r.ok) throw new Error('Failed to load model budget');
  return r.json();
}

export async function getRecommendations(): Promise<RecommendationsResponse> {
  const r = await fetch(`${API_URL}/api/v1/models/recommendations`);
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
  const r = await fetch(`${API_URL}/api/v1/models/test`, {
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
  const r = await fetch(`${API_URL}/api/v1/models/curated`);
  if (!r.ok) throw new Error('Failed to load curated models');
  return r.json();
}

export async function createCuratedModel(body: Partial<CuratedModel>): Promise<CuratedModel> {
  const r = await fetch(`${API_URL}/api/v1/models/curated`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchCuratedModel(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/models/curated/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteCuratedModel(id: string): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/models/curated/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export async function uninstallModel(name: string): Promise<void> {
  const r = await fetch(`${API_URL}/api/v1/models/uninstall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Uninstall failed');
}

export async function* pullModel(name: string): AsyncGenerator<Record<string, unknown>> {
  const r = await fetch(`${API_URL}/api/v1/models/pull`, {
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
