// Provider accounts and the models they offer (docs/07, FR-014, FR-023, FR-101). Credentials
// go to the SecretStore; the database row holds only a `secret://` reference, and the key is
// resolved per request inside the adapter, never returned by the API.
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  NovaError,
  isNovaError,
  modelRef,
  parseModelRef,
  uuidv7,
  type CreateProviderRequest,
  type ModelRef,
  type ModelView,
  type ProviderAccountView,
  type ProviderKind,
  type ProviderTestResult,
} from '@nova/shared';
import {
  DEFAULT_BASE_URLS,
  MockProvider,
  OpenAICompatibleProvider,
  type ModelInfo,
  type Provider,
} from '@nova/providers';
import { defaultRedactor, type Redactor } from '@nova/security';
import { secretRef, type SecretStore } from '@nova/secrets';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';

const { providerAccount, modelPref } = schema;

export type ProviderAccountRow = typeof providerAccount.$inferSelect;

export interface ProviderFactoryInput {
  row: ProviderAccountRow;
  /** Reads the credential from the vault at call time; null when none is stored. */
  apiKey: () => Promise<string | null>;
}

/** Return a Provider for the row, or undefined to use the built-in construction. */
export type ProviderFactory = (input: ProviderFactoryInput) => Provider | undefined;

export interface ProviderRegistryOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  log?: Logger;
  factory?: ProviderFactory;
  /** How long a provider's model list is reused (default 30 s). */
  modelCacheMs?: number;
  now?: () => Date;
  redactor?: Redactor;
}

export interface ResolvedModel {
  ref: ModelRef;
  account: ProviderAccountRow;
  provider: Provider;
  modelId: string;
  vision: boolean;
}

export const MOCK_PROVIDER_LABEL = 'Mock (offline)';

/** Kinds with an adapter in this build. Anthropic arrives with its own adapter (M2). */
export const SUPPORTED_PROVIDER_KINDS: readonly ProviderKind[] = [
  'mock',
  'openai_compatible',
  'openai',
  'ollama',
];

export class ProviderRegistry {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #log: Logger;
  readonly #factory: ProviderFactory | undefined;
  readonly #cacheMs: number;
  readonly #now: () => Date;
  readonly #redactor: Redactor;
  readonly #instances = new Map<string, Provider>();
  readonly #models = new Map<string, { at: number; models: ModelInfo[] }>();

  constructor(opts: ProviderRegistryOptions) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#log = opts.log ?? new Logger({ module: 'core.providers', sinks: [] });
    this.#factory = opts.factory;
    this.#cacheMs = opts.modelCacheMs ?? 30_000;
    this.#now = opts.now ?? (() => new Date());
    this.#redactor = opts.redactor ?? defaultRedactor;
  }

  async list(accountId: string): Promise<ProviderAccountView[]> {
    const rows = await this.#db.orm
      .select()
      .from(providerAccount)
      .where(and(eq(providerAccount.accountId, accountId), isNull(providerAccount.deletedAt)))
      .orderBy(asc(providerAccount.createdAt), asc(providerAccount.id));
    return rows.map(toView);
  }

  async account(accountId: string, id: string): Promise<ProviderAccountRow> {
    const rows = await this.#db.orm
      .select()
      .from(providerAccount)
      .where(
        and(
          eq(providerAccount.id, id),
          eq(providerAccount.accountId, accountId),
          isNull(providerAccount.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new NovaError('not_found', 'provider account not found');
    return row;
  }

  async create(accountId: string, req: CreateProviderRequest): Promise<ProviderAccountView> {
    if (!SUPPORTED_PROVIDER_KINDS.includes(req.provider)) {
      throw new NovaError(
        'validation',
        `${req.provider} accounts are not available in this build`,
        {
          details: { reason: 'unsupported_provider' },
        },
      );
    }
    if (req.provider === 'openai_compatible' && !req.baseUrl)
      throw new NovaError('validation', 'a base URL is required for an OpenAI-compatible endpoint');
    if (req.provider === 'openai' && !req.apiKey)
      throw new NovaError('validation', 'an API key is required for OpenAI');
    const defaultBase =
      req.provider === 'openai' || req.provider === 'ollama'
        ? DEFAULT_BASE_URLS[req.provider]
        : null;
    const baseUrl = req.provider === 'mock' ? null : (req.baseUrl ?? defaultBase);
    if (baseUrl) {
      // Validates scheme and shape the same way the adapter will.
      new OpenAICompatibleProvider({ id: 'check', kind: 'openai_compatible', baseUrl });
    }
    const id = uuidv7();
    const apiKey = req.provider === 'mock' ? undefined : req.apiKey;
    const ref = apiKey ? secretRef('provider', id, 'api_key') : null;
    if (ref && apiKey) await this.#secrets.put(ref, apiKey);
    const now = this.#now().toISOString();
    const row: ProviderAccountRow = {
      id,
      accountId,
      provider: req.provider,
      label: req.label.trim(),
      authKind: apiKey ? 'api_key' : 'none',
      secretRef: ref,
      baseUrl: baseUrl ? baseUrl.replace(/\/+$/, '') : null,
      scopes: null,
      entitlements: null,
      status: 'active',
      lastCheckAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    try {
      await this.#db.transaction(() => this.#db.orm.insert(providerAccount).values(row));
    } catch (err) {
      if (ref) await this.#secrets.delete(ref).catch(() => false);
      throw err;
    }
    return toView(row);
  }

  /** Soft-delete the account and delete its credential from the vault. */
  async remove(accountId: string, id: string): Promise<void> {
    const row = await this.account(accountId, id);
    const now = this.#now().toISOString();
    await this.#db.transaction(() =>
      this.#db.orm
        .update(providerAccount)
        .set({ deletedAt: now, updatedAt: now, secretRef: null })
        .where(eq(providerAccount.id, id)),
    );
    if (row.secretRef) await this.#secrets.delete(row.secretRef);
    this.#instances.delete(id);
    this.#models.delete(id);
  }

  /**
   * Create the offline mock account the first time an account has no provider accounts at all,
   * so a fresh install can chat with no network (local-first). Never recreated once deleted.
   */
  async ensureDefaultProvider(accountId: string): Promise<ProviderAccountView | null> {
    return this.#db.transaction(async () => {
      const rows = await this.#db.orm
        .select({ n: sql<number>`count(*)` })
        .from(providerAccount)
        .where(eq(providerAccount.accountId, accountId));
      if ((rows[0]?.n ?? 0) > 0) return null;
      return this.create(accountId, { provider: 'mock', label: MOCK_PROVIDER_LABEL });
    });
  }

  /** Connect and list models. Never throws for a bad key or an unreachable server. */
  async test(accountId: string, id: string): Promise<ProviderTestResult> {
    const row = await this.account(accountId, id);
    const now = this.#now().toISOString();
    let result: ProviderTestResult;
    let status: ProviderAccountRow['status'] = 'active';
    try {
      const models = await this.#fetchModels(row, true);
      result = { ok: true, models: models.length };
    } catch (err) {
      const code = isNovaError(err) ? err.code : 'provider_error';
      status = code === 'auth_expired' || code === 'auth_missing' ? 'expired' : 'error';
      result = { ok: false, detail: this.#safeMessage(err) };
    }
    await this.#db.transaction(() =>
      this.#db.orm
        .update(providerAccount)
        .set({ status, lastCheckAt: now, updatedAt: now })
        .where(eq(providerAccount.id, id)),
    );
    return result;
  }

  /** Models across every provider account; an unreachable provider is skipped, not fatal. */
  async listModels(accountId: string): Promise<ModelView[]> {
    const rows = (
      await this.#db.orm
        .select()
        .from(providerAccount)
        .where(and(eq(providerAccount.accountId, accountId), isNull(providerAccount.deletedAt)))
        .orderBy(asc(providerAccount.createdAt), asc(providerAccount.id))
    ).filter((r) => r.status !== 'revoked');
    const lists = await Promise.all(
      rows.map(async (row) => {
        try {
          return (await this.#fetchModels(row, false)).map((m): ModelView => ({
            ref: modelRef(row.id, m.id),
            kind: 'model',
            source: 'account',
            providerAccountId: row.id,
            provider: row.provider as ProviderKind,
            modelId: m.id,
            label: m.label,
            reasoning: Boolean(m.capabilities.reasoning),
          }));
        } catch (err) {
          this.#log.warn('provider model list failed', {
            providerAccountId: row.id,
            error: this.#safeMessage(err),
          });
          // Remember the failure briefly so an unreachable server does not stall every
          // model list for its connect timeout; `test()` always retries.
          this.#models.set(row.id, { at: this.#now().getTime(), models: [] });
          return [];
        }
      }),
    );
    return lists.flat();
  }

  /** The first model of the first provider account that answers (new-chat default). */
  async firstModel(accountId: string): Promise<ModelRef | null> {
    return (await this.listModels(accountId))[0]?.ref ?? null;
  }

  async resolve(accountId: string, ref: string): Promise<ResolvedModel> {
    const parsed = parseModelRef(ref);
    if (!parsed) throw new NovaError('validation', `not a model reference: ${ref}`);
    let account: ProviderAccountRow;
    try {
      account = await this.account(accountId, parsed.providerAccountId);
    } catch {
      throw new NovaError(
        'validation',
        'the provider for this model was removed; choose another model',
        {
          details: { reason: 'unknown_model', model: ref },
        },
      );
    }
    const provider = this.provider(account);
    const info = this.#models.get(account.id)?.models.find((m) => m.id === parsed.modelId);
    return {
      ref,
      account,
      provider,
      modelId: parsed.modelId,
      vision: info?.capabilities.vision ?? provider.capabilities.vision,
    };
  }

  /** Per-1M-token prices from `model_pref`, when the user set them (docs/07 §11). */
  async pricing(
    accountId: string,
    provider: string,
    modelId: string,
  ): Promise<{ costIn: number; costOut: number } | null> {
    const rows = await this.#db.orm
      .select({ costIn: modelPref.costIn, costOut: modelPref.costOut })
      .from(modelPref)
      .where(
        and(
          eq(modelPref.accountId, accountId),
          eq(modelPref.provider, provider),
          eq(modelPref.modelId, modelId),
        ),
      )
      .limit(1);
    const r = rows[0];
    if (!r || (r.costIn === null && r.costOut === null)) return null;
    return { costIn: r.costIn ?? 0, costOut: r.costOut ?? 0 };
  }

  provider(row: ProviderAccountRow): Provider {
    const cached = this.#instances.get(row.id);
    if (cached) return cached;
    const ref = row.secretRef;
    const apiKey = () => (ref ? this.#secrets.get(ref) : Promise.resolve(null));
    const built = this.#factory?.({ row, apiKey }) ?? this.#build(row, apiKey);
    this.#instances.set(row.id, built);
    return built;
  }

  #build(row: ProviderAccountRow, apiKey: () => Promise<string | null>): Provider {
    switch (row.provider) {
      case 'mock':
        return new MockProvider({ id: row.id, timing: 'streamed' });
      case 'openai':
      case 'ollama':
      case 'openai_compatible':
        return new OpenAICompatibleProvider({
          id: row.id,
          kind: row.provider,
          ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
          apiKey,
        });
      default:
        throw new NovaError('capability_missing', `no adapter for ${row.provider} in this build`);
    }
  }

  async #fetchModels(row: ProviderAccountRow, fresh: boolean): Promise<ModelInfo[]> {
    const hit = this.#models.get(row.id);
    const now = this.#now().getTime();
    if (!fresh && hit && now - hit.at < this.#cacheMs) return hit.models;
    const models = await this.provider(row).listModels();
    this.#models.set(row.id, { at: now, models });
    return models;
  }

  #safeMessage(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return this.#redactor.redactString(msg);
  }
}

function toView(r: ProviderAccountRow): ProviderAccountView {
  return {
    id: r.id,
    provider: r.provider as ProviderKind,
    label: r.label,
    authKind: r.authKind,
    baseUrl: r.baseUrl,
    status: r.status,
    hasSecret: r.secretRef !== null,
    lastCheckAt: r.lastCheckAt,
    createdAt: r.createdAt,
  };
}
