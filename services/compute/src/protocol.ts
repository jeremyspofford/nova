// Node side of the Hub ↔ node protocol (contracts/hub-api.md §2, ADR-089). The Hub's validator
// for the /node/v1 bodies the node sends lives in @nova/core (nodes/protocol.ts); this file holds
// what the node validates: the job requests the Hub submits.
import { z } from 'zod';
import type { ChatJobRequest } from './jobs.ts';

/** Protocol versions this node speaks; the Hub picks the highest common one. */
export const PROTOCOL_VERSIONS = [1];

const MAX_TEXT = 2_000_000;

const leafPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(MAX_TEXT) }),
  z.object({
    type: z.literal('image'),
    mime: z.string().max(100),
    data: z.string().max(40_000_000),
  }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string().max(200),
    name: z.string().max(200),
    args: z.unknown(),
  }),
]);

const contentPart = z.union([
  leafPart,
  z.object({
    type: z.literal('tool_result'),
    callId: z.string().max(200),
    content: z.array(leafPart).max(100),
    isError: z.boolean().optional(),
    untrusted: z.literal(true),
  }),
]);

const reasoningLevel = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const chatRequestSchema = z.object({
  model: z.string().min(1).max(300),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.array(contentPart).max(500),
      }),
    )
    .min(1)
    .max(5_000),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(10_000),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .max(500)
    .optional(),
  toolChoice: z
    .union([z.enum(['auto', 'none', 'required']), z.object({ name: z.string().max(200) })])
    .optional(),
  temperature: z.number().min(0).max(5).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().min(1).max(10_000_000).optional(),
  reasoning: z
    .union([
      z.object({ level: reasoningLevel }),
      z.object({ budgetTokens: z.number().int().min(0) }),
    ])
    .optional(),
  responseFormat: z
    .union([
      z.object({ type: z.literal('text') }),
      z.object({ type: z.literal('json_schema'), schema: z.unknown() }),
    ])
    .optional(),
  cacheHints: z
    .object({
      system: z.boolean().optional(),
      tools: z.boolean().optional(),
      history: z.boolean().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.string().max(1_000)).optional(),
});

export const jobSchema = z.object({
  kind: z.literal('chat'),
  request: chatRequestSchema,
});

export function parseJob(body: unknown): ChatJobRequest {
  // The schema mirrors ChatRequest without its signal.
  return jobSchema.parse(body).request;
}

// ---- bodies the node sends to the Hub ------------------------------------------------------

export interface RegisterBody {
  enrollToken: string;
  name: string;
  endpoint: string;
  publicKey: string;
  capability: Record<string, unknown>;
  signature: string;
  jobToken: string;
  protocolVersions: number[];
}

export interface RegisterResult {
  nodeId: string;
  credential: string;
  heartbeatIntervalMs: number;
  protocolVersion: number;
}

export interface HeartbeatBody {
  load: { running: number; queued: number };
  models?: string[];
}

export interface SyncBody {
  capability: Record<string, unknown>;
  signature: string;
}
