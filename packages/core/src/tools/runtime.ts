// The tool runtime (docs/08 §1, docs/09 §2 step 6): runs one tool call end to end — validate the
// arguments, ask the policy gate (with the intent provenance and taint of the turn, FR-189),
// wait for an approval when the gate asks (the thread shows `waiting_approval`), run the handler
// with its timeout, persist the `tool_call` row and the message parts, publish the tool events
// and audit the call (input hash only, FR-104). The conversation engine drives it once per call
// through a TurnTools; the Hub's POST /tools/:name/invoke drives it with origin `ui`.
//
// M4 lifecycle hooks (FR-197, docs/08 §4.1): `tool.pre` runs before the gate and may refuse the
// call (the card shows it denied, with the hook's reason); `tool.post` runs after the handler.
// Context either adds travels with the result, each part in its own untrusted envelope labelled
// with the hook. Calls made by hooks (origin `hook`) fire no hooks.
import { eq } from 'drizzle-orm';
import {
  NovaError,
  uuidv7,
  type MentionCandidate,
  type MentionKind,
  type ToolCallPartView,
  type ToolCallStatus,
  type ToolDescriptor,
  type ToolSource,
  type ToolView,
} from '@nova/shared';
import type { ContentPart, ToolSchema } from '@nova/providers';
import { defaultRedactor, type Redactor } from '@nova/security';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { HookDispatcher, HookInput, HookOutcome } from '../extensions/types.ts';
import {
  isBuiltinTool,
  type BuiltinContext,
  type CallExtras,
  type ToolSearchHit,
  type WebCitation,
} from './builtin.ts';
import { remoteFilesFor } from './fs-remote.ts';
import { mentionCandidates, resolveMentions } from './mentions.ts';
import type { ToolRegistry } from './registry.ts';
import type { PathPolicy } from './roots.ts';
import { validateArgs } from './schema-check.ts';
import {
  DEFAULT_DEFER_BUDGET,
  planListing,
  rankTools,
  sourceGroup,
  type DeferBudget,
} from './search.ts';
import {
  CHARS_PER_TOKEN,
  DEFAULT_OUTPUT_TOKENS,
  UNTRUSTED_RULES,
  capHeadTail,
  clip,
  contentText,
  inputHash,
  previewOf,
} from './text.ts';
import type {
  AuditSink,
  GateOutcome,
  GateRequest,
  Origin,
  Provenance,
  ResolvedMention,
  SandboxClient,
  ToolContext,
  ToolDefinition,
  ToolGate,
  ToolResult,
  ToolRoot,
} from './types.ts';

const { toolCall, messagePart } = schema;

/** Sources whose tools can end the turn from inside a call (a timed-out or stopping approval). */
const STOPPING_SOURCES: ReadonlySet<string> = new Set(['builtin', 'browser', 'computer']);
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
/** Characters of a result the model gets back (10,000 tokens, FR-184). */
export const MAX_RESULT_CHARS = DEFAULT_OUTPUT_TOKENS * CHARS_PER_TOKEN;
/** Arguments larger than this are stored as a preview only. */
const MAX_ARGS_JSON = 200_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Roots, permission profile and network for tools in a thread (FR-190). */
export interface ToolScope {
  roots: ToolRoot[];
  profile: { id: string; hash: string };
  network: 'off' | 'allowlist' | 'limited';
  /** Paths the profile denies inside the roots. */
  deny?: string[];
}

export type ThreadMode = GateRequest['mode'];

export interface ToolRuntimeOptions {
  db: NovaDatabase;
  events: EventSink;
  gate: ToolGate;
  registry: ToolRegistry;
  sandbox: SandboxClient;
  audit?: AuditSink;
  /** The roots and profile of a thread; the policy area owns this (FR-190). */
  scope: (input: {
    accountId: string;
    threadId: string | null;
    projectId: string | null;
  }) => Promise<ToolScope>;
  /** `tools.deferBudget` (FR-196). */
  deferBudget?: (projectId: string | null) => Promise<DeferBudget>;
  /** The user's per-tool default, when known (FR-048); else read from the preview's source. */
  userDefault?: (accountId: string, tool: string) => Promise<'allow' | 'ask' | 'deny' | null>;
  paths?: PathPolicy;
  redactor?: Redactor;
  log?: Logger;
  now?: () => Date;
  /** `tool.pre` and `tool.post` hooks (FR-197); none by default. */
  hooks?: HookDispatcher;
}

export interface TurnInput {
  accountId: string;
  threadId: string;
  turnId: string;
  projectId: string | null;
  mode: ThreadMode;
  signal: AbortSignal;
  /** Tools named by `@`-mentions: never deferred this turn. */
  pinned?: readonly string[];
}

export interface CallInput {
  call: { id: string; name: string; args: unknown };
  /** The assistant message of the step that made the call. */
  messageId: string;
  /** First free part index of that message; a call uses three. */
  partIdx: number;
  provenance: Provenance;
  /** The thread waits for an approval (true) or no longer does (false). */
  onWaiting?: (waiting: boolean) => Promise<void>;
  /** Number web results as citations of the reply (FR-029). */
  cite?: (items: WebCitation[]) => number[];
}

export interface CallOutcome {
  callId: string;
  status: ToolCallStatus;
  /** The origin the result adds to the context's taint, if any. */
  origin: Origin | null;
  /** End the turn: deny and stop, or an approval that timed out (docs/12 §4.1). */
  stop: 'deny_stop' | 'approval_timeout' | null;
  /**
   * The signed-in user answered `ask_user` in a Nova client (FR-188): the loop gives the rest of
   * the turn their instruction. Only the built-in tool can say so.
   */
  userAnswer?: boolean;
}

export interface InvokeResult {
  callId: string;
  ok: boolean;
  text: string;
  error?: { code: string; message: string };
  /**
   * The result's `meta` (an image's artifact, ...), redacted and bounded like the stored result
   * (over 20,000 characters of JSON it is `{truncated: true}`); null when there is none (M7).
   */
  meta: unknown;
}

/** What the model sees of a stored tool result (message part `tool_result`). */
export interface StoredResult {
  callId: string;
  modelCallId: string | null;
  tool: string;
  origin: Origin | null;
  isError: boolean;
  content: ContentPart[];
  /** Context `tool.pre` and `tool.post` hooks added (FR-197), redacted. */
  hooks?: HookContext[];
  /** The user's own answer to `ask_user` (FR-188): shown to the model as their words. */
  userAnswer?: boolean;
}

/** Context a hook added, labelled with the hook as its origin (FR-197, FR-189). */
export interface HookContext {
  hookId: string;
  text: string;
}

interface ExecInput {
  callId?: string;
  accountId: string;
  threadId: string | null;
  turnId: string | null;
  projectId: string | null;
  mode: ThreadMode;
  origin: ToolContext['origin'];
  def: ToolDefinition | null;
  name: string;
  args: unknown;
  modelCallId: string | null;
  messageId: string | null;
  partIdx: number;
  provenance: Provenance;
  scope: ToolScope;
  signal: AbortSignal;
  extras: CallExtras;
  onWaiting?: ((waiting: boolean) => Promise<void>) | undefined;
}

interface ExecOutput {
  callId: string;
  status: ToolCallStatus;
  ok: boolean;
  text: string;
  error: { code: string; message: string } | null;
  origin: Origin | null;
  stop: CallOutcome['stop'];
  userAnswer: boolean;
  /** A successful result's redacted, bounded `meta` (`#meta`). */
  meta?: unknown;
}

const ABORTED = Symbol('aborted');

interface FinishExtra {
  decision?: GateOutcome | null;
  startedAt?: number | null;
  stop?: CallOutcome['stop'];
  resource?: GateRequest['resource'];
  /** Context from tool.pre hooks. */
  hooks?: HookContext[];
  /** The handler ran: run the tool.post hooks. */
  post?: boolean;
}

export class ToolRuntime {
  readonly registry: ToolRegistry;
  readonly sandbox: SandboxClient;
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #gate: ToolGate;
  readonly #audit: AuditSink | undefined;
  readonly #scope: ToolRuntimeOptions['scope'];
  readonly #budget: (projectId: string | null) => Promise<DeferBudget>;
  readonly #userDefault: ToolRuntimeOptions['userDefault'];
  readonly #paths: PathPolicy;
  readonly #redactor: Redactor;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #hooks: HookDispatcher | undefined;
  /** Tools loaded by tool.search per thread, oldest first (docs/08 §1.4). */
  readonly #loaded = new Map<string, string[]>();
  readonly #stop = new AbortController();
  readonly #running = new Set<Promise<unknown>>();

  constructor(opts: ToolRuntimeOptions) {
    this.registry = opts.registry;
    this.sandbox = opts.sandbox;
    this.#db = opts.db;
    this.#events = opts.events;
    this.#gate = opts.gate;
    this.#audit = opts.audit;
    this.#scope = opts.scope;
    this.#budget = opts.deferBudget ?? (() => Promise.resolve(DEFAULT_DEFER_BUDGET));
    this.#userDefault = opts.userDefault;
    this.#paths = opts.paths ?? {};
    this.#redactor = opts.redactor ?? defaultRedactor;
    this.#log = opts.log ?? new Logger({ module: 'core.tools', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#hooks = opts.hooks;
  }

  scopeFor(accountId: string, threadId: string | null, projectId: string | null) {
    return this.#scope({ accountId, threadId, projectId });
  }

  /**
   * Tools for one turn: snapshot the catalog, hide what policy denies outright. The listing is
   * scoped to the turn's thread and mode, so mode tools (runs, code, requests) are offered only
   * in their threads (M5).
   */
  async beginTurn(input: TurnInput): Promise<TurnTools> {
    const scope = await this.scopeFor(input.accountId, input.threadId, input.projectId);
    const all = await this.registry.list(input.accountId, {
      threadId: input.threadId,
      mode: input.mode,
    });
    const hidden = await this.#deniedOutright(input, scope, all);
    return new TurnTools(this, input, scope, all, hidden);
  }

  /** Every tool as Settings shows it, with the effective decision now (FR-048). */
  async views(accountId: string, threadId: string | null): Promise<ToolView[]> {
    const t = threadId ? this.#thread(accountId, threadId) : null;
    const scope = await this.scopeFor(accountId, threadId, t?.projectId ?? null);
    const all = await this.registry.list(accountId);
    const listing = planListing({
      tools: all.map((d) => d.descriptor),
      budget: await this.#budget(t?.projectId ?? null),
      pinned: new Set(),
      loaded: threadId ? (this.#loaded.get(threadId) ?? []) : [],
    });
    const deferred = new Set(listing.deferred);
    return Promise.all(
      all.map(async (d) => {
        let effective: ToolView['effective'] = {
          effect: 'ask',
          reason: 'the policy engine could not be reached',
          tier: 'pre_approvable',
        };
        let source: string | null = null;
        let fromPreview: ToolView['userDefault'] | undefined;
        try {
          const p = await this.#gate.preview({
            accountId,
            threadId: threadId ?? '',
            projectId: t?.projectId ?? null,
            mode: t?.mode ?? 'chat',
            tool: d.descriptor,
            args: {},
            provenance: { userInstruction: { messageId: '', accountId }, taint: [] },
            profile: scope.profile,
            roots: scope.roots,
          });
          effective = { effect: p.effect, reason: p.reason, tier: p.tier };
          source = p.source;
          if (p.userDefault !== undefined) fromPreview = p.userDefault;
        } catch (err) {
          this.#log.warn('tool preview failed', { err, tool: d.descriptor.name });
        }
        // The gate reports the user's own default; older gates only name the deciding layer.
        let userDefault: ToolView['userDefault'] = null;
        if (this.#userDefault) userDefault = await this.#userDefault(accountId, d.descriptor.name);
        else if (fromPreview !== undefined) userDefault = fromPreview;
        else if (source === 'tool_default' && effective.effect !== 'handoff')
          userDefault = effective.effect;
        return {
          ...d.descriptor,
          deferred: deferred.has(d.descriptor.name),
          userDefault,
          effective,
        };
      }),
    );
  }

  /**
   * Run a tool for the UI (POST /tools/:name/invoke): it passes the gate exactly like a model
   * call. Returns at once; `done` settles when the call finishes. Only a call the signed-in
   * user made themselves (`initiator: 'user'`, a click in a Nova client) carries their
   * instruction; a call an MCP App makes on its own is MCP content and authorizes nothing
   * (FR-189, FR-198), so it is the default.
   */
  async invoke(input: {
    accountId: string;
    name: string;
    args: unknown;
    threadId?: string | null;
    initiator?: 'user' | 'app';
  }): Promise<{ callId: string; done: Promise<InvokeResult> }> {
    const threadId = input.threadId ?? null;
    const t = threadId ? this.#thread(input.accountId, threadId) : null;
    const def = await this.registry.find(input.accountId, input.name);
    if (!def) throw new NovaError('not_found', `no tool named ${input.name}`);
    const scope = await this.scopeFor(input.accountId, threadId, t?.projectId ?? null);
    const callId = uuidv7();
    const done = this.execute({
      callId,
      accountId: input.accountId,
      threadId,
      turnId: null,
      projectId: t?.projectId ?? null,
      mode: t?.mode ?? 'chat',
      origin: 'ui',
      def,
      name: input.name,
      args: input.args,
      modelCallId: null,
      messageId: null,
      partIdx: 0,
      provenance:
        input.initiator === 'user'
          ? // The authenticated user asked for this call in a Nova client (FR-189).
            {
              userInstruction: { messageId: `ui:${callId}`, accountId: input.accountId },
              taint: [],
            }
          : { taint: ['mcp'] },
      scope,
      signal: this.#stop.signal,
      extras: {
        messageId: null,
        network: scope.network,
        deny: scope.deny ?? [],
        cite: (items) => items.map((_, i) => i + 1),
        searchTools: () => [],
      },
    }).then((r) => {
      const out: InvokeResult = { callId: r.callId, ok: r.ok, text: r.text, meta: r.meta ?? null };
      if (r.error) out.error = r.error;
      return out;
    });
    this.#track(done);
    return { callId, done };
  }

  /** The approval a call is waiting for, if the policy area recorded one. */
  pendingApproval(callId: string): string | null {
    try {
      const exists = this.#db.raw
        .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'approval'")
        .get();
      if (!exists) return null;
      const row = this.#db.raw
        .prepare('SELECT id FROM approval WHERE tool_call_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(callId) as { id: string } | undefined;
      return row?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Composer candidates (GET /mentions, FR-022). */
  async mentionCandidates(
    accountId: string,
    q: string,
    threadId: string | null,
  ): Promise<MentionCandidate[]> {
    const t = threadId ? this.#thread(accountId, threadId) : null;
    const scope = await this.scopeFor(accountId, threadId, t?.projectId ?? null);
    const tools = await this.registry.list(accountId);
    return mentionCandidates(q, scope.roots, tools, this.#pathsFor(scope));
  }

  /** Mentions sent with a message, resolved inside the thread's roots (FR-022). */
  async resolveMentions(
    accountId: string,
    threadId: string,
    projectId: string | null,
    mentions: readonly { kind: MentionKind; ref: string }[],
  ): Promise<ResolvedMention[]> {
    if (!mentions.length) return [];
    const scope = await this.scopeFor(accountId, threadId, projectId);
    // A turn's mentions resolve against the tools its thread is offered (M5 scoped listing).
    const tools = await this.registry.list(accountId, {
      threadId,
      mode: this.#thread(accountId, threadId).mode,
    });
    return resolveMentions(mentions, scope.roots, tools, this.#pathsFor(scope));
  }

  /** After a restart: calls left open are cancelled (their turn was interrupted). */
  async recover(): Promise<number> {
    const open = this.#db.raw
      .prepare(
        "SELECT id, message_id AS messageId FROM tool_call WHERE status IN ('pending', 'awaiting_approval', 'running')",
      )
      .all() as { id: string; messageId: string | null }[];
    if (!open.length) return 0;
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      for (const c of open) {
        this.#db.raw
          .prepare(
            "UPDATE tool_call SET status = 'cancelled', error = 'interrupted by a restart', ended_at = ? WHERE id = ?",
          )
          .run(now, c.id);
        this.#patchPartSync(c.id, { status: 'cancelled', error: 'interrupted by a restart' });
      }
    });
    return open.length;
  }

  /** Cancel UI calls in flight and kill every sandbox session. */
  async close(): Promise<void> {
    this.#stop.abort();
    await Promise.allSettled([...this.#running]);
    const killAll = (this.sandbox as { killAll?: () => Promise<void> }).killAll;
    if (killAll) await killAll.call(this.sandbox).catch(() => undefined);
  }

  #pathsFor(scope: ToolScope): PathPolicy {
    if (!scope.deny?.length) return this.#paths;
    return { ...this.#paths, deny: [...(this.#paths.deny ?? []), ...scope.deny] };
  }

  // ---- loaded tools (FR-196) ----------------------------------------------------------------

  loaded(threadId: string): string[] {
    return this.#loaded.get(threadId) ?? [];
  }

  load(threadId: string, names: readonly string[]): void {
    const list = (this.#loaded.get(threadId) ?? []).filter((n) => !names.includes(n));
    list.push(...names);
    this.#loaded.delete(threadId);
    this.#loaded.set(threadId, list);
    for (const key of this.#loaded.keys()) {
      if (this.#loaded.size <= 500) break;
      this.#loaded.delete(key);
    }
  }

  unload(threadId: string, names: readonly string[]): void {
    const list = this.#loaded.get(threadId);
    if (list)
      this.#loaded.set(
        threadId,
        list.filter((n) => !names.includes(n)),
      );
  }

  budget(projectId: string | null): Promise<DeferBudget> {
    return this.#budget(projectId);
  }

  // ---- one call ------------------------------------------------------------------------------

  /** Run one call through validation, the gate and its handler; never throws. */
  async execute(x: ExecInput): Promise<ExecOutput> {
    const callId = x.callId ?? uuidv7();
    const source = x.def?.descriptor.source ?? guessSource(x.name);
    const title = x.def?.descriptor.title ?? x.name;
    const argsPreview = previewOf(x.args, this.#redactor);
    const created = this.#now().toISOString();
    const view: ToolCallPartView = {
      type: 'tool_call',
      callId,
      tool: x.name,
      title,
      source,
      status: 'pending',
      argsPreview,
      resultPreview: null,
      error: null,
      approvalId: null,
      durationMs: null,
    };
    try {
      await this.#db.transaction(async () => {
        await this.#db.orm.insert(toolCall).values({
          id: callId,
          accountId: x.accountId,
          messageId: x.messageId,
          threadId: x.threadId,
          turnId: x.turnId,
          modelCallId: x.modelCallId,
          toolName: x.name,
          source,
          serverId: x.def?.descriptor.serverId ?? null,
          pluginId: x.def?.descriptor.pluginId ?? null,
          origin: x.origin,
          argsJson: this.#argsJson(x.args),
          status: 'pending',
          createdAt: created,
        });
        if (x.messageId) {
          await this.#db.orm.insert(messagePart).values({
            id: uuidv7(),
            messageId: x.messageId,
            idx: x.partIdx,
            type: 'tool_call',
            content: JSON.stringify({ ...view, modelCallId: x.modelCallId }),
            refId: callId,
            createdAt: created,
          });
        }
      });
    } catch (err) {
      this.#log.error('could not record a tool call', { err, tool: x.name });
      return {
        callId,
        status: 'error',
        ok: false,
        text: 'The call could not be recorded and did not run.',
        error: { code: 'server_error', message: 'the call could not be recorded' },
        origin: null,
        stop: null,
        userAnswer: false,
      };
    }
    const correlation = this.#correlation(x, callId);
    await this.#emit({
      name: 'tool.call.started',
      accountId: x.accountId,
      ...(correlation ? { correlation } : {}),
      payload: {
        callId,
        tool: x.name,
        source,
        argsPreview,
        title,
        messageId: x.messageId,
        threadId: x.threadId,
      },
    });

    const finish = (status: ToolCallStatus, result: ToolResult, extra: FinishExtra = {}) =>
      this.#finish(x, callId, view, status, result, extra);

    const def = x.def;
    if (!def)
      return finish('error', {
        ok: false,
        error: { code: 'unknown_tool', message: `There is no tool named ${x.name}.` },
      });
    const problems = validateArgs(def.descriptor.inputSchema, x.args);
    if (problems.length)
      return finish('error', {
        ok: false,
        error: {
          code: 'invalid_arguments',
          message: `The arguments do not match the tool's schema: ${problems.join('; ')}`,
        },
      });

    let resource: GateRequest['resource'];
    const ctx = this.#context(x, callId, def);
    if (isBuiltinTool(def) && def.resource) {
      try {
        resource = def.resource(x.args, ctx);
      } catch {
        resource = undefined;
      }
    }
    // The origin sets the engine's actor (a UI call is the user's own); the roots are exactly
    // those the tool runs with.
    const req: GateRequest = {
      origin: x.origin,
      roots: x.scope.roots,
      accountId: x.accountId,
      threadId: x.threadId ?? '',
      turnId: x.turnId ?? '',
      callId,
      projectId: x.projectId,
      mode: x.mode,
      tool: def.descriptor,
      args: x.args,
      argsPreview,
      provenance: x.provenance,
      profile: x.scope.profile,
    };
    if (resource) req.resource = resource;
    // What the approval card shows besides the arguments (a device write's diff); without it the
    // card shows the arguments alone.
    if (isBuiltinTool(def) && def.approvalDetail) {
      try {
        const detail = await def.approvalDetail(x.args, ctx);
        if (detail) req.argsPreview = `${argsPreview}\n\n${this.#redactor.redactString(detail)}`;
      } catch {
        // The arguments alone.
      }
    }

    // tool.pre hooks (FR-197): a block refuses the call before anything is asked or run.
    let hooks: HookContext[] = [];
    if (this.#hooks && x.origin !== 'hook') {
      const pre = await this.#hook('tool.pre', x, callId, def);
      hooks = this.#hookContext(pre);
      if (pre.block) {
        const reason = this.#redactor.redactString(pre.block.reason);
        return finish(
          'denied',
          { ok: false, error: { code: 'denied', message: `A hook blocked this call: ${reason}` } },
          {
            decision: { effect: 'deny', reason, tier: 'pre_approvable', stop: false },
            resource,
            hooks,
          },
        );
      }
    }

    // The gate itself waits for an approval; a preview tells whether the thread will wait.
    let waiting: boolean;
    try {
      const p = await this.#gate.preview(withoutCallFields(req));
      waiting = p.effect === 'ask' || p.effect === 'handoff';
    } catch {
      waiting = false;
    }
    let outcome: GateOutcome;
    try {
      if (waiting) {
        view.status = 'awaiting_approval';
        await this.#setStatus(callId, view);
        await x.onWaiting?.(true).catch(() => undefined);
      }
      const r = await abortable(this.#gate.check(req, x.signal), x.signal);
      if (r === ABORTED)
        return await finish(
          'cancelled',
          { ok: false, error: { code: 'cancelled', message: 'The call was cancelled.' } },
          { resource, hooks },
        );
      outcome = r;
    } catch (err) {
      // The engine failed: fail closed (AGENTS.md §8).
      this.#log.error('policy gate failed', { err, tool: x.name });
      outcome = {
        effect: 'deny',
        reason: 'the policy engine failed, so the call was not allowed',
        tier: 'pre_approvable',
        stop: false,
      };
    } finally {
      if (waiting) await x.onWaiting?.(false).catch(() => undefined);
    }
    if (outcome.approvalId) view.approvalId = outcome.approvalId;

    if (outcome.effect === 'deny') {
      if (outcome.timeout)
        return finish(
          'timeout',
          {
            ok: false,
            error: {
              code: 'approval_timeout',
              message: 'Nobody answered the approval in time, so the call did not run.',
            },
          },
          { decision: outcome, stop: 'approval_timeout', resource, hooks },
        );
      return finish(
        'denied',
        { ok: false, error: { code: 'denied', message: `Denied: ${outcome.reason}` } },
        { decision: outcome, stop: outcome.stop ? 'deny_stop' : null, resource, hooks },
      );
    }
    if (outcome.effect === 'handoff') {
      const note = outcome.note ? ` Their note: ${outcome.note}` : '';
      return finish(
        'ok',
        {
          ok: true,
          content: [{ type: 'text', text: `The user did this step themselves.${note}` }],
        },
        { decision: outcome, resource, hooks },
      );
    }

    view.status = 'running';
    const startedAt = Date.now();
    await this.#setStatus(callId, view, new Date(startedAt).toISOString());
    const timeoutMs = def.descriptor.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), timeoutMs);
    const signal = AbortSignal.any([x.signal, timer.signal]);
    (ctx as { signal: AbortSignal }).signal = signal;
    let result: ToolResult | typeof ABORTED;
    try {
      result = await abortable(
        def.handler(x.args, ctx).catch((err: unknown): ToolResult => {
          if (signal.aborted) return { ok: false, error: { code: 'aborted', message: 'aborted' } };
          this.#log.warn('tool failed', { err, tool: x.name });
          return {
            ok: false,
            error: {
              code: 'tool_error',
              message: this.#redactor.redactString(
                err instanceof Error ? err.message : String(err),
              ),
            },
          };
        }),
        signal,
      );
    } finally {
      clearTimeout(t);
      this.#flushProgress(callId);
    }
    if (result === ABORTED || (!result.ok && signal.aborted)) {
      if (x.signal.aborted)
        return finish(
          'cancelled',
          { ok: false, error: { code: 'cancelled', message: 'The call was cancelled.' } },
          { decision: outcome, startedAt, resource, hooks },
        );
      return finish(
        'timeout',
        {
          ok: false,
          error: { code: 'timeout', message: `The tool did not finish within ${timeoutMs} ms.` },
        },
        { decision: outcome, startedAt, resource, hooks },
      );
    }
    // A trusted tool that waited for the user in vain (an unanswered ask_user, FR-188; an
    // approval inside a browser or screen action) ends the turn like an approval that timed out,
    // and one whose approval the user answered "Deny and stop" ends it like a denied call.
    // Tools of other sources cannot end the turn this way.
    const trusted = STOPPING_SOURCES.has(def.descriptor.source);
    const stop =
      result.ok || !trusted
        ? null
        : result.error.code === 'approval_timeout'
          ? ('approval_timeout' as const)
          : result.error.code === 'denied_stop'
            ? ('deny_stop' as const)
            : null;
    return finish(result.ok ? 'ok' : 'error', result, {
      decision: outcome,
      startedAt,
      resource,
      hooks,
      post: this.#hooks !== undefined && x.origin !== 'hook',
      ...(stop ? { stop } : {}),
    });
  }

  /** Run a tool hook event; a dispatcher that fails blocks `tool.pre` (fail closed). */
  async #hook(
    event: 'tool.pre' | 'tool.post',
    x: ExecInput,
    callId: string,
    def: ToolDefinition,
    result?: string,
  ): Promise<HookOutcome> {
    // The call's id, and its first root as the hook's working directory.
    const input: HookInput = {
      accountId: x.accountId,
      threadId: x.threadId ?? '',
      turnId: x.turnId,
      projectId: x.projectId,
      tool: def.descriptor,
      args: this.#redactor.redact(x.args ?? null),
      callId,
    };
    const cwd = x.scope.roots[0]?.path;
    if (cwd) input.cwd = cwd;
    if (result !== undefined) input.result = result;
    try {
      return await this.#hooks!.dispatch(event, input, x.signal);
    } catch (err) {
      this.#log.warn('tool hooks failed', { err, event, tool: x.name });
      if (event === 'tool.post') return { context: [] };
      return { context: [], block: { reason: 'the tool hooks could not run', hookId: 'hooks' } };
    }
  }

  #hookContext(out: HookOutcome): HookContext[] {
    return out.context
      .filter((c) => c.text.trim())
      .map((c) => ({
        hookId: c.hookId,
        text: clip(this.#redactor.redactString(c.text), MAX_RESULT_CHARS),
      }));
  }

  async #finish(
    x: ExecInput,
    callId: string,
    view: ToolCallPartView,
    status: ToolCallStatus,
    result: ToolResult,
    extra: FinishExtra,
  ): Promise<ExecOutput> {
    const ended = Date.now();
    const durationMs = extra.startedAt ? ended - extra.startedAt : null;
    const content = this.#resultContent(result);
    const text = contentText(content);
    const hooks = [...(extra.hooks ?? [])];
    // tool.post hooks see the redacted, capped result the model gets (FR-197).
    if (extra.post && x.def && !x.signal.aborted)
      hooks.push(...this.#hookContext(await this.#hook('tool.post', x, callId, x.def, text)));
    const error = result.ok ? null : { code: result.error.code, message: result.error.message };
    const origin = result.ok || status === 'error' ? this.#originOf(x) : null;
    // Only Nova's own `ask_user`, answered by the signed-in user, carries their words (FR-188).
    const userAnswer =
      result.ok &&
      x.name === 'ask_user' &&
      x.def !== null &&
      isBuiltinTool(x.def) &&
      x.def.descriptor.source === 'builtin' &&
      result.meta?.userAnswer === true;
    view.status = status;
    view.durationMs = durationMs;
    view.resultPreview = clip(text, 300);
    view.error = error ? clip(this.#redactor.redactString(error.message), 500) : null;
    const now = this.#now().toISOString();
    const stored: StoredResult = {
      callId,
      modelCallId: x.modelCallId,
      tool: x.name,
      origin,
      isError: !result.ok,
      content,
    };
    if (hooks.length) stored.hooks = hooks;
    if (userAnswer) stored.userAnswer = true;
    const artifact = result.ok
      ? (result.meta?.artifact as Record<string, unknown> | undefined)
      : undefined;
    const meta = result.ok ? this.#meta(result.meta) : null;
    try {
      await this.#db.transaction(async () => {
        await this.#db.orm
          .update(toolCall)
          .set({
            status,
            resultJson: JSON.stringify({ content, meta }),
            error: view.error,
            decision: extra.decision?.effect ?? null,
            approvalId: view.approvalId,
            endedAt: now,
            durationMs,
          })
          .where(eq(toolCall.id, callId));
        if (x.messageId) {
          await this.#patchPart(callId, view, x.modelCallId);
          await this.#db.orm.insert(messagePart).values({
            id: uuidv7(),
            messageId: x.messageId,
            idx: x.partIdx + 1,
            type: 'tool_result',
            content: JSON.stringify(stored),
            refId: callId,
            createdAt: now,
          });
          if (artifact && typeof artifact.id === 'string') {
            await this.#db.orm.insert(messagePart).values({
              id: uuidv7(),
              messageId: x.messageId,
              idx: x.partIdx + 2,
              type: 'artifact_ref',
              content: JSON.stringify({
                artifactId: artifact.id,
                kind: artifact.kind,
                title: artifact.title ?? null,
              }),
              refId: artifact.id,
              createdAt: now,
            });
          }
        }
      });
    } catch (err) {
      this.#log.error('could not save a tool result', { err, callId });
    }
    const correlation = this.#correlation(x, callId);
    await this.#emit({
      name: 'tool.call.completed',
      accountId: x.accountId,
      ...(correlation ? { correlation } : {}),
      payload: {
        callId,
        tool: x.name,
        status,
        durationMs,
        resultPreview: view.resultPreview,
        messageId: x.messageId,
        threadId: x.threadId,
      },
    });
    const d = extra.decision ?? null;
    try {
      await this.#audit?.append({
        accountId: x.accountId,
        actor: x.origin === 'ui' ? 'user' : 'system',
        kind: 'tool_call',
        action: x.name,
        resource: extra.resource?.value ?? null,
        inputHash: inputHash({ tool: x.name, args: x.args }),
        decision: d?.effect ?? null,
        result: status,
        threadId: x.threadId,
        turnId: x.turnId,
        detail: {
          callId,
          source: view.source,
          origin: x.origin,
          tier: d?.tier ?? null,
          approvalId: view.approvalId,
          profile: x.scope.profile.id,
          profileHash: x.scope.profile.hash,
          durationMs,
          taint: x.provenance.taint,
          userAsked: !!x.provenance.userInstruction,
        },
      });
    } catch (err) {
      this.#log.error('could not audit a tool call', { err, callId });
    }
    return {
      callId,
      status,
      ok: result.ok,
      text,
      error,
      origin,
      stop: extra.stop ?? null,
      userAnswer,
      meta,
    };
  }

  /** Content returned to the model: redacted, capped text; small images kept. */
  #resultContent(result: ToolResult): ContentPart[] {
    if (!result.ok) {
      let text = `Error (${result.error.code}): ${result.error.message}`;
      if (result.error.details !== undefined) {
        try {
          text += `\nDetails: ${clip(JSON.stringify(result.error.details), 2000)}`;
        } catch {
          // details that cannot be serialized are left out
        }
      }
      return [{ type: 'text', text: this.#redactor.redactString(text) }];
    }
    const out: ContentPart[] = [];
    let text = '';
    let imageBytes = 0;
    for (const p of result.content) {
      if (p.type === 'text') text += p.text;
      else if (p.type === 'image') {
        const size = Math.ceil((p.data.length * 3) / 4);
        if (imageBytes + size <= MAX_IMAGE_BYTES) {
          imageBytes += size;
          out.push({ type: 'image', mime: p.mime, data: p.data });
        } else text += `\n[image ${p.mime} left out: too large]`;
      } else if (p.type === 'tool_result') text += contentText(p.content);
    }
    const capped = capHeadTail(this.#redactor.redactString(text), MAX_RESULT_CHARS);
    return [{ type: 'text', text: capped.text || '(no output)' }, ...out];
  }

  #meta(meta: Record<string, unknown> | undefined): unknown {
    if (!meta) return null;
    try {
      const json = JSON.stringify(this.#redactor.redact(meta));
      return json.length > 20_000 ? { truncated: true } : (JSON.parse(json) as unknown);
    } catch {
      return null;
    }
  }

  #argsJson(args: unknown): string {
    let json: string;
    try {
      json = JSON.stringify(this.#redactor.redact(args ?? null)) ?? 'null';
    } catch {
      json = 'null';
    }
    if (json.length <= MAX_ARGS_JSON) return json;
    return JSON.stringify({ truncated: true, preview: clip(json, 2000) });
  }

  #originOf(x: ExecInput): Origin | null {
    const def = x.def;
    if (!def) return null;
    if (isBuiltinTool(def)) return def.origin;
    switch (def.descriptor.source) {
      case 'mcp':
        return 'mcp';
      case 'plugin':
        return 'plugin';
      case 'page':
      case 'browser':
        return 'page';
      default:
        return 'tool';
    }
  }

  #context(x: ExecInput, callId: string, def: ToolDefinition): ToolContext {
    const ctx: BuiltinContext = {
      accountId: x.accountId,
      threadId: x.threadId ?? '',
      turnId: x.turnId ?? '',
      callId,
      projectId: x.projectId,
      origin: x.origin,
      profile: x.scope.profile,
      roots: x.scope.roots,
      sandbox: this.sandbox,
      signal: x.signal,
      log: this.#log.child(def.descriptor.name),
      progress: (chunk) => this.#progress(x, callId, chunk),
      extras: x.extras,
    };
    return ctx;
  }

  readonly #pendingProgress = new Map<
    string,
    { chunks: string[]; timer: ReturnType<typeof setTimeout>; x: ExecInput }
  >();

  /** Coalesce progress to at most ~20 events per second per call (contracts/events.md). */
  #progress(x: ExecInput, callId: string, chunk: string): void {
    const p = this.#pendingProgress.get(callId);
    if (p) {
      p.chunks.push(chunk);
      return;
    }
    this.#pendingProgress.set(callId, {
      chunks: [chunk],
      x,
      timer: setTimeout(() => this.#flushProgress(callId), 50),
    });
  }

  #flushProgress(callId: string): void {
    const p = this.#pendingProgress.get(callId);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pendingProgress.delete(callId);
    const correlation = this.#correlation(p.x, callId);
    this.#events.emitEphemeral({
      name: 'tool.call.progress',
      accountId: p.x.accountId,
      ...(correlation ? { correlation } : {}),
      payload: { callId, chunk: clip(p.chunks.join(''), 8000) },
    });
  }

  #correlation(
    x: ExecInput,
    callId: string,
  ): { threadId?: string; turnId?: string; callId: string } | null {
    const c: { threadId?: string; turnId?: string; callId: string } = { callId };
    if (x.threadId) c.threadId = x.threadId;
    if (x.turnId) c.turnId = x.turnId;
    return c;
  }

  async #emit(e: Parameters<EventSink['emit']>[0]): Promise<void> {
    try {
      await this.#events.emit(e);
    } catch (err) {
      this.#log.warn('could not publish a tool event', { err, name: e.name });
    }
  }

  async #setStatus(callId: string, view: ToolCallPartView, startedAt?: string): Promise<void> {
    try {
      await this.#db.transaction(async () => {
        await this.#db.orm
          .update(toolCall)
          .set(startedAt ? { status: view.status, startedAt } : { status: view.status })
          .where(eq(toolCall.id, callId));
        await this.#patchPart(callId, view);
      });
    } catch (err) {
      this.#log.warn('could not update a tool call', { err, callId });
    }
  }

  async #patchPart(callId: string, view: ToolCallPartView, modelCallId?: string | null) {
    const rows = await this.#db.orm
      .select({ id: messagePart.id, content: messagePart.content })
      .from(messagePart)
      .where(eq(messagePart.refId, callId));
    for (const r of rows) {
      let prev: Record<string, unknown>;
      try {
        prev = JSON.parse(r.content ?? '{}') as Record<string, unknown>;
      } catch {
        prev = {};
      }
      if (prev.type !== 'tool_call') continue;
      const next: Record<string, unknown> = { ...prev, ...view };
      if (modelCallId !== undefined) next.modelCallId = modelCallId;
      await this.#db.orm
        .update(messagePart)
        .set({ content: JSON.stringify(next) })
        .where(eq(messagePart.id, r.id));
    }
  }

  #patchPartSync(callId: string, patch: Partial<ToolCallPartView>): void {
    const rows = this.#db.raw
      .prepare("SELECT id, content FROM message_part WHERE ref_id = ? AND type = 'tool_call'")
      .all(callId) as { id: string; content: string | null }[];
    for (const r of rows) {
      let prev: Record<string, unknown>;
      try {
        prev = JSON.parse(r.content ?? '{}') as Record<string, unknown>;
      } catch {
        prev = {};
      }
      this.#db.raw
        .prepare('UPDATE message_part SET content = ? WHERE id = ?')
        .run(JSON.stringify({ ...prev, ...patch }), r.id);
    }
  }

  async #deniedOutright(
    input: TurnInput,
    scope: ToolScope,
    all: readonly ToolDefinition[],
  ): Promise<Set<string>> {
    const hidden = new Set<string>();
    await Promise.all(
      all.map(async (d) => {
        try {
          const p = await this.#gate.preview({
            accountId: input.accountId,
            threadId: input.threadId,
            projectId: input.projectId,
            mode: input.mode,
            tool: d.descriptor,
            args: {},
            provenance: { taint: [] },
            profile: scope.profile,
            roots: scope.roots,
          });
          if (p.effect === 'deny') hidden.add(d.descriptor.name);
        } catch {
          // listed; the call itself still passes the gate and fails closed there
        }
      }),
    );
    return hidden;
  }

  #thread(accountId: string, threadId: string): { projectId: string | null; mode: ThreadMode } {
    const row = this.#db.raw
      .prepare(
        'SELECT project_id AS projectId, mode FROM thread WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
      )
      .get(threadId, accountId) as { projectId: string | null; mode: ThreadMode } | undefined;
    if (!row) throw new NovaError('not_found', 'thread not found');
    return row;
  }

  #track(p: Promise<unknown>): void {
    const t = p.catch(() => undefined);
    this.#running.add(t);
    void t.finally(() => this.#running.delete(t));
  }
}

/** The tools of one turn: listing with deferral, calls, and cleanup (docs/09 §2). */
export class TurnTools {
  readonly scope: ToolScope;
  readonly #runtime: ToolRuntime;
  readonly #input: TurnInput;
  readonly #all: ToolDefinition[];
  readonly #hidden: Set<string>;
  readonly #pinned: Set<string>;
  #deferred: ToolDescriptor[] = [];

  constructor(
    runtime: ToolRuntime,
    input: TurnInput,
    scope: ToolScope,
    all: ToolDefinition[],
    hidden: Set<string>,
  ) {
    this.#runtime = runtime;
    this.#input = input;
    this.scope = scope;
    this.#all = all;
    this.#hidden = hidden;
    this.#pinned = new Set(input.pinned ?? []);
  }

  /** Tools named by mentions are loaded and never deferred this turn (FR-196). */
  pin(names: readonly string[]): void {
    for (const n of names) this.#pinned.add(n);
  }

  /** The model's tool list for the next step, plus the system-prompt section about tools. */
  async offer(): Promise<{ tools: ToolSchema[]; system: string }> {
    const visible = this.#all.filter((d) => !this.#hidden.has(d.descriptor.name));
    const listing = planListing({
      tools: visible.map((d) => d.descriptor),
      budget: await this.#runtime.budget(this.#input.projectId),
      pinned: this.#pinned,
      loaded: this.#runtime.loaded(this.#input.threadId),
    });
    if (listing.unloaded.length) this.#runtime.unload(this.#input.threadId, listing.unloaded);
    const offered = new Set(listing.offered);
    // tool.search only helps when something is deferred; small models get a shorter list.
    if (!listing.deferred.length) offered.delete('tool.search');
    const deferred = new Set(listing.deferred);
    this.#deferred = visible
      .filter((d) => deferred.has(d.descriptor.name))
      .map((d) => d.descriptor);
    const tools = visible
      .filter((d) => offered.has(d.descriptor.name))
      .map((d) => ({
        name: d.descriptor.name,
        description: d.descriptor.description,
        inputSchema: d.descriptor.inputSchema,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const roots = this.scope.roots
      .map(
        (r, i) =>
          `- ${r.path} (${r.access === 'write' ? 'read and write' : 'read only'}${i === 0 ? ', relative paths start here' : ''})`,
      )
      .join('\n');
    const lines = ['## Tools', UNTRUSTED_RULES];
    // A session on another machine has no folder on the Hub: its tools reach the folder there.
    const remote = remoteFilesFor(
      this.#runtime.sandbox,
      this.#input.accountId,
      this.#input.threadId,
    );
    if (remote)
      lines.push(
        `Folders the file and command tools can use:\n- ${remote.root} on ${remote.label} (${remote.access === 'write' ? 'read and write' : 'read only'}, relative paths start here)`,
      );
    else if (remote === null)
      lines.push(
        "The session's folder is on another machine that cannot be reached now; file and command tools will fail.",
      );
    else if (roots) lines.push(`Folders the file and command tools can use:\n${roots}`);
    else lines.push('No folders are available to file and command tools.');
    if (listing.summary.length)
      lines.push(
        `More tools are available but not loaded; find them with tool.search:\n${listing.summary.map((s) => `- ${s}`).join('\n')}`,
      );
    return { tools, system: lines.join('\n\n') };
  }

  /** Run one model tool call. */
  async call(input: CallInput): Promise<CallOutcome> {
    const def = this.#all.find((d) => d.descriptor.name === input.call.name) ?? null;
    const extras: CallExtras = {
      messageId: input.messageId,
      network: this.scope.network,
      deny: this.scope.deny ?? [],
      cite: input.cite ?? ((items) => items.map((_, i) => i + 1)),
      searchTools: (query, limit) => this.#search(query, limit),
    };
    const r = await this.#runtime.execute({
      accountId: this.#input.accountId,
      threadId: this.#input.threadId,
      turnId: this.#input.turnId,
      projectId: this.#input.projectId,
      mode: this.#input.mode,
      origin: 'model',
      def,
      name: input.call.name,
      args: input.call.args,
      modelCallId: input.call.id,
      messageId: input.messageId,
      partIdx: input.partIdx,
      provenance: input.provenance,
      scope: this.scope,
      signal: this.#input.signal,
      extras,
      onWaiting: input.onWaiting,
    });
    const out: CallOutcome = { callId: r.callId, status: r.status, origin: r.origin, stop: r.stop };
    if (r.userAnswer) out.userAnswer = true;
    return out;
  }

  /** Kill the turn's exec sessions (cancel, end of turn; FR-184). */
  async end(): Promise<void> {
    try {
      await this.#runtime.sandbox.killTurn(this.#input.turnId);
    } catch {
      // the sandbox is gone; nothing left to kill
    }
  }

  #search(query: string, limit: number): ToolSearchHit[] {
    const hits = rankTools(this.#deferred, query, Math.min(Math.max(limit, 1), 20));
    if (hits.length)
      this.#runtime.load(
        this.#input.threadId,
        hits.map((h) => h.name),
      );
    return hits;
  }
}

function guessSource(name: string): ToolSource {
  if (name.startsWith('mcp:')) return 'mcp';
  if (name.startsWith('plugin:')) return 'plugin';
  if (name.startsWith('page:')) return 'page';
  return 'builtin';
}

function withoutCallFields(
  req: GateRequest,
): Omit<GateRequest, 'callId' | 'turnId' | 'argsPreview'> {
  const { callId: _c, turnId: _t, argsPreview: _a, ...rest } = req;
  return rest;
}

async function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return ABORTED;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([p, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    p.catch(() => undefined);
  }
}

/** A mention group key for a server (exported for the Hub's candidates). */
export { sourceGroup };
