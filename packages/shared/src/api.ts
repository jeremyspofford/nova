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

/** A model is addressed as `<providerAccountId>/<modelId>`. */
export type ModelRef = string;

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
  providerAccountId: string;
  provider: ProviderKind;
  modelId: string;
  label: string;
  reasoning: boolean;
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
  createdAt: string;
  updatedAt: string;
}

export const createThreadSchema = z.object({
  mode: threadModeSchema.default('chat'),
  title: z.string().max(300).optional(),
  projectId: idSchema.optional(),
  model: z.string().max(300).optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  temporary: z.boolean().optional(),
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
}

export interface ThreadDetail {
  thread: ThreadView;
  messages: MessageView[];
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
});
export type SendMessageRequest = z.infer<typeof sendMessageSchema>;

export interface SendMessageResponse {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  threadTitle: string | null;
  snippet: string;
  createdAt: string;
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
