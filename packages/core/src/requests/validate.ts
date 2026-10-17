// Payloads and answers of server-to-client requests per kind (FR-188;
// contracts/schemas/server-request.json `$defs`). A request is created only with a payload its
// kind allows, and an answer resolves it only when it is valid for that kind and payload
// (contracts/hub-api.md §5 rule 3). Approvals are answered through the approvals flow.
import { z } from 'zod';
import { NovaError, type ServerRequestKind } from '@nova/shared';

export type AskKind = Exclude<ServerRequestKind, 'approval'>;

const userInputPayload = z
  .object({
    question: z.string().trim().min(1).max(4000),
    choices: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    allowFreeText: z.boolean().optional(),
    /** The answer is long-form text (a multi-line field); see the contract note in the area. */
    multiline: z.boolean().optional(),
  })
  .strict();

const elicitationPayload = z
  .object({
    serverId: z.string().min(1).max(200),
    message: z.string().trim().min(1).max(4000),
    requestedSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

const clientToolPayload = z
  .object({
    tool: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

const credentialRefreshPayload = z
  .object({
    targetKind: z.enum(['provider_account', 'connector', 'mcp_server']),
    targetId: z.string().min(1).max(200),
    reason: z.string().max(500).optional(),
  })
  .strict();

const PAYLOADS = {
  user_input: userInputPayload,
  elicitation: elicitationPayload,
  client_tool: clientToolPayload,
  credential_refresh: credentialRefreshPayload,
} as const;

function invalid(err: z.ZodError, what: string): NovaError {
  return new NovaError('validation', `${what} is not valid for this request`, {
    details: {
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    },
  });
}

/** The payload a request of `kind` carries; throws `validation` when it does not fit. */
export function requestPayload(kind: AskKind, payload: unknown): Record<string, unknown> {
  const r = PAYLOADS[kind].safeParse(payload);
  if (!r.success) throw invalid(r.error, 'the request payload');
  return r.data;
}

const userInputResult = z.union([
  z.object({ text: z.string().max(20_000) }).strict(),
  z.object({ choice: z.string().max(200) }).strict(),
]);

const primitive = z.union([z.string().max(10_000), z.number(), z.boolean()]);
const elicitationResult = z
  .object({
    action: z.enum(['accept', 'decline', 'cancel']),
    content: z.record(z.string(), primitive).optional(),
  })
  .strict();

const clientToolResult = z.union([
  z.object({ ok: z.literal(true), output: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({ code: z.string().max(100).optional(), message: z.string().max(4000) })
        .strict(),
    })
    .strict(),
]);

const credentialRefreshResult = z.object({ refreshed: z.boolean() }).strict();

/**
 * Validate an answer against its request (contracts/hub-api.md §5 rule 3) and return the value
 * that resolves it; throws `validation`.
 */
export function requestResult(
  kind: AskKind,
  payload: Record<string, unknown>,
  result: unknown,
): Record<string, unknown> {
  switch (kind) {
    case 'user_input': {
      const r = userInputResult.safeParse(result);
      if (!r.success) throw invalid(r.error, 'the answer');
      const choices = Array.isArray(payload.choices) ? (payload.choices as string[]) : [];
      if ('choice' in r.data) {
        if (!choices.includes(r.data.choice))
          throw new NovaError('validation', 'the answer is not one of the offered choices', {
            details: { choices },
          });
        return { choice: r.data.choice };
      }
      if (choices.length > 0 && payload.allowFreeText === false)
        throw new NovaError('validation', 'pick one of the offered choices');
      const text = r.data.text.trim();
      if (!text) throw new NovaError('validation', 'the answer is empty');
      return { text };
    }
    case 'elicitation': {
      const r = elicitationResult.safeParse(result);
      if (!r.success) throw invalid(r.error, 'the answer');
      if (r.data.action !== 'accept') {
        if (r.data.content !== undefined)
          throw new NovaError('validation', 'only an accepted request carries content');
        return { action: r.data.action };
      }
      const content = r.data.content ?? {};
      checkElicitation(payload.requestedSchema, content);
      return { action: 'accept', content };
    }
    case 'client_tool': {
      const r = clientToolResult.safeParse(result);
      if (!r.success) throw invalid(r.error, 'the tool result');
      return r.data;
    }
    case 'credential_refresh': {
      const r = credentialRefreshResult.safeParse(result);
      if (!r.success) throw invalid(r.error, 'the answer');
      return r.data;
    }
  }
}

interface FieldSchema {
  type?: unknown;
  enum?: unknown;
}

/**
 * MCP elicitation asks for a flat object of primitive fields: every required field present, no
 * field the schema does not name, and each value of its declared type (and enum, if any).
 */
function checkElicitation(schema: unknown, content: Record<string, unknown>): void {
  const s = (schema ?? {}) as { properties?: unknown; required?: unknown };
  const props =
    s.properties && typeof s.properties === 'object'
      ? (s.properties as Record<string, FieldSchema>)
      : {};
  const required = Array.isArray(s.required) ? (s.required as unknown[]) : [];
  for (const key of required)
    if (typeof key === 'string' && !(key in content))
      throw new NovaError('validation', `the answer is missing ${key}`);
  for (const [key, value] of Object.entries(content)) {
    const field = Object.hasOwn(props, key) ? props[key] : undefined;
    if (!field) throw new NovaError('validation', `the request does not ask for ${key}`);
    const type = typeof field.type === 'string' ? field.type : null;
    const okType =
      type === null ||
      (type === 'string' && typeof value === 'string') ||
      (type === 'boolean' && typeof value === 'boolean') ||
      (type === 'number' && typeof value === 'number') ||
      (type === 'integer' && typeof value === 'number' && Number.isInteger(value));
    if (!okType) throw new NovaError('validation', `${key} must be a ${type ?? 'value'}`);
    if (Array.isArray(field.enum) && !field.enum.includes(value))
      throw new NovaError('validation', `${key} is not one of the allowed values`);
  }
}
