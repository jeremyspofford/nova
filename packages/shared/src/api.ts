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
  | { type: 'file'; attachmentId: string; name: string; mime: string; size: number };

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

export const sendMessageSchema = z.object({
  text: z.string().max(200_000),
  attachments: z.array(attachmentInputSchema).max(ATTACHMENT_LIMITS.maxCount).optional(),
  model: z.string().max(300).optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  /** Overrides the `general.followUp` setting for this message while a turn runs (FR-019). */
  inputMode: inputModeSchema.optional(),
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
  sourceKind: 'chat' | 'consolidation' | 'import' | 'manual';
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
