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
  AnthropicProvider,
  DEFAULT_BASE_URLS,
  MockProvider,
  OpenAICompatibleProvider,
  hasDefaultBase,
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
  /**
   * Retries inside the adapters built here, before the first byte (default 0): the router
   * retries and falls back (docs/07 §9), so attempts are not multiplied.
   */
  adapterRetries?: number;
}

export interface ResolvedModel {
  ref: ModelRef;
  account: ProviderAccountRow;
  provider: Provider;
  modelId: string;
  vision: boolean;
  reasoning: boolean;
  /** Runs on hardware the user owns (mock, or a local or LAN server), not a cloud API. */
  local: boolean;
  /** Per-1M-token prices the provider reported in its model list, when it did. */
  costIn?: number;
  costOut?: number;
}

/** An account model with the details the router and preset generation need. */
export interface AccountModel {
  view: ModelView;
  info: ModelInfo;
  account: ProviderAccountRow;
  local: boolean;
}

export const MOCK_PROVIDER_LABEL = 'Mock (offline)';

/** Kinds with an adapter in this build (docs/07 §3). */
export const SUPPORTED_PROVIDER_KINDS: readonly ProviderKind[] = [
  'mock',
  'openai_compatible',
  'openai',
  'anthropic',
  'openrouter',
  'ollama',
  'llamacpp',
];

/** Cloud APIs need a key; local servers and generic endpoints may not. */
const KEY_REQUIRED: ReadonlySet<string> = new Set(['openai', 'anthropic', 'openrouter']);
const KIND_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
};

/**
 * Whether a provider account runs on hardware the user owns (FR-127 `routing.allowCloud`).
 * Cloud APIs never do; local server kinds and generic endpoints do when their address is on
 * this machine or a private network. Unknown or public addresses count as cloud (fail closed).
 */
export function isLocalProvider(kind: string, baseUrl: string | null): boolean {
  if (kind === 'mock') return true;
  if (KEY_REQUIRED.has(kind)) return false;
  if (!baseUrl) return kind === 'ollama' || kind === 'llamacpp';
  try {
    return isPrivateHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function isPrivateHost(raw: string): boolean {
  const h = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') && !h.includes(':')) return true; // single-label LAN name
  if (h === 'localhost' || /\.(localhost|local|lan|internal|home\.arpa|ts\.net)$/.test(h))
    return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT, used by tailnets
    );
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

export class ProviderRegistry {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #log: Logger;
  readonly #factory: ProviderFactory | undefined;
  readonly #cacheMs: number;
  readonly #now: () => Date;
  readonly #redactor: Redactor;
  readonly #adapterRetries: number;
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
    this.#adapterRetries = opts.adapterRetries ?? 0;
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
    if (KEY_REQUIRED.has(req.provider) && !req.apiKey)
      throw new NovaError('validation', `an API key is required for ${KIND_LABEL[req.provider]}`);
    const defaultBase = hasDefaultBase(req.provider) ? DEFAULT_BASE_URLS[req.provider] : null;
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
    return (await this.accountModels(accountId)).map((m) => m.view);
  }

  /** Account models with their reported capabilities, in account then model order. */
  async accountModels(accountId: string): Promise<AccountModel[]> {
    const rows = (await this.#activeRows(accountId)).filter((r) => r.status !== 'revoked');
    const lists = await Promise.all(
      rows.map(async (row) => {
        try {
          const local = isLocalProvider(row.provider, row.baseUrl);
          return (await this.#fetchModels(row, false)).map((m): AccountModel => ({
            view: {
              ref: modelRef(row.id, m.id),
              kind: 'model',
              source: 'account',
              providerAccountId: row.id,
              provider: row.provider as ProviderKind,
              modelId: m.id,
              label: m.label,
              reasoning: Boolean(m.capabilities.reasoning),
            },
            info: m,
            account: row,
            local,
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

  /**
   * The model list last fetched for a provider account, without any network call; undefined
   * when it has not been fetched yet. Lets routing check availability cheaply.
   */
  cachedModels(providerAccountId: string): ModelInfo[] | undefined {
    return this.#models.get(providerAccountId)?.models;
  }

  /**
   * The Hub's own local servers (other than `exceptId`) whose last known model list includes
   * `modelId`, for routing a local model across places (FR-127). Never calls the network.
   */
  async localServing(
    accountId: string,
    modelId: string,
    exceptId: string,
  ): Promise<ResolvedModel[]> {
    const out: ResolvedModel[] = [];
    for (const row of await this.#activeRows(accountId)) {
      if (row.id === exceptId || row.status === 'revoked' || row.provider === 'mock') continue;
      if (!isLocalProvider(row.provider, row.baseUrl)) continue;
      if (!this.cachedModels(row.id)?.some((m) => m.id === modelId)) continue;
      out.push(this.#resolved(row, modelId));
    }
    return out;
  }

  #activeRows(accountId: string): Promise<ProviderAccountRow[]> {
    return this.#db.orm
      .select()
      .from(providerAccount)
      .where(and(eq(providerAccount.accountId, accountId), isNull(providerAccount.deletedAt)))
      .orderBy(asc(providerAccount.createdAt), asc(providerAccount.id));
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
    return this.#resolved(account, parsed.modelId);
  }

  #resolved(account: ProviderAccountRow, modelId: string): ResolvedModel {
    const provider = this.provider(account);
    const info = this.#models.get(account.id)?.models.find((m) => m.id === modelId);
    const reasoning = info?.capabilities.reasoning ?? provider.capabilities.reasoning;
    const r: ResolvedModel = {
      ref: modelRef(account.id, modelId),
      account,
      provider,
      modelId,
      vision: info?.capabilities.vision ?? provider.capabilities.vision,
      reasoning: reasoning !== false,
      local: isLocalProvider(account.provider, account.baseUrl),
    };
    if (info?.costIn !== undefined) r.costIn = info.costIn;
    if (info?.costOut !== undefined) r.costOut = info.costOut;
    return r;
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
      case 'anthropic':
        return new AnthropicProvider({
          id: row.id,
          ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
          apiKey,
          maxRetries: this.#adapterRetries,
        });
      case 'openai':
      case 'openrouter':
      case 'ollama':
      case 'llamacpp':
      case 'openai_compatible':
        return new OpenAICompatibleProvider({
          id: row.id,
          kind: row.provider,
          ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
          apiKey,
          maxRetries: this.#adapterRetries,
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
