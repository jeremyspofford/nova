// Registered compute nodes as a ModelSource (FR-126, FR-127, docs/07 §12). Each active node's
// models are offered as `node:<nodeId>/<modelId>`; a target streams through a NodeProvider that
// calls the node's job API. Unreachable and revoked nodes offer nothing.
import { nodeModelRef, parseAnyModelRef, type ModelRef, type ModelView } from '@nova/shared';
import type { ModelSource, RouteTarget } from '../routing/types.ts';
import { NodeProvider, type NodeProviderOptions } from './provider.ts';
import type { NodeRecord, NodeService } from './service.ts';

export interface NodeModelSourceOptions {
  nodes: NodeService;
  /** Passed to every NodeProvider (timeouts, a test fetch). */
  provider?: Pick<
    NodeProviderOptions,
    'fetch' | 'connectTimeoutMs' | 'idleTimeoutMs' | 'cancelTimeoutMs'
  >;
}

export class NodeModelSource implements ModelSource {
  readonly #nodes: NodeService;
  readonly #providerOpts: NodeModelSourceOptions['provider'];
  /** One signal per node, aborted when it is revoked so its in-flight jobs stop. */
  readonly #revocations = new Map<string, AbortController>();

  constructor(opts: NodeModelSourceOptions) {
    this.#nodes = opts.nodes;
    this.#providerOpts = opts.provider;
    opts.nodes.onRevoked((nodeId) => {
      this.#revocations.get(nodeId)?.abort();
      this.#revocations.delete(nodeId);
    });
  }

  async listModels(accountId: string): Promise<ModelView[]> {
    const out: ModelView[] = [];
    for (const node of await this.#nodes.activeNodes(accountId)) {
      for (const modelId of node.models) {
        out.push({
          ref: nodeModelRef(node.id, modelId),
          kind: 'model',
          providerAccountId: '',
          provider: 'node',
          modelId,
          label: `${modelId} (${node.name})`,
          reasoning: false,
          source: 'node',
          nodeId: node.id,
        });
      }
    }
    return out;
  }

  async targets(accountId: string, ref: ModelRef): Promise<RouteTarget[]> {
    const parsed = parseAnyModelRef(ref);
    if (parsed?.kind !== 'node') return [];
    const [node] = await this.#nodes.activeNodes(accountId, parsed.nodeId);
    if (!node?.models.includes(parsed.modelId)) return [];
    return [this.#target(node, parsed.modelId)];
  }

  async targetsForModel(accountId: string, modelId: string): Promise<RouteTarget[]> {
    const nodes = await this.#nodes.activeNodes(accountId);
    return nodes.filter((n) => n.models.includes(modelId)).map((n) => this.#target(n, modelId));
  }

  load(nodeId: string): { running: number; queued: number } | null {
    return this.#nodes.load(nodeId);
  }

  #target(node: NodeRecord, modelId: string): RouteTarget {
    let revocation = this.#revocations.get(node.id);
    if (!revocation) {
      revocation = new AbortController();
      this.#revocations.set(node.id, revocation);
    }
    const provider = new NodeProvider({
      ...this.#providerOpts,
      nodeId: node.id,
      name: node.name,
      endpoint: node.endpoint,
      models: async () => (await this.#nodes.activeNodes(node.accountId, node.id))[0]?.models ?? [],
      jobToken: () => this.#nodes.jobToken(node.id),
      revoked: revocation.signal,
    });
    return {
      ref: nodeModelRef(node.id, modelId),
      provider,
      providerKind: 'node',
      providerAccountId: null,
      modelId,
      vision: false,
      reasoning: false,
      location: { kind: 'node', nodeId: node.id },
      local: true,
    };
  }
}
