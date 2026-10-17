// Tool naming and descriptors for MCP tools (docs/08 §1, §8; contracts/schemas/tool-descriptor.json).
// External tools become `mcp:<server>.<tool>`. Server annotations are untrusted hints: they can
// make a tool stricter, never looser (docs/08 §1).
import type { ToolDescriptor } from '@nova/shared';

/** The descriptor pattern for MCP tools (tool-descriptor.json `name`). */
export const MCP_TOOL_NAME = /^mcp:[a-z0-9-]+\.[A-Za-z0-9_.-]+$/;

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const SEGMENT_MAX = 128;

/** A server name as the namespace segment: lowercase letters, digits and dashes. */
export function serverSegment(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 40);
  return s || 'server';
}

/** A tool name as the last segment: letters, digits, `_`, `.` and `-`; anything else becomes `_`. */
export function toolSegment(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, SEGMENT_MAX);
  return s || '_';
}

/**
 * Canonical names for a server's tools, in list order. Two tools that sanitize to the same name
 * keep the first; later ones get `_2`, `_3` … so every name stays unique and stable for that list.
 */
export function canonicalNames(server: string, tools: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const prefix = `mcp:${serverSegment(server)}.`;
  for (const original of tools) {
    if (out.has(original)) continue;
    const base = toolSegment(original);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base.slice(0, SEGMENT_MAX - 4)}_${n}`;
    taken.add(name);
    out.set(original, prefix + name);
  }
  return out;
}

/**
 * Whether a tool list entry names this tool. Settings may store the server's own name, the
 * sanitized segment or the full canonical name; all three match.
 */
export function listNames(list: readonly string[], original: string, canonical: string): boolean {
  const segment = canonical.slice(canonical.indexOf('.') + 1);
  return list.some((entry) => entry === original || entry === canonical || entry === segment);
}

/** Whether a tool is exposed under the server's allow and deny lists (deny applies after allow). */
export function toolExposed(
  lists: { enabledTools: readonly string[] | null; disabledTools: readonly string[] },
  original: string,
  canonical: string,
): boolean {
  if (lists.enabledTools && !listNames(lists.enabledTools, original, canonical)) return false;
  return !listNames(lists.disabledTools, original, canonical);
}

/** The parts of an MCP `Tool` this module reads. */
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

function clip(text: string, max: number): string {
  // Strip control characters a server could use to break out of a listing line.
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The Nova descriptor for an MCP tool. Hints only ever add restrictions: `destructiveHint: true`
 * marks the tool destructive and `openWorldHint: true` marks it as needing the network;
 * `readOnlyHint` and `idempotentHint` are ignored, and `effects` are never set from hints
 * (tool-descriptor.json `effects`).
 */
export function toDescriptor(
  server: { id: string; toolTimeoutMs: number },
  tool: McpToolInfo,
  canonical: string,
): ToolDescriptor {
  const annotations: NonNullable<ToolDescriptor['annotations']> = {};
  if (tool.annotations?.destructiveHint === true) annotations.destructive = true;
  if (tool.annotations?.openWorldHint === true) annotations.requiresNetwork = true;
  const d: ToolDescriptor = {
    name: canonical,
    title: clip(tool.title ?? tool.annotations?.title ?? tool.name, TITLE_MAX) || canonical,
    description: clip(tool.description ?? '', DESCRIPTION_MAX),
    source: 'mcp',
    serverId: server.id,
    inputSchema: isObject(tool.inputSchema) ? tool.inputSchema : { type: 'object' },
    loading: 'deferrable',
    timeoutMs: server.toolTimeoutMs,
  };
  if (isObject(tool.outputSchema)) d.outputSchema = tool.outputSchema;
  if (Object.keys(annotations).length) d.annotations = annotations;
  return d;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
