// M7 flagged features: scripted tool calls (FR-202) and external agent adapters (FR-203). Both are
// off by default (`scripts.enabled`, `externalAgents.enabled`); their routes answer 404 while off.
// Also the MCP server fields this area adds in M7 (FR-042 `deviceId`, `auth`, `oauth`).
import { z } from 'zod';
import { idSchema, mcpServerSchema, type ToolCallStatus } from '../api.ts';
import { hostPatternSchema } from '../m6/computers.ts';

// ---- scripted tool calls (FR-202) ----------------------------------------------------------------

/** One tool call a script made: a tool call of its own, with the script's call as its parent. */
export interface ScriptNestedCallView {
  callId: string;
  tool: string;
  status: ToolCallStatus;
  /** The gate's decision (allow, deny, handoff), null before it decided. */
  decision: string | null;
  approvalId: string | null;
  createdAt: string;
  durationMs: number | null;
}

/** A `script.run` call: its id is the tool call's. The code itself is kept only as a hash. */
export interface ScriptRunView {
  id: string;
  threadId: string | null;
  turnId: string | null;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  /** `cpu_limit`, `memory_limit`, `stack_limit`, `syntax_error`, `script_error`, ... */
  errorCode: string | null;
  calls: number;
  cpuMs: number;
  codeSha256: string;
  createdAt: string;
  endedAt: string | null;
  nested: ScriptNestedCallView[];
}

/**
 * `GET /api/v1/scripts/runs`: one thread's runs (`threadId`) or the account's across threads,
 * newest first; `cursor` is the previous page's `nextCursor`.
 */
export const scriptRunsQuerySchema = z
  .object({
    threadId: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().min(1).max(300).optional(),
  })
  .strict();
export type ScriptRunsQuery = z.input<typeof scriptRunsQuerySchema>;

/** A page of script runs (without their nested calls); null `nextCursor` on the last page. */
export interface ScriptRunsPageView {
  items: Omit<ScriptRunView, 'nested'>[];
  nextCursor: string | null;
}

// ---- external agent adapters (FR-203) ------------------------------------------------------------

/** How an adapter handles permission: only `client` (every request routed to Nova) is accepted. */
export const PERMISSION_ROUTINGS = ['client', 'agent'] as const;
export type PermissionRouting = (typeof PERMISSION_ROUTINGS)[number];

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'an environment variable name');
// A program name or absolute path; arguments go in `args`, so no shell syntax is ever needed.
const commandSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9_./@+-]+$/, 'a program name or path without spaces or shell syntax');

export const createAgentAdapterSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    command: commandSchema,
    args: z.array(z.string().max(1000)).max(50).default([]),
    /** Values are `secret://` references or secrets to store in the vault (never kept in rows). */
    env: z.record(envName, z.string().max(10_000)).default({}),
    /** Hosts the agent's process may reach (its model service), through the egress allowlist. */
    network: z.array(hostPatternSchema).max(20).default([]),
    /** `agent` (the agent decides on its own) is refused: Nova must decide every request. */
    permissionRouting: z.enum(PERMISSION_ROUTINGS),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateAgentAdapterRequest = z.input<typeof createAgentAdapterSchema>;

export const updateAgentAdapterSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    args: z.array(z.string().max(1000)).max(50).optional(),
    /** Replaces the environment; an empty string keeps a variable's saved secret. */
    env: z.record(envName, z.string().max(10_000)).optional(),
    network: z.array(hostPatternSchema).max(20).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateAgentAdapterRequest = z.input<typeof updateAgentAdapterSchema>;

/** The last handshake with an adapter's agent. */
export interface AgentAdapterCheck {
  ok: boolean;
  at: string;
  agent: { name: string | null; version: string | null } | null;
  protocolVersion: number | null;
  /** Why it was refused or failed. */
  reason: string | null;
}

export interface AgentAdapterView {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Variable names to `secret://` references; values never leave the vault. */
  env: Record<string, string>;
  network: string[];
  permissionRouting: 'client';
  enabled: boolean;
  lastCheck: AgentAdapterCheck | null;
  createdAt: string;
  updatedAt: string;
}

export const createDelegationSchema = z
  .object({
    adapterId: idSchema,
    prompt: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type CreateDelegationRequest = z.infer<typeof createDelegationSchema>;

export const DELEGATION_STATUSES = [
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

export interface DelegationView {
  id: string;
  threadId: string;
  adapterId: string;
  adapterName: string | null;
  status: DelegationStatus;
  prompt: string;
  /** The agent's reply text, redacted and capped. */
  output: string | null;
  /** The agent's stop reason (`end_turn`, `max_tokens`, `refusal`, `cancelled`, ...). */
  stopReason: string | null;
  error: string | null;
  agent: { name: string | null; version: string | null } | null;
  permissionRequests: number;
  operations: number;
  createdAt: string;
  endedAt: string | null;
}

export const delegationsQuery = z.object({ threadId: idSchema }).strict();

// ---- MCP server fields that arrive in M7 (FR-042, FR-047; contracts/schemas/mcp-config.json) --------

/** OAuth settings of a remote server (docs/08 §2.1): a client metadata document or dynamic registration. */
export const mcpOAuthSettingsSchema = z
  .object({
    clientMetadataUrl: z
      .url({ protocol: /^https$/ })
      .max(2000)
      .optional(),
    dynamicRegistration: z.boolean().optional(),
    scopes: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .strict()
  .refine((o) => !(o.clientMetadataUrl && o.dynamicRegistration === true), {
    message: 'use a client metadata document or dynamic registration, not both',
  });
export type McpOAuthSettings = z.infer<typeof mcpOAuthSettingsSchema>;

const mcpServerM7Fields = {
  /** Run this stdio server on a device through `novad`; `command` names it as the device lists it. */
  deviceId: idSchema.nullable().optional(),
  /** An API key or bearer token for sse/http servers: the value goes to the vault; '' keeps it. */
  auth: z.string().max(10_000).nullable().optional(),
  oauth: mcpOAuthSettingsSchema.nullable().optional(),
};

/** What M7 adds to a server's checks: device servers are stdio; auth and OAuth are remote. */
function checkMcpServerM7(
  v: {
    transport?: string;
    command?: string;
    url?: string;
    deviceId?: string | null;
    auth?: string | null;
    oauth?: McpOAuthSettings | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (v.transport === 'stdio' ? !v.command : !v.url)
    ctx.addIssue({ code: 'custom', message: 'stdio needs a command; sse and http need a url' });
  if (v.deviceId && v.transport !== 'stdio')
    ctx.addIssue({
      code: 'custom',
      path: ['deviceId'],
      message: 'only stdio servers run on a device',
    });
  if ((v.auth || v.oauth) && v.transport === 'stdio')
    ctx.addIssue({
      code: 'custom',
      path: ['auth'],
      message: 'auth and oauth are for sse and http servers',
    });
  if (v.auth && v.oauth)
    ctx.addIssue({ code: 'custom', path: ['auth'], message: 'use an API key or OAuth, not both' });
}

/** `POST /mcp/servers` with the M7 fields (`deviceId`, `auth`, `oauth`). */
export const mcpServerM7Schema = z
  .object({ ...mcpServerSchema.shape, ...mcpServerM7Fields })
  .superRefine(checkMcpServerM7);
export type McpServerM7Request = z.input<typeof mcpServerM7Schema>;

/** `PATCH /mcp/servers/:id`: any field; the merged server is checked with `mcpServerM7Schema`. */
export const mcpServerPatchM7Schema = z
  .object({ ...mcpServerSchema.shape, ...mcpServerM7Fields })
  .partial();

/** The M7 fields of a server's view. The token itself never leaves the vault. */
export interface McpServerM7View {
  deviceId: string | null;
  hasAuth: boolean;
  oauthSettings: McpOAuthSettings | null;
}
