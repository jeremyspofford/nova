// A conversation engine with a tool runtime, lifecycle hooks and skills for the M4 loop tests
// (FR-046, FR-197): a scripted hook dispatcher records every event and answers per event, and a
// fixed skill catalog stands in for the plugins area.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HookEvent, PolicyEffect, ToolDescriptor } from '@nova/shared';
import type { MockProviderOptions } from '@nova/providers';
import {
  ArtifactService,
  ToolRegistry,
  ToolRuntime,
  UnavailableSandbox,
  allowAllGate,
  builtinSource,
  builtinTools,
  type AuditRecord,
  type DeferBudget,
  type GateOutcome,
  type GateRequest,
  type HookDispatcher,
  type HookInput,
  type HookOutcome,
  type ResolvedSkill,
  type SkillCatalogProvider,
  type ToolDefinition,
  type ToolGate,
  type ToolSourceProvider,
} from '../src/index.ts';
import { makeEnv, type Env } from './helpers.ts';

export interface HookCall {
  event: HookEvent;
  input: HookInput;
  signal: AbortSignal;
}

export type HookScript = Partial<
  Record<HookEvent, (input: HookInput) => HookOutcome | Promise<HookOutcome>>
>;

/** A dispatcher that records each event and answers from `script` (else no effect). */
export function scriptedHooks(script: HookScript = {}): HookDispatcher & { calls: HookCall[] } {
  const calls: HookCall[] = [];
  return {
    calls,
    async dispatch(event, input, signal) {
      calls.push({ event, input, signal });
      const h = script[event];
      return h ? await h(input) : { context: [] };
    },
  };
}

/** A fixed skill catalog (the plugins area's SkillCatalogProvider). */
export function fixedSkills(
  skills: ResolvedSkill[],
  catalog: string | null = null,
  tools: ToolDefinition[] = [],
): SkillCatalogProvider & { resolved: string[]; catalogCalls: number[] } {
  const resolved: string[] = [];
  const catalogCalls: number[] = [];
  return {
    resolved,
    catalogCalls,
    catalogSection: (_a, _p, contextTokens) => {
      catalogCalls.push(contextTokens);
      return Promise.resolve(catalog);
    },
    resolve: (_a, _p, name) => {
      resolved.push(name);
      return Promise.resolve(
        skills.find((s) => s.name === name || s.skillId.endsWith(`:${name}`)) ?? null,
      );
    },
    tools: { source: 'plugin', list: () => Promise.resolve(tools) },
  };
}

type Decide = (req: GateRequest, signal: AbortSignal) => Promise<GateOutcome>;

/** A gate that records requests; `decide` answers check, `effectOf` answers preview. */
export function recordingGate(
  decide: Decide = () => Promise.resolve({ effect: 'allow', reason: 'ok', tier: 'pre_approvable' }),
  effectOf: (tool: string) => PolicyEffect = () => 'allow',
): ToolGate & { requests: GateRequest[] } {
  const requests: GateRequest[] = [];
  return {
    requests,
    check(req, signal) {
      requests.push(req);
      return decide(req, signal);
    },
    preview(req) {
      return Promise.resolve({
        effect: effectOf(req.tool.name),
        tier: 'pre_approvable' as const,
        reason: 'preview',
        source: 'test',
        ruleId: null,
      });
    },
  };
}

export function mcpTool(
  name: string,
  handler: ToolDefinition['handler'],
  extra: Partial<ToolDescriptor> = {},
): ToolDefinition {
  return {
    descriptor: {
      name,
      title: name,
      description: `the ${name} tool`,
      source: 'mcp',
      inputSchema: { type: 'object', properties: {} },
      ...extra,
    },
    handler,
  };
}

export interface LoopEnvOptions {
  hooks?: HookDispatcher;
  /** Give the tool runtime the hooks too (default true). */
  toolHooks?: boolean;
  skills?: SkillCatalogProvider;
  gate?: ToolGate;
  sources?: ToolSourceProvider[];
  mock?: MockProviderOptions;
  budget?: DeferBudget;
  /** No tool runtime at all. */
  noTools?: boolean;
  /** MCP Apps' model context (FR-198). */
  appContext?: (accountId: string, threadId: string) => Promise<string | null>;
}

export interface LoopEnv extends Env {
  runtime: ToolRuntime | null;
  workspace: string;
  audit: AuditRecord[];
}

export async function makeLoopEnv(opts: LoopEnvOptions = {}): Promise<LoopEnv> {
  let runtime: ToolRuntime | null = null;
  let workspace = '';
  const audit: AuditRecord[] = [];
  const env = await makeEnv({
    ...(opts.mock ? { mock: opts.mock } : {}),
    chat: {
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.skills ? { skills: opts.skills } : {}),
      ...(opts.appContext ? { appContext: opts.appContext } : {}),
    },
    ...(opts.noTools
      ? {}
      : {
          tools: ({ db, events, dataDir }) => {
            workspace = join(dataDir, 'workspace');
            mkdirSync(workspace, { recursive: true });
            const artifacts = new ArtifactService({ db, events, dataDir });
            const searxngUrl = () => Promise.resolve(null);
            const builtins = builtinTools({
              artifacts,
              searxngUrl,
              paths: { denied: [dataDir], allowed: [workspace] },
            });
            const sources = [...(opts.sources ?? [])];
            if (opts.skills) sources.push(opts.skills.tools);
            runtime = new ToolRuntime({
              db,
              events,
              gate: opts.gate ?? allowAllGate,
              registry: new ToolRegistry({
                sources: [builtinSource(builtins, searxngUrl), ...sources],
              }),
              sandbox: new UnavailableSandbox(),
              audit: { append: (r) => Promise.resolve(void audit.push(r)) },
              scope: () =>
                Promise.resolve({
                  roots: [{ path: workspace, access: 'write', label: 'Workspace' }],
                  profile: { id: 'workspace', hash: 'test-hash' },
                  network: 'off',
                }),
              ...(opts.budget ? { deferBudget: () => Promise.resolve(opts.budget!) } : {}),
              paths: { denied: [dataDir], allowed: [workspace] },
              ...(opts.hooks && opts.toolHooks !== false ? { hooks: opts.hooks } : {}),
            });
            return runtime;
          },
        }),
  });
  return { ...env, runtime, workspace, audit };
}

/** All text the model got in user messages of a request. */
export function userText(req: { messages: { role: string; content: unknown[] }[] } | undefined) {
  return (req?.messages ?? [])
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content as { type: string; text?: string }[])
    .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
    .join('');
}

export function systemText(req: { messages: { role: string; content: unknown[] }[] } | undefined) {
  return (req?.messages ?? [])
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.content as { type: string; text?: string }[])
    .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
    .join('');
}

/** The text of every tool result of a request, envelopes included. */
export function toolResultText(
  req: { messages: { role: string; content: unknown[] }[] } | undefined,
) {
  return (req?.messages ?? [])
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content as { type: string; content?: { type: string; text?: string }[] }[])
    .flatMap((p) => (p.type === 'tool_result' ? (p.content ?? []) : []))
    .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
    .join('');
}
