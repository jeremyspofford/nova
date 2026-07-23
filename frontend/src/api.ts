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

// ── Observability board (system monitoring + turn/cost rollups) ───────────

export interface GpuStat {
  name: string; mem_used_gb: number; mem_total_gb: number; util_pct: number; temp_c: number;
}
export interface ContainerStat {
  name: string; service: string; state: string;
  cpu_pct: number | null; mem_used_gb: number | null; mem_total_gb: number | null;
}
export interface SystemResources {
  instance: { id: string; label: string; leader: boolean };
  platform: string;
  cpu: { pct: number | null; cores: number | null; load1: number | null };
  mem: { used_gb: number | null; total_gb: number | null };
  gpu: { gpus: GpuStat[]; error?: string } | null;
  disk: {
    used_gb: number | null; total_gb: number | null;
    docker?: Record<string, number | null>;
    model_store?: { path: string; free_gb: number; total_gb: number };
  };
  containers: ContainerStat[];
  sampled_at: number;
}
export async function getSystemResources(): Promise<SystemResources> {
  const r = await apiFetch(`${API_URL}/api/v1/system/resources`);
  if (!r.ok) throw new Error('Failed to load system resources');
  return r.json();
}

export interface ServiceHealth {
  name: string; ok: boolean; ms?: number; optional?: boolean; detail?: string;
}
export async function getSystemHealth(): Promise<{ services: ServiceHealth[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/system/health`);
  if (!r.ok) throw new Error('Failed to load system health');
  return r.json();
}

export interface ModelCost {
  model: string; turns: number; calls: number;
  prompt: number; completion: number; est_cost: number | null; priced: boolean;
}
export interface ObservabilitySummary {
  window: string; turns: number; errors: number; cancelled: number; error_rate: number;
  p50_secs: number | null; p95_secs: number | null;
  tokens: { prompt: number; completion: number; total: number };
  est_cost: number; cost_partial: boolean;
  by_model: ModelCost[];
  sources: Record<string, number>;
}
export async function getObservabilitySummary(window = '24h'): Promise<ObservabilitySummary> {
  const r = await apiFetch(`${API_URL}/api/v1/observability/summary?window=${window}`);
  if (!r.ok) throw new Error('Failed to load observability summary');
  return r.json();
}

export interface HistoryPoint {
  ts: number;
  cpu_pct: number | null; mem_used_gb: number | null; mem_total_gb: number | null;
  vram_used_gb: number | null; vram_total_gb: number | null;
  gpu_pct: number | null; gpu_temp_c: number | null;
  disk_used_gb: number | null; disk_total_gb: number | null;
}
export interface ResourceHistory {
  window: string; instance: string; bucket_secs: number; points: HistoryPoint[];
}
export async function getResourceHistory(
  window = '24h', instance?: string,
): Promise<ResourceHistory> {
  const q = instance ? `&instance=${encodeURIComponent(instance)}` : '';
  const r = await apiFetch(`${API_URL}/api/v1/system/resources/history?window=${window}${q}`);
  if (!r.ok) throw new Error('Failed to load resource history');
  return r.json();
}

export interface FleetInstance {
  id: string; label: string | null; self: boolean; leader: boolean;
  last_seen: number | null; stale: boolean;
  reaches: Record<string, { ok: boolean; ms?: number; detail?: string }>;
  cpu_pct?: number | null; mem_used_gb?: number | null; mem_total_gb?: number | null;
  vram_used_gb?: number | null; vram_total_gb?: number | null;
  disk_used_gb?: number | null; disk_total_gb?: number | null;
}
export async function getSystemFleet(): Promise<{ instances: FleetInstance[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/system/fleet`);
  if (!r.ok) throw new Error('Failed to load fleet');
  return r.json();
}

export interface MonitorAlert {
  id: string; instance_id: string; label: string; kind: string;
  message: string; value: number | null; threshold: number | null;
  raised_at: number; cleared_at: number | null;
}
export async function getSystemAlerts(): Promise<{ active: MonitorAlert[]; recent: MonitorAlert[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/system/alerts`);
  if (!r.ok) throw new Error('Failed to load alerts');
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

export interface ModelInfo {
  id: string; provider: string; name: string;
  // Provider-supplied "what is this good for" facts, present when the provider's
  // /models endpoint returns them (OpenRouter does; most others just return ids).
  description?: string;
  context_length?: number;
  vision?: boolean;
  price_in?: number;   // USD per million prompt tokens
  price_out?: number;  // USD per million completion tokens
}

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

export interface NotifyTestResult {
  ok: boolean;
  id?: string | null;
  error?: string;
  provider?: string;
}

/** Send a real test notification through the configured provider. */
export async function testNotification(): Promise<NotifyTestResult> {
  const r = await apiFetch(`${API_URL}/api/v1/notify/test`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Test failed');
  return r.json();
}

export interface NotifyReachability {
  provider: string;
  enabled: boolean;
  checks: { label: string; ok: boolean | null; detail?: string }[];
  phone?: { server_url: string; topic: string } | null;
  note?: string;
}

/** Read-only diagnostic of the notification delivery path. */
export async function getNotifyReachability(): Promise<NotifyReachability> {
  const r = await apiFetch(`${API_URL}/api/v1/notify/reachability`);
  if (!r.ok) throw new Error('Failed to load reachability');
  return r.json();
}

export interface NotifyService {
  available: boolean;
  phone_url?: string;
  base_url?: string;
  ntfy?: { present: boolean; running: boolean; state: string };
  tailscale?: { present: boolean; running: boolean; state: string };
  tailnet_route?: boolean;
  op?: string | null;
  error?: string | null;
}

/** State of the self-hosted ntfy service (via the inference-control sidecar). */
export async function getNotifyService(): Promise<NotifyService> {
  const r = await apiFetch(`${API_URL}/api/v1/notify/service`);
  if (!r.ok) throw new Error('Failed to load notify service');
  return r.json();
}

/** Start/stop the self-hosted ntfy service, or (re)apply just the tailnet
 *  route. 'up' also derives + applies the correct base URL so the phone stays
 *  in sync; 'expose' re-applies the :8443 route live (no ntfy restart). */
export async function notifyServiceAction(action: 'up' | 'down' | 'expose'): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/notify/service`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Action failed');
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

/** A proactive recommendation card (distinct from model ModelRecommendation). */
export interface RecCard {
  id: string;
  kind: string;
  title: string;
  body: string;
  source: string;
  status: string;
  priority: number;
  created_at: string | null;
  decided_at: string | null;
}

/** Proactive cards Nova/automations raised. 'new' = the live banner queue. */
export async function getRecCards(status: 'new' | 'all' = 'new'): Promise<RecCard[]> {
  const r = await apiFetch(`${API_URL}/api/v1/recommendations?status=${status}`);
  if (!r.ok) throw new Error('Failed to load recommendations');
  return r.json();
}

export async function decideRecCard(
  id: string, choice: 'approve' | 'later' | 'dismiss'): Promise<RecCard> {
  const r = await apiFetch(`${API_URL}/api/v1/recommendations/${id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ choice }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'decide failed');
  return r.json();
}

// ── ingestion queue (migration 041): the durable background ingest lane ──────

export type IngestStatus = 'queued' | 'running' | 'done' | 'skipped' | 'failed';

export interface IngestJob {
  id: string;
  url: string;
  title: string | null;
  source_key: string | null;
  status: IngestStatus;
  attempts: number;
  max_attempts?: number;
  orphans?: number;
  error: string | null;
  result_item_id?: string | null;
  enqueued_by?: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface IngestSummary {
  counts: Partial<Record<IngestStatus, number>>;
  jobs: IngestJob[];
}

/** Counts by status + the most-recently-touched jobs — the Ingestion panel's
 *  live poll. queued+running = work in flight; done/failed/skipped = the trail. */
export async function getIngestSummary(): Promise<IngestSummary> {
  const r = await apiFetch(`${API_URL}/api/v1/ingest/summary`);
  if (!r.ok) throw new Error('Failed to load ingestion status');
  return r.json();
}

/** Requeue a failed/skipped job so the worker tries it again. */
export async function retryIngestJob(id: string): Promise<IngestJob> {
  const r = await apiFetch(`${API_URL}/api/v1/ingest/jobs/${id}/retry`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Retry failed');
  return r.json();
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

export type StackMode = 'hybrid' | 'local' | 'cloud';

export interface RecommendationsResponse {
  hardware: HardwareInfo;
  cloud_available: boolean;
  mode: StackMode;
  mode_note: string | null;
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

export async function getRecommendations(mode: StackMode = 'hybrid'): Promise<RecommendationsResponse> {
  const r = await apiFetch(`${API_URL}/api/v1/models/recommendations?mode=${mode}`);
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

// The fixed "what is this good for" vocabulary (mirrors curated_models._USE_CASES).
export const USE_CASES = [
  'coding', 'agentic-tools', 'reasoning', 'writing', 'chat',
  'vision', 'long-context', 'multilingual', 'summarization',
] as const;

export interface CuratedModel {
  id: string;
  model: string;
  // 'ollama' (built-in local) or any registered provider slug
  provider: string;
  min_ram_gb: number | null;
  min_vram_gb: number | null;
  tool_tier: 'A' | 'B' | 'C';
  speed: 'fast' | 'medium' | 'slow';
  roles: string[];
  // "what is this good for" — filterable task-fit tags (see USE_CASES).
  use_cases: string[];
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

// ── LLM providers (bring-your-own key / endpoint). The API never returns the
//    key — only key_set + the last-4 hint. ──────────────────────────────────
export interface Provider {
  id: string;
  slug: string;
  label: string;
  kind: string;
  base_url: string;
  extra_headers: Record<string, string>;
  catalog_path: string;
  needs_key: boolean;
  enabled: boolean;
  is_system: boolean;
  created_at: string | null;
  updated_at: string | null;
  key_set: boolean;
  key_hint: string;
  configured: boolean;
  // persistent reachability (stamped on save + a 60s backend loop)
  last_checked_at: string | null;
  last_seen_at: string | null;
  last_ok: boolean | null;
  last_error: string | null;
}

export interface ProviderPreset {
  slug: string;
  label: string;
  base_url: string;
  needs_key: boolean;
}

export interface ProviderTest { ok: boolean | null; error?: string; model_count?: number }

export async function getProviders(): Promise<Provider[]> {
  const r = await apiFetch(`${API_URL}/api/v1/providers`);
  if (!r.ok) throw new Error('Failed to load providers');
  return r.json();
}

export async function getProviderPresets(): Promise<ProviderPreset[]> {
  const r = await apiFetch(`${API_URL}/api/v1/providers/presets`);
  if (!r.ok) throw new Error('Failed to load provider presets');
  return r.json();
}

export async function createProvider(body: Record<string, unknown>): Promise<Provider> {
  const r = await apiFetch(`${API_URL}/api/v1/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchProvider(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/providers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteProvider(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/providers/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export async function testProvider(id: string): Promise<ProviderTest> {
  const r = await apiFetch(`${API_URL}/api/v1/providers/${id}/test`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Test failed');
  return r.json();
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
