// ── Models page ──────────────────────────────────────────────────────────────
// The recommended-model catalog lives in data/recommended_models.json, served
// by recovery at /inference/models/recommended (filterable by backend + VRAM).

/** Provider display order for the Models page. */
export const CLOUD_PROVIDER_ORDER = [
  'claude-max', 'anthropic', 'openai', 'chatgpt',
  'groq', 'gemini', 'cerebras', 'openrouter', 'github', 'nvidia',
]

// ── Task Pipeline ────────────────────────────────────────────────────────────

/** Task statuses that indicate the pipeline is actively processing. */
export const ACTIVE_TASK_STATUSES = new Set([
  'queued', 'running', 'context_running', 'task_running',
  'guardrail_running', 'code_review_running', 'decision_running',
])

/** Visual config for task pipeline status badges (distinct from agent StatusBadge). */
export const TASK_STATUS_CONFIG: Record<string, { label: string; className: string; pulse?: boolean }> = {
  queued:              { label: 'Queued',        className: 'bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300' },
  running:             { label: 'Running',       className: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400', pulse: true },
  context_running:     { label: 'Context',       className: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400', pulse: true },
  task_running:        { label: 'Task',          className: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400', pulse: true },
  guardrail_running:   { label: 'Guardrail',     className: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400', pulse: true },
  code_review_running: { label: 'Code Review',   className: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400', pulse: true },
  decision_running:    { label: 'Decision',      className: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400', pulse: true },
  complete:            { label: 'Complete',      className: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' },
  failed:              { label: 'Failed',        className: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400' },
  cancelled:           { label: 'Cancelled',     className: 'bg-neutral-400/30 dark:bg-neutral-600/30 text-neutral-500 dark:text-neutral-400' },
  pending_human_review:  { label: 'Needs Review',        className: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400', pulse: true },
  clarification_needed:  { label: 'Needs Clarification', className: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400', pulse: true },
  waiting_human:         { label: 'Waiting on You',      className: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400', pulse: true },
}
