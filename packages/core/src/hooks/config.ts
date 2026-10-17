// Hook definitions (contracts/schemas/hook-config.json; docs/08 §4.1; FR-197, ADR-068): parsing a
// hooks file, matching an event's subject, what each event lets a hook do, and the content hash
// a user trusts. The contract's validator is the parser, so code and schema cannot drift.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { contracts } from '@nova/contracts';
import { globMatch } from '@nova/policy';
import { isWithin } from '@nova/security';
import type { HookEvent } from '@nova/shared';
import { canonicalJson } from '../nodes/crypto.ts';

export type HookSource = 'managed' | 'user' | 'project' | 'plugin' | 'extension';

/** The order added context is combined in (docs/08 §4.1 "Combining results"). */
export const HOOK_SOURCE_ORDER: readonly HookSource[] = [
  'managed',
  'user',
  'project',
  'plugin',
  'extension',
];

export const HOOK_EVENTS: readonly HookEvent[] = [
  'session.start',
  'session.end',
  'prompt.submit',
  'tool.pre',
  'permission.request',
  'tool.post',
  'compact.pre',
  'compact.post',
  'subagent.start',
  'subagent.stop',
  'stop',
  'interrupt',
];

/** hook-config.json `timeoutMs` default and range (ADR-083: 30 s, at most 10 min). */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
export const MIN_HOOK_TIMEOUT_MS = 1_000;
export const MAX_HOOK_TIMEOUT_MS = 600_000;

export interface CommandHandler {
  type: 'command';
  command: string[];
  windowsCommand?: string[];
  network?: string[];
  timeoutMs?: number;
}

export interface McpToolHandler {
  type: 'mcp_tool';
  tool: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
}

export type HookHandler = CommandHandler | McpToolHandler;

/** One hook as written in a hooks file (hook-config.json#/$defs/hook). */
export interface HookDefinition {
  id: string;
  event: HookEvent;
  matcher?: string | string[];
  handler: HookHandler;
  failClosed?: boolean;
  statusMessage?: string;
  enabled?: boolean;
}

/** A handler's answer (hook-config.json#/$defs/result); empty output means no opinion. */
export interface HookResult {
  block?: { reason: string };
  decision?: 'allow' | 'deny';
  context?: string;
  continue?: string;
}

/** What a hook may do at each event (docs/08 §4.1 "Events and effects"). */
export interface HookEventEffects {
  /** The event has a matcher subject (tool name, start reason, trigger or role). */
  subject: boolean;
  context: boolean;
  block: boolean;
  decision: boolean;
  continue: boolean;
  /**
   * A hook that fails or times out blocks (or denies) here whatever its `failClosed` says: a
   * guard that cannot answer never lets the call through (AGENTS.md §8, ADR-090).
   */
  failClosed: boolean;
}

const NONE: HookEventEffects = {
  subject: false,
  context: false,
  block: false,
  decision: false,
  continue: false,
  failClosed: false,
};

export const HOOK_EVENT_EFFECTS: Record<HookEvent, HookEventEffects> = {
  'session.start': { ...NONE, subject: true, context: true },
  'session.end': NONE,
  'prompt.submit': { ...NONE, context: true, block: true },
  'tool.pre': { ...NONE, subject: true, context: true, block: true, failClosed: true },
  'permission.request': { ...NONE, subject: true, context: true, decision: true, failClosed: true },
  'tool.post': { ...NONE, subject: true, context: true },
  'compact.pre': { ...NONE, subject: true, context: true },
  'compact.post': { ...NONE, subject: true, context: true },
  'subagent.start': { ...NONE, subject: true, context: true },
  'subagent.stop': { ...NONE, subject: true, context: true },
  stop: { ...NONE, continue: true },
  interrupt: NONE,
};

/** Whether a failed run of this hook blocks its event (fail closed). */
export function failsClosed(def: HookDefinition): boolean {
  const e = HOOK_EVENT_EFFECTS[def.event];
  return e.failClosed || (def.failClosed === true && (e.block || e.decision));
}

let validators: {
  hook: (d: unknown) => { ok: boolean; errors: { instancePath: string; message?: string }[] };
  result: (d: unknown) => { ok: boolean; errors: { instancePath: string; message?: string }[] };
} | null = null;

function v() {
  validators ??= {
    hook: contracts().validator('hook-config.json#/$defs/hook'),
    result: contracts().validator('hook-config.json#/$defs/result'),
  };
  return validators;
}

function describe(errors: { instancePath: string; message?: string }[]): string {
  return errors
    .slice(0, 3)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
    .join('; ');
}

export interface ParsedHooks {
  hooks: HookDefinition[];
  /** One line per hook (or the file) that was left out, and why. */
  errors: string[];
  /** Set when the file as a whole is not a hooks file (none of it can be trusted to be current). */
  fileError?: string;
}

function invalidFile(message: string): ParsedHooks {
  return { hooks: [], errors: [message], fileError: message };
}

/**
 * The hooks of a hooks file: `{schemaVersion?, hooks: [...]}`, or a bare array (a plugin
 * manifest's inline `hooks`). Each hook is validated on its own, so one bad entry does not hide
 * the others; an invalid entry and a repeated id are left out and reported.
 */
export function parseHooksFile(data: unknown): ParsedHooks {
  let list: unknown[];
  if (Array.isArray(data)) list = data;
  else if (isObject(data) && Array.isArray(data.hooks)) {
    if (data.schemaVersion !== undefined && data.schemaVersion !== 1)
      return invalidFile(`unsupported schemaVersion ${JSON.stringify(data.schemaVersion)}`);
    const extra = Object.keys(data).filter((k) => k !== 'hooks' && k !== 'schemaVersion');
    if (extra.length) return invalidFile(`unknown top-level keys: ${extra.join(', ')}`);
    list = data.hooks;
  } else return invalidFile('a hooks file is an object with a "hooks" array');
  const hooks: HookDefinition[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const r = v().hook(item);
    const id = isObject(item) && typeof item.id === 'string' ? item.id : `#${i + 1}`;
    if (!r.ok) {
      errors.push(`hook ${id}: ${describe(r.errors)}`);
      return;
    }
    const def = item as HookDefinition;
    if (seen.has(def.id)) {
      errors.push(`hook ${def.id}: the id is used twice; the first one is kept`);
      return;
    }
    seen.add(def.id);
    hooks.push(def);
  });
  return { hooks, errors };
}

/** A handler's output as a result, or an error message when it is not one. */
export function parseHookResult(data: unknown): HookResult | { error: string } {
  const r = v().result(data);
  if (!r.ok) return { error: `the hook answered with an invalid result: ${describe(r.errors)}` };
  return data as HookResult;
}

/** The matcher globs of a hook; empty means every occurrence. */
export function matcherList(def: Pick<HookDefinition, 'matcher'>): string[] {
  if (def.matcher === undefined) return [];
  return Array.isArray(def.matcher) ? def.matcher : [def.matcher];
}

/**
 * Whether a hook runs for this occurrence. A hook without a matcher runs for every occurrence;
 * events without a subject ignore matchers; a subject-bearing event with no subject given matches
 * only matcher-less hooks.
 */
export function hookMatches(def: HookDefinition, subject: string | undefined): boolean {
  const globs = matcherList(def);
  if (!globs.length || !HOOK_EVENT_EFFECTS[def.event].subject) return true;
  if (subject === undefined) return false;
  return globs.some((g) => globMatch(g, subject));
}

export function handlerTimeout(handler: HookHandler): number {
  const t = handler.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  return Math.min(MAX_HOOK_TIMEOUT_MS, Math.max(MIN_HOOK_TIMEOUT_MS, t));
}

/** `${pluginRoot}` and similar variables in a command hook's argv. */
export type HookVars = Record<string, string>;

export function expandArgv(argv: readonly string[], vars: HookVars): string[] {
  return argv.map((a) =>
    a.replace(/\$\{([A-Za-z]+)\}/g, (m, name: string) => (name in vars ? vars[name]! : m)),
  );
}

function hashFile(path: string): { sha256: string; size: number } | null {
  let fd: number;
  try {
    if (!statSync(path).isFile()) return null;
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      size += n;
    }
    return { sha256: h.digest('hex'), size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Files a command hook runs that sit inside its folder (the plugin or project folder): every
 * argv element that, after `${pluginRoot}` expansion and resolution against the folder, names an
 * existing file there. Their bytes are part of the content hash (docs/08 §4.1 "Trust").
 */
export function referencedFiles(
  def: HookDefinition,
  baseDir: string | null,
  vars: HookVars = {},
): { path: string; abs: string }[] {
  if (!baseDir || def.handler.type !== 'command') return [];
  const out = new Map<string, string>();
  const argv = [...def.handler.command, ...(def.handler.windowsCommand ?? [])];
  for (const arg of expandArgv(argv, vars)) {
    if (!arg || arg.includes('\0')) continue;
    const base = resolve(baseDir);
    const abs = isAbsolute(arg) ? resolve(arg) : resolve(base, arg);
    if (abs === base || !isWithin(base, abs)) continue;
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    out.set(relative(base, abs), abs);
  }
  return [...out.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, abs]) => ({ path, abs }));
}

/**
 * `sha256:<hex>` over the canonical JSON of the definition (without `enabled`: turning a hook
 * off and on is not a change to trust) and the bytes of the files it runs inside its folder.
 * The definition is hashed before `${pluginRoot}` expansion and files by their path relative to
 * the folder, so a plugin's preview and its installed copy hash the same.
 */
export function hookContentHash(
  def: HookDefinition,
  baseDir: string | null,
  vars: HookVars = {},
): string {
  const { enabled: _enabled, ...rest } = def;
  const files = referencedFiles(def, baseDir, vars).map((f) => ({
    path: f.path,
    ...(hashFile(f.abs) ?? { sha256: 'unreadable', size: -1 }),
  }));
  const digest = createHash('sha256')
    .update(canonicalJson({ hook: JSON.parse(JSON.stringify(rest)) as unknown, files }))
    .digest('hex');
  return `sha256:${digest}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
