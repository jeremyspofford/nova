// What every Hub area receives when it is set up (M3 seams; lead-owned). Each area owns one
// `setup<Area>` file that builds its services and registers its routes.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SettingKey, SettingValue } from '@nova/shared';
import type {
  AuditSink,
  NodeService,
  Notifier,
  ProviderRegistry,
  ModelRouter,
  ThreadService,
  ToolGate,
  ToolSourceProvider,
} from '@nova/core';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { HubConfig } from './config.ts';
import type { EventStore } from './event-store.ts';

export interface HubContext {
  config: HubConfig;
  db: NovaDatabase;
  log: Logger;
  events: EventStore;
  secrets: SecretStore;
  dataDir: string;
  registry: ProviderRegistry;
  router: ModelRouter;
  nodes: NodeService;
  threads: ThreadService;
  /** A setting after precedence (docs/14 §1). */
  setting: <K extends SettingKey>(key: K, projectId?: string | null) => Promise<SettingValue<K>>;
  /** The authenticated account id; throws `token_required` without a session. */
  accountOf: (req: FastifyRequest) => Promise<string>;
  /** Parts of GET /diagnostics that other areas contribute (FR-043, FR-118). */
  diagnostics: DiagnosticsRegistry;
}

/** Collects named diagnostics probes; the ops area serves them. Probes must not throw. */
export class DiagnosticsRegistry {
  readonly #probes = new Map<string, () => Promise<unknown>>();
  add(name: string, probe: () => Promise<unknown>): void {
    this.#probes.set(name, probe);
  }
  async collect(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [name, probe] of this.#probes) {
      try {
        out[name] = await probe();
      } catch (err) {
        out[name] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return out;
  }
}

/** A Hub area: its routes and its shutdown. */
export interface HubArea {
  register(app: FastifyInstance): void;
  close(): Promise<void>;
}

export interface OpsArea extends HubArea {
  audit: AuditSink;
  notifier: Notifier;
}

export interface PolicyArea extends HubArea {
  gate: ToolGate;
}

export interface McpArea extends HubArea {
  source: ToolSourceProvider;
}
