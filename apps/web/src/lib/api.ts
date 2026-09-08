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
import { failureReason } from './streamChat'
import { statedReason } from './statedReason'
import { createLineBuffer } from './lineBuffer'

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
  /** `provider:model` as the gateway stated it on this turn's llm_call span
   * (S10-pre) — DERIVED from the trace server-side, never stored on the row.
   * null for user rows, for rows older than the turn link, and for a turn
   * whose gateway call never stated one. */
  served_by?: string | null
  /** `turns.kind` of the turn that wrote this row (S9) — 'chat' for an
   * ordinary reply, 'reminder' / 'scheduled' for a row a timer firing
   * landed here, DERIVED server-side from `messages.turn_id` the same way
   * `served_by` is, never stored on the message. null for user rows and for
   * rows older than the turn link. The chat bubble's "Reminder" /
   * "Scheduled" label reads this and nothing else. */
  turn_kind?: string | null
  /** The turn's cost in USD summed from its llm_call spans (S10) — the
   * gateway's ledger figures, never a stored claim. null when no round was
   * priced (local, unmetered, or unpriced). */
  cost_usd?: number | null
  /** The gateway's stated reason when this turn's answer came from a
   * fallback link (S10-2); null when link 1 served. */
  route_reason?: string | null
  /** The agent whose turn wrote this row (S12, the `@name` path) —
   * `agents.name` joined through the turn's `agent_id`, the `turn_kind`
   * idiom: DERIVED on read, never a stored label, so a deleted agent's
   * rows simply lose the badge. null for user rows and for Nova's own
   * replies. Absent on a core older than S12. */
  agent?: string | null
  /** The delegations Nova's turn made while writing this row (S12) —
   * derived from her `delegate_to_agent` spans' `meta.facts`, the
   * `served_by` idiom. Empty when she delegated nothing; absent on a core
   * older than S12. */
  delegations?: Delegation[]
}

/** One `delegate_to_agent` call as the turn ledger recorded it (S12).
 * `status` is the CHILD turn's close and `files` the paths of its
 * successful workspace_write_file spans — both derived from spans, never
 * from the agent's own report of what it did. */
export interface Delegation {
  agent: string
  /** Null when the call was refused before any child turn ran. */
  agent_turn_id: string | null
  /** 'refused' = the delegate call never started a run (unknown agent,
   * empty task, an agent trying to delegate) — a stated refusal, not a run
   * that failed. */
  status: 'ok' | 'error' | 'interrupted' | 'refused'
  files: string[]
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

// ── spend (S10): the gateway's ledger, rolled up ────────────────────────

export type SpendWindow = 'today' | '7d' | '30d' | 'month'

export interface SpendRollup {
  key: string | null
  local: boolean
  usd: number | null
  calls: number
  unmetered: number
  prompt_tokens: number
  completion_tokens: number
  gpu_seconds: number
  /** by_person only: named by core; null for a call with no person;
   * "(no longer exists)" for a deleted one. */
  person?: { name: string; role: string | null } | null
  [key: string]: unknown
}

export interface SpendProvider {
  provider: string
  local: boolean
  usd: number | null
  calls: number
  unmetered: number
  refusals: number
  gpu_seconds: number | null
  month_usd: number | null
  cap_usd: number | null
  remaining_usd: number | null
}

export interface SpendReport {
  window: SpendWindow
  since: string
  until: string
  timezone: string
  totals: {
    usd: number | null
    usd_by_basis: Record<string, number | null>
    gpu_seconds: number
    calls: number
    unmetered: number
    refusals: number
    probes: number
    ledger_write_failures: number
    month_usd: number | null
    month_cap_usd: number | null
    in_flight_note: string
  }
  by_provider: SpendProvider[]
  by_model: SpendRollup[]
  by_purpose: SpendRollup[]
  by_role: SpendRollup[]
  by_person: SpendRollup[]
  by_day: {
    day: string
    usd: number | null
    calls: number
    gpu_seconds: number
    /** Each model's share of the day (served_by), for the stacked bar. */
    models: { key: string; local: boolean; usd: number | null; calls: number; gpu_seconds: number }[]
  }[]
  unpriced: { provider: string; model: string; calls: number }[]
  recent_refusals: { at: string; provider: string; model: string; status: number; error: string | null; purpose: string }[]
  caps: Record<string, number | null>
}

export interface SpendCap {
  provider: string
  monthly_usd: number | null
  spent_usd: number
  remaining_usd: number | null
}

export interface SpendPrice {
  provider: string
  model: string
  basis: 'owner' | 'listing' | 'curated'
  prompt_usd_per_token: number
  completion_usd_per_token: number
  cache_read_multiplier: number | null
  cache_write_multiplier: number | null
  verified_at: string
  source: string | null
}

export const getSpend = (window: SpendWindow = 'month') => apiGet<SpendReport>(`/api/v1/spend?window=${window}`)
export const getSpendCaps = () => apiGet<{ caps: SpendCap[]; month_since: string; timezone: string }>('/api/v1/spend/caps')
export const putSpendCap = (provider: string, monthly_usd: number | null) =>
  apiSend<{ provider: string; monthly_usd: number | null }>('/api/v1/spend/caps', 'PUT', { provider, monthly_usd })
export const getSpendPrices = () => apiGet<{ prices: SpendPrice[] }>('/api/v1/spend/prices')
export const putOwnerPrice = (provider: string, model: string, prompt_usd_per_token: number, completion_usd_per_token: number) =>
  apiSend<{ provider: string; model: string; basis: 'owner' }>('/api/v1/spend/prices', 'PUT', {
    provider,
    model,
    prompt_usd_per_token,
    completion_usd_per_token,
  })
export const deleteOwnerPrice = (provider: string, model: string) =>
  apiSend<{ removed: boolean }>(`/api/v1/spend/prices?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`, 'DELETE')

// ── routing (S10-2): the role chains, the walk explained, the walls ─────

/** The five roles the gateway ships with; every other role is derived — a
 * core-side agent named `x` owns `agent_x` (S12). */
export type BuiltinRole = 'chat' | 'scheduled' | 'judge' | 'coding' | 'vision'
/** Any routing role: a built-in or an agent's derived `agent_<name>`. */
export type RouteRole = BuiltinRole | string

export interface RouteVerdict {
  link: number
  id: string
  provider?: string
  model?: string
  local?: boolean
  verdict: 'runnable' | 'over_cap' | 'walled' | 'not_installed' | 'unreachable' | 'unknown' | 'refused' | string
  reason: string | null
  walled_until?: string
}

export interface RouteExplain {
  role: RouteRole
  chain: RouteVerdict[]
  would_serve: { role: string; link: number; reason: string | null; served_by: string; standby: boolean } | null
  reason: string | null
}

export interface RouteWall {
  provider: string
  walled_until: string
  reason: string
  status: number
  strikes: number
}

export interface Routes {
  roles: { role: RouteRole; chain: string[]; reserved: boolean; builtin?: boolean }[]
  walls: RouteWall[]
}

export const getRoutes = () => apiGet<Routes>('/api/v1/routes')
export const putRoute = (role: RouteRole, chain: string[]) =>
  apiSend<{ role: RouteRole; chain: string[] }>(`/api/v1/routes/${role}`, 'PUT', { chain })
export const explainRoute = (role: RouteRole, model?: string) =>
  apiGet<RouteExplain>(`/api/v1/routes/explain?role=${role}${model ? `&model=${encodeURIComponent(model)}` : ''}`)
export const clearWall = (provider: string) =>
  apiSend<{ provider: string; cleared: boolean }>(`/api/v1/routes/walls/${encodeURIComponent(provider)}`, 'DELETE')
/** DELETE /routes/{role} drops the role's stored chain — nothing to read
 * back; a built-in (400) or a role with no row (404) is thrown by `request`
 * with the gateway's stated reason. */
export async function deleteRoute(role: string): Promise<void> {
  await request(`/api/v1/routes/${encodeURIComponent(role)}`, { method: 'DELETE' })
}

// ── agents (S12): the live agents, each owning a derived routing role ───

/** The three fields every consumer of the roster needs (the `@` menu, the
 * Routing page's labels). A subset of `Agent`, so a full row satisfies it. */
export interface AgentSummary {
  name: string
  purpose: string
  /** the routing role derived from the name: `agent_<name>` */
  role: string
}

/** One skill the agent names, checked against `<root>/skills/` AT THE CALL —
 * a file that has since gone is flagged (`present: false`), never dropped. */
export interface AgentSkill {
  name: string
  present: boolean
}

/** Whether the agent is working RIGHT NOW, and on what — derived server-side
 * from the process-local `traces.DOING` map, never a stored flag (a stored
 * "working" would still say so a day after the process died). Idle is
 * `working: false` with the rest null. */
export interface AgentState {
  working: boolean
  doing: string | null
  since: string | null
  turn_id: string | null
}

/** A timer bound to the agent (`timers.agent_id`) — what a delete pauses. */
export interface AgentTimerRef {
  id: string
  title: string
}

/** What the gateway did with the agent's `agent_<name>` role on a create,
 * update or delete, in words fit to show. `registered` is true only when the
 * gateway holds the state the call asked for. */
export interface AgentRoute {
  registered: boolean
  detail: string
}

/**
 * One agent as GET /api/v1/agents returns it (services/core/app/agents_api.py).
 * The row's own columns plus the facts DERIVED at the request: `state`,
 * `last_active`, `bound_timers`, `skills` (present or not), `unknown_tools`
 * (subset entries naming no registered tool), and `spent_month_usd` from the
 * gateway's ledger for the derived role — null with `spend_note` saying why
 * when the ledger could not be read, NEVER shown as 0 (0 is a real figure).
 */
export interface Agent extends AgentSummary {
  id: string
  instructions: string
  tools: string[]
  skills: AgentSkill[]
  unknown_tools: string[]
  monthly_cap_usd: number | null
  max_tool_rounds: number
  read_shared_memory: boolean
  /** `agents/<name>/` — the workspace folder its files live under. */
  folder: string
  /** null until the first delegation creates it — /log is then empty. */
  log_conversation_id: string | null
  created_via: string
  created_at: string
  updated_at: string
  bound_timers: AgentTimerRef[]
  spent_month_usd: number | null
  spend_note: string | null
  last_active: string | null
  state: AgentState
}

/** POST /agents body — the AgentSpec fields by name. `name` is immutable
 * after create (the store refuses a rename in its own words). */
export interface AgentWrite {
  name: string
  purpose: string
  instructions: string
  tools: string[]
  skills?: string[]
  monthly_cap_usd?: number | null
  max_tool_rounds?: number
  read_shared_memory?: boolean
  model_chain?: string[]
}

/** PUT /agents/{name} body — the subset being changed. */
export type AgentChanges = Partial<Omit<AgentWrite, 'name'>>

/** A create/update answers with the row read back after the commit, plus
 * `text` — the sentence the store composed from what it READ BACK, the
 * same one Nova's own tools return — and the gateway's route outcome. */
export interface AgentSaved extends Agent {
  text: string
  route: AgentRoute
}

/** What DELETE /agents/{name} answers: which timers it paused
 * (`already_paused` is null for one THIS delete paused, else the reason it
 * already carried), the route outcome, and `remains` — the store's own
 * sentence about what was left in place (folder, notes, log). */
export interface AgentDeleted {
  deleted: string
  paused_timers: { id: string; title: string; already_paused: string | null }[]
  route: AgentRoute
  remains: string
  text: string
}

/** One entry of the live tool registry (GET /api/v1/tools), in
 * `tool_names()` order — the checkbox list the agent form offers. */
export interface ToolInfo {
  name: string
  description: string
  result_kind: string
  ephemeral: boolean
}

/** One file under `<WORKSPACE_ROOT>/skills/` (GET /api/v1/skills). */
export interface SkillInfo {
  name: string
  size: number
  modified: string
}

export const listAgents = () => apiGet<Agent[]>('/api/v1/agents')

/** A 404 (no agent by that name) is thrown by `request` with core's words. */
export const getAgent = (name: string) =>
  apiGet<Agent>(`/api/v1/agents/${encodeURIComponent(name)}`)

/** A refusal (400) is the store's own sentence — shown verbatim in the form. */
export const createAgent = (body: AgentWrite) =>
  apiSend<AgentSaved>('/api/v1/agents', 'POST', body)

export const updateAgent = (name: string, changes: AgentChanges) =>
  apiSend<AgentSaved>(`/api/v1/agents/${encodeURIComponent(name)}`, 'PUT', changes)

export const deleteAgent = (name: string) =>
  apiSend<AgentDeleted>(`/api/v1/agents/${encodeURIComponent(name)}`, 'DELETE')

/** The agent's log conversation — the briefs it was handed (user rows) and
 * the reports it wrote (assistant rows), oldest first, in the chat
 * transcript's own row shape. [] for an agent that has never been delegated
 * to (its log conversation does not exist yet). */
export const getAgentLog = (name: string) =>
  apiGet<StoredMessage[]>(`/api/v1/agents/${encodeURIComponent(name)}/log`)

export const listTools = () => apiGet<ToolInfo[]>('/api/v1/tools')

export const listSkills = () => apiGet<SkillInfo[]>('/api/v1/skills')

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
  /** Who the turn ran for (S10); null for rows older than the column. */
  person_id?: string | null
  /** WHO did the work (S12): the agent's name read off the agents row the
   * turn's agent_id points at — derived on every read, so a deleted agent's
   * turns come back null. null for Nova's own turns. Absent on a core older
   * than S12. */
  agent?: string | null
  /** The routing role the turn's gateway rounds walked (S12) — `agent_<name>`
   * for an agent's turn, kept as the turn recorded it even after the agent
   * is deleted; null = Nova's own turn, routed by kind. */
  role?: string | null
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
  opts: { limit?: number; before?: string; agent?: string } = {},
): Promise<ActivityTurn[]> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? ACTIVITY_PAGE_SIZE))
  if (opts.before) params.set('before', opts.before)
  // S12: one agent's turns, matched server-side on the agents row's name. A
  // name no agent holds is an EMPTY list, not a 404 — a fresh agent's Traces
  // tab has simply done nothing yet.
  if (opts.agent !== undefined) params.set('agent', opts.agent)
  const body = await apiGet<{ turns: ActivityTurn[] }>(`/api/v1/activity?${params.toString()}`)
  return body.turns
}

export const getActivityTurn = (turnId: string) =>
  apiGet<ActivityTurnDetail>(`/api/v1/activity/${turnId}`)

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

/** `prefix` (S12) narrows the walk to one folder — an agent's `agents/<name>/`
 * for its Artifacts tab. It goes through core's same containment gate as
 * every path; a folder that is not there yet is an EMPTY listing, not an
 * error. Entries stay relative to the ROOT so each links to /file?path=
 * unchanged. */
export const getWorkspaceFiles = (prefix?: string) =>
  apiGet<WorkspaceFileListing>(
    prefix === undefined
      ? '/api/v1/workspace/files'
      : `/api/v1/workspace/files?prefix=${encodeURIComponent(prefix)}`,
  )

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
  /** S10a: where the preflight size came from (`hf-hub` | `ollama-registry`). */
  size_source?: string
  /** S10a: what a typed ref resolved to before the pull. */
  resolved?: { quant?: string; family?: string; params_b?: number }
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

// ── devices (services/core/app/devices_api.py) ──────────────────────────

/**
 * A machine paired to this Nova. Pairing is the whole of it: a paired device
 * does everything the user novad runs as can do, and there is no per-device
 * grant to edit (owner ruling 2026-09-03) — the only things an operator
 * changes here are the name and whether the pairing still stands. `last_seen`
 * is core's clock at the last heartbeat, or null before the first — the ONLY
 * liveness fact the REST list carries: `connected` is ALWAYS false on this
 * route by design (only the model-facing device_list tool overwrites it from
 * live WS hub membership), so the tile derives liveness from `last_seen`
 * freshness, never from `connected`. See pages/settings/devicesFormat.ts. A
 * revoked device is still listed — a machine that was revoked is part of what
 * the operator needs to see.
 */
export interface Device {
  id: string
  name: string
  platform: string
  hostname: string
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

/** POST /devices/{id}/revoke — core also drops the device's live socket. */
export async function revokeDevice(id: string): Promise<Device> {
  const body = await apiSend<{ device: Device }>(
    `/api/v1/devices/${encodeURIComponent(id)}/revoke`,
    'POST',
  )
  return body.device
}

// ── governance audit (services/core/app/governance_api.py) ──────────────

/** One row of the append-only ledger: what happened, verbatim — a record,
 * never a decision. Never derived or filtered by this client — see
 * governance.py's own docstring. */
export interface GovernanceEvent {
  id: string
  kind: string
  actor: string | null
  subject_ref: string | null
  meta: Record<string, unknown>
  created_at: string
}

export const GOVERNANCE_PAGE_SIZE = 50

export async function getGovernanceEvents(
  opts: { limit?: number; before?: string } = {},
): Promise<GovernanceEvent[]> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? GOVERNANCE_PAGE_SIZE))
  if (opts.before) params.set('before', opts.before)
  const body = await apiGet<{ events: GovernanceEvent[] }>(
    `/api/v1/governance?${params.toString()}`,
  )
  return body.events
}

// ── timers / schedules (services/core/app/timers_api.py, S9) ────────────

/** A timer is a row; its kind says what a firing does. `reminder` — code
 * delivers his words to chat and every connected paired device, no model.
 * `scheduled` — an instruction run as a real model turn. `job` — a code
 * handler bound by name (retention). Nothing here is a heartbeat. */
export type TimerKind = 'reminder' | 'scheduled' | 'job'

/** timer_firings.status — `running` while the firing holds it, then exactly
 * one of ok / error / refused / interrupted (the CHECK constraint's set). A
 * firing that could not verify its own outcome is `error` with a reason. */
export type TimerFiringStatus = 'running' | 'ok' | 'error' | 'refused' | 'interrupted'

export interface TimerLastFiring {
  status: TimerFiringStatus
  ended_at: string | null
  reason: string | null
}

export interface Timer {
  id: string
  kind: TimerKind
  title: string
  /** reminder: {message, device?}; scheduled: {instruction}; job: {handler}. */
  payload: Record<string, unknown>
  /** The validated spec (app/schedule.py). Shown only through
   * `schedule_words` — this client never recomputes a recurrence. */
  schedule: Record<string, unknown>
  /** `describe()`'s words, computed server-side by the SAME function her
   * chat confirmation uses, so the page and her reply cannot disagree
   * about one row. Rendered verbatim. */
  schedule_words: string
  /** IANA zone the spec is computed in. */
  timezone: string
  /** null = finished (a once that has fired) — never a flag that could drift. */
  next_fire_at: string | null
  paused_at: string | null
  /** Set whenever paused_at is (DB CHECK): the owner's pause, or core's own
   * "paused after 5 consecutive failures: <last reason>". */
  paused_reason: string | null
  consecutive_failures: number
  created_via: 'chat' | 'page' | 'system'
  created_at: string
  /** The newest firing's outcome, or null when it has never fired. */
  last_firing: TimerLastFiring | null
  /** S12: the agent a scheduled firing runs as (the agents row's NAME,
   * derived from `timers.agent_id` on read), or null — Nova herself. A
   * deleted agent SETs it null, so a firing never runs as a name no row
   * holds. */
  agent: string | null
}

/** One channel's delivery verdict — `ok` only from the channel's own result
 * (the chat row persisted; the device's own result frame), never assumed. */
export interface TimerChannelDelivery {
  ok: boolean
  reason?: string
}

export interface TimerDeviceDelivery extends TimerChannelDelivery {
  name: string
}

/** {"chat": {ok, reason?}, "devices": [{name, ok, reason?}], "note"?} — a
 * reminder with no connected device has an EMPTY devices list and a stated
 * note; that is a fact, not a failure. A job's delivery is {}. */
export interface TimerDelivery {
  chat?: TimerChannelDelivery
  devices?: TimerDeviceDelivery[]
  note?: string
}

export interface TimerFiring {
  id: string
  timer_id: string
  /** The next_fire_at this firing was claimed at. */
  scheduled_for: string
  started_at: string
  ended_at: string | null
  status: TimerFiringStatus
  reason: string | null
  /** The turn this firing opened — every firing is a traced turn. */
  turn_id: string | null
  delivery: TimerDelivery
}

export const TIMERS_PAGE_SIZE = 50

/** A page is the last one when it comes back shorter than the limit asked
 * for — the same cursor contract as getActivity (cursor = the last row's id). */
export async function listTimers(
  opts: { limit?: number; before?: string } = {},
): Promise<Timer[]> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? TIMERS_PAGE_SIZE))
  if (opts.before) params.set('before', opts.before)
  const body = await apiGet<{ timers: Timer[] }>(`/api/v1/timers?${params.toString()}`)
  return body.timers
}

export async function listTimerFirings(
  timerId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<TimerFiring[]> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? TIMERS_PAGE_SIZE))
  if (opts.before) params.set('before', opts.before)
  const body = await apiGet<{ firings: TimerFiring[] }>(
    `/api/v1/timers/${encodeURIComponent(timerId)}/firings?${params.toString()}`,
  )
  return body.firings
}

/** POST /timers/{id}/pause → the updated row. `reason` is what the row
 * will say it was paused for; core records one either way (paused_reason
 * is NOT NULL whenever paused_at is). */
export const pauseTimer = (id: string, reason?: string) =>
  apiSend<Timer>(
    `/api/v1/timers/${encodeURIComponent(id)}/pause`,
    'POST',
    reason === undefined ? {} : { reason },
  )

/** POST /timers/{id}/resume → the updated row (a paused once still in the
 * future keeps its instant; a repeat is recomputed from now, server-side). */
export const resumeTimer = (id: string) =>
  apiSend<Timer>(`/api/v1/timers/${encodeURIComponent(id)}/resume`, 'POST')

/** POST /timers/{id}/fire — "Run now". Core sets next_fire_at = now() and
 * runs one scheduler tick INLINE, so the answer is the firing row that tick
 * produced (claim + run history included), not an acknowledgement. */
export async function fireTimer(id: string): Promise<TimerFiring> {
  const body = await apiSend<{ firing: TimerFiring }>(
    `/api/v1/timers/${encodeURIComponent(id)}/fire`,
    'POST',
  )
  return body.firing
}

/** DELETE /timers/{id} → 204, no body — so this reads nothing back; a
 * non-2xx is thrown by `request` with core's stated reason. */
export async function deleteTimer(id: string): Promise<void> {
  await request(`/api/v1/timers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** PUT /timers/{id}/agent {agent} (S12) — rebind which agent a scheduled
 * timer runs as; null = Nova herself. The answer is the row as written (the
 * pause/resume idiom), and the Schedules page re-reads the list after it so
 * the column only ever shows a binding the server confirmed. A refusal (an
 * unknown name — the 404 names the agents that exist; a reminder or job row
 * — the store's 400) is thrown by `request` with core's stated reason. */
export const bindTimerAgent = (id: string, agent: string | null) =>
  apiSend<Timer>(`/api/v1/timers/${encodeURIComponent(id)}/agent`, 'PUT', { agent })

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
  /** When the row was persisted — present on every stored case. */
  created_at?: string
}

export interface EvalScoreSummary {
  total: number
  gradeable: number
  ungradeable: number
  passed: number
  /** null when nothing is gradeable — an empty state, never a fabricated 0. */
  pass_rate: number | null
}

/** One suite run's record (eval_suite_runs, migration 016): the server-side
 * job's truth. `status` is the fact the page reads — 'running' while the job
 * holds it, then exactly one of 'done' (every case scored), 'error' (the job
 * failed; `error` says why) or 'interrupted' (the core process running it
 * exited first; `error` says so). */
export type EvalRunStatus = 'running' | 'done' | 'error' | 'interrupted'

export interface EvalSuiteRun {
  id: string
  suite: string
  suite_version: number
  model: string
  status: EvalRunStatus
  case_count: number
  error: string | null
  started_at: string
  ended_at: string | null
}

export interface EvalRunResult {
  suite: string
  suite_version: number
  model: string
  /** The complete run these cases belong to — null when none has finished
   * for this (suite, version, model), in which case `cases` is empty. */
  run: EvalSuiteRun | null
  cases: EvalCaseResult[]
  summary: EvalScoreSummary
}

/**
 * The latest COMPLETE run for (suite, model) at the suite's CURRENT version —
 * so the page shows prior results without re-running, only ever within one
 * suite_version, and never a partial (interrupted/errored) run's rows blended
 * with an older complete one's. Empty `cases` with a null pass_rate is the
 * honest "no finished run yet" state, never a 0/0 score.
 */
export async function getEvalRuns(suite: string, model: string): Promise<EvalRunResult> {
  const params = new URLSearchParams({ suite, model })
  return apiGet<EvalRunResult>(`/api/v1/evals/runs?${params.toString()}`)
}

/** What POST /evals/run answers (202): the run's id to poll. */
export interface EvalRunStarted {
  run_id: string
  status: 'running'
  case_count: number
  suite: string
  suite_version: number
  model: string
}

/**
 * POST /api/v1/evals/run — start a suite run as a SERVER-SIDE job and return
 * at once. The run's truth is its database row, detached from this request:
 * reloading, closing the tab or backgrounding the PWA no longer cancels a case
 * mid-turn. Poll `getEvalRun(run_id)` for progress. A 409 (an ApiError with
 * status 409) means a run is already active — one runs at a time, the GPU is
 * shared — and the page attaches to that run (getActiveEvalRun) instead of
 * showing an error.
 */
export async function startEvalRun(suite: string, model: string): Promise<EvalRunStarted> {
  return apiSend<EvalRunStarted>('/api/v1/evals/run', 'POST', { suite, model })
}

/** GET /api/v1/evals/runs/active — the running suite run, or null. Read on
 * mount so navigating away and back re-attaches to the same run. */
export async function getActiveEvalRun(): Promise<EvalSuiteRun | null> {
  return apiGet<EvalSuiteRun | null>('/api/v1/evals/runs/active')
}

/** One run's record: the row, the cases persisted so far (suite order), and a
 * summary ONLY once status is 'done' — null otherwise, so a partial run is
 * never read as a score. */
export interface EvalRunRecord {
  run: EvalSuiteRun
  cases: EvalCaseResult[]
  summary: EvalScoreSummary | null
}

export async function getEvalRun(runId: string): Promise<EvalRunRecord> {
  return apiGet<EvalRunRecord>(`/api/v1/evals/runs/${encodeURIComponent(runId)}`)
}

// ── providers (S10-pre) ─────────────────────────────────────────────────

/** The wire protocols a provider row can name. Vendors are not the unit;
 * protocols are: everything OpenAI-shaped (OpenAI, OpenRouter, Groq, Azure
 * v1, Bedrock, Gemini's compat layer, …) is `openai-chat`. */
export type ProviderAdapter = 'ollama' | 'openai-chat' | 'anthropic-messages'
export type ProviderAuthShape = 'none' | 'static-bearer' | 'api-key-header'
export type ProviderListingState = 'available' | 'unavailable' | 'unknown'

export interface Provider {
  name: string
  adapter: ProviderAdapter
  base_url: string
  auth_shape: ProviderAuthShape
  /** Masked by the gateway; never the real key. */
  api_key: string | null
  default_model: string | null
  model_note: string | null
  preset: string | null
  builtin: boolean
  is_default: boolean
  verified_at: string | null
  /** What the LAST model listing learned — rewritten by every listing fetch. */
  listing: ProviderListingState
  listing_note: string | null
  /** The save's verdict on the KEY, written only by a save: true = accepted
   * (the listing required it, or a 1-token completion came back as a
   * completion); false = a completion was refused for a non-auth reason;
   * null = never tested. `verify_note` says how, in the gateway's words. */
  key_proven: boolean | null
  verify_note: string | null
  created_at: string
  updated_at: string
}

export interface ProviderWrite {
  name?: string
  adapter: ProviderAdapter
  base_url: string
  auth_shape: ProviderAuthShape
  api_key?: string
  default_model?: string
  model_note?: string
  preset?: string
}

export interface ProviderPreset {
  name: string
  label: string
  adapter: ProviderAdapter
  base_url: string
  auth_shape: ProviderAuthShape
  docs_url?: string
  model_note?: string
  quirks?: string
  /** `{resource}`, `{region}` … the owner fills in before saving. */
  placeholders?: string[]
}

export interface ProviderModel {
  id: string
  owned_by: string
  name?: string
  context_length?: number
  /** USD per token, as the provider stated it. Absent when it stated none. */
  pricing?: { prompt?: number; completion?: number }
}

/** A live listing — always labelled with where and when it came from. */
export interface ProviderListing {
  source: string
  fetched_at: string
  models: ProviderModel[]
}

export async function getProviders(): Promise<Provider[]> {
  const body = await apiGet<{ providers: Provider[] }>('/api/v1/providers')
  return body.providers
}

export async function getProviderPresets(): Promise<ProviderPreset[]> {
  const body = await apiGet<{ presets: ProviderPreset[] }>('/api/v1/providers/presets')
  return body.presets
}

/** The gateway verifies the provider live BEFORE saving; a 502 means the
 * row never landed and the message is the provider's own reason. */
export const createProvider = (provider: ProviderWrite & { name: string }) =>
  apiSend<Provider>('/api/v1/providers', 'POST', provider)

export const updateProvider = (name: string, patch: Partial<ProviderWrite>) =>
  apiSend<Provider>(`/api/v1/providers/${encodeURIComponent(name)}`, 'PUT', patch)

export const deleteProvider = (name: string) =>
  apiSend<{ deleted: string }>(`/api/v1/providers/${encodeURIComponent(name)}`, 'DELETE')

export const makeDefaultProvider = (name: string) =>
  apiSend<Provider>(`/api/v1/providers/${encodeURIComponent(name)}/default`, 'PUT')

export const getProviderModels = (name: string) =>
  apiGet<ProviderListing>(`/api/v1/providers/${encodeURIComponent(name)}/models`)

// ── the model catalogue (S10a) ───────────────────────────────────────────

/** How a fact is known. `declared` = the source stated it; `inferred` = a
 * heuristic (name, tags), drawn dashed with a `?` and off by default in
 * filters; `vetted` = a dated human annotation; `measured` = Nova ran it. */
export type CatalogBasis = 'declared' | 'inferred' | 'vetted' | 'measured'

export interface CatalogFact<T = unknown> {
  value: T
  basis: CatalogBasis
  /** A key into the row's `sources[]`. */
  source: string
  note?: string
  at?: string
  detail?: Record<string, unknown>
}

export interface CatalogSource {
  key: string
  url?: string
  fetched_at?: string
  cached?: boolean
  ok?: boolean
  note?: string
  rows?: number
}

export type CatalogKind = 'local' | 'cloud' | 'hub'
export type CatalogAction = 'use' | 'pull' | 'probe' | 'check_update' | 'update' | 'remove'

export type CatalogRow = {
  /** provider:model — what Use writes to chat.model. */
  id: string
  provider: string
  model: string
  label: string
  kind: CatalogKind
  installed?: boolean
  sources: CatalogSource[]
  facts: Record<string, CatalogFact>
  capabilities: Record<string, CatalogFact<boolean>>
  /** One entry per (name, basis): keys are `name` or `name:basis` when two bases exist. */
  suitability: Record<string, CatalogFact<number | boolean>>
  /** The vetted note, a failure note (a show that did not answer), or "installed as …" on a Hub row. */
  note?: string | null
  fit?: ModelFit | null
  probe?: { ok: boolean; latency_ms: number | null; vram_mb: number | null; created_at: string } | null
  drift?: {
    checked_at: string
    installed_digest: string | null
    upstream_digest: string | null
    moved: boolean | null
    basis: string
    note?: string
  } | null
  pull?: { target: string; quants: PullOption[] } | null
  actions: CatalogAction[]
}

export interface PullOption {
  tag: string
  filename: string
  size_bytes: number
  sha256?: string
  is_default: boolean
  mmproj_bytes?: number
}

export interface Catalog {
  fetched_at: string
  sources: CatalogSource[]
  rows: CatalogRow[]
}

export interface HfPage {
  rows: CatalogRow[]
  next_cursor: string | null
  fetched_at: string
  cached: boolean
  budget?: { remaining: number; resets_in_s: number }
}

/** What a typed ref (`qwen3:4b`, `hf.co/org/repo:Q4_K_M`) resolves to before a pull. */
export interface ResolvedRef {
  model: string
  source: string
  fetched_at: string
  facts: Record<string, CatalogFact>
  pull?: { target: string; quants: PullOption[] } | null
  note?: string
}

export const getCatalog = () => apiGet<Catalog>('/api/v1/models/catalog')

export function searchHf(query: string, sort = 'downloads', cursor?: string, limit = 30) {
  const params = new URLSearchParams({ q: query, sort, limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  return apiGet<HfPage>(`/api/v1/models/catalog/hf?${params.toString()}`)
}

export const getHfRepo = (org: string, repo: string) =>
  apiGet<CatalogRow>(`/api/v1/models/catalog/hf/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`)

export const resolveModel = (model: string) =>
  apiGet<ResolvedRef>(`/api/v1/models/catalog/resolve?model=${encodeURIComponent(model)}`)

export interface ProbeResult {
  id: number
  model: string
  kind: string
  ok: boolean
  latency_ms: number | null
  vram_mb: number | null
  error: string | null
  created_at: string
}

/** POST /api/v1/models/probe — a real 1-token completion through the same
 * adapter a turn uses; the gateway records the result in its probes table. */
export const probeModel = (model: string) =>
  apiSend<ProbeResult>('/api/v1/models/probe', 'POST', { model })

/** Has the source moved since this model was pulled? The installed weights
 * digest against the registry's / the Hub's current one. Never pulls. */
export type DriftResult = NonNullable<CatalogRow['drift']> & { model: string; source: string | null; retry_after_s?: number }
/** Remove an installed model from the bundled ollama; the gateway verifies
 * against /api/tags before it says removed. */
export const removeModel = (model: string) =>
  apiSend<{ removed: string; verified: boolean; installed_now: number }>(
    `/api/v1/models?model=${encodeURIComponent(model)}`,
    'DELETE',
  )

export const checkDrift = (model: string) =>
  apiSend<DriftResult>('/api/v1/models/catalog/drift', 'POST', { model })
