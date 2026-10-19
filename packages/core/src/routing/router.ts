// The Hub's model router (docs/07 §8-§9, §12; docs/21 §4-§5; FR-023, FR-127, FR-221). It lists
// presets, account models and compute-node models; resolves a ref to ordered targets (presets
// by strategy, local models across every place that serves them by `routing.order`); and
// streams with retries, fallback before any output, and a circuit breaker per provider account
// or node. Cloud targets are dropped when `routing.allowCloud` is off (fail closed).
import {
  NovaError,
  parseAnyModelRef,
  presetRef,
  type ModelRef,
  type ModelView,
  type Preset,
  type RoutingStep,
} from '@nova/shared';
import type { AgentErrorShape, CallContext, ChatRequest, StreamEvent } from '@nova/providers';
import { Logger } from '@nova/telemetry';
import type { AccountModel, ProviderRegistry, ResolvedModel } from '../registry.ts';
import { CircuitBreaker, type BreakerOptions } from './breaker.ts';
import { BUILT_IN_PRESET_IDS, generatePresets, type PresetCandidate } from './presets.ts';
import {
  DEFAULT_RETRY,
  isTransient,
  retryDelay,
  abortableSleep,
  toAgentError,
  type RetryPolicy,
} from './retry.ts';
import type {
  ModelRoute,
  ModelRouter,
  ModelSource,
  RoutedEvent,
  RouteOptions,
  RouteTarget,
} from './types.ts';
import { managedDenied } from '../managed/restrictions.ts';

export type { RoutingStep };

export interface RoutingSettings {
  /** `models.presets`; empty means the generated built-ins. */
  presets: Preset[];
  /** `routing.order`. */
  order: RoutingStep[];
  /** `routing.allowCloud`. */
  allowCloud: boolean;
  /**
   * The provider kinds managed policy allows models from (`node` for compute nodes); null or
   * absent: any (FR-106, `ManagedRestrictions.providers`).
   */
  providers?: readonly string[] | null;
}

/** Targets of provider kinds managed policy allows; refused with `policy_denied` when none is. */
function managedTargets<T extends { providerKind: string }>(
  targets: T[],
  settings: RoutingSettings,
  model: string,
): T[] {
  const allowed = settings.providers;
  if (!allowed) return targets;
  const out = targets.filter((t) => allowed.includes(t.providerKind));
  if (!out.length)
    throw managedDenied(
      `the models of ${model} come from providers your organization's policy does not allow`,
      { model },
    );
  return out;
}

export interface RouterOptions {
  registry: ProviderRegistry;
  /** Extra model sources, such as registered compute nodes (FR-126). */
  sources?: ModelSource[];
  /** The account's routing settings after precedence (docs/14 §1). */
  settings: (accountId: string) => Promise<RoutingSettings>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  random?: () => number;
  retry?: Partial<RetryPolicy>;
  breaker?: Partial<Omit<BreakerOptions, 'now'>>;
  log?: Logger;
}

/** A target reached through a preset (it may fix reasoning level and speed). */
export type PresetTarget = RouteTarget;

type Outcome = { kind: 'done' } | { kind: 'retry'; error: AgentErrorShape };

const ALL_OPEN: AgentErrorShape = {
  code: 'provider_error',
  message: 'The model is unavailable after repeated failures; try again shortly',
  retryable: true,
  action: 'Try again shortly',
};

const ENDED: AgentErrorShape = {
  code: 'provider_error',
  message: 'The response ended unexpectedly',
  retryable: true,
};

export class Router implements ModelRouter {
  readonly #registry: ProviderRegistry;
  readonly #sources: ModelSource[];
  readonly #settings: (accountId: string) => Promise<RoutingSettings>;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<boolean>;
  readonly #random: () => number;
  readonly #retry: RetryPolicy;
  readonly #breaker: CircuitBreaker;
  readonly #log: Logger;
  /** Streams this router has open per breaker key, for least-loaded ordering. */
  readonly #inflight = new Map<string, number>();
  /** Provider-reported prices of resolved targets, for cost ordering. */
  readonly #reportedCost = new WeakMap<RouteTarget, number>();

  constructor(opts: RouterOptions) {
    this.#registry = opts.registry;
    this.#sources = opts.sources ?? [];
    this.#settings = opts.settings;
    this.#sleep = opts.sleep ?? abortableSleep;
    this.#random = opts.random ?? Math.random;
    this.#retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.#breaker = new CircuitBreaker({ ...opts.breaker, now: opts.now ?? Date.now });
    this.#log = opts.log ?? new Logger({ module: 'core.router', sinks: [] });
  }

  // ---- listing ----------------------------------------------------------------------------

  /** Presets first (by rank), then provider-account models, then compute-node models. */
  async listModels(accountId: string): Promise<ModelView[]> {
    const [settings, accounts, nodes] = await Promise.all([
      this.#settings(accountId),
      this.#registry.accountModels(accountId),
      this.#sourceModels(accountId),
    ]);
    const presets = settings.presets.length
      ? settings.presets
      : generatePresets(candidates(accounts, nodes, settings.allowCloud));
    const available = new Map<ModelRef, boolean>();
    for (const a of accounts) available.set(a.view.ref, a.local);
    for (const n of nodes) available.set(n.ref, true);
    const views = [...presets]
      .sort((a, b) => a.rank - b.rank)
      .map((p) => presetView(p, available, settings.allowCloud));
    return [...views, ...accounts.map((a) => a.view), ...nodes];
  }

  /** The built-in presets as they would be generated now (GET /presets when none are saved). */
  async builtInPresets(accountId: string): Promise<Preset[]> {
    const [settings, accounts, nodes] = await Promise.all([
      this.#settings(accountId),
      this.#registry.accountModels(accountId),
      this.#sourceModels(accountId),
    ]);
    return generatePresets(candidates(accounts, nodes, settings.allowCloud));
  }

  /** M1 rule: the first model of the first account; else the first node model. */
  async firstModel(accountId: string): Promise<ModelRef | null> {
    const accounts = await this.#registry.listModels(accountId);
    if (accounts[0]) return accounts[0].ref;
    return (await this.#sourceModels(accountId))[0]?.ref ?? null;
  }

  async usable(accountId: string, ref: ModelRef): Promise<boolean> {
    try {
      const p = parseAnyModelRef(ref);
      if (!p) return false;
      if (p.kind === 'account') {
        await this.#registry.account(accountId, p.providerAccountId);
        return true;
      }
      if (p.kind === 'node') return (await this.#sourceTargets(accountId, ref)).length > 0;
      const s = await this.#settings(accountId);
      return s.presets.length
        ? s.presets.some((x) => x.id === p.presetId)
        : BUILT_IN_PRESET_IDS.includes(p.presetId);
    } catch {
      return false;
    }
  }

  pricing(accountId: string, providerKind: string, modelId: string) {
    return this.#registry.pricing(accountId, providerKind, modelId);
  }

  // ---- routing ----------------------------------------------------------------------------

  async route(accountId: string, ref: ModelRef, opts: RouteOptions = {}): Promise<ModelRoute> {
    const parsed = parseAnyModelRef(ref);
    if (!parsed) throw unknownModel(ref);
    const settings = await this.#settings(accountId);
    if (parsed.kind === 'preset') {
      return {
        requested: ref,
        targets: await this.#routePreset(accountId, parsed.presetId, settings, opts),
      };
    }

    let candidates: RouteTarget[];
    if (parsed.kind === 'account') {
      const primary = this.#target(await this.#registry.resolve(accountId, ref));
      candidates = [primary, ...(await this.#gather(accountId, primary))];
    } else {
      const own = await this.#sourceTargets(accountId, ref);
      if (!own[0]) throw unknownModel(ref);
      candidates = [...own, ...(await this.#gather(accountId, own[0]))];
    }
    const permitted = managedTargets(candidates, settings, ref);
    const allowed = settings.allowCloud ? permitted : permitted.filter((t) => t.local);
    if (!allowed.length) {
      throw new NovaError(
        'validation',
        'cloud models are turned off in routing settings; choose a local model',
        { details: { reason: 'cloud_disabled', model: ref } },
      );
    }
    // An explicitly chosen model is kept even without vision: the engine sends a note in place
    // of the image (FR-021); routing only prefers places that can see it.
    return { requested: ref, targets: await this.#order(accountId, allowed, settings.order, opts) };
  }

  /** Every other local place serving the same model id, for a local model (FR-127). */
  async #gather(accountId: string, primary: RouteTarget): Promise<RouteTarget[]> {
    if (!primary.local || primary.providerKind === 'mock') return [];
    const out: RouteTarget[] = [];
    for (const s of this.#sources) {
      try {
        out.push(...(await s.targetsForModel(accountId, primary.modelId)));
      } catch (err) {
        this.#log.warn('model source failed', { error: errorText(err) });
      }
    }
    const servers = await this.#registry.localServing(
      accountId,
      primary.modelId,
      primary.providerAccountId ?? '',
    );
    out.push(...servers.map((r) => this.#target(r)));
    const seen = new Set([primary.ref]);
    return out.filter((t) => (seen.has(t.ref) ? false : (seen.add(t.ref), true)));
  }

  async #routePreset(
    accountId: string,
    presetId: string,
    settings: RoutingSettings,
    opts: RouteOptions,
  ): Promise<PresetTarget[]> {
    const preset = settings.presets.length
      ? settings.presets.find((p) => p.id === presetId)
      : (await this.builtInPresets(accountId)).find((p) => p.id === presetId);
    if (!preset) throw unknownModel(presetRef(presetId));

    const resolved: PresetTarget[] = [];
    for (const ref of preset.targets) {
      const p = parseAnyModelRef(ref);
      if (!p || p.kind === 'preset') continue;
      if (p.kind === 'account') {
        // A model the provider no longer lists is unavailable; an unlisted cache is tried.
        const listed = this.#registry.cachedModels(p.providerAccountId);
        if (listed && !listed.some((m) => m.id === p.modelId)) continue;
        try {
          const t = this.#target(await this.#registry.resolve(accountId, ref));
          resolved.push(this.#withPreset(t, preset));
        } catch {
          // its account was removed
        }
      } else {
        for (const t of await this.#sourceTargets(accountId, ref))
          resolved.push(this.#withPreset(t, preset));
      }
    }

    const fail = (reason: string, message: string) =>
      new NovaError('validation', message, {
        details: { reason, model: presetRef(preset.id), preset: preset.id },
      });
    if (!resolved.length)
      throw fail(
        'preset_unavailable',
        `none of the models in the ${preset.label} preset are available; choose another model`,
      );
    const permitted = managedTargets(resolved, settings, presetRef(preset.id));
    let usable = settings.allowCloud ? permitted : permitted.filter((t) => t.local);
    if (!usable.length)
      throw fail(
        'cloud_disabled',
        `the ${preset.label} preset uses only cloud models, and cloud models are turned off`,
      );
    if (opts.needsVision) {
      usable = usable.filter((t) => t.vision);
      if (!usable.length)
        throw fail(
          'vision_required',
          `no model in the ${preset.label} preset can view images; choose a vision model or remove the image`,
        );
    }
    switch (preset.strategy) {
      case 'single':
        return usable.slice(0, 1);
      case 'cheapest': {
        const costs = await Promise.all(usable.map((t) => this.#cost(accountId, t)));
        return usable
          .map((t, i) => ({ t, c: costs[i]!, i }))
          .sort((a, b) => a.c - b.c || a.i - b.i)
          .map((x) => x.t);
      }
      case 'fallback':
      case 'best':
        return usable;
    }
  }

  /** Order candidates by `routing.order` (docs/21 §5); ties keep the candidate order. */
  async #order(
    accountId: string,
    targets: RouteTarget[],
    order: RoutingStep[],
    opts: RouteOptions,
  ): Promise<RouteTarget[]> {
    if (targets.length < 2) return targets;
    const keyed = await Promise.all(
      targets.map(async (t, i) => ({
        t,
        i,
        k: await Promise.all(order.map((step) => this.#stepKey(accountId, step, t, opts))),
      })),
    );
    keyed.sort((a, b) => {
      for (let j = 0; j < a.k.length; j++) {
        const d = a.k[j]! - b.k[j]!;
        if (d) return d;
      }
      return a.i - b.i;
    });
    return keyed.map((x) => x.t);
  }

  async #stepKey(
    accountId: string,
    step: RoutingStep,
    t: RouteTarget,
    opts: RouteOptions,
  ): Promise<number> {
    switch (step) {
      case 'same_device':
        return t.location.kind === 'hub' && t.local ? 0 : 1;
      case 'capability': {
        const vision = opts.needsVision && !t.vision ? 1 : 0;
        const reasoning = t.reasoningLevel && t.reasoningLevel !== 'off' && !t.reasoning ? 1 : 0;
        return vision + reasoning;
      }
      case 'least_loaded':
        return this.#load(t);
      case 'cost':
        return this.#cost(accountId, t);
      case 'cloud':
        return t.local ? 0 : 1;
    }
  }

  #load(t: RouteTarget): number {
    if (t.location.kind === 'node') {
      for (const s of this.#sources) {
        const l = s.load(t.location.nodeId);
        if (l) return l.running + l.queued;
      }
    }
    return this.#inflight.get(breakerKey(t)) ?? 0;
  }

  /** Per-1M price sum: the user's price, else the provider's, else 0 locally, else unknown. */
  async #cost(accountId: string, t: RouteTarget): Promise<number> {
    const price = await this.#registry
      .pricing(accountId, t.providerKind, t.modelId)
      .catch(() => null);
    if (price) return price.costIn + price.costOut;
    const reported = this.#reportedCost.get(t);
    if (reported !== undefined) return reported;
    return t.local ? 0 : Number.POSITIVE_INFINITY;
  }

  #target(r: ResolvedModel): RouteTarget {
    const t: RouteTarget = {
      ref: r.ref,
      provider: r.provider,
      providerKind: r.account.provider,
      providerAccountId: r.account.id,
      modelId: r.modelId,
      vision: r.vision,
      reasoning: r.reasoning,
      location: { kind: 'hub' },
      local: r.local,
    };
    if (r.costIn !== undefined || r.costOut !== undefined)
      this.#reportedCost.set(t, (r.costIn ?? 0) + (r.costOut ?? 0));
    return t;
  }

  /** A copy of the target carrying the preset's reasoning level and speed. */
  #withPreset(t: RouteTarget, p: Preset): PresetTarget {
    const out: PresetTarget = { ...t };
    if (p.reasoningLevel) out.reasoningLevel = p.reasoningLevel;
    if (p.speed) out.speed = p.speed;
    const cost = this.#reportedCost.get(t);
    if (cost !== undefined) this.#reportedCost.set(out, cost);
    return out;
  }

  async #sourceModels(accountId: string): Promise<ModelView[]> {
    const lists = await Promise.all(
      this.#sources.map(async (s) => {
        try {
          return await s.listModels(accountId);
        } catch (err) {
          this.#log.warn('model source list failed', { error: errorText(err) });
          return [];
        }
      }),
    );
    return lists.flat();
  }

  async #sourceTargets(accountId: string, ref: ModelRef): Promise<RouteTarget[]> {
    const out: RouteTarget[] = [];
    for (const s of this.#sources) {
      try {
        out.push(...(await s.targets(accountId, ref)));
      } catch (err) {
        this.#log.warn('model source failed', { error: errorText(err) });
      }
    }
    return out;
  }

  // ---- streaming --------------------------------------------------------------------------

  /**
   * Try each target in order. A transient failure before any content is retried on the same
   * target (backoff with jitter, Retry-After up to the cap), then the next target is tried.
   * Once content has streamed, or on a non-transient error, the attempt's outcome is final.
   */
  async *stream(
    route: ModelRoute,
    req: Omit<ChatRequest, 'model'>,
    ctx: CallContext,
  ): AsyncIterable<RoutedEvent> {
    if (!route.targets.length) throw new NovaError('validation', 'no model to run this turn');
    let last: AgentErrorShape | null = null;
    for (const [i, target] of route.targets.entries()) {
      const key = breakerKey(target);
      for (let retry = 0; ; retry++) {
        if (!this.#breaker.tryAcquire(key)) {
          this.#log.info('circuit open, skipping target', { key, ref: target.ref });
          break;
        }
        const reason =
          retry > 0 && last
            ? `retry after ${last.code}`
            : i > 0 && last
              ? `fallback after ${last.code}`
              : undefined;
        yield reason
          ? { type: 'route', target, attempt: retry + 1, reason }
          : { type: 'route', target, attempt: retry + 1 };
        const outcome = yield* this.#attempt(target, req, ctx, key);
        if (outcome.kind === 'done') return;
        last = outcome.error;
        if (req.signal.aborted) {
          yield { type: 'stop', reason: 'cancelled' };
          return;
        }
        if (retry >= this.#retry.maxRetries) break;
        const wait = retryDelay(retry + 1, last, this.#retry, this.#random);
        if (wait === null) break; // asked to wait longer than allowed: move on
        if (!(await this.#sleep(wait, req.signal))) {
          yield { type: 'stop', reason: 'cancelled' };
          return;
        }
      }
      if (last) this.#log.info('falling back', { from: target.ref, code: last.code });
    }
    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }
    yield { type: 'stop', reason: 'error', error: last ?? ALL_OPEN };
  }

  async *#attempt(
    target: RouteTarget,
    req: Omit<ChatRequest, 'model'>,
    ctx: CallContext,
    key: string,
  ): AsyncGenerator<RoutedEvent, Outcome> {
    let content = false;
    let verdict: 'success' | 'failure' | 'none' = 'none';
    this.#inflight.set(key, (this.#inflight.get(key) ?? 0) + 1);
    try {
      for await (const e of target.provider.stream(requestFor(target, req), ctx)) {
        if (e.type === 'stop') {
          if (e.reason === 'error') {
            const error = e.error ?? { ...ENDED, retryable: false };
            const transient = isTransient(error);
            verdict = transient ? 'failure' : 'success';
            if (transient && !content) return { kind: 'retry', error };
          } else if (e.reason !== 'cancelled') {
            verdict = 'success';
          }
          yield e;
          return { kind: 'done' };
        }
        if (isContent(e)) content = true;
        yield e;
      }
      if (req.signal.aborted) return { kind: 'done' };
      // The stream ended without a stop event.
      verdict = 'failure';
      return content ? { kind: 'done' } : { kind: 'retry', error: ENDED };
    } catch (err) {
      if (req.signal.aborted) {
        yield { type: 'stop', reason: 'cancelled' };
        return { kind: 'done' };
      }
      const error = toAgentError(err);
      const transient = isTransient(error);
      verdict = transient ? 'failure' : 'success';
      if (transient && !content) return { kind: 'retry', error };
      yield { type: 'stop', reason: 'error', error };
      return { kind: 'done' };
    } finally {
      const n = (this.#inflight.get(key) ?? 1) - 1;
      if (n > 0) this.#inflight.set(key, n);
      else this.#inflight.delete(key);
      if (verdict === 'success') this.#breaker.success(key);
      else if (verdict === 'failure') this.#breaker.failure(key);
      else this.#breaker.release(key);
    }
  }
}

// ---- helpers ------------------------------------------------------------------------------

/** The provider request for a target: its model id, a preset's level and speed (docs/07 §6). */
export function requestFor(target: RouteTarget, req: Omit<ChatRequest, 'model'>): ChatRequest {
  const r: ChatRequest = { ...req, model: target.modelId };
  if (target.reasoningLevel) r.reasoning = { level: target.reasoningLevel };
  // A model without reasoning would reject the parameter (FR-024 hides the selector for it).
  if (!target.reasoning) delete r.reasoning;
  const speed = target.speed;
  if (speed) r.speed = speed;
  return r;
}

export function breakerKey(t: RouteTarget): string {
  return t.location.kind === 'node'
    ? `node:${t.location.nodeId}`
    : `account:${t.providerAccountId ?? t.ref}`;
}

function isContent(e: StreamEvent): boolean {
  return (
    e.type === 'text_delta' ||
    e.type === 'reasoning_delta' ||
    e.type === 'tool_call_start' ||
    e.type === 'tool_call_delta' ||
    e.type === 'tool_call_end'
  );
}

function candidates(
  accounts: AccountModel[],
  nodes: ModelView[],
  allowCloud: boolean,
): PresetCandidate[] {
  const out: PresetCandidate[] = accounts.map((a) => ({
    ref: a.view.ref,
    modelId: a.info.id,
    owner: a.account.id,
    local: a.local,
    reasoning: Boolean(a.info.capabilities.reasoning),
    offline: a.account.provider === 'mock',
  }));
  for (const n of nodes)
    out.push({
      ref: n.ref,
      modelId: n.modelId,
      owner: `node:${n.nodeId ?? n.ref}`,
      local: true,
      reasoning: n.reasoning,
    });
  return allowCloud ? out : out.filter((c) => c.local);
}

function presetView(p: Preset, available: Map<ModelRef, boolean>, allowCloud: boolean): ModelView {
  const view: ModelView = {
    ref: presetRef(p.id),
    kind: 'preset',
    providerAccountId: '',
    provider: 'preset',
    modelId: p.id,
    label: p.label,
    reasoning: false,
    source: 'preset',
  };
  const listed = p.targets.filter((t) => available.has(t));
  if (!listed.length) view.disabledReason = 'None of its models are available right now';
  else if (!allowCloud && !listed.some((t) => available.get(t)))
    view.disabledReason = 'It uses only cloud models, and cloud models are turned off';
  return view;
}

function unknownModel(ref: string): NovaError {
  return new NovaError('validation', `unknown model: ${ref}`, {
    details: { reason: 'unknown_model', model: ref },
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
