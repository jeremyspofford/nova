/**
 * Recovery Service API client.
 *
 * Talks to the recovery sidecar (/recovery-api prefix) which stays alive
 * even when other Nova services are down.
 */

import { fetchWithAuthRetry } from './api'

const BASE = '/recovery-api'

export async function recoveryFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const resp = await fetchWithAuthRetry(`${BASE}${path}`, options)
  if (!resp.ok) {
    let msg = resp.statusText
    try {
      const body = await resp.json()
      msg = body.detail ?? body.error ?? JSON.stringify(body)
    } catch {
      msg = await resp.text().catch(() => resp.statusText)
    }
    throw new Error(`${resp.status}: ${msg}`)
  }
  if (resp.status === 204) return undefined as T
  return resp.json() as Promise<T>
}

// ── Health ────────────────────────────────────────────────────────────────────

export const getRecoveryHealth = () =>
  recoveryFetch<{ status: string; db?: string }>('/health/ready')

// ── Overview ─────────────────────────────────────────────────────────────────

export interface RecoveryOverview {
  services: {
    up: number
    down: number
    total: number
    details: ServiceStatus[]
  }
  database: {
    connected: boolean
    size?: string
    table_count?: number
    error?: string
  }
  backups: {
    count: number
    latest: BackupInfo | null
    total_size_bytes: number
  }
}

export const getRecoveryOverview = () =>
  recoveryFetch<RecoveryOverview>('/api/v1/recovery/status')

// ── Service Status ───────────────────────────────────────────────────────────

export interface ServiceStatus {
  service: string
  container_name: string | null
  status: string
  health: string
}

export const getServiceStatus = () =>
  recoveryFetch<ServiceStatus[]>('/api/v1/recovery/services')

export interface FullServiceStatus {
  service: string
  container_name: string | null
  status: string
  health: string
  ports: number[]
  optional: boolean
  profile?: string
}

export interface AllServicesResponse {
  core: FullServiceStatus[]
  optional: FullServiceStatus[]
}

export const getAllServiceStatus = () =>
  recoveryFetch<AllServicesResponse>('/api/v1/recovery/services/all')

export const restartService = (serviceName: string) =>
  recoveryFetch<{ service: string; action: string; ok: boolean }>(
    `/api/v1/recovery/services/${serviceName}/restart`,
    { method: 'POST' },
  )

export const restartAllServices = () =>
  recoveryFetch<{ service: string; action: string; ok: boolean }[]>(
    '/api/v1/recovery/services/restart-all',
    { method: 'POST' },
  )

// ── Backups ──────────────────────────────────────────────────────────────────

export interface BackupInfo {
  filename: string
  size_bytes: number
  created_at: string
}

export const getBackups = () =>
  recoveryFetch<BackupInfo[]>('/api/v1/recovery/backups')

export const createBackup = () =>
  recoveryFetch<BackupInfo>('/api/v1/recovery/backups', { method: 'POST' })

export const restoreBackup = (filename: string) =>
  recoveryFetch<{ filename: string; restored: boolean }>(
    `/api/v1/recovery/backups/${encodeURIComponent(filename)}/restore`,
    { method: 'POST' },
  )

export const deleteBackup = (filename: string) =>
  recoveryFetch<{ filename: string; deleted: boolean }>(
    `/api/v1/recovery/backups/${encodeURIComponent(filename)}`,
    { method: 'DELETE' },
  )

// ── Factory Reset ────────────────────────────────────────────────────────────

export interface ResetCategory {
  key: string
  label: string
  description: string
  default_keep: boolean
  destructive_warning: string | null
}

export interface FactoryResetStats {
  tables_truncated: number
  redis_keys_deleted: number
  filesystem_files_removed: number
  backup_files_removed: number
  backup_bytes_reclaimed: number
}

export interface FactoryResetResult {
  wiped: string[]
  kept: string[]
  errors: string[] | null
  stats: FactoryResetStats
  detail: Record<string, unknown>
}

export const getResetCategories = () =>
  recoveryFetch<ResetCategory[]>('/api/v1/recovery/factory-reset/categories')

export const factoryReset = (keep: string[], confirm: string) =>
  recoveryFetch<FactoryResetResult>(
    '/api/v1/recovery/factory-reset',
    { method: 'POST', body: JSON.stringify({ keep, confirm }) },
  )

// ── Env Management ──────────────────────────────────────────────────────────

export const getEnvVars = () =>
  recoveryFetch<Record<string, string>>('/api/v1/recovery/env')

export const patchEnv = (updates: Record<string, string>) =>
  recoveryFetch<Record<string, string>>(
    '/api/v1/recovery/env',
    { method: 'PATCH', body: JSON.stringify({ updates }) },
  )

// ── Diagnostics ─────────────────────────────────────────────────────────────

export interface DiagnosticsData {
  services: ServiceStatus[]
  service_logs: Record<string, string>
  database: { connected: boolean; size?: string; error?: string }
  checkpoints: { count: number; latest: BackupInfo | null }
  error_patterns: string[]
}

export const getDiagnostics = () =>
  recoveryFetch<DiagnosticsData>('/api/v1/recovery/diagnostics')

// ── Troubleshoot ────────────────────────────────────────────────────────────

export interface TroubleshootMessage {
  role: string
  content: string
}

export interface TroubleshootResponse {
  response: string
  provider: string | null
}

export const troubleshootChat = (message: string, history: TroubleshootMessage[]) =>
  recoveryFetch<TroubleshootResponse>(
    '/api/v1/recovery/troubleshoot/chat',
    { method: 'POST', body: JSON.stringify({ message, history }) },
  )

// ── Compose Profiles ────────────────────────────────────────────────────────

export const manageComposeProfile = (profile: string, action: 'start' | 'stop') =>
  recoveryFetch<{ profile: string; service: string; action: string; ok: boolean }>(
    '/api/v1/recovery/compose-profiles',
    { method: 'POST', body: JSON.stringify({ profile, action }) },
  )

// ── Remote Access ───────────────────────────────────────────────────────────

export interface RemoteAccessStatus {
  cloudflare: {
    configured: boolean
    container: { name: string; container_name: string | null; status: string; health: string; running: boolean }
  }
  tailscale: {
    configured: boolean
    container: { name: string; container_name: string | null; status: string; health: string; running: boolean }
  }
}

export const getRemoteAccessStatus = () =>
  recoveryFetch<RemoteAccessStatus>('/api/v1/recovery/remote-access/status')

// ── Inference Model Management ───────────────────────────────────────────────

export interface BackendStatus {
  backend: string
  state: string
  /** true when the backend is a server the user runs, not a bundled container */
  external?: boolean
  active_model?: string | null
  container_status: { status: string; health?: string; running?: boolean } | null
  switch_progress?: {
    step: string
    detail: string
  }
}

export const getBackendStatus = () =>
  recoveryFetch<BackendStatus>('/api/v1/recovery/inference/backend')

// ── Bundled inference containers ─────────────────────────────────────────────

export interface BundledBackend {
  backend: string
  container_status: string | null
  healthy: boolean
  base_url: string
  active: boolean
  gpu_required: boolean
}

export const getBundledBackends = () =>
  recoveryFetch<BundledBackend[]>('/api/v1/recovery/inference/bundled')

export const startBundledBackend = (name: string) =>
  recoveryFetch<BundledBackend>(`/api/v1/recovery/inference/bundled/${name}/start`, { method: 'POST' })

export const stopBundledBackend = (name: string) =>
  recoveryFetch<{ ok: boolean }>(`/api/v1/recovery/inference/bundled/${name}/stop`, { method: 'POST' })

export interface HardwareInfo {
  gpus: Array<{ vendor: string; model: string; vram_gb: number; index: number }>
  docker_gpu_runtime: string | null
  cpu_cores: number
  ram_gb: number
  disk_free_gb: number
  recommended_backend: string
}

export const getHardwareInfo = () =>
  recoveryFetch<HardwareInfo>('/api/v1/recovery/inference/hardware')

export interface ModelSearchResult {
  id: string
  description: string
  downloads: number
  likes: number
  vram_estimate_gb: number | null
  quantized: boolean
  tags: string[]
}

export const searchModels = (q: string, backend: string = 'vllm', maxVramGb?: number) => {
  const params = new URLSearchParams({ q, backend })
  if (maxVramGb) params.set('max_vram_gb', String(maxVramGb))
  return recoveryFetch<ModelSearchResult[]>(`/api/v1/recovery/inference/models/search?${params}`)
}

export interface RecommendedModel {
  id: string
  ollama_id?: string
  name: string
  category: string
  /** absent on live-popularity entries (sizes aren't published on the list page) */
  min_vram_gb?: number
  backends: string[]
  description: string
  /** ollama.com pull count label, e.g. "5.4M" — live-popularity entries only */
  pulls?: string | null
  /** Download size in GB (default tag); 0 for Ollama Cloud models. */
  size_gb?: number
  required?: boolean
  cloud?: boolean
  starter?: boolean
  gated?: boolean
  /** parameter variants available, e.g. ["8B","70B","405B"] (popular source) */
  param_sizes?: string[]
  /** deep link to the model on its registry (ollama.com / huggingface) */
  url?: string
}

export const getRecommendedModels = (backend?: string, maxVramGb?: number, source?: 'popular' | 'curated') => {
  const params = new URLSearchParams()
  if (backend) params.set('backend', backend)
  if (maxVramGb) params.set('max_vram_gb', String(maxVramGb))
  if (source) params.set('source', source)
  const qs = params.toString()
  return recoveryFetch<RecommendedModel[]>(`/api/v1/recovery/inference/models/recommended${qs ? '?' + qs : ''}`)
}

export const switchModel = (backend: string, model: string) =>
  recoveryFetch<{ status: string; backend: string; model: string }>(
    `/api/v1/recovery/inference/backend/${backend}/switch-model`,
    { method: 'POST', body: JSON.stringify({ model }) },
  )

// ── GPU Stats ────────────────────────────────────────────────────────────────

export interface GPUStats {
  gpu_utilization_pct: number
  vram_used_gb: number
  vram_total_gb: number
  temperature_c: number
}

export const getGPUStats = () =>
  recoveryFetch<GPUStats | null>('/api/v1/recovery/inference/hardware/gpu-stats')

// ── Inference Recommendation ─────────────────────────────────────────────────

export interface InferenceRecommendation {
  backend: string
  model: string
  reason: string
}

export const getRecommendation = () =>
  recoveryFetch<InferenceRecommendation>('/api/v1/recovery/inference/recommendation')
