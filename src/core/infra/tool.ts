// The plan/apply tool (M10d, docs/plans/M10d.md), behind an adapter (ADR-8). One adapter: OpenTofu's
// command line (`tofu` on PATH; Terraform's is the same shape). Every call is argv, never a shell
// string, in the project's folder, with a minimal environment: PATH, a home of Nova's own, OpenTofu's
// automation switches, and the project's provider secrets from the vault, handed to this one process
// at the moment of use. Everything the tool says is passed through the run's redactor before Nova
// keeps it: a leaky provider that prints its token leaves it nowhere.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { CoreError } from '../errors.ts';
import { runLines, tail, which } from '../providers/cli.ts';
import type { Redactor } from '../browser/logins.ts';

export type Action = 'create' | 'update' | 'delete' | 'replace' | 'read' | 'no-op';
export interface ResourceChange { address: string; type: string; name: string; action: Action; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
export interface StateResource { address: string; type: string; name: string; values: Record<string, unknown> }

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
  showPlan(c: ToolContext, file: string): Promise<{ changes: ResourceChange[]; text: string }>;
  apply(c: ToolContext, file: string): Promise<ToolRun>;
  // What the tool's state holds now. Synchronous too, for the verifier (which can't wait).
  state(c: ToolContext): Promise<StateResource[]>;
  stateSync(c: Omit<ToolContext, 'signal'>): StateResource[];
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
    return [{ address: c.address, type: c.type, name: typeof c.name === 'string' ? c.name : c.address, action, before: obj(c.change?.before), after: obj(c.change?.after) }];
  });
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
      return { changes: parsePlan(json.out), text: text.out };
    },
    apply: async (c, file) => run(c, ['apply', '-input=false', '-no-color', file]),
    async state(c) {
      return parseState(must(await run(c, ['show', '-json']), '`tofu show -json` (the state)').out);
    },
    stateSync(c) {
      const bin = where();
      if (!bin) throw new CoreError('conflict', `OpenTofu isn’t on this computer (no ${command} on PATH).`);
      const r = spawnSync(bin, ['show', '-json'], { cwd: c.dir, env: c.env, encoding: 'utf8', timeout: c.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) throw new CoreError('conflict', `\`tofu show -json\` failed (exit ${r.status ?? 'none'}): ${c.red.text(tail(`${r.stderr ?? ''}`, 6, 800))}`);
      return parseState(r.stdout);
    },
  };
}
