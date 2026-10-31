// The plan/apply tool (M10d, docs/plans/M10d.md), behind an adapter (ADR-8). One adapter: OpenTofu's
// command line (`tofu` on PATH; Terraform's is the same shape). Every call is argv, never a shell
// string, in the project's folder, with a minimal environment: PATH, a home of Nova's own, OpenTofu's
// automation switches, and the project's provider secrets from the vault, handed to this one process
// at the moment of use. Everything the tool says is passed through the run's redactor before Nova
// keeps it: a leaky provider that prints its token leaves it nowhere.
import { mkdirSync } from 'node:fs';
import { CoreError } from '../errors.ts';
import { runLines, tail, which } from '../providers/cli.ts';
import type { Redactor } from '../browser/logins.ts';

export type Action = 'create' | 'update' | 'delete' | 'replace' | 'read' | 'no-op';
export interface ResourceChange { address: string; type: string; name: string; action: Action; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
export interface StateResource { address: string; type: string; name: string; values: Record<string, unknown> }
// A saved plan as Nova reads it: each change, and every resource before (prior_state) and after
// (planned_values) the apply, values with the plan's sensitive ones masked (review of PR #241, S6).
export interface PlanData { changes: ResourceChange[]; prior: StateResource[]; planned: StateResource[] }
export const SENSITIVE = '(sensitive)';

export interface ToolRun { code: number | null; out: string; err: string; timedOut: boolean; aborted: boolean }
export interface ToolContext { dir: string; env: Record<string, string>; red: Redactor; signal?: AbortSignal; timeoutMs?: number }

// What Nova asks of a plan/apply tool.
export interface PlanApplyTool {
  readonly id: string;
  readonly name: string;
  // Where its command is, or null: Nova never installs one.
  where(): string | null;
  init(c: ToolContext): Promise<ToolRun>;
  // Writes the saved plan to `out`; `changes` is whether it changes anything.
  plan(c: ToolContext, out: string, o: { destroy: boolean }): Promise<ToolRun & { changes: boolean }>;
  // The saved plan, as data and as the tool's own words.
  showPlan(c: ToolContext, file: string): Promise<PlanData & { text: string }>;
  apply(c: ToolContext, file: string): Promise<ToolRun>;
  // What the tool's state holds now.
  state(c: ToolContext): Promise<StateResource[]>;
}

// A value with what the plan marks sensitive replaced: `marks` is OpenTofu's *_sensitive shape (true,
// or an object or list of the same shape as the value).
export function maskSensitive(v: unknown, marks: unknown, depth = 0): unknown {
  if (marks === true) return SENSITIVE;
  if (depth > 30 || marks === null || marks === undefined || marks === false || typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) return v.map((x, i) => maskSensitive(x, Array.isArray(marks) ? marks[i] : undefined, depth + 1));
  const m = marks as Record<string, unknown>;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskSensitive(x, m[k], depth + 1)]));
}

// Read from the tool's JSON: a saved plan's resource changes (`tofu show -json FILE`).
export function parsePlan(text: string): ResourceChange[] {
  let j: { resource_changes?: unknown };
  try { j = JSON.parse(text); } catch { throw new CoreError('validation', 'The tool’s plan isn’t JSON Nova can read.'); }
  const list = Array.isArray(j.resource_changes) ? j.resource_changes : [];
  return list.flatMap((raw): ResourceChange[] => {
    const c = raw as { address?: unknown; type?: unknown; name?: unknown; mode?: unknown; change?: { actions?: unknown; before?: unknown; after?: unknown } };
    if (c.mode === 'data') return [];
    const actions = Array.isArray(c.change?.actions) ? c.change!.actions.map(String) : [];
    const action: Action = actions.includes('delete') && actions.includes('create') ? 'replace'
      : actions.includes('create') ? 'create' : actions.includes('delete') ? 'delete' : actions.includes('update') ? 'update' : actions.includes('read') ? 'read' : 'no-op';
    const obj = (v: unknown) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null);
    if (typeof c.address !== 'string' || typeof c.type !== 'string') return [];
    const ch = c.change as { before_sensitive?: unknown; after_sensitive?: unknown } | undefined;
    return [{ address: c.address, type: c.type, name: typeof c.name === 'string' ? c.name : c.address, action,
      before: obj(maskSensitive(c.change?.before, ch?.before_sensitive)), after: obj(maskSensitive(c.change?.after, ch?.after_sensitive)) }];
  });
}

// The plan's whole before and after: prior_state and planned_values, sensitive values masked.
export function parsePlanData(text: string): PlanData {
  let j: { planned_values?: { root_module?: unknown }; prior_state?: { values?: { root_module?: unknown } } };
  try { j = JSON.parse(text); } catch { throw new CoreError('validation', 'The tool’s plan isn’t JSON Nova can read.'); }
  if (!j.planned_values) throw new CoreError('validation', 'The tool’s plan has no planned_values, so Nova can’t price what the project would hold after it.');
  return { changes: parsePlan(text), planned: modules(j.planned_values.root_module), prior: modules(j.prior_state?.values?.root_module) };
}

function modules(root: unknown): StateResource[] {
  const out: StateResource[] = [];
  const walk = (m: unknown, depth = 0) => {
    if (depth > 20 || typeof m !== 'object' || m === null) return;
    const mod = m as { resources?: unknown[]; child_modules?: unknown[] };
    for (const r of mod.resources ?? []) {
      const x = r as { address?: unknown; type?: unknown; name?: unknown; mode?: unknown; values?: unknown; sensitive_values?: unknown };
      if (x.mode === 'data' || typeof x.address !== 'string' || typeof x.type !== 'string') continue;
      const values = maskSensitive(typeof x.values === 'object' && x.values !== null ? x.values : {}, x.sensitive_values) as Record<string, unknown>;
      out.push({ address: x.address, type: x.type, name: typeof x.name === 'string' ? x.name : x.address, values });
    }
    for (const c of mod.child_modules ?? []) walk(c, depth + 1);
  };
  walk(root);
  return out;
}

// The state's managed resources (`tofu show -json`), child modules included.
export function parseState(text: string): StateResource[] {
  let j: { values?: { root_module?: unknown } };
  try { j = JSON.parse(text); } catch { throw new CoreError('validation', 'The tool’s state isn’t JSON Nova can read.'); }
  const out: StateResource[] = [];
  const walk = (m: unknown, depth = 0) => {
    if (depth > 20 || typeof m !== 'object' || m === null) return;
    const mod = m as { resources?: unknown[]; child_modules?: unknown[] };
    for (const r of mod.resources ?? []) {
      const x = r as { address?: unknown; type?: unknown; name?: unknown; mode?: unknown; values?: unknown };
      if (x.mode === 'data' || typeof x.address !== 'string' || typeof x.type !== 'string') continue;
      out.push({ address: x.address, type: x.type, name: typeof x.name === 'string' ? x.name : x.address, values: typeof x.values === 'object' && x.values !== null ? x.values as Record<string, unknown> : {} });
    }
    for (const c of mod.child_modules ?? []) walk(c, depth + 1);
  };
  walk(j.values?.root_module);
  return out;
}

// OpenTofu's environment: nothing of Nova's or the person's, but PATH and the provider secrets.
export function toolEnv(o: { path: string; home: string; secrets: Record<string, string> }): Record<string, string> {
  mkdirSync(o.home, { recursive: true });
  return {
    PATH: o.path, HOME: o.home, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1', NO_COLOR: '1', LANG: 'C.UTF-8',
    ...o.secrets,
  };
}

export function openTofu(o: { command?: string; path: () => string }): PlanApplyTool {
  const command = o.command ?? 'tofu';
  const where = () => which(command, o.path());
  const run = async (c: ToolContext, args: string[]): Promise<ToolRun> => {
    const bin = where();
    if (!bin) throw new CoreError('conflict', `OpenTofu isn’t on this computer (no ${command} on PATH). Nova doesn’t install it; once it is installed, plan again.`);
    let out = '';
    const ran = await runLines({ argv: [bin, ...args], cwd: c.dir, env: c.env, ...(c.signal ? { signal: c.signal } : {}), timeoutMs: c.timeoutMs ?? 15 * 60_000, onLine: (l) => { out += `${l}\n`; } });
    if (c.signal?.aborted) throw c.signal.reason ?? new Error('stopped');
    return { code: ran.code, out: c.red.text(out), err: c.red.text(ran.stderr), timedOut: ran.timedOut, aborted: ran.aborted };
  };
  const must = (r: ToolRun, what: string): ToolRun => {
    if (r.timedOut) throw new CoreError('conflict', `${what} took too long, so Nova stopped it.`);
    if (r.code !== 0) throw new CoreError('conflict', `${what} failed (exit ${r.code ?? 'none'}): ${tail(`${r.err}\n${r.out}`.trim(), 8, 1200)}`);
    return r;
  };
  return {
    id: 'opentofu', name: 'OpenTofu',
    where,
    init: async (c) => must(await run(c, ['init', '-input=false', '-no-color']), '`tofu init`'),
    async plan(c, out, { destroy }) {
      const r = await run(c, ['plan', '-input=false', '-no-color', '-lock=true', '-detailed-exitcode', ...(destroy ? ['-destroy'] : []), `-out=${out}`]);
      // -detailed-exitcode: 0 no changes, 2 changes, anything else an error.
      if (r.code === 2) return { ...r, changes: true };
      return { ...must(r, '`tofu plan`'), changes: false };
    },
    async showPlan(c, file) {
      const json = must(await run(c, ['show', '-json', file]), '`tofu show -json`');
      const text = must(await run(c, ['show', '-no-color', file]), '`tofu show`');
      return { ...parsePlanData(json.out), text: text.out };
    },
    apply: async (c, file) => run(c, ['apply', '-input=false', '-no-color', file]),
    async state(c) {
      return parseState(must(await run(c, ['show', '-json']), '`tofu show -json` (the state)').out);
    },
  };
}
