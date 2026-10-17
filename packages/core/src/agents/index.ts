// M6 always-on agents (docs/09 §8; FR-079..FR-084, FR-089, FR-090, FR-181, FR-194, FR-206):
// the agent service with its turn extension, policy and status sources, tools, schedule target
// and external-agent guard. Names are explicit so other areas' exports never collide.
export {
  AgentService,
  parseDuration as parseWakeDuration,
  type AgentRow,
  type AgentServiceOptions,
  type AgentStatusLookup,
  type AgentTimers,
} from './service.ts';
export { agentTools, type AgentToolHost, type AgentTools } from './tools.ts';
export {
  RULE_EFFECT as AGENT_RULE_ENGINE_EFFECT,
  channelResource,
  checkAgentRule,
  engineCommandRule as agentCommandRule,
  engineRules as agentEngineRules,
  previewMatches as agentRulePreviewMatches,
  rulesSummary as agentRulesSummary,
  type AgentRuleLike,
} from './rules.ts';
export {
  detectExternalAgent,
  externalAgentDecision,
  looksLikeAgent,
  namesAgent,
  normalizeCounterpart,
  type ExternalEvidence,
  type ExternalFinding,
  type ExternalSender,
} from './external.ts';
export type {
  AgentBinding,
  AgentComputers,
  AgentDeleteHook,
  AgentPolicySource,
  AgentRuns,
  AgentScheduler,
  AgentSettings,
  AgentThreadLink,
  AgentThreadPolicy,
  ExternalAgentGuard,
  ExternalCounterpart,
  QuietHours,
} from './types.ts';
