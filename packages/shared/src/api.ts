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
  /** The active account of its provider kind (FR-115); the others stay configured. */
  active?: boolean;
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
  /**
   * How a user message entered the turn: typed, a steer of a running turn, a queued send, or a
   * lifecycle hook's continuation (FR-197), which is not the user's and carries no authority.
   */
  provenance?: 'typed' | 'steer' | 'queued' | 'hook';
  /** The `@`-mentions sent with a user message (FR-022). */
  mentions?: { kind: MentionKind; ref: string; label: string }[];
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
  /** `plan` for a dated intention; `past_event` once its date has passed (FR-204 aging). */
  kind: 'plan' | 'past_event' | null;
  /** When a plan stops being upcoming. */
  validUntil: string | null;
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
  /** An MCP Apps resource that renders this tool (FR-198). */
  ui?: { resourceUri: string };
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
  /** The matched rule's label, when it has one. */
  ruleLabel?: string | null;
  /** Managed policy turned persistent grants off: show "Always allow" disabled, marked Managed. */
  alwaysAllowManaged?: boolean;
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
  /** The per-tool default the user set, when the preview is for a tool (FR-048). */
  userDefault?: 'allow' | 'ask' | 'deny' | null;
}

// ---- MCP servers (FR-042, FR-043; contracts/schemas/mcp-config.json) ---------------------------

export type McpTransport = 'stdio' | 'sse' | 'http';
export type McpStatus = 'disabled' | 'starting' | 'connected' | 'error' | 'stopped';

export interface McpServerView {
  id: string;
  /** How the server authenticates (FR-047), for http/sse servers. */
  auth?: McpAuthView;
  /** Installed from a bundle (FR-199): its signature state. */
  bundle?: { name: string; version: string; signature: 'verified' | 'unverified' } | null;
  /** When the current connection was made, and automatic restarts in the last 10 minutes (FR-043). */
  connectedAt?: string | null;
  restarts?: number;
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
  /** Further probes other areas register (e.g. `memoryConsolidation`), by name. */
  probes?: Record<string, unknown>;
}

export type SandboxSubstrate = 'os_sandbox' | 'container' | 'micro_vm' | 'cloud';

export interface EncryptionStatus {
  /** Attachment, source and artifact blobs are encrypted with the Hub data key (ADR-090). */
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

// ==== M4: plugins, skills, hooks, Nova's MCP server, bundles, MCP Apps, workspace, profile ======

// ---- plugins (FR-045; contracts/schemas/plugin-manifest.json) ---------------------------------

export type PluginSource = 'local' | 'catalog' | 'git';

export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  source: PluginSource;
  /** Where it came from: a folder, a catalog id or a Git URL. */
  origin: string;
  enabled: boolean;
  /** Signed by a trusted publisher (N3); local plugins are unverified. */
  verified: boolean;
  /** The manifest's `permissions` block as confirmed at install. */
  permissions: Record<string, unknown>;
  components: {
    skills: number;
    commands: number;
    agents: number;
    hooks: number;
    mcpServers: number;
    uiEntryPoints: number;
  };
  status: 'ok' | 'needs_trust' | 'disabled' | 'error';
  error: string | null;
  installedAt: string;
  updatedAt: string;
}

/** What installing would do, shown before anything is installed (FR-045, FR-197). */
export interface PluginPreview {
  previewId: string;
  manifest: Record<string, unknown>;
  permissions: Record<string, unknown>;
  hooks: HookView[];
  mcpServers: {
    name: string;
    transport: McpTransport;
    command: string | null;
    url: string | null;
  }[];
  skills: { name: string; description: string }[];
  verified: boolean;
  warnings: string[];
  /** Set when a plugin with this id is installed: the update replaces it. */
  replaces: { version: string } | null;
}

export const pluginSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), path: z.string().min(1).max(1000) }),
  z.object({
    kind: z.literal('catalog'),
    catalogId: z.string().min(1).max(200),
    pluginId: z.string().min(1).max(200),
    version: z.string().max(50).optional(),
  }),
  z.object({
    kind: z.literal('git'),
    url: z.string().url().max(1000),
    ref: z.string().max(200).optional(),
  }),
]);

export const installPluginSchema = z.object({
  previewId: idSchema,
  /** Required to install a plugin that is not verified (every plugin until signing lands, M8). */
  confirmSideload: z.boolean().optional(),
  enable: z.boolean().default(true),
  /** Hooks to trust now, by id with the hash shown in the preview (FR-197). */
  trustHooks: z
    .array(z.object({ id: z.string().max(300), contentHash: z.string().max(200) }))
    .max(50)
    .optional(),
});

export interface CatalogView {
  id: string;
  name: string;
  /** A folder on the Hub, an https URL or a Git URL (docs/14 §5). */
  location: string;
  kind: 'local' | 'url' | 'git';
}

export interface CatalogEntryView {
  catalogId: string;
  pluginId: string;
  name: string;
  version: string;
  description: string | null;
  verified: boolean;
  installedVersion: string | null;
}

// ---- skills and slash commands (FR-046) ---------------------------------------------------------

export type SkillSource = 'builtin' | 'user' | 'project' | 'plugin' | 'managed' | 'import';

export interface SkillView {
  /** `skill:<source or pluginId>:<name>`. */
  id: string;
  name: string;
  description: string;
  whenToUse: string | null;
  allowedTools: string[];
  modelHint: string | null;
  source: SkillSource;
  pluginId: string | null;
  projectId: string | null;
  enabled: boolean;
  /** Another skill with the same name wins by precedence (managed > project > user > plugin > built-in). */
  shadowedBy: string | null;
  updatedAt: string;
}

export interface SkillDetail extends SkillView {
  body: string;
  files: string[];
}

export const createSkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  description: z.string().min(1).max(1024),
  whenToUse: z.string().max(1024).optional(),
  allowedTools: z.array(z.string().max(200)).max(50).optional(),
  body: z.string().min(1).max(200_000),
  projectId: idSchema.optional(),
});

/** A `/name` the composer can complete: a skill or a plugin command (FR-046). */
export interface SlashCommandView {
  name: string;
  description: string;
  skillId: string;
  source: SkillSource;
  pluginId: string | null;
}

// ---- hooks (FR-197; contracts/schemas/hook-config.json) --------------------------------------

export type HookEvent =
  | 'session.start'
  | 'session.end'
  | 'prompt.submit'
  | 'tool.pre'
  | 'permission.request'
  | 'tool.post'
  | 'compact.pre'
  | 'compact.post'
  | 'subagent.start'
  | 'subagent.stop'
  | 'stop'
  | 'interrupt';

export interface HookView {
  id: string;
  source: 'managed' | 'user' | 'project' | 'plugin' | 'extension';
  pluginId: string | null;
  event: HookEvent;
  matcher: string | null;
  /** `command` with its argv, or `mcp_tool` with its tool name. */
  handler: { type: 'command'; command: string[] } | { type: 'mcp_tool'; tool: string };
  timeoutMs: number;
  contentHash: string;
  status: 'trusted' | 'needs_trust' | 'disabled' | 'revoked';
  enabled: boolean;
  lastRun: {
    at: string;
    effect: 'none' | 'context' | 'decision' | 'continue' | 'blocked' | 'error';
  } | null;
  /** A project hook's project. */
  projectId?: string | null;
  /** The content changed after it was trusted, so it waits for re-trust (docs/04 §2.10). */
  changedSinceTrust?: boolean;
}

export const trustHookSchema = z.object({ contentHash: z.string().min(1).max(200) });

// ---- Nova's MCP server and app authorizations (FR-044, FR-192, FR-222) -------------------------

export interface AppAuthorizationView {
  id: string;
  kind: 'mcp_client' | 'app';
  clientName: string;
  scopes: {
    /** Tool names the client may call, or `*` for every allowed tool. */
    tools: string[] | '*';
    projects: string[] | '*';
    threads: 'none' | 'read' | 'read_write';
    mode: 'read_only' | 'run_allowed';
  };
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export const createAppAuthorizationSchema = z.object({
  kind: z.literal('mcp_client'),
  clientName: z.string().trim().min(1).max(100),
  scopes: z.object({
    tools: z.union([z.literal('*'), z.array(z.string().max(200)).max(200)]),
    projects: z.union([z.literal('*'), z.array(idSchema).max(200)]),
    threads: z.enum(['none', 'read', 'read_write']),
    mode: z.enum(['read_only', 'run_allowed']),
  }),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export interface AppAuthorizationCreated {
  authorization: AppAuthorizationView;
  /** Shown once; Nova keeps only its hash. */
  token: string;
  /** The URL external clients use (streamable HTTP). */
  endpoint: string;
}

// ---- MCP bundles (FR-199; contracts/schemas/mcp-bundle-manifest.json) --------------------------

export interface BundleConfigField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file';
  title: string;
  description: string | null;
  required: boolean;
  sensitive: boolean;
  multiple: boolean;
  default: unknown;
}

export interface BundlePreview {
  previewId: string;
  name: string;
  displayName: string | null;
  version: string;
  description: string;
  author: string | null;
  serverType: 'node' | 'python' | 'uv' | 'binary';
  signature: 'verified' | 'unverified';
  /** Proposed permissions (network hosts, filesystem access) the user confirms. */
  permissions: { network: string[]; fs: 'none' | 'read' | 'project' };
  userConfig: BundleConfigField[];
  tools: { name: string; description: string | null }[];
  warnings: string[];
}

export const installBundleSchema = z.object({
  previewId: idSchema,
  permissions: z.object({
    network: z.array(z.string().max(253)).max(50),
    fs: z.enum(['none', 'read', 'project']),
  }),
  userConfig: z.record(z.string(), z.unknown()).default({}),
  confirmSideload: z.boolean().optional(),
});

// ---- connectors and OAuth (FR-047) ------------------------------------------------------------

export interface McpAuthView {
  kind: 'none' | 'api_key' | 'oauth';
  status: 'connected' | 'needs_auth' | 'expired' | 'error';
  expiresAt: string | null;
  scopes: string[];
}

// ---- MCP Apps (FR-198) --------------------------------------------------------------------------

export interface UiEntryPointView {
  id: string;
  kind: 'global' | 'thread' | 'file';
  title: string;
  serverId: string;
  pluginId: string | null;
  /** The `ui://` resource. */
  resource: string;
  /** File extensions, for file entry points. */
  extensions: string[];
  /** The external hosts the app may reach (resource CSP domains ∩ its permissions). */
  domains?: string[];
}

// ---- workspace: files, terminal, layout, library (FR-005, FR-006, FR-039, FR-041) ------------

export interface FileEntryView {
  /** Path relative to the root. */
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number | null;
  mime: string | null;
  modifiedAt: string | null;
}

export interface FileContentView {
  root: string;
  path: string;
  mime: string;
  size: number;
  /** For text files; binary files are fetched from `/files/raw`. */
  text: string | null;
  /** Pass back on save; a changed file is refused with `conflict`. */
  sha256: string;
  readOnly: boolean;
}

export const saveFileSchema = z.object({
  root: z.string().min(1).max(1000),
  path: z.string().min(1).max(1000),
  text: z.string().max(5_000_000),
  baseSha256: z.string().max(100).nullable(),
});

export interface TerminalView {
  id: string;
  threadId: string | null;
  cwd: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  createdAt: string;
}

export const createTerminalSchema = z.object({
  root: z.string().max(1000).optional(),
  threadId: idSchema.optional(),
  cols: z.number().int().min(10).max(500).default(100),
  rows: z.number().int().min(5).max(200).default(30),
});

export type LibraryKind = 'artifact' | 'attachment' | 'source' | 'image' | 'file';

export interface LibraryItemView {
  kind: LibraryKind;
  id: string;
  title: string;
  mime: string | null;
  size: number | null;
  threadId: string | null;
  projectId: string | null;
  /** Where it opens in the app. */
  href: string;
  createdAt: string;
}

// ---- local project folders (FR-035) -----------------------------------------------------------

export interface ProjectFolderView {
  id: string;
  projectId: string;
  path: string;
  access: 'read' | 'write';
  status: 'indexing' | 'ready' | 'error';
  fileCount: number;
  error: string | null;
  indexedAt: string | null;
}

export const addProjectFolderSchema = z.object({
  path: z.string().min(1).max(1000),
  access: z.enum(['read', 'write']).default('read'),
});

// ---- profile, usage and accounts (FR-113, FR-114, FR-115) -------------------------------------

export interface AccountView {
  accountId: string;
  displayName: string | null;
  username: string | null;
  /** Fetched from `/account/avatar`; null without one. */
  hasAvatar: boolean;
  createdAt: string;
}

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().max(100).nullable().optional(),
    username: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{1,31}$/)
      .nullable()
      .optional(),
    /** A PNG, JPEG or WebP data as base64 (≤ 2 MB), or null to remove it. */
    avatar: z
      .object({
        mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        data: z.string().max(3_000_000),
      })
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export interface UsageSummary {
  from: string;
  to: string;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
    turns: number;
  };
  byModel: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    turns: number;
  }[];
  byProject: {
    projectId: string | null;
    name: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[];
  byDay: { day: string; inputTokens: number; outputTokens: number; costUsd: number }[];
  activeDays: number;
  /** Consecutive active days ending today. */
  streak: number;
  longestTurn: { threadId: string; turnId: string; seconds: number } | null;
}

// ---- import from other assistants (FR-200) ----------------------------------------------------

export type ImportKind =
  | 'instructions'
  | 'skills'
  | 'commands'
  | 'plugins'
  | 'mcp_servers'
  | 'projects'
  | 'memories'
  | 'chats';

export const importPreviewSchema = z.object({
  /** Folders or files on the Hub to scan. */
  paths: z.array(z.string().min(1).max(1000)).min(1).max(20),
  kinds: z
    .array(
      z.enum([
        'instructions',
        'skills',
        'commands',
        'plugins',
        'mcp_servers',
        'projects',
        'memories',
        'chats',
      ]),
    )
    .min(1),
});

export interface ImportItemView {
  id: string;
  kind: ImportKind;
  name: string;
  sourcePath: string;
  /** What it becomes in Nova, e.g. "skill review-pr" or "MCP server github (disabled)". */
  target: string;
  sha256: string;
  status: 'new' | 'duplicate' | 'conflict' | 'unsupported';
  /** Secrets found, masked; they move to the vault on apply. */
  maskedSecrets: string[];
  note: string | null;
}

export interface ImportPreview {
  previewId: string;
  items: ImportItemView[];
}

export const importApplySchema = z.object({
  previewId: idSchema,
  items: z.array(z.string().max(200)).min(1).max(1000),
});

export interface ImportResult {
  importId: string;
  imported: number;
  duplicates: number;
  disabled: number;
  secretsMigrated: number;
}

export interface ImportRecordView {
  id: string;
  kind: ImportKind;
  sourcePath: string;
  sha256: string;
  target: string;
  createdAt: string;
}
