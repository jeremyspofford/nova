// Hub API shapes shared by the Hub and its clients (contracts/hub-api.md §1). Request bodies are
// validated with these schemas at the Hub boundary; responses are typed with the inferred types.
import { z } from 'zod';

// ---- common ---------------------------------------------------------------------------------

export const idSchema = z.string().min(1).max(100);
export const isoSchema = z.string();

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const pageQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---- providers & models (docs/07, FR-014, FR-023, FR-115) -------------------------------------

export const PROVIDER_KINDS = [
  'mock',
  'openai_compatible',
  'openai',
  'anthropic',
  'ollama',
  'openrouter',
  'llamacpp',
] as const;
export const providerKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export interface ProviderAccountView {
  id: string;
  provider: ProviderKind;
  label: string;
  authKind: 'api_key' | 'none' | 'oauth';
  baseUrl: string | null;
  status: 'active' | 'expired' | 'revoked' | 'error';
  /** True when a credential is stored. The credential itself is never returned. */
  hasSecret: boolean;
  lastCheckAt: string | null;
  createdAt: string;
}

export const createProviderSchema = z.object({
  provider: providerKindSchema,
  label: z.string().min(1).max(100),
  baseUrl: z.url().max(500).optional(),
  /** Write-only. Stored in the secret vault; only a `secret://` reference reaches the database. */
  apiKey: z.string().min(1).max(4000).optional(),
});
export type CreateProviderRequest = z.infer<typeof createProviderSchema>;

export interface ProviderTestResult {
  ok: boolean;
  detail?: string;
  models?: number;
}

/**
 * A model is addressed as `<providerAccountId>/<modelId>` (a provider account),
 * `node:<nodeId>/<modelId>` (a compute node, FR-126) or `preset:<presetId>` (a virtual
 * model, FR-221).
 */
export type ModelRef = string;

export type ParsedModelRef =
  | { kind: 'account'; providerAccountId: string; modelId: string }
  | { kind: 'node'; nodeId: string; modelId: string }
  | { kind: 'preset'; presetId: string };

export function nodeModelRef(nodeId: string, modelId: string): ModelRef {
  return `node:${nodeId}/${modelId}`;
}

export function presetRef(presetId: string): ModelRef {
  return `preset:${presetId}`;
}

export function parseAnyModelRef(ref: string): ParsedModelRef | null {
  if (ref.startsWith('preset:')) {
    const presetId = ref.slice('preset:'.length);
    return /^[a-z0-9][a-z0-9-]{0,40}$/.test(presetId) ? { kind: 'preset', presetId } : null;
  }
  if (ref.startsWith('node:')) {
    const p = parseModelRef(ref.slice('node:'.length));
    return p ? { kind: 'node', nodeId: p.providerAccountId, modelId: p.modelId } : null;
  }
  const p = parseModelRef(ref);
  return p ? { kind: 'account', ...p } : null;
}

export function modelRef(providerAccountId: string, modelId: string): ModelRef {
  return `${providerAccountId}/${modelId}`;
}

export function parseModelRef(ref: string): { providerAccountId: string; modelId: string } | null {
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) return null;
  return { providerAccountId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

export interface ModelView {
  ref: ModelRef;
  /** `model` = a provider or node model; `preset` = a virtual model (FR-221, docs/07 §8). */
  kind: 'model' | 'preset';
  providerAccountId: string;
  provider: ProviderKind | 'node' | 'preset';
  modelId: string;
  label: string;
  reasoning: boolean;
  /** Where it runs: a provider account, or a registered compute node (FR-126). */
  source: 'account' | 'node' | 'preset';
  nodeId?: string;
  /** Set when the entry cannot be used now (a preset whose targets are all unavailable). */
  disabledReason?: string;
}

export const REASONING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const reasoningLevelSchema = z.enum(REASONING_LEVELS);

// ---- account ------------------------------------------------------------------------------------

export const updateAccountSchema = z
  .object({
    /** An empty or blank name clears it. */
    displayName: z.string().max(100).optional(),
    /** Avatars arrive later; `null` clears one. */
    avatar: z.null().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateAccountRequest = z.infer<typeof updateAccountSchema>;

// ---- threads & messages (FR-017, FR-018, FR-021) ----------------------------------------------

export const THREAD_MODES = ['chat', 'work', 'code', 'agent'] as const;
export const threadModeSchema = z.enum(THREAD_MODES);
export type ThreadMode = z.infer<typeof threadModeSchema>;

export type ThreadState = 'idle' | 'streaming' | 'waiting_approval' | 'waiting_input' | 'error';

export interface ThreadView {
  id: string;
  mode: ThreadMode;
  title: string | null;
  projectId: string | null;
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  temporary: boolean;
  state: ThreadState;
  model: ModelRef | null;
  reasoningLevel: string | null;
  /** Branch and side-chat lineage (FR-020, FR-026, FR-033). */
  parentThreadId: string | null;
  branchFromMessageId: string | null;
  /** A side chat answers using its parent's context without adding turns to it (FR-026). */
  side: boolean;
  /** True when this chat is excluded from memory extraction (FR-032). */
  memoryOptOut: boolean;
  createdAt: string;
  updatedAt: string;
}

export const INPUT_MODES = ['steer', 'queue'] as const;
export const inputModeSchema = z.enum(INPUT_MODES);
export type InputMode = z.infer<typeof inputModeSchema>;

export const createThreadSchema = z.object({
  mode: threadModeSchema.default('chat'),
  title: z.string().max(300).optional(),
  projectId: idSchema.optional(),
  model: z.string().max(300).optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  temporary: z.boolean().optional(),
  memoryOptOut: z.boolean().optional(),
});
export type CreateThreadRequest = z.input<typeof createThreadSchema>;

export const updateThreadSchema = z
  .object({
    title: z.string().max(300).nullable().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    unread: z.boolean().optional(),
    model: z.string().max(300).optional(),
    reasoningLevel: reasoningLevelSchema.optional(),
    memoryOptOut: z.boolean().optional(),
    projectId: idSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateThreadRequest = z.infer<typeof updateThreadSchema>;

export const listThreadsQuerySchema = pageQuerySchema.extend({
  mode: threadModeSchema.optional(),
  projectId: idSchema.optional(),
  archived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  q: z.string().max(200).optional(),
});

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'summary';
export type MessageStatus = 'streaming' | 'complete' | 'incomplete' | 'error';

export type PartView =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'file'; attachmentId: string; name: string; mime: string; size: number }
  | ToolCallPartView
  | { type: 'artifact'; artifactId: string; kind: ArtifactKind; title: string | null };

/** A tool call inside an assistant message (M3, FR-099, FR-100; contracts/events.md tools). */
export interface ToolCallPartView {
  type: 'tool_call';
  callId: string;
  /** Canonical tool name, e.g. `fs.read` or `mcp:files.search`. */
  tool: string;
  title: string | null;
  source: ToolSource;
  status: ToolCallStatus;
  /** Redacted, truncated JSON of the arguments. */
  argsPreview: string;
  /** Redacted, truncated result text once finished. */
  resultPreview: string | null;
  error: string | null;
  /** Set while (or after) the call waited for an approval. */
  approvalId: string | null;
  durationMs: number | null;
}

export interface MessageView {
  id: string;
  threadId: string;
  turnId: string | null;
  role: MessageRole;
  status: MessageStatus;
  parts: PartView[];
  model: ModelRef | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  createdAt: string;
  /** The message this one answers or follows on the active path (M2 message tree, FR-020). */
  parentId?: string | null;
  /** Versions at this point (this message and its edited/regenerated siblings, oldest first);
   *  present only when there is more than one (FR-020). */
  siblingIds?: string[];
  /** Sources used in this answer (FR-040). */
  citations?: CitationView[];
  /** How a user message entered the turn: typed, a steer of a running turn, or a queued send. */
  provenance?: 'typed' | 'steer' | 'queued';
}

export interface ThreadDetail {
  thread: ThreadView;
  /** The active path, oldest first; a branch's inherited messages keep their own threadId. */
  messages: MessageView[];
  /** Messages waiting for the running turn to finish (FR-019). */
  queue?: QueuedInputView[];
}

export interface QueuedInputView {
  id: string;
  threadId: string;
  text: string;
  attachmentCount: number;
  position: number;
  createdAt: string;
}

/** Attachment limits (FR-021). */
export const ATTACHMENT_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxCount: 10,
  mimes: [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
    'text/plain',
    'text/markdown',
    'application/json',
    'text/csv',
  ],
  /** Code and text files are accepted by extension when the browser reports a generic type. */
  textExtensions: [
    '.md',
    '.txt',
    '.json',
    '.ts',
    '.tsx',
    '.js',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.c',
    '.h',
    '.cpp',
    '.css',
    '.html',
    '.yaml',
    '.yml',
    '.toml',
    '.sh',
    '.sql',
    '.csv',
  ],
} as const;

export const attachmentInputSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(200),
  /** Base64 file contents. */
  data: z.string().max(Math.ceil((ATTACHMENT_LIMITS.maxBytes * 4) / 3) + 8),
});

/** An `@`-mention sent with a message (FR-022); `ref` comes from GET /mentions. */
export const mentionSchema = z.object({
  kind: z.enum(['file', 'folder', 'mcp_server', 'tool', 'skill']),
  ref: z.string().min(1).max(1000),
});

export const sendMessageSchema = z.object({
  text: z.string().max(200_000),
  attachments: z.array(attachmentInputSchema).max(ATTACHMENT_LIMITS.maxCount).optional(),
  model: z.string().max(300).optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  /** Overrides the `general.followUp` setting for this message while a turn runs (FR-019). */
  inputMode: inputModeSchema.optional(),
  /** `@`-mentions resolved into context items (FR-022). */
  mentions: z.array(mentionSchema).max(20).optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageSchema>;

export interface SendMessageResponse {
  /** `started` a new turn; `steered` the running turn (applied at its next model step);
   *  `queued` behind the running turn (FR-019). */
  disposition: 'started' | 'steered' | 'queued';
  /** The new turn, or the running turn that was steered; null while queued. */
  turnId: string | null;
  userMessageId: string;
  /** The assistant message that will answer; null while queued. */
  assistantMessageId: string | null;
  /** Position in the queue (1-based) when queued. */
  queuePosition?: number;
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  threadTitle: string | null;
  snippet: string;
  createdAt: string;
  role?: MessageRole;
  projectId?: string | null;
}

// ---- stream payloads (contracts/events.md "chat & turns") --------------------------------------

/** `chat.delta` payload: one normalized stream event for one assistant message (ephemeral). */
export type ChatDeltaPayload = { threadId: string; messageId: string } & (
  { type: 'text_delta'; text: string } | { type: 'reasoning_delta'; text: string }
);

export interface ChatMessageCompletedPayload {
  threadId: string;
  messageId: string;
  status: MessageStatus;
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
}

// ==== M2: branches, side chats, projects, sources, memory, presets, nodes ====================

// ---- message versions, branches, tree (FR-020, FR-026, FR-033) -------------------------------

/** Edit a user message: adds an edited sibling version and runs it; prior turns are kept. */
export const editMessageSchema = z.object({
  text: z.string().min(1).max(200_000),
  model: z.string().max(300).optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
});

/** Regenerate an assistant reply: adds a sibling reply to the same user message. */
export const regenerateSchema = z.object({
  model: z.string().max(300).optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
});

/** Switch the active path to the one through this message version. */
export const selectVersionSchema = z.object({ messageId: idSchema });

/** Branch from here: a new thread that continues from this message (FR-020, FR-033). */
export const branchSchema = z.object({
  fromMessageId: idSchema,
  title: z.string().max(300).optional(),
});

export interface ThreadTreeNode {
  threadId: string;
  parentThreadId: string | null;
  branchFromMessageId: string | null;
  title: string | null;
  side: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ThreadTree {
  rootThreadId: string;
  nodes: ThreadTreeNode[];
}

/** Side chat: a child thread that reads the parent's context and adds no turns to it (FR-026). */
export const sideChatSchema = z.object({
  text: z.string().min(1).max(200_000),
  model: z.string().max(300).optional(),
});

export interface SideChatResponse {
  thread: ThreadView;
  send: SendMessageResponse;
}

// ---- projects & sources (FR-034, FR-040) ------------------------------------------------------

export interface ProjectView {
  id: string;
  name: string;
  instructions: string | null;
  memoryScope: 'shared' | 'project_only';
  threadCount: number;
  sourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  instructions: z.string().max(20_000).optional(),
  memoryScope: z.enum(['shared', 'project_only']).default('shared'),
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    instructions: z.string().max(20_000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export type SourceStatus = 'pending' | 'indexing' | 'ready' | 'error';

export interface SourceView {
  id: string;
  projectId: string;
  name: string;
  mime: string;
  size: number;
  status: SourceStatus;
  chunkCount: number;
  error: string | null;
  indexedAt: string | null;
  createdAt: string;
}

export const addSourceSchema = z.union([
  attachmentInputSchema.extend({ kind: z.literal('file') }),
  z.object({
    kind: z.literal('text'),
    name: z.string().min(1).max(255),
    text: z.string().min(1).max(2_000_000),
  }),
]);

/** A source passage used in an answer, stored with the turn (FR-040, docs/06 citation). */
export interface CitationView {
  id: string;
  messageId: string;
  idx: number;
  url: string | null;
  sourceId: string | null;
  title: string | null;
  snippet: string | null;
}

// ---- memory (FR-032) --------------------------------------------------------------------------

export type MemoryScopeKind = 'global' | 'project' | 'thread' | 'agent';

export interface MemoryItemView {
  id: string;
  scopeKind: MemoryScopeKind;
  scopeRef: string | null;
  content: string;
  category: string | null;
  pinned: boolean;
  confidence: number | null;
  status: 'active' | 'dismissed';
  sourceKind: 'chat' | 'consolidation' | 'import' | 'manual' | 'ambient';
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const createMemorySchema = z.object({
  content: z.string().trim().min(1).max(2_000),
  scopeKind: z.enum(['global', 'project']).default('global'),
  scopeRef: idSchema.optional(),
  category: z.string().max(60).optional(),
  pinned: z.boolean().optional(),
});

export const updateMemorySchema = z
  .object({
    content: z.string().trim().min(1).max(2_000).optional(),
    pinned: z.boolean().optional(),
    status: z.enum(['active', 'dismissed']).optional(),
    category: z.string().max(60).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

/** Import memories from an export: a JSON array of strings or {content, category?}, or lines of text. */
export const importMemorySchema = z.object({
  format: z.enum(['json', 'text']),
  data: z.string().min(1).max(1_000_000),
  scopeKind: z.enum(['global', 'project']).default('global'),
  scopeRef: idSchema.optional(),
});

export interface MemoryImportResult {
  imported: number;
  skipped: number;
}

// ---- presets / virtual models (FR-221, docs/07 §8) ---------------------------------------------

export const presetStrategySchema = z.enum(['single', 'fallback', 'cheapest', 'best']);

export const presetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  label: z.string().min(1).max(60),
  strategy: presetStrategySchema,
  /** Ordered model refs; `single` uses the first, `fallback` tries them in order. */
  targets: z.array(z.string().max(300)).min(1).max(8),
  reasoningLevel: reasoningLevelSchema.optional(),
  speed: z.enum(['standard', 'fast']).optional(),
  /** Position on the Faster ↔ Smarter control; lower is faster. */
  rank: z.number().int().min(0).max(100),
});
export type Preset = z.infer<typeof presetSchema>;

// ---- local servers & compute nodes (docs/07 §12, FR-126, FR-127) ------------------------------

export interface DetectedServer {
  kind: 'ollama' | 'llamacpp' | 'openai_compatible';
  baseUrl: string;
  models: string[];
}

export interface NodeView {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'unreachable' | 'revoked';
  /** Where the Hub reaches the node's job API. */
  endpoint: string;
  models: string[];
  capabilities: { gpus: number; vramBytes: number | null; maxConcurrentJobs: number };
  load: { running: number; queued: number } | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface NodeEnrollToken {
  token: string;
  expiresAt: string;
}

export const ROUTING_STEPS = [
  'same_device',
  'capability',
  'least_loaded',
  'cost',
  'cloud',
] as const;
export type RoutingStep = (typeof ROUTING_STEPS)[number];

// ==== M3: tools, approvals, policy, MCP, audit, notifications, diagnostics, artifacts ===========

export const TOOL_SOURCES = [
  'builtin',
  'mcp',
  'plugin',
  'computer',
  'browser',
  'page',
  'device',
] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];

export type ToolCallStatus =
  'pending' | 'awaiting_approval' | 'running' | 'ok' | 'error' | 'denied' | 'timeout' | 'cancelled';

export type ActionEffectClass =
  | 'external_communication'
  | 'purchase'
  | 'account_change'
  | 'credential_change'
  | 'data_delete'
  | 'file_write'
  | 'exec'
  | 'network'
  | 'install'
  | 'security_bypass'
  | 'captcha'
  | 'policy_change'
  | 'secret_access';

/** contracts/schemas/tool-descriptor.json, as listed by the Hub. */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  source: ToolSource;
  serverId?: string;
  pluginId?: string;
  deviceId?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  loading?: 'always' | 'deferrable';
  deferred?: boolean;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    idempotent?: boolean;
    requiresNetwork?: boolean;
    requiresUser?: boolean;
    costClass?: 'free' | 'metered';
    action?: 'read' | 'write' | 'send' | 'delete' | 'execute';
  };
  effects?: ActionEffectClass[];
  timeoutMs?: number;
}

export type PolicyEffect = 'allow' | 'ask' | 'handoff' | 'deny';
export type ConfirmationTier = 'handoff_required' | 'confirm_at_action' | 'pre_approvable';

/** A tool as Settings shows it: descriptor plus its default and the effective decision (FR-048). */
export interface ToolView extends ToolDescriptor {
  /** The per-tool default the user set, or null for the built-in default. */
  userDefault: 'allow' | 'ask' | 'deny' | null;
  /** What the engine would decide for a plain call in a chat now (preview, no side effects). */
  effective: { effect: PolicyEffect; reason: string; tier: ConfirmationTier };
}

export const toolDefaultSchema = z.object({
  tool: z.string().min(1).max(200),
  default: z.enum(['allow', 'ask', 'deny']).nullable(),
});

// ---- approvals (FR-100; contracts/schemas/approval-decision.json) ------------------------------

export const APPROVAL_DECISIONS = [
  'allow_once',
  'allow_session',
  'allow_always',
  'deny_continue',
  'deny_stop',
  'handoff',
] as const;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISIONS)[number] | 'timeout';

export interface ApprovalView {
  id: string;
  threadId: string | null;
  turnId: string | null;
  callId: string | null;
  /** Human-readable action, e.g. "Write notes/plan.md". */
  action: string;
  tool: string | null;
  /** Redacted arguments preview. */
  argsPreview: string | null;
  reason: string;
  tier: ConfirmationTier;
  risk: 'low' | 'medium' | 'high' | null;
  /** Whether the authenticated user asked for this action (intent provenance, FR-189). */
  userAsked: boolean;
  ruleId: string | null;
  /** Which decisions the card may offer (tier and managed policy decide). */
  options: ApprovalDecisionKind[];
  /** Suggested "Always allow" scopes, ready to send back as `alwaysScope`. */
  alwaysScopes: (
    | { kind: 'tool'; label: string; tool: string }
    | {
        kind: 'prefix_rule';
        label: string;
        rule: {
          pattern: (string | string[])[];
          matchExamples: string[];
          notMatchExamples: string[];
        };
      }
    | { kind: 'host'; label: string; host: string }
  )[];
  status: 'pending' | 'decided' | 'expired' | 'cancelled';
  decision: ApprovalDecisionKind | null;
  decidedBy: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

/** contracts/schemas/approval-decision.json as a client sends it; the Hub sets decidedBy/At. */
export const decideApprovalSchema = z
  .object({
    approvalId: idSchema,
    decision: z.enum(APPROVAL_DECISIONS),
    alwaysScope: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('tool'), tool: z.string().min(1).max(200) }),
        z.object({
          kind: z.literal('prefix_rule'),
          rule: z.object({
            pattern: z
              .array(z.union([z.string(), z.array(z.string()).min(1)]))
              .min(1)
              .max(20),
            matchExamples: z.array(z.string().max(1000)).max(20).optional(),
            notMatchExamples: z.array(z.string().max(1000)).max(20).optional(),
          }),
        }),
        z.object({ kind: z.literal('host'), host: z.string().min(1).max(253) }),
      ])
      .optional(),
    reason: z.string().max(2000).optional(),
    override: z.boolean().optional(),
    /** A shorter lifetime for allow_session / allow_always grants (docs/12 §4.2). */
    expiresInMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 365)
      .optional(),
  })
  .refine((v) => v.decision !== 'allow_always' || v.alwaysScope, {
    message: 'allow_always needs an alwaysScope',
  });
export type DecideApprovalRequest = z.infer<typeof decideApprovalSchema>;

/** POST /approvals/:id/handoff-done: the user finished the handed-off step. */
export const handoffDoneSchema = z.object({ note: z.string().max(2000).optional() });

// ---- rules, grants, profiles (FR-084 partial, FR-190, FR-191) ----------------------------------

export interface PolicyRuleView {
  id: string;
  scopeKind: 'global' | 'project' | 'thread' | 'tool' | 'site';
  scopeRef: string | null;
  /** contracts/schemas/policy-rule.json matcher. */
  match: { tool?: string; resource?: string; effects?: ActionEffectClass[] };
  effect: PolicyEffect;
  label: string | null;
  priority: number;
  source: 'user' | 'managed' | 'plugin';
  enabled: boolean;
  createdAt: string;
}

export interface CommandRuleView {
  id: string;
  scopeKind: 'global' | 'project' | 'thread' | 'session' | 'agent';
  scopeRef: string | null;
  /** Token prefix; each element a literal or a list of alternatives (contracts/schemas/command-rule.json). */
  pattern: (string | string[])[];
  decision: 'allow' | 'ask' | 'deny';
  justification: string | null;
  matchExamples: string[];
  notMatchExamples: string[];
  priority: number;
  source: 'user' | 'managed' | 'plugin';
  enabled: boolean;
  createdAt: string;
}

export interface PermissionGrantView {
  id: string;
  duration: 'session' | 'always';
  /** What the grant allows, e.g. "Tool fs.write" or "Commands starting with npm test". */
  label: string;
  tool: string | null;
  host: string | null;
  commandRuleId: string | null;
  scopeKind: string | null;
  scopeRef: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface PermissionProfileView {
  id: string;
  name: string;
  builtin: boolean;
  fs: { path: string; access: 'read' | 'write' | 'deny' }[];
  network: { mode: 'off' | 'allowlist' | 'limited'; allow: string[]; deny: string[] };
  requiresSubstrate: 'vm_or_container' | null;
  hash: string;
}

export const evaluatePreviewSchema = z.object({
  tool: z.string().min(1).max(200),
  args: z.unknown().optional(),
  threadId: idSchema.optional(),
  /** Preview as if the user typed the instruction (true) or as if it came from a tool (false). */
  userAsked: z.boolean().default(true),
});

export interface PolicyPreview {
  effect: PolicyEffect;
  tier: ConfirmationTier;
  reason: string;
  source: string;
  ruleId: string | null;
}

// ---- MCP servers (FR-042, FR-043; contracts/schemas/mcp-config.json) ---------------------------

export type McpTransport = 'stdio' | 'sse' | 'http';
export type McpStatus = 'disabled' | 'starting' | 'connected' | 'error' | 'stopped';

export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  /** Names of environment variables whose values live in the vault (never the values). */
  envKeys: string[];
  enabled: boolean;
  status: McpStatus;
  lastError: string | null;
  protocolVersion: string | null;
  serverInfo: { name: string; version: string } | null;
  counts: { tools: number; resources: number; prompts: number };
  toolTimeoutMs: number;
  startupTimeoutMs: number;
  defaultApproval: 'allow' | 'ask' | 'deny' | null;
  enabledTools: string[] | null;
  disabledTools: string[];
  createdAt: string;
  updatedAt: string;
}

export const mcpServerSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]{1,40}$/),
    transport: z.enum(['stdio', 'sse', 'http']),
    command: z.string().min(1).max(500).optional(),
    args: z.array(z.string().max(1000)).max(50).optional(),
    url: z.string().url().max(2000).optional(),
    /** Values go to the vault; only the names are stored. */
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)).optional(),
    enabled: z.boolean().optional(),
    toolTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
    startupTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
    defaultApproval: z.enum(['allow', 'ask', 'deny']).nullable().optional(),
    enabledTools: z.array(z.string().max(200)).nullable().optional(),
    disabledTools: z.array(z.string().max(200)).optional(),
  })
  .refine((v) => (v.transport === 'stdio' ? !!v.command : !!v.url), {
    message: 'stdio needs a command; sse and http need a url',
  });
export type McpServerRequest = z.input<typeof mcpServerSchema>;

export interface McpLogLine {
  ts: string;
  stream: 'stderr' | 'protocol' | 'status';
  text: string;
}

// ---- audit & activity (FR-104 partial) ----------------------------------------------------------

export interface AuditEntryView {
  id: string;
  actor: string;
  kind: string;
  action: string;
  resource: string | null;
  decision: string | null;
  result: string | null;
  threadId: string | null;
  turnId: string | null;
  createdAt: string;
  hash: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  /** The first entry whose hash does not match, when the chain is broken. */
  brokenAt: string | null;
}

/** One line of a thread's activity trace (tool calls, approvals, policy decisions, turns). */
export interface ActivityItemView {
  id: string;
  ts: string;
  kind: 'turn' | 'tool_call' | 'approval' | 'policy' | 'notice';
  title: string;
  detail: string | null;
  status: string | null;
  callId: string | null;
  turnId: string | null;
}

// ---- notifications (FR-013) ---------------------------------------------------------------------

export const NOTIFICATION_KINDS = [
  'approval',
  'completion',
  'error',
  'attention',
  'system',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  /** Where clicking it goes, e.g. `/chat/<id>?m=<messageId>` or `/approvals/<id>`. */
  href: string | null;
  read: boolean;
  createdAt: string;
}

// ---- logs & diagnostics (FR-118, FR-043) --------------------------------------------------------

export interface LogEntryView {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  msg: string;
  /** Redacted structured fields. */
  fields: Record<string, unknown>;
}

export interface DiagnosticsSnapshot {
  hub: {
    version: string;
    uptimeSeconds: number;
    dataDir: string;
    encryptedAtRest: EncryptionStatus;
  };
  providers: { id: string; label: string; status: string }[];
  nodes: { id: string; name: string; status: string }[];
  mcp: { id: string; name: string; status: McpStatus; lastError: string | null }[];
  sandbox: { substrate: SandboxSubstrate | null; available: boolean; detail: string };
  secrets: { backend: 'keychain' | 'vault' | 'memory'; detail: string };
  warnings: string[];
}

export type SandboxSubstrate = 'os_sandbox' | 'container' | 'micro_vm' | 'cloud';

export interface EncryptionStatus {
  /** Blobs and backups are encrypted with the Hub data key (ADR-090). */
  blobs: boolean;
  /** Whether the data directory sits on an encrypted volume, when it can be told. */
  volume: 'encrypted' | 'unencrypted' | 'unknown';
}

// ---- artifacts (FR-038) --------------------------------------------------------------------------

export type ArtifactKind =
  'markdown' | 'code' | 'html' | 'image' | 'svg' | 'chart' | 'pdf' | 'file';

export interface ArtifactView {
  id: string;
  threadId: string | null;
  messageId: string | null;
  kind: ArtifactKind;
  title: string | null;
  mime: string;
  /** Language for code artifacts. */
  language: string | null;
  version: number;
  live: boolean;
  size: number;
  createdAt: string;
  updatedAt: string;
}

// ---- mentions (FR-022) ----------------------------------------------------------------------------

export type MentionKind = 'file' | 'folder' | 'mcp_server' | 'tool' | 'skill';

export interface MentionCandidate {
  kind: MentionKind;
  /** Stable reference sent back with the message, e.g. `file:<root>/<path>` or `mcp:<server>`. */
  ref: string;
  label: string;
  detail: string | null;
}

// ---- memory consolidation (FR-204, FR-205) --------------------------------------------------------

export interface ConsolidationRunView {
  id: string;
  scopeKind: 'global' | 'project';
  scopeRef: string | null;
  phase: 'extract' | 'consolidate';
  status: 'running' | 'completed' | 'failed';
  threadsScanned: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsAged: number;
  summaryTokens: number | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface MemorySummaryView {
  scopeKind: 'global' | 'project';
  scopeRef: string | null;
  summary: string | null;
  summaryTokens: number;
  runId: string | null;
  updatedAt: string | null;
}

export const memoryTopicSchema = z.object({
  topic: z.string().trim().min(1).max(100),
  preference: z.enum(['more', 'less', 'default']),
});
