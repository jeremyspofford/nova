// Design tokens for programmatic access (charts, dynamic styles, etc.)
// These mirror the CSS custom properties defined in index.css

export const radius = {
  xs: '4px',
  sm: '6px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  full: '9999px',
} as const

export const transition = {
  fast: '150ms ease',
  normal: '200ms ease',
  slow: '300ms ease',
  spring: '300ms cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const

export const statusColors = {
  success: { DEFAULT: '#34d399', dim: 'rgba(52, 211, 153, 0.12)' },
  warning: { DEFAULT: '#fbbf24', dim: 'rgba(251, 191, 36, 0.12)' },
  danger: { DEFAULT: '#f87171', dim: 'rgba(248, 113, 113, 0.12)' },
  info: { DEFAULT: '#60a5fa', dim: 'rgba(96, 165, 250, 0.12)' },
} as const

export const breakpoints = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const

// Pipeline stage names (used by PipelineStages component)
export const PIPELINE_STAGES = ['context', 'task', 'guardrail', 'code_review', 'decision'] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

// Badge/status semantic color map
export type SemanticColor = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
