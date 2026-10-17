// Shared shape of the built-in tools (docs/08 §1.1). A built-in is a ToolDefinition plus two
// things the runtime needs from it: the untrusted origin its results carry into the context
// (taint, FR-189) and the resource a call touches (what the policy gate evaluates).
import type { ActionEffectClass, ToolDescriptor } from '@nova/shared';
import type { GateRequest, Origin, ToolContext, ToolDefinition, ToolResult } from './types.ts';

/** A web result registered as a citation of the reply (FR-029). */
export interface WebCitation {
  url: string;
  title: string | null;
  snippet: string | null;
}

export interface ToolSearchHit {
  name: string;
  title: string;
  description: string;
  score: number;
}

/** Per-call services the runtime gives built-ins beyond the seam's ToolContext. */
export interface CallExtras {
  /** The assistant message the call belongs to (model calls); null from the UI. */
  messageId: string | null;
  /** Network the permission profile allows commands (FR-190). */
  network: 'off' | 'allowlist' | 'limited';
  /** Paths the permission profile denies inside the roots (FR-190). */
  deny: readonly string[];
  /** Register web results as citations of the reply; returns the number of each. */
  cite: (items: WebCitation[]) => number[];
  /** Search the deferred tools and load the matches for the next model call (FR-196). */
  searchTools: (query: string, limit: number) => ToolSearchHit[];
}

export type BuiltinContext = ToolContext & { extras?: CallExtras };

export interface BuiltinTool extends ToolDefinition {
  /** Where this tool's results come from, as context taint (FR-189). */
  origin: Origin | null;
  /** The resource a call touches, for the gate (paths, hosts). */
  resource?: (args: unknown, ctx: ToolContext) => GateRequest['resource'] | undefined;
}

export function isBuiltinTool(t: ToolDefinition): t is BuiltinTool {
  return 'origin' in t;
}

export function extrasOf(ctx: ToolContext): CallExtras | undefined {
  return (ctx as BuiltinContext).extras;
}

/** A built-in descriptor: always loaded, never deferred (tool-descriptor.json). */
export function builtinDescriptor(d: {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolDescriptor['annotations'];
  effects?: ActionEffectClass[];
  timeoutMs?: number;
}): ToolDescriptor {
  const out: ToolDescriptor = {
    name: d.name,
    title: d.title,
    description: d.description,
    source: 'builtin',
    inputSchema: d.inputSchema,
    loading: 'always',
    deferred: false,
    effects: d.effects ?? [],
  };
  if (d.annotations) out.annotations = d.annotations;
  if (d.timeoutMs !== undefined) out.timeoutMs = d.timeoutMs;
  return out;
}

export function ok(text: string, meta?: Record<string, unknown>): ToolResult {
  const r: ToolResult = { ok: true, content: [{ type: 'text', text }] };
  if (meta) r.meta = meta;
  return r;
}

export function fail(code: string, message: string, details?: unknown): ToolResult {
  const error: { code: string; message: string; details?: unknown } = { code, message };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}

/** Narrow tool arguments (already validated against the schema) to a record. */
export function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
