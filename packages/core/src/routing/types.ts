// Model routing seam (docs/07 §8, §12; FR-023, FR-126, FR-127, FR-221). The conversation engine
// asks a ModelRouter where a model ref runs and streams through it; the router owns presets,
// fallback, retries, circuit breaking and node selection. Compute nodes plug in as a
// ModelSource.
import type { ModelRef, ModelView } from '@nova/shared';
import type {
  CallContext,
  ChatRequest,
  Provider,
  ReasoningLevel,
  StreamEvent,
} from '@nova/providers';

/** Where a turn runs; recorded on the turn as `hub` or `node:<id>`. */
export type ExecutionLocation = { kind: 'hub' } | { kind: 'node'; nodeId: string };

export function locationLabel(l: ExecutionLocation): string {
  return l.kind === 'hub' ? 'hub' : `node:${l.nodeId}`;
}

/** One concrete place a request can go. */
export interface RouteTarget {
  /** The concrete model ref (never a preset). */
  ref: ModelRef;
  provider: Provider;
  /** Provider kind for usage accounting and pricing (`node` for compute nodes). */
  providerKind: string;
  /** Provider account row id, or null for a node. */
  providerAccountId: string | null;
  /** The model id sent to the provider. */
  modelId: string;
  vision: boolean;
  reasoning: boolean;
  location: ExecutionLocation;
  /** True when the target runs on hardware the user owns (local server or node), not a cloud API. */
  local: boolean;
  /** A preset may pin the reasoning level for its target. */
  reasoningLevel?: ReasoningLevel;
  /** A preset may pin the serving speed (docs/07 §8.1). */
  speed?: 'standard' | 'fast';
}

export interface ModelRoute {
  /** What the user picked (may be a preset). */
  requested: ModelRef;
  /** Ordered: the first is tried first; the rest are fallbacks (only before any output). */
  targets: RouteTarget[];
}

export interface RouteOptions {
  /** The request carries images. */
  needsVision?: boolean;
}

/**
 * Stream events plus a `route` marker before each attempt, so the caller records which target
 * actually answered. A fallback only happens before the first content event of an attempt.
 */
export type RoutedEvent =
  StreamEvent | { type: 'route'; target: RouteTarget; attempt: number; reason?: string };

export interface ModelRouter {
  /** Every model the account can pick: provider accounts, nodes and presets. */
  listModels(accountId: string): Promise<ModelView[]>;
  /** The default for a new chat when no setting applies. */
  firstModel(accountId: string): Promise<ModelRef | null>;
  /** Whether a ref can be used (its account, node or preset exists). Never throws. */
  usable(accountId: string, ref: ModelRef): Promise<boolean>;
  /** Resolve a ref to its ordered targets; throws `validation` (unknown_model) when none. */
  route(accountId: string, ref: ModelRef, opts?: RouteOptions): Promise<ModelRoute>;
  /** Stream through the route; the request's `model` is set per target. */
  stream(
    route: ModelRoute,
    req: Omit<ChatRequest, 'model'>,
    ctx: CallContext,
  ): AsyncIterable<RoutedEvent>;
  /** Per-1M-token prices the user set for a model, if any (docs/07 §11). */
  pricing(
    accountId: string,
    providerKind: string,
    modelId: string,
  ): Promise<{ costIn: number; costOut: number } | null>;
}

/** A source of extra models, such as registered compute nodes (FR-126). */
export interface ModelSource {
  listModels(accountId: string): Promise<ModelView[]>;
  /** Targets serving the ref (a `node:` ref), or [] if this source does not know it. */
  targets(accountId: string, ref: ModelRef): Promise<RouteTarget[]>;
  /** Every target serving a model id, for routing a local model across devices (FR-127). */
  targetsForModel(accountId: string, modelId: string): Promise<RouteTarget[]>;
  /** Current load of a node, for least-loaded routing; null when unknown. */
  load(nodeId: string): { running: number; queued: number } | null;
}
