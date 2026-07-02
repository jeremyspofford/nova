export interface AgentConfig {
  name: string
  model: string
  system_prompt: string
  tools: string[]
  max_context_tokens: number
  fallback_models: string[]
  metadata: Record<string, unknown>
}

export interface AgentInfo {
  id: string
  config: AgentConfig
  status: 'idle' | 'running' | 'stopped'
  created_at: string
  last_active: string | null
}

export interface UsageEvent {
  id: string
  api_key_id: string | null
  key_name: string | null
  agent_id: string | null
  session_id: string | null
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd: number | null
  duration_ms: number | null
  created_at: string
  agent_name: string | null
  pod_name: string | null
}

export interface ApiKey {
  id: string
  name: string
  key_prefix: string
  is_active: boolean
  rate_limit_rpm: number
  created_at: string
  last_used_at: string | null
  metadata: Record<string, unknown>
}

export interface OAIModel {
  id: string
  object: string
  created: number
  owned_by: string
}

// ── Pipeline ───────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'context_running'
  | 'task_running'
  | 'guardrail_running'
  | 'code_review_running'
  | 'decision_running'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'pending_human_review'
  | 'clarification_needed'

export interface PipelineTask {
  id: string
  status: TaskStatus
  pod_id: string | null
  pod_name: string | null
  goal_id: string | null
  user_input: string
  output: string | null
  error: string | null
  current_stage: string | null
  retry_count: number
  max_retries: number
  queued_at: string | null
  started_at: string | null
  completed_at: string | null
  metadata: Record<string, unknown>
  summary: Record<string, unknown> | null
  checkpoint: Record<string, Record<string, unknown>> | null
}

export interface GuardrailFinding {
  id: string
  task_id: string
  finding_type: string
  severity: string
  description: string
  evidence: string | null
  status: string
  created_at: string
}

export interface CodeReviewVerdict {
  id: string
  task_id: string
  iteration: number
  verdict: string
  issues: { severity: string; description: string; file?: string; line?: string }[]
  summary: string
  created_at: string
}

export interface AgentSession {
  id: string
  task_id: string
  role: string
  status: 'running' | 'complete' | 'failed' | 'skipped'
  output: Record<string, unknown> | null
  error: string | null
  traceback: string | null
  duration_ms: number | null
  model_used: string | null
  cost_usd: number
  started_at: string | null
}

export interface PodAgent {
  id: string
  pod_id: string
  name: string
  role: string
  enabled: boolean
  position: number
  model: string | null
  fallback_models: string[]
  temperature: number
  max_tokens: number
  timeout_seconds: number
  max_retries: number
  system_prompt: string | null
  allowed_tools: string[] | null
  on_failure: string
  run_condition: Record<string, unknown>
  artifact_type: string | null
  parallel_group: string | null
  created_at: string
}

export interface Pod {
  id: string
  name: string
  description: string
  enabled: boolean
  routing_keywords: string[] | null
  default_model: string | null
  max_cost_usd: number | null
  max_execution_seconds: number
  require_human_review: string
  escalation_threshold: string
  sandbox: string
  metadata: Record<string, unknown>
  created_at: string
  active_agent_count?: number
  agents?: PodAgent[]
}

export interface EngramDetail {
  id: string
  type: string
  content: string
  activation: number
  importance: number
  access_count: number
  confidence: number
  source_type: string
  superseded: boolean
  created_at: string | null
  source_ref_id: string | null
}
