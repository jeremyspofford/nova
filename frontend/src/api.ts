/** API client for the Nova backend. */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export interface Activity {
  kind: 'tool_start' | 'tool_result' | 'dispatch';
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
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
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
}
export interface GraphEdge { source: string; target: string; kind: string }

export async function getMemoryGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const r = await fetch(`${API_URL}/api/v1/memory/graph`);
  if (!r.ok) throw new Error('Failed to load memory graph');
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

export async function getModels(): Promise<ModelInfo[]> {
  const r = await fetch(`${API_URL}/api/v1/models`);
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
  model: string;
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
