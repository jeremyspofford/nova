// Provider accounts and the models they offer (docs/07, FR-014, FR-023, FR-101). Credentials
// go to the SecretStore; the database row holds only a `secret://` reference, and the key is
// resolved per request inside the adapter, never returned by the API.
//
// One account per provider kind is active (FR-115): the one the user picked, else the oldest.
// The active account takes its kind's first place in every list, and models it also offers are
// served by it alone, so new chats and the built-in presets use the active account while an
// inactive one keeps only the models nobody else of its kind has. Threads that name an inactive
// account's model keep resolving it.
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
import { isHubOwner } from './team/owner.ts';
import {
  privateAddressError,
  publicFetch,
  publicUrlProblem,
  type ResolveHost,
} from './team/public-net.ts';

const { providerAccount, modelPref, providerActive } = schema;

export type ProviderAccountRow = typeof providerAccount.$inferSelect;

/** A provider account as listed: whether it is its kind's active account (FR-115). */
export interface ProviderAccountListItem extends ProviderAccountView {
  active: boolean;
}

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
  /** DNS for the public-address check of non-owners' base URLs (tests replace it). */
  resolveHost?: ResolveHost;
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
  /** The account is its provider kind's active one (FR-115). */
  active: boolean;
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
  readonly #resolveHost: ResolveHost | undefined;
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
    this.#resolveHost = opts.resolveHost;
  }

  /**
   * An account that is not the Hub's owner (a member, a team agent's identity) reaches public
   * addresses only: never the Hub's loopback services or the owner's network (decision 5).
   */
  #publicOnly(accountId: string): boolean {
    return !isHubOwner(this.#db, accountId);
  }

  async list(accountId: string): Promise<ProviderAccountListItem[]> {
    const { rows, active } = await this.#ordered(accountId);
    return Promise.all(rows.map(async (r) => toView(r, active.has(r.id), await this.#stored(r))));
  }

  /** The view of one account, with its active flag. */
  async view(accountId: string, id: string): Promise<ProviderAccountListItem> {
    const row = await this.account(accountId, id);
    const { active } = await this.#ordered(accountId);
    return toView(row, active.has(row.id), await this.#stored(row));
  }

  /**
   * Whether the vault holds the account's credential. The reference alone is not enough: an
   * import without a passphrase keeps the references and leaves the secrets out (M8V2), so the
   * key must be entered again before the account works.
   */
  async #stored(row: ProviderAccountRow): Promise<boolean> {
    if (row.secretRef === null) return false;
    return this.#secrets.has(row.secretRef).catch(() => false);
  }

  /**
   * Make an account its kind's active one (FR-115); the previous one stays, inactive. Returns
   * the account's view.
   */
  async setActive(accountId: string, id: string): Promise<ProviderAccountListItem> {
    const row = await this.account(accountId, id);
    const now = this.#now().toISOString();
    await this.#db.transaction(() =>
      this.#db.orm
        .insert(providerActive)
        .values({ accountId, provider: row.provider, providerAccountId: id, updatedAt: now })
        .onConflictDoUpdate({
          target: [providerActive.accountId, providerActive.provider],
          set: { providerAccountId: id, updatedAt: now },
        }),
    );
    return toView(row, true, await this.#stored(row));
  }

  /**
   * Live accounts in list order and the ids of the active ones. Accounts keep their creation
   * order, except that each kind's active account takes the place of that kind's first one.
   */
  async #ordered(accountId: string): Promise<{ rows: ProviderAccountRow[]; active: Set<string> }> {
    const rows = await this.#activeRows(accountId);
    const chosen = new Map(
      (
        await this.#db.orm
          .select({ provider: providerActive.provider, id: providerActive.providerAccountId })
          .from(providerActive)
          .where(eq(providerActive.accountId, accountId))
      ).map((r) => [r.provider, r.id]),
    );
    const byKind = new Map<string, ProviderAccountRow[]>();
    for (const r of rows) byKind.set(r.provider, [...(byKind.get(r.provider) ?? []), r]);
    const active = new Set<string>();
    const queues = new Map<string, ProviderAccountRow[]>();
    for (const [kind, list] of byKind) {
      const pick = list.find((r) => r.id === chosen.get(kind)) ?? list[0]!;
      active.add(pick.id);
      queues.set(kind, [pick, ...list.filter((r) => r !== pick)]);
    }
    return { rows: rows.map((r) => queues.get(r.provider)!.shift()!), active };
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
      if (this.#publicOnly(accountId)) {
        const problem = await publicUrlProblem(baseUrl, this.#resolveHost);
        if (problem) throw privateAddressError('the provider base URL', problem);
      }
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
    return this.view(accountId, id);
  }

  /**
   * Soft-delete the account and delete its credential from the vault. When it was its kind's
   * active account, the next one of that kind (in creation order, wrapping) becomes active.
   */
  async remove(accountId: string, id: string): Promise<void> {
    const row = await this.account(accountId, id);
    const { active } = await this.#ordered(accountId);
    const now = this.#now().toISOString();
    const sameKind = (await this.#activeRows(accountId)).filter((r) => r.provider === row.provider);
    const at = sameKind.findIndex((r) => r.id === id);
    const next = sameKind.length > 1 ? sameKind[(at + 1) % sameKind.length] : undefined;
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(providerAccount)
        .set({ deletedAt: now, updatedAt: now, secretRef: null })
        .where(eq(providerAccount.id, id));
      if (!active.has(id)) return;
      const where = and(
        eq(providerActive.accountId, accountId),
        eq(providerActive.provider, row.provider),
      );
      if (next)
        await this.#db.orm
          .insert(providerActive)
          .values({ accountId, provider: row.provider, providerAccountId: next.id, updatedAt: now })
          .onConflictDoUpdate({
            target: [providerActive.accountId, providerActive.provider],
            set: { providerAccountId: next.id, updatedAt: now },
          });
      else await this.#db.orm.delete(providerActive).where(where);
    });
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

  /**
   * Account models with their reported capabilities, in account then model order. A model that
   * its kind's active account offers is listed for that account only (FR-115).
   */
  async accountModels(accountId: string): Promise<AccountModel[]> {
    const ordered = await this.#ordered(accountId);
    const rows = ordered.rows.filter((r) => r.status !== 'revoked');
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
            active: ordered.active.has(row.id),
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
    const served = new Map<string, Set<string>>();
    for (const list of lists)
      for (const m of list)
        if (m.active)
          served.set(
            m.account.provider,
            (served.get(m.account.provider) ?? new Set()).add(m.info.id),
          );
    return lists.flat().filter((m) => m.active || !served.get(m.account.provider)?.has(m.info.id));
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
    // Every request of a non-owner's adapter is pinned to a checked public address.
    const pinned = this.#publicOnly(row.accountId) ? { fetch: publicFetch(this.#resolveHost) } : {};
    switch (row.provider) {
      case 'mock':
        return new MockProvider({ id: row.id, timing: 'streamed' });
      case 'anthropic':
        return new AnthropicProvider({
          id: row.id,
          ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
          apiKey,
          maxRetries: this.#adapterRetries,
          ...pinned,
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
          ...pinned,
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

function toView(
  r: ProviderAccountRow,
  active: boolean,
  hasSecret: boolean,
): ProviderAccountListItem {
  return {
    id: r.id,
    provider: r.provider as ProviderKind,
    label: r.label,
    authKind: r.authKind,
    baseUrl: r.baseUrl,
    status: r.status,
    hasSecret,
    lastCheckAt: r.lastCheckAt,
    createdAt: r.createdAt,
    active,
  };
}
