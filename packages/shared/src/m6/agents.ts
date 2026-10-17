// M6 always-on agents: API shapes (owned by the agents area; the web reads them). FR-079,
// FR-080, FR-082..FR-084, FR-089, FR-090, FR-181, FR-194, FR-206; docs/09 §8, docs/12 §3.
import { z } from 'zod';
import {
  RUN_AUTONOMY,
  idSchema,
  setGoalSchema,
  type ActionEffectClass,
  type RunAutonomy,
  type StatusView,
} from '../api.ts';

export const AGENT_STATUSES = ['active', 'paused', 'stopped'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Custom rule effects (docs/12 §3): take action without asking, when you say so, ask, hand off. */
export const AGENT_RULE_EFFECTS = ['act', 'act_on_request', 'ask', 'handoff'] as const;
export type AgentRuleEffect = (typeof AGENT_RULE_EFFECTS)[number];

/** Action classes a rule may name (FR-045 classes; `write` is any change, `read` any read). */
export const AGENT_ACTION_CLASSES = ['read', 'write', 'send', 'delete', 'execute'] as const;
export type AgentActionClass = (typeof AGENT_ACTION_CLASSES)[number];

/** Effect classes a rule may match on (contracts/schemas/policy-rule.json). */
export const AGENT_RULE_EFFECT_CLASSES = [
  'external_communication',
  'purchase',
  'account_change',
  'credential_change',
  'data_delete',
  'file_write',
  'exec',
  'network',
] as const satisfies readonly ActionEffectClass[];

export const AGENT_MEMORY_KINDS = ['note', 'fact', 'preference', 'observation'] as const;
export type AgentMemoryKind = (typeof AGENT_MEMORY_KINDS)[number];

/** The confirmation the client shows before deleting an agent (FR-090). */
export const AGENT_DELETE_NOTICE =
  'Deleting this agent is permanent. It removes its threads, notes, rules, schedules, wakes, ' +
  'channel bindings and grants. Actions it already took are not undone.';

// ---- requests ------------------------------------------------------------------------------

const avatarSchema = z
  .object({
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    data: z.string().max(3_000_000),
  })
  .strict();

export const agentBudgetsSchema = z
  .object({
    timeSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 86_400)
      .optional(),
    tokens: z.number().int().min(1_000).max(100_000_000).optional(),
    costUsd: z.number().min(0).max(100_000).nullable().optional(),
  })
  .strict();

export const responsibilitySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().max(4000).optional(),
  })
  .strict();

export const updateResponsibilitySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    instructions: z.string().trim().max(4000).nullable().optional(),
    status: z.enum(['active', 'paused', 'done']).optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const createAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    instructions: z.string().max(16_000).optional(),
    avatar: avatarSchema.optional(),
    responsibilities: z.array(responsibilitySchema).max(20).optional(),
    autonomy: z.enum(RUN_AUTONOMY).optional(),
    budgets: agentBudgetsSchema.optional(),
    proactive: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    model: z.string().max(300).optional(),
  })
  .strict();
export type CreateAgentRequest = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    instructions: z.string().max(16_000).optional(),
    avatar: avatarSchema.nullable().optional(),
    autonomy: z.enum(RUN_AUTONOMY).optional(),
    budgets: agentBudgetsSchema.optional(),
    proactive: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    model: z.string().max(300).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateAgentRequest = z.infer<typeof updateAgentSchema>;

/** DELETE /agents/:id must carry the confirmation (FR-090). */
export const deleteAgentSchema = z.object({ confirm: z.literal(true) }).strict();

const toolPattern = z.string().regex(/^[A-Za-z0-9_.:*-]{1,200}$/, 'a tool name or glob');
const hostPattern = z
  .string()
  .regex(/^(\*\.)?[A-Za-z0-9.-]{1,253}$/, 'a host, optionally starting with *.');

export const agentRuleMatchSchema = z
  .object({
    tools: z.array(toolPattern).max(20).optional(),
    hosts: z.array(hostPattern).max(20).optional(),
    actions: z.array(z.enum(AGENT_ACTION_CLASSES)).max(5).optional(),
    effects: z.array(z.enum(AGENT_RULE_EFFECT_CLASSES)).max(8).optional(),
    channels: z
      .array(
        z
          .object({
            kind: z.enum(['inapp', 'slack', 'teams', 'email', 'webhook', 'telegram']),
            conversation: z.string().trim().min(1).max(300).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
export type AgentRuleMatch = z.infer<typeof agentRuleMatchSchema>;

/** A command prefix rule inside an agent rule (FR-191, contracts/schemas/command-rule.json). */
export const agentRuleCommandSchema = z
  .object({
    pattern: z
      .array(z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(2)]))
      .min(1)
      .max(20),
    matchExamples: z.array(z.string().min(1).max(1000)).min(1).max(20),
    notMatchExamples: z.array(z.string().min(1).max(1000)).min(1).max(20),
    justification: z.string().max(500).optional(),
    tools: z
      .array(z.enum(['exec.run', 'exec.write']))
      .max(2)
      .optional(),
  })
  .strict();
export type AgentRuleCommand = z.infer<typeof agentRuleCommandSchema>;

export const createAgentRuleSchema = z
  .object({
    description: z.string().trim().min(1).max(300),
    effect: z.enum(AGENT_RULE_EFFECTS),
    match: agentRuleMatchSchema.default({}),
    command: agentRuleCommandSchema.optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type CreateAgentRuleRequest = z.input<typeof createAgentRuleSchema>;

export const updateAgentRuleSchema = z
  .object({
    description: z.string().trim().min(1).max(300).optional(),
    effect: z.enum(AGENT_RULE_EFFECTS).optional(),
    match: agentRuleMatchSchema.optional(),
    command: agentRuleCommandSchema.nullable().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateAgentRuleRequest = z.infer<typeof updateAgentRuleSchema>;

export const createAgentNoteSchema = z
  .object({
    content: z.string().trim().min(1).max(8000),
    kind: z.enum(AGENT_MEMORY_KINDS).default('note'),
    responsibilityId: idSchema.optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

export const updateAgentMemorySchema = z
  .object({
    content: z.string().trim().min(1).max(8000).optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

/** PUT /agents/:id/goal: the goal.json body, optionally held by one responsibility. */
export const setAgentGoalSchema = setGoalSchema.extend({ responsibilityId: idSchema.optional() });

export const externalAgentSchema = z
  .object({
    address: z.string().trim().min(1).max(300),
    label: z.string().trim().max(200).optional(),
  })
  .strict();

// ---- views ---------------------------------------------------------------------------------

export interface AgentResponsibilityView {
  id: string;
  agentId: string;
  title: string;
  /** The user's words: trusted. */
  instructions: string | null;
  status: 'active' | 'paused' | 'done';
  goalId: string | null;
  /** The agent's last progress note: untrusted. */
  progressNote: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentView {
  id: string;
  name: string;
  /** Fetched from `/agents/:id/avatar`. */
  hasAvatar: boolean;
  instructions: string;
  status: AgentStatus;
  /** Set while paused: `safety` when monitoring paused it (FR-090). */
  pauseReason: 'user' | 'safety' | null;
  statusDetail: string | null;
  autonomy: RunAutonomy;
  model: string | null;
  /** The agent's persistent cloud computer (FR-080); null until the computers area made it. */
  computerId: string | null;
  primaryThreadId: string | null;
  proactive: { enabled: boolean; lastRunAt: string | null };
  memoryEnabled: boolean;
  /** Per turn chain (a turn plus its hook continuations). */
  budgets: { timeSeconds: number; tokens: number; costUsd: number | null };
  /** Lifetime use. */
  usage: { timeSeconds: number; tokens: number; costUsd: number };
  goalId: string | null;
  responsibilities: AgentResponsibilityView[];
  /** The derived status of its threads and background work (FR-215). */
  derived: StatusView;
  openSuggestions: number;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRuleView {
  id: string;
  agentId: string;
  description: string;
  effect: AgentRuleEffect;
  match: AgentRuleMatch;
  command: AgentRuleCommand | null;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A recent action of the agent a rule would have matched (the rule preview, FR-084). */
export interface AgentRulePreviewItem {
  callId: string;
  threadId: string;
  tool: string;
  status: string;
  decision: string | null;
  createdAt: string;
}

/**
 * One memory item: a note or learned item (`source: notes`) or a conversation memory item
 * scoped to the agent (`source: conversation`, a memory_item row). Agent-written items are
 * untrusted. `originAudience` says whether it came from a private or a shared thread.
 */
export interface AgentMemoryItemView {
  id: string;
  agentId: string;
  store: 'notes' | 'conversation';
  kind: AgentMemoryKind;
  content: string;
  author: 'user' | 'agent';
  source: 'manual' | 'tool' | 'proactive' | 'conversation';
  sourceThreadId: string | null;
  responsibilityId: string | null;
  pinned: boolean;
  originAudience: 'private' | 'shared';
  createdAt: string;
  updatedAt: string;
}

export interface AgentSuggestionView {
  id: string;
  agentId: string;
  noteId: string | null;
  title: string;
  body: string;
  status: 'open' | 'accepted' | 'dismissed';
  threadId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface AgentThreadView {
  threadId: string;
  agentId: string;
  kind: 'main' | 'proactive' | 'binding' | 'background';
  bindingRef: string | null;
  audience: 'private' | 'shared';
  runId: string | null;
  title: string | null;
  createdAt: string;
}

/** Background work the agent delegated (FR-083, FR-059): one Work run each. */
export interface AgentBackgroundView {
  runId: string;
  threadId: string;
  title: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
}

export interface ExternalAgentView {
  id: string;
  address: string;
  label: string | null;
  createdAt: string;
}
