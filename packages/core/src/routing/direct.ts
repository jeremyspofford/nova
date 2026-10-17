// The simplest ModelRouter: a ref names one provider-account model and runs on the Hub, with no
// presets, fallback or nodes. Tests and minimal setups use it; the Hub uses the full router.
import { NovaError, parseAnyModelRef, type ModelRef, type ModelView } from '@nova/shared';
import type { CallContext, ChatRequest } from '@nova/providers';
import type { ProviderRegistry } from '../registry.ts';
import type { ModelRoute, ModelRouter, RoutedEvent, RouteTarget } from './types.ts';

const LOCAL_KINDS = new Set(['mock', 'ollama', 'llamacpp']);

export class DirectRouter implements ModelRouter {
  readonly #registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.#registry = registry;
  }

  listModels(accountId: string): Promise<ModelView[]> {
    return this.#registry.listModels(accountId);
  }

  firstModel(accountId: string): Promise<ModelRef | null> {
    return this.#registry.firstModel(accountId);
  }

  async usable(accountId: string, ref: ModelRef): Promise<boolean> {
    const parsed = parseAnyModelRef(ref);
    if (parsed?.kind !== 'account') return false;
    try {
      await this.#registry.account(accountId, parsed.providerAccountId);
      return true;
    } catch {
      return false;
    }
  }

  async route(accountId: string, ref: ModelRef): Promise<ModelRoute> {
    if (parseAnyModelRef(ref)?.kind !== 'account')
      throw new NovaError('validation', `unknown model: ${ref}`, {
        details: { reason: 'unknown_model', model: ref },
      });
    const r = await this.#registry.resolve(accountId, ref);
    const target: RouteTarget = {
      ref,
      provider: r.provider,
      providerKind: r.account.provider,
      providerAccountId: r.account.id,
      modelId: r.modelId,
      vision: r.vision,
      reasoning: r.provider.capabilities.reasoning !== false,
      location: { kind: 'hub' },
      local: LOCAL_KINDS.has(r.account.provider),
    };
    return { requested: ref, targets: [target] };
  }

  async *stream(
    route: ModelRoute,
    req: Omit<ChatRequest, 'model'>,
    ctx: CallContext,
  ): AsyncIterable<RoutedEvent> {
    const target = route.targets[0];
    if (!target) throw new NovaError('validation', 'no model to run this turn');
    yield { type: 'route', target, attempt: 1 };
    yield* target.provider.stream({ ...req, model: target.modelId }, ctx);
  }

  pricing(accountId: string, providerKind: string, modelId: string) {
    return this.#registry.pricing(accountId, providerKind, modelId);
  }
}
