/**
 * Every call the browser makes. Core (:8000) is the only backend a browser
 * ever sees — nginx and the vite dev server both send /api there — so there
 * is no base URL to configure and no second origin to get wrong.
 *
 * A refusal keeps its stated reason — see lib/statedReason.ts for where in a
 * response that reason lives — because "something went wrong" is not a fact
 * anyone can act on.
 */
import type { Role } from './roles'
import type { Person } from './gate'
import type { ConsentCard } from './consentCard'
import { failureReason } from './streamChat'
import { statedReason } from './statedReason'
import { createLineBuffer } from './lineBuffer'

export type { ConsentCard }

/** The three backends core's PUT /inference/backend accepts. */
export type EngineKind = 'ollama' | 'remote' | 'cloud'

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
  } catch (err) {
    throw new ApiError(0, `could not reach Nova — ${failureReason(err)}`)
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      statedReason(await response.text().catch(() => ''), response.status),
    )
  }
  return response
}

export async function apiGet<T>(path: string): Promise<T> {
  return (await request(path)).json() as Promise<T>
}

export async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return response.json() as Promise<T>
}

// ── auth ────────────────────────────────────────────────────────────────

export interface AuthState {
  has_users: boolean
}

export const getAuthState = () => apiGet<AuthState>('/api/v1/auth/state')

const asPerson = (body: { person: { id: string; name: string; role: string } }): Person => ({
  id: body.person.id,
  name: body.person.name,
  role: body.person.role as Role,
})

export async function getMe(): Promise<Person> {
  return asPerson(await apiGet('/api/v1/auth/me'))
}

export async function postLogin(name: string, password: string): Promise<Person> {
  return asPerson(await apiSend('/api/v1/auth/login', 'POST', { name, password }))
}

export async function postRegister(name: string, password: string): Promise<Person> {
  return asPerson(await apiSend('/api/v1/auth/register', 'POST', { name, password }))
}

export async function postLogout(): Promise<void> {
  await apiSend('/api/v1/auth/logout', 'POST')
}

// ── settings ────────────────────────────────────────────────────────────

export interface SettingDef {
  key: string
  // Mirrors core's settings registry (services/core/app/settings_store.py).
  // 'int' arrived with the tool loop's round cap; a union that lies about
  // what the API can return is worse than no union at all.
  type: 'bool' | 'str' | 'int'
  default: unknown
  description: string
  value: unknown
}

export async function getSettings(): Promise<SettingDef[]> {
  const body = await apiGet<{ settings: SettingDef[] }>('/api/v1/settings')
  return body.settings
}

export function settingValue<T>(settings: SettingDef[], key: string, fallback: T): T {
  const found = settings.find(s => s.key === key)
  return found === undefined ? fallback : (found.value as T)
}

export async function putSetting(key: string, value: boolean | string | number): Promise<void> {
  await apiSend('/api/v1/settings', 'PUT', { key, value })
}

// ── hardware, models, backend ───────────────────────────────────────────

export interface Gpu {
  name?: string
  vram_mb?: number
}

export interface HardwareInfo {
  gpus: Gpu[]
  ram_mb?: number
  disk_free_gb?: number
  docker_gpu_runtime?: boolean
  /** Present when hardware.json could not be read — an absence, stated. */
  note?: string
}

export const getHardware = () => apiGet<HardwareInfo>('/api/v1/system/hardware')

/** comfortable/tight/wont_fit are only ever computed from a REAL free-VRAM
 * reading; 'unknown' (with a stated reason) is what the gateway answers when
 * it cannot determine one — never a guess. See services/gateway/app/fit.py. */
export type FitVerdict = 'comfortable' | 'tight' | 'wont_fit' | 'unknown'

/** 'verified' means a real POST /admin/probe measured this model's VRAM on
 * THIS host; 'estimated' means the curated catalog's min_vram_gb floor. */
export type FitSource = 'verified' | 'estimated'

export interface ModelFit {
  verdict: FitVerdict
  needed_gb: number | null
  free_gb: number | null
  total_gb: number | null
  source: FitSource
  reason: string | null
}

export interface SuggestedModel {
  slug: string
  label: string
  params_b: number
  min_vram_gb: number
  note: string
  /** Optional: older/test fixtures may omit it. A real gateway response
   * always attaches one per model — see GET /admin/suggest in T2. */
  fit?: ModelFit
}

export interface Suggestion {
  tier: string
  engine_suggestion: string
  models: SuggestedModel[]
  rationale: string
}

export const getSuggestion = () => apiGet<Suggestion>('/api/v1/models/suggest')

/** One entry of the gateway's OpenAI-compat GET /v1/models list. */
export interface InstalledModel {
  id: string
}

/**
 * The models actually installed on the active backend (core's passthrough
 * to the gateway's GET /v1/models — ollama's tags, or a remote/cloud
 * endpoint's own list). Settings -> Models uses this to mark which curated
 * slugs are already usable versus still needing a pull.
 */
export async function getInstalledModels(): Promise<string[]> {
  const body = await apiGet<{ data: InstalledModel[] }>('/api/v1/models')
  return body.data.map(m => m.id)
}

export interface BackendConfig {
  kind: EngineKind
  url: string | null
  provider: string | null
  model: string | null
  /** Masked by core; never the real key. */
  api_key: string | null
}

export interface BackendWrite {
  kind: EngineKind
  url?: string
  provider?: string
  model?: string
  api_key?: string
}

export const getBackend = () => apiGet<BackendConfig>('/api/v1/inference/backend')

/** Core verifies the backend is live before saving; a 502 means unsaved. */
export const putBackend = (config: BackendWrite) =>
  apiSend<BackendConfig>('/api/v1/inference/backend', 'PUT', config)

// ── conversations ───────────────────────────────────────────────────────

export interface Conversation {
  id: string
  title: string | null
  created_at: string
  // True when this conversation's newest turn is still running server-side
  // (turns.status NULL). A client returning after a hard refresh reads this
  // to know a reply is still on its way and to poll for it, rather than
  // showing a truncated answer — see services/core/app/conversations.py and
  // ChatPage's in-flight poll. (S2c.)
  pending_turn: boolean
}

export interface StoredMessage {
  id: string
  role: string
  content: string
  created_at: string
}

export const getActiveConversation = () => apiGet<Conversation>('/api/v1/conversations/active')

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  const body = await apiGet<{ messages: StoredMessage[] }>(
    `/api/v1/conversations/${conversationId}/messages`,
  )
  return body.messages
}

export interface ClearedConversation {
  id: string
  /** How many message rows were removed — a real count from the server, never
   * a bare "ok". */
  cleared: number
}

/**
 * Clear this conversation's transcript (POST .../clear). Deletes the messages
 * only — turns/turn_spans and the governance ledger (Activity + audit) and
 * long-term memory are deliberately left intact server-side
 * (services/core/app/conversations.py). The store resets the UI only AFTER this
 * resolves, so there is no fake success.
 */
export async function clearConversation(conversationId: string): Promise<ClearedConversation> {
  return apiSend<ClearedConversation>(`/api/v1/conversations/${conversationId}/clear`, 'POST')
}

// ── activity (the turn ledger, read-only) ───────────────────────────────

export interface ActivityTurn {
  id: string
  kind: string
  model: string | null
  // NULL means unfinished — never coerced by this client into 'ok' or
  // 'error'; see services/core/app/activity.py and pages/activity.
  status: 'ok' | 'error' | 'interrupted' | null
  started_at: string
  duration_ms: number | null
  tool_call_count: number
  llm_round_count: number
  conversation_id: string | null
}

export interface ActivitySpan {
  kind: string
  name: string | null
  started_at: string
  duration_ms: number | null
  // Shape varies by span kind, and args_redacted inside a tool span's meta
  // is itself polymorphic (object or clipped string) — see
  // pages/activity/activityFormat.ts's viewArgs, which is where that
  // quirk is actually handled.
  meta: Record<string, unknown>
}

export interface ActivityTurnDetail {
  turn: ActivityTurn
  spans: ActivitySpan[]
}

export const ACTIVITY_PAGE_SIZE = 50

/**
 * A page is "the last one" when it comes back shorter than the limit asked
 * for — there is no separate has-more flag, so a caller never has more to
 * track than the rows it already fetched.
 */
export async function getActivity(
  opts: { limit?: number; before?: string } = {},
): Promise<ActivityTurn[]> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? ACTIVITY_PAGE_SIZE))
  if (opts.before) params.set('before', opts.before)
  const body = await apiGet<{ turns: ActivityTurn[] }>(`/api/v1/activity?${params.toString()}`)
  return body.turns
}

export const getActivityTurn = (turnId: string) =>
  apiGet<ActivityTurnDetail>(`/api/v1/activity/${turnId}`)

// ── consents (approval cards — services/core/app/consents_api.py) ───────

/**
 * Pending approval cards. With no conversationId, every pending card across
 * every conversation (the Approvals page); with one, only that conversation's
 * (the inline card's reconciliation path, if a page ever needs it).
 */
export async function getConsents(conversationId?: string): Promise<ConsentCard[]> {
  const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : ''
  const body = await apiGet<{ consents: ConsentCard[] }>(`/api/v1/consents${query}`)
  return body.consents
}

/**
 * Approve or deny a card. Returns the updated card — status flipped, nothing
 * else: the kernel runs nothing at decide time (ruling S3-R4), so this alone
 * never makes the action happen. chat-store.tsx's decideConsent is what
 * layers the re-attempt continuation on top of this call.
 */
export async function decideConsent(
  consentId: string,
  decision: 'approve' | 'deny',
): Promise<ConsentCard> {
  const body = await apiSend<{ consent: ConsentCard }>(
    `/api/v1/consents/${consentId}/decide`,
    'POST',
    { decision },
  )
  return body.consent
}

// ── workspace files (read-only view over Nova's workspace volume) ───────

export interface WorkspaceFileEntry {
  path: string
  size: number
  modified: string
}

export interface WorkspaceFileListing {
  files: WorkspaceFileEntry[]
  total: number
  truncated: boolean
}

export const getWorkspaceFiles = () =>
  apiGet<WorkspaceFileListing>('/api/v1/workspace/files')

export interface WorkspaceFileDetail {
  path: string
  size: number
  modified: string
  // Mutually exclusive with binary/too_large: text is the file's contents
  // only when core actually decoded it as UTF-8 under the size cap — see
  // services/core/app/workspace_api.py. Never a truncated fragment
  // presented as the whole file.
  text: string | null
  binary: boolean
  too_large: boolean
}

export const getWorkspaceFile = (path: string) =>
  apiGet<WorkspaceFileDetail>(`/api/v1/workspace/file?path=${encodeURIComponent(path)}`)

/** Not fetched through apiGet — this is handed straight to an <a href>,
 * so the browser's own download machinery (and core's Content-Disposition
 * header) does the work, same origin, same session cookie. */
export function workspaceRawUrl(path: string): string {
  return `/api/v1/workspace/raw?path=${encodeURIComponent(path)}`
}

// ── model pull (newline-delimited JSON, not SSE) ────────────────────────

export interface PullLine {
  status?: string
  digest?: string
  total?: number
  completed?: number
  error?: string
  note?: string
  required_gb?: number
  free_gb?: number
  ok?: boolean
}

/**
 * One line of the pull stream. A line that will not parse becomes an error
 * object rather than being dropped: the download step decides it is finished
 * by seeing `{"status":"success"}`, so a parser that quietly skipped a line it
 * did not understand could turn a failed pull into a silent one.
 */
export function parsePullLine(line: string): PullLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { error: `unreadable progress line: ${line.slice(0, 200)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `unexpected progress line: ${line.slice(0, 200)}` }
  }
  return parsed as PullLine
}

/**
 * POST /api/v1/models/pull, yielding one parsed progress object per line.
 *
 * Newline-delimited JSON, not SSE — no `data:` prefix and no terminator — so
 * the framing is its own, but the chunk reassembly underneath is the same
 * problem as the chat stream and uses the same tested buffer.
 */
export async function* pullModel(
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<PullLine> {
  const response = await request('/api/v1/models/pull', {
    method: 'POST',
    body: JSON.stringify({ model }),
    signal,
  })
  if (!response.body) {
    yield { error: 'the server answered the pull with no stream to read' }
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const lines = createLineBuffer()
  const parsed = (batch: string[]) =>
    batch.filter(line => line.trim() !== '').map(parsePullLine)

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const line of parsed(lines.push(decoder.decode(value, { stream: true })))) yield line
    }
    // A stream that ended without a final newline still owes us its last line.
    for (const line of parsed(lines.flush())) yield line
  } finally {
    reader.cancel().catch(() => {})
  }
}

// ── earned autonomy (services/core/app/autonomy_api.py) ─────────────────

/**
 * One action class's current disposition and graduation progress, verbatim
 * off autonomy.state() — `consecutive_successes`/`graduation_runs` are the
 * REAL stored counter and threshold, never computed or guessed client-side.
 */
export interface AutonomyClass {
  action_class: string
  risk_tier: string
  disposition: 'auto' | 'consent' | 'deny'
  /** True only for a class THIS loop promoted — see services/core/app/
   * autonomy.py's module docstring. Only an earned class can be revoked. */
  earned: boolean
  consecutive_successes: number
  graduation_runs: number
  updated_at: string
}

export async function getAutonomyState(): Promise<AutonomyClass[]> {
  const body = await apiGet<{ classes: AutonomyClass[] }>('/api/v1/autonomy')
  return body.classes
}

/** Demotes an earned-auto class back to consent (a governance event); the
 * server 404s a class that never graduated rather than a silent no-op. */
export async function revokeAutonomy(actionClass: string): Promise<AutonomyClass[]> {
  const body = await apiSend<{ classes: AutonomyClass[] }>(
    `/api/v1/autonomy/${encodeURIComponent(actionClass)}/revoke`,
    'POST',
  )
  return body.classes
}

// ── devices (services/core/app/devices_api.py) ──────────────────────────

/**
 * A machine paired to this Nova. `capabilities`/`fs_roots` are the live grant
 * (edited here, read per call by core). `last_seen` is core's clock at the last
 * heartbeat, or null before the first — the ONLY liveness fact the REST list
 * carries: `connected` is ALWAYS false on this route by design (only the
 * model-facing device_list tool overwrites it from live WS hub membership), so
 * the tile derives liveness from `last_seen` freshness, never from `connected`.
 * See pages/settings/devicesFormat.ts. A revoked device is still listed — a
 * machine that was revoked is part of what the operator needs to see.
 */
export interface Device {
  id: string
  name: string
  platform: string
  hostname: string
  capabilities: string[]
  fs_roots: string[]
  enrolled_at: string
  last_seen: string | null
  revoked_at: string | null
  connected: boolean
}

/** A freshly minted pairing code — shown ONCE (core stores only its hash). */
export interface PairingCode {
  code: string
  expires_at: string
}

export async function listDevices(): Promise<Device[]> {
  const body = await apiGet<{ devices: Device[] }>('/api/v1/devices')
  return body.devices
}

/** POST /devices/pairing-code — the code is returned once and never again. */
export const mintPairingCode = () =>
  apiSend<PairingCode>('/api/v1/devices/pairing-code', 'POST')

export async function renameDevice(id: string, name: string): Promise<Device> {
  const body = await apiSend<{ device: Device }>(
    `/api/v1/devices/${encodeURIComponent(id)}`,
    'PATCH',
    { name },
  )
  return body.device
}

/** PUT /devices/{id}/grants — the full capability + fs-root grant, replaced
 * wholesale (core validates the capability names and the absolute roots). */
export async function setGrants(
  id: string,
  grants: { capabilities: string[]; fs_roots: string[] },
): Promise<Device> {
  const body = await apiSend<{ device: Device }>(
    `/api/v1/devices/${encodeURIComponent(id)}/grants`,
    'PUT',
    grants,
  )
  return body.device
}

/** POST /devices/{id}/revoke — core also drops the device's live socket. */
export async function revokeDevice(id: string): Promise<Device> {
  const body = await apiSend<{ device: Device }>(
    `/api/v1/devices/${encodeURIComponent(id)}/revoke`,
    'POST',
  )
  return body.device
}

// ── governance audit (services/core/app/governance_api.py) ──────────────

/** One row of the append-only ledger: every decision, verbatim. Never
 * derived or filtered by this client — see governance.py's own docstring. */
export interface GovernanceEvent {
  id: string
  kind: string
  action_class: string | null
  actor: string | null
  subject_ref: string | null
  meta: Record<string, unknown>
  created_at: string
}

export const GOVERNANCE_PAGE_SIZE = 50

export async function getGovernanceEvents(
  opts: { limit?: number; before?: string; actionClass?: string } = {},
): Promise<GovernanceEvent[]> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? GOVERNANCE_PAGE_SIZE))
  if (opts.before) params.set('before', opts.before)
  if (opts.actionClass) params.set('action_class', opts.actionClass)
  const body = await apiGet<{ events: GovernanceEvent[] }>(
    `/api/v1/governance?${params.toString()}`,
  )
  return body.events
}

// ── AI Quality / evals (services/core/app/evals_api.py) ─────────────────

/** One suite the git corpus defines. `suite_version` pins comparability — a
 * score is only ever compared across runs of the SAME version. */
export interface EvalSuite {
  suite: string
  suite_version: number
  case_count: number
}

export async function getEvalSuites(): Promise<EvalSuite[]> {
  const body = await apiGet<{ suites: EvalSuite[] }>('/api/v1/evals/suites')
  return body.suites
}

/** One predicate's outcome inside a scored case — WHAT the contract checked
 * (predicate + optional arg) and whether it held. Mirrors the runner's
 * detail.predicates; extra explanatory fields the scorer may add are kept. */
export interface EvalPredicateResult {
  predicate: string
  arg?: string | null
  passed: boolean
  [k: string]: unknown
}

/** The persisted detail of one scored case: for a gradeable run, the reply
 * excerpt and each predicate's outcome; for an ungradeable one, the turn's
 * stated error reason instead. */
export interface EvalCaseDetail {
  reply?: string
  predicates?: EvalPredicateResult[]
  reason?: string
  status?: string
  [k: string]: unknown
}

export interface EvalCaseResult {
  case_id: string
  /** The replayed message, joined from the suite by case_id — null only if the
   * case no longer exists at this version. */
  message: string | null
  /** null EXACTLY when ungradeable (the turn errored) — never coerced to false.
   * An ungradeable case is excluded from the pass rate, not scored 0. */
  passed: boolean | null
  ungradeable: boolean
  detail: EvalCaseDetail
  turn_id: string | null
}

export interface EvalScoreSummary {
  total: number
  gradeable: number
  ungradeable: number
  passed: number
  /** null when nothing is gradeable — an empty state, never a fabricated 0. */
  pass_rate: number | null
}

export interface EvalRunResult {
  suite: string
  suite_version: number
  model: string
  cases: EvalCaseResult[]
  summary: EvalScoreSummary
}

/**
 * The latest stored run per case for (suite, model) at the suite's CURRENT
 * version — so the page shows prior results without re-running, and only ever
 * within one suite_version. Empty `cases` with a null pass_rate is the honest
 * "no runs yet" state, never a 0/0 score.
 */
export async function getEvalRuns(suite: string, model: string): Promise<EvalRunResult> {
  const params = new URLSearchParams({ suite, model })
  return apiGet<EvalRunResult>(`/api/v1/evals/runs?${params.toString()}`)
}

/**
 * POST /api/v1/evals/run — run the suite against the model through the REAL
 * funnel and stream the outcome. Each case is a real turn (the model loads,
 * tools run), so a suite takes MINUTES; the route streams newline-delimited
 * JSON — one `{case}` per finished case, then a final `{summary,…}` — over the
 * same createLineBuffer the model pull uses.
 *
 * `onCase` fires as each case lands so the page fills its table live with REAL
 * progress (a case genuinely finished), never a fabricated percentage. Resolves
 * with the completed run once the summary line arrives. An `{error}` line (an
 * infra/harness failure mid-run) is thrown, and a stream that ends with no
 * summary is thrown too — a truncated run must never read as a finished score.
 */
export async function runEvalSuite(
  suite: string,
  model: string,
  onCase?: (result: EvalCaseResult) => void,
  signal?: AbortSignal,
): Promise<EvalRunResult> {
  const response = await request('/api/v1/evals/run', {
    method: 'POST',
    body: JSON.stringify({ suite, model }),
    signal,
  })
  if (!response.body) {
    throw new ApiError(0, 'the server answered the run with no stream to read')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const lines = createLineBuffer()
  const cases: EvalCaseResult[] = []
  let summary: EvalScoreSummary | null = null
  let suiteVersion = 0

  const handle = (raw: string) => {
    const line = raw.trim()
    if (line === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new ApiError(0, `unreadable run line: ${line.slice(0, 200)}`)
    }
    const obj = parsed as Record<string, unknown>
    if (obj.error) throw new ApiError(0, String(obj.error))
    if (obj.case) {
      const result = obj.case as EvalCaseResult
      cases.push(result)
      onCase?.(result)
    } else if (obj.summary) {
      summary = obj.summary as EvalScoreSummary
      suiteVersion = Number(obj.suite_version)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const raw of lines.push(decoder.decode(value, { stream: true }))) handle(raw)
    }
    for (const raw of lines.flush()) handle(raw)
  } finally {
    reader.cancel().catch(() => {})
  }

  const finalSummary = summary
  if (finalSummary === null) {
    throw new ApiError(0, 'the run ended before a summary — it did not finish')
  }
  return { suite, suite_version: suiteVersion, model, cases, summary: finalSummary }
}
