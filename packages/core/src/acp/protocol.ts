// The subset of the Agent Client Protocol (version 1; JSON-RPC 2.0 over stdio) Nova implements as
// a client (FR-203). No copy of the protocol's schema is available offline, so this is the
// documented subset Nova needs, written from the protocol's public description:
//
//   Nova → agent:  initialize, session/new, session/prompt, session/cancel (notification)
//   agent → Nova:  session/update (notification), session/request_permission, fs/read_text_file,
//                  fs/write_text_file, terminal/create, terminal/output, terminal/wait_for_exit,
//                  terminal/kill, terminal/release
//
// Not implemented: authenticate, session/load, session/set_mode, MCP servers passed to the agent,
// images and resources in prompts. Unknown fields are ignored (the protocol allows `_meta`
// extensions); everything the agent sends is validated here before Nova acts on it.
import { z } from 'zod';

export const ACP_PROTOCOL_VERSION = 1;

const text = (max: number) => z.string().max(max);

export const initializeResultSchema = z.object({
  protocolVersion: z.number().int(),
  agentCapabilities: z.record(z.string(), z.unknown()).optional(),
  authMethods: z
    .array(z.object({ id: text(200) }).passthrough())
    .max(50)
    .optional(),
  agentInfo: z
    .object({ name: text(200).optional(), version: text(100).optional() })
    .passthrough()
    .optional(),
});
export type InitializeResult = z.infer<typeof initializeResultSchema>;

export const newSessionResultSchema = z.object({ sessionId: z.string().min(1).max(200) });

export const STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export const promptResultSchema = z.object({ stopReason: z.enum(STOP_REASONS) });

/** What a permission request or a tool call update is about. */
export const TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

const location = z
  .object({ path: text(4096), line: z.number().int().min(0).optional() })
  .passthrough();

export const toolCallSchema = z
  .object({
    toolCallId: text(200),
    title: text(2000).optional(),
    // An unknown kind is treated as `other`.
    kind: z.string().max(50).optional(),
    status: z.string().max(50).optional(),
    rawInput: z.unknown().optional(),
    locations: z.array(location).max(100).optional(),
  })
  .passthrough();
export type AcpToolCall = z.infer<typeof toolCallSchema>;

export const PERMISSION_OPTION_KINDS = [
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
] as const;

export const requestPermissionSchema = z.object({
  sessionId: text(200),
  toolCall: toolCallSchema,
  options: z
    .array(
      z
        .object({
          optionId: text(200),
          name: text(500).optional(),
          kind: z.string().max(50),
        })
        .passthrough(),
    )
    .min(1)
    .max(20),
});
export type PermissionRequest = z.infer<typeof requestPermissionSchema>;

export const readTextFileSchema = z.object({
  sessionId: text(200),
  path: z.string().min(1).max(4096),
  line: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(1_000_000).optional(),
});
export type ReadTextFileRequest = z.infer<typeof readTextFileSchema>;

export const writeTextFileSchema = z.object({
  sessionId: text(200),
  path: z.string().min(1).max(4096),
  content: z.string().max(5 * 1024 * 1024),
});
export type WriteTextFileRequest = z.infer<typeof writeTextFileSchema>;

export const createTerminalSchema = z.object({
  sessionId: text(200),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(200).optional(),
  env: z
    .array(z.object({ name: text(200), value: text(10_000) }))
    .max(100)
    .optional(),
  cwd: z.string().max(4096).nullish(),
  outputByteLimit: z.number().int().min(0).nullish(),
});
export type CreateTerminalRequest = z.infer<typeof createTerminalSchema>;

export const terminalRefSchema = z.object({ sessionId: text(200), terminalId: text(200) });

export const sessionUpdateSchema = z.object({
  sessionId: text(200),
  update: z.object({ sessionUpdate: z.string().max(100) }).passthrough(),
});
export type SessionUpdate = z.infer<typeof sessionUpdateSchema>['update'];

/** A plain-text prompt (the only content block Nova sends). */
export function textPrompt(t: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: t }];
}

/** The text of a content block the agent streams (`agent_message_chunk` and similar). */
export function contentText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as { type?: unknown; text?: unknown };
  return c.type === 'text' && typeof c.text === 'string' ? c.text : '';
}

export function toolKind(kind: string | undefined): ToolKind {
  return (TOOL_KINDS as readonly string[]).includes(kind ?? '') ? (kind as ToolKind) : 'other';
}
