// Deferred tools and tool search (FR-196, docs/08 §1.4). Over the budget, MCP and plugin tools
// are held back from the model; `tool.search` ranks them with BM25 over each tool's name (split
// on `.`, `_`, `-`, `:` and camelCase), title and description, locally and deterministically,
// and loads the matches for the next model call. Loading grants nothing: every call still
// passes the policy gate.
import type { ToolDescriptor } from '@nova/shared';
import {
  argsOf,
  builtinDescriptor,
  extrasOf,
  fail,
  num,
  ok,
  str,
  type BuiltinTool,
  type ToolSearchHit,
} from './builtin.ts';
import { CHARS_PER_TOKEN, clip } from './text.ts';

export interface DeferBudget {
  tools: number;
  schemaTokens: number;
}

export const DEFAULT_DEFER_BUDGET: DeferBudget = { tools: 40, schemaTokens: 8000 };

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** BM25 (k1 1.2, b 0.75) over name, title and description; ties break by name. */
export function rankTools(
  tools: readonly ToolDescriptor[],
  query: string,
  limit: number,
): ToolSearchHit[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !tools.length) return [];
  const docs = tools.map((t) => {
    const terms = tokenize(`${t.name} ${t.name} ${t.title} ${t.description}`);
    const tf = new Map<string, number>();
    for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
    return { t, tf, len: terms.length };
  });
  const avg = docs.reduce((n, d) => n + d.len, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const term of q) df.set(term, docs.filter((d) => d.tf.has(term)).length);
  const k1 = 1.2;
  const b = 0.75;
  const scored = docs.map((d) => {
    let score = 0;
    for (const term of q) {
      const f = d.tf.get(term) ?? 0;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.len) / avg));
    }
    return { d, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score || (x.d.t.name < y.d.t.name ? -1 : 1))
    .slice(0, limit)
    .map((s) => ({
      name: s.d.t.name,
      title: s.d.t.title,
      description: clip(s.d.t.description.split('\n')[0] ?? '', 200),
      score: Math.round(s.score * 1000) / 1000,
    }));
}

/** Schema tokens of a tool as the model sees it (4 characters per token, docs/08 §1.4). */
export function schemaTokens(t: ToolDescriptor): number {
  const chars = t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function isDeferrable(t: ToolDescriptor): boolean {
  if (t.source === 'builtin') return false;
  if (t.loading === 'always') return false;
  return t.source === 'mcp' || t.source === 'plugin' || t.loading === 'deferrable';
}

export interface ListingInput {
  tools: readonly ToolDescriptor[];
  budget: DeferBudget;
  /** Named by an `@`-mention this turn: never deferred. */
  pinned: ReadonlySet<string>;
  /** Loaded by tool.search, oldest first. */
  loaded: readonly string[];
}

export interface Listing {
  /** In the model's tool list. */
  offered: string[];
  /** Held behind tool.search. */
  deferred: string[];
  /** Search-loaded tools dropped to stay within budget (oldest first). */
  unloaded: string[];
  /** One line per source with deferred tools, e.g. "mcp:linear: 23 tools, deferred". */
  summary: string[];
}

/** Which tools the model sees this step (docs/08 §1.4). */
export function planListing(input: ListingInput): Listing {
  const { tools, budget, pinned } = input;
  const total = tools.reduce((n, t) => n + schemaTokens(t), 0);
  if (tools.length <= budget.tools && total <= budget.schemaTokens) {
    return { offered: tools.map((t) => t.name), deferred: [], unloaded: [], summary: [] };
  }
  const keep = tools.filter((t) => !isDeferrable(t) || pinned.has(t.name));
  const byName = new Map(tools.map((t) => [t.name, t]));
  let count = keep.length;
  let tokens = keep.reduce((n, t) => n + schemaTokens(t), 0);
  // Newest search loads win; the oldest are unloaded first when over budget.
  const loaded = input.loaded.filter((n) => byName.has(n) && !pinned.has(n));
  const kept: string[] = [];
  const unloaded: string[] = [];
  for (let i = loaded.length - 1; i >= 0; i--) {
    const t = byName.get(loaded[i]!)!;
    if (!isDeferrable(t)) continue;
    const cost = schemaTokens(t);
    if (count + 1 <= budget.tools && tokens + cost <= budget.schemaTokens) {
      kept.unshift(t.name);
      count++;
      tokens += cost;
    } else unloaded.unshift(t.name);
  }
  const offered = new Set([...keep.map((t) => t.name), ...kept]);
  const deferred = tools.filter((t) => !offered.has(t.name)).map((t) => t.name);
  const groups = new Map<string, number>();
  for (const name of deferred) {
    const g = sourceGroup(byName.get(name)!);
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  const summary = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([g, n]) => `${g}: ${n} tool${n === 1 ? '' : 's'}, deferred`);
  return {
    offered: tools.filter((t) => offered.has(t.name)).map((t) => t.name),
    deferred,
    unloaded,
    summary,
  };
}

/** `mcp:<server>` or `plugin:<id>` for a namespaced tool, else its source. */
export function sourceGroup(t: ToolDescriptor): string {
  const m = /^(mcp|plugin|page):([^.]+)\./.exec(t.name);
  if (m) return `${m[1]}:${m[2]}`;
  if (t.serverId) return `${t.source}:${t.serverId}`;
  return t.source;
}

/** The `tool.search` built-in. */
export function toolSearchTool(): BuiltinTool {
  return {
    descriptor: builtinDescriptor({
      name: 'tool.search',
      title: 'Search tools',
      description:
        'Search the tools that are not loaded yet (see the deferred tool summary) by what they do. Matches are loaded for your next step.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 300 },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnly: true, idempotent: true, action: 'read' },
      timeoutMs: 10_000,
    }),
    origin: 'mcp',
    handler: (args, ctx) => {
      const a = argsOf(args);
      const extras = extrasOf(ctx);
      if (!extras) return Promise.resolve(fail('unavailable', 'tool search runs inside a chat'));
      const hits = extras.searchTools(str(a.query) ?? '', num(a.limit) ?? 5);
      if (!hits.length) return Promise.resolve(ok('No matching tools.', { hits: [] }));
      const text = hits.map((h) => `${h.name} (${h.title}): ${h.description}`).join('\n');
      return Promise.resolve(
        ok(`Loaded for your next step:\n${text}`, { hits: hits.map((h) => ({ ...h })) }),
      );
    },
  };
}
