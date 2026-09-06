import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  ExternalLink,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { formatRelativeTime } from '../activity/activityFormat'
import {
  Badge,
  Button,
  ConfirmDialog,
  Input,
  Section,
  Select,
  Skeleton,
} from '../../components/ui'
import {
  createProvider as apiCreateProvider,
  deleteProvider as apiDeleteProvider,
  getProviderModels as apiGetProviderModels,
  getProviderPresets as apiGetProviderPresets,
  getProviders as apiGetProviders,
  makeDefaultProvider as apiMakeDefaultProvider,
  putSetting as apiPutSetting,
  type Provider,
  type ProviderAdapter,
  type ProviderAuthShape,
  type ProviderListing,
  type ProviderModel,
  type ProviderPreset,
} from '../../lib/api'

/**
 * Settings → Providers (S10-pre): the cloud (and remote) model providers Nova
 * can route to. A provider is DATA — a name, a wire protocol, a base URL, an
 * auth shape and a key; nothing here knows a vendor. Presets fill the form,
 * they never gate it: "custom" is base URL + key + go.
 *
 * Every save is verified live by the gateway BEFORE the row lands, and a
 * refusal is shown in the provider's own words. Model lists are fetched live
 * per provider and labelled with their source and fetch time (never an
 * unlabelled number); a provider with no listing says so and offers a model
 * id field instead of a fake empty list. "Use" writes `provider:model` to
 * `chat.model` through the same setting Settings → Models writes, and calls
 * `onModelChanged` ONLY after the PUT returned.
 *
 * `api` is the same dependency-injection seam ModelsSection/DevicesSection
 * use: production binds the real lib/api calls; tests inject fakes.
 */
interface ProvidersApi {
  getProviders: typeof apiGetProviders
  getProviderPresets: typeof apiGetProviderPresets
  createProvider: typeof apiCreateProvider
  deleteProvider: typeof apiDeleteProvider
  makeDefaultProvider: typeof apiMakeDefaultProvider
  getProviderModels: typeof apiGetProviderModels
  putSetting: typeof apiPutSetting
}

const DEFAULT_API: ProvidersApi = {
  getProviders: apiGetProviders,
  getProviderPresets: apiGetProviderPresets,
  createProvider: apiCreateProvider,
  deleteProvider: apiDeleteProvider,
  makeDefaultProvider: apiMakeDefaultProvider,
  getProviderModels: apiGetProviderModels,
  putSetting: apiPutSetting,
}

const ADAPTER_LABELS: Record<ProviderAdapter, string> = {
  ollama: 'Bundled Ollama',
  'openai-chat': 'OpenAI-compatible chat',
  'anthropic-messages': 'Anthropic Messages API',
}

const AUTH_LABELS: Record<ProviderAuthShape, string> = {
  none: 'No auth',
  'static-bearer': 'Bearer key',
  'api-key-header': 'API-key header',
}

const CUSTOM = '__custom__'

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const bannerClass =
  'rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger'

/** USD per MILLION tokens from a per-token price — what people actually
 * compare — or nothing when the provider stated nothing. */
export function formatPrice(model: ProviderModel): string | null {
  const p = model.pricing
  if (!p || (p.prompt === undefined && p.completion === undefined)) return null
  const per = (v: number | undefined) =>
    v === undefined ? '–' : `$${(v * 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  return `${per(p.prompt)} / ${per(p.completion)} per 1M`
}

export function formatContext(model: ProviderModel): string | null {
  if (!model.context_length) return null
  const k = model.context_length / 1000
  return k >= 1000 ? `${(k / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M ctx` : `${Math.round(k)}K ctx`
}

/** Fill a preset's `{placeholder}`s from what the owner typed. */
export function fillPlaceholders(url: string, values: Record<string, string>): string {
  return url.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`)
}

interface Draft {
  preset: string
  name: string
  adapter: ProviderAdapter
  base_url: string
  auth_shape: ProviderAuthShape
  api_key: string
  placeholders: Record<string, string>
}

const EMPTY_DRAFT: Draft = {
  preset: CUSTOM,
  name: '',
  adapter: 'openai-chat',
  base_url: '',
  auth_shape: 'static-bearer',
  api_key: '',
  placeholders: {},
}

export function ProvidersSection({
  chatModel,
  onModelChanged,
  api = DEFAULT_API,
}: {
  chatModel: string
  onModelChanged: (model: string) => void
  api?: ProvidersApi
}) {
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Provider | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // The row the owner just added opens on its own, models loaded — the
  // verdict of the save and the list to pick from are the next thing they
  // need, not a name to discover is clickable.
  const [justCreated, setJustCreated] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [rows, known] = await Promise.all([api.getProviders(), api.getProviderPresets()])
      setProviders(rows)
      setPresets(known)
    } catch (err) {
      setLoadError(reasonOf(err))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const selectedPreset = useMemo(
    () => presets.find(p => p.name === draft.preset) ?? null,
    [presets, draft.preset],
  )

  const choosePreset = (name: string) => {
    const preset = presets.find(p => p.name === name)
    if (!preset) {
      setDraft({ ...EMPTY_DRAFT, preset: CUSTOM })
      return
    }
    setDraft({
      preset: preset.name,
      name: preset.name,
      adapter: preset.adapter,
      base_url: preset.base_url,
      auth_shape: preset.auth_shape,
      api_key: '',
      placeholders: {},
    })
  }

  const effectiveBaseUrl = fillPlaceholders(draft.base_url, draft.placeholders)
  const unfilled = (selectedPreset?.placeholders ?? []).filter(
    key => !draft.placeholders[key]?.trim(),
  )

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const created = await api.createProvider({
        name: draft.name.trim(),
        adapter: draft.adapter,
        base_url: effectiveBaseUrl.trim(),
        auth_shape: draft.auth_shape,
        api_key: draft.auth_shape === 'none' ? undefined : draft.api_key,
        preset: selectedPreset?.name,
        model_note: selectedPreset?.model_note,
      })
      setProviders(prev => [...(prev ?? []), created])
      setJustCreated(created.name)
      setDraft(EMPTY_DRAFT)
      setAdding(false)
    } catch (err) {
      // The gateway's verify-before-save refused: the row never landed and
      // this is the provider's own reason.
      setSaveError(reasonOf(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (provider: Provider) => {
    setActionError(null)
    try {
      await api.deleteProvider(provider.name)
      setProviders(prev => (prev ?? []).filter(p => p.name !== provider.name))
    } catch (err) {
      setActionError(reasonOf(err))
    } finally {
      setPendingDelete(null)
    }
  }

  /** Re-read one row's server state after its listing was fetched (the
   * fetch rewrites listing/listing_note server-side). Merges by name so a
   * row the server knows and this page knows agree; never drops rows. */
  const refreshRow = async (name: string) => {
    try {
      const fresh = (await api.getProviders()).find(p => p.name === name)
      if (!fresh) return
      setProviders(prev => (prev ?? []).map(p => (p.name === name ? { ...p, ...fresh } : p)))
    } catch {
      // A failed refresh leaves the last server-returned row in place —
      // still the server's words, just older.
    }
  }

  const makeDefault = async (provider: Provider) => {
    setActionError(null)
    try {
      const updated = await api.makeDefaultProvider(provider.name)
      setProviders(prev =>
        (prev ?? []).map(p => ({ ...p, is_default: p.name === updated.name })),
      )
    } catch (err) {
      setActionError(reasonOf(err))
    }
  }

  return (
    <Section
      id="providers"
      icon={Cloud}
      title="Providers"
      description="Cloud and remote model providers Nova can route to. A provider is a base URL, an auth shape and a key — its models are discovered live. Pick a preset or add any OpenAI-compatible endpoint by URL."
    >
      {loadError && (
        <div role="alert" className={bannerClass}>
          Could not read the providers: {loadError}
        </div>
      )}
      {actionError && (
        <div role="alert" className={bannerClass}>
          {actionError}
        </div>
      )}

      {providers === null && !loadError ? (
        <Skeleton lines={3} />
      ) : (
        <div className="space-y-3" data-testid="providers-list">
          {(providers ?? []).map(provider => (
            <ProviderRow
              key={provider.name}
              provider={provider}
              chatModel={chatModel}
              api={api}
              onModelChanged={onModelChanged}
              onDelete={() => setPendingDelete(provider)}
              onMakeDefault={() => void makeDefault(provider)}
              onListingFetched={() => void refreshRow(provider.name)}
              initiallyOpen={provider.name === justCreated}
            />
          ))}
        </div>
      )}

      {!adding ? (
        <div className="mt-3">
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={12} />}
            onClick={() => {
              setAdding(true)
              setSaveError(null)
              choosePreset(presets[0]?.name ?? CUSTOM)
            }}
          >
            Add a provider
          </Button>
        </div>
      ) : (
        <form
          data-testid="provider-form"
          className="mt-3 space-y-3 rounded-md border border-line p-4"
          onSubmit={e => {
            e.preventDefault()
            void save()
          }}
        >
          <Select
            label="Preset"
            description="A preset only fills in the fields below. Anything OpenAI-compatible works as custom."
            value={draft.preset}
            onChange={e => choosePreset(e.target.value)}
            items={[
              ...presets.map(p => ({ value: p.name, label: p.label })),
              { value: CUSTOM, label: 'Custom (OpenAI-compatible)' },
            ]}
          />
          {selectedPreset?.quirks && (
            <p className="text-caption text-content-tertiary">{selectedPreset.quirks}</p>
          )}
          <Input
            label="Name"
            description="A short slug; model ids become name:model"
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder="openrouter"
            required
          />
          {(selectedPreset?.placeholders ?? []).map(key => (
            <Input
              key={key}
              label={key}
              value={draft.placeholders[key] ?? ''}
              onChange={e =>
                setDraft(d => ({
                  ...d,
                  placeholders: { ...d.placeholders, [key]: e.target.value },
                }))
              }
              required
            />
          ))}
          <Input
            label="Base URL"
            description={
              draft.adapter === 'anthropic-messages'
                ? 'Includes the version path, e.g. https://api.anthropic.com/v1'
                : 'Includes the version path, e.g. https://openrouter.ai/api/v1'
            }
            value={draft.preset === CUSTOM ? draft.base_url : effectiveBaseUrl}
            onChange={e => setDraft(d => ({ ...d, base_url: e.target.value }))}
            readOnly={draft.preset !== CUSTOM}
            required
          />
          {draft.preset === CUSTOM && (
            <Select
              label="Protocol"
              value={draft.adapter}
              onChange={e =>
                setDraft(d => {
                  const adapter = e.target.value as ProviderAdapter
                  return {
                    ...d,
                    adapter,
                    auth_shape: adapter === 'anthropic-messages' ? 'api-key-header' : d.auth_shape,
                  }
                })
              }
              items={[
                { value: 'openai-chat', label: ADAPTER_LABELS['openai-chat'] },
                { value: 'anthropic-messages', label: ADAPTER_LABELS['anthropic-messages'] },
              ]}
            />
          )}
          {draft.preset === CUSTOM && draft.adapter !== 'anthropic-messages' && (
            <Select
              label="Auth"
              value={draft.auth_shape}
              onChange={e =>
                setDraft(d => ({ ...d, auth_shape: e.target.value as ProviderAuthShape }))
              }
              items={[
                { value: 'static-bearer', label: 'Authorization: Bearer <key>' },
                { value: 'api-key-header', label: 'api-key: <key> (Azure-shaped)' },
                { value: 'none', label: 'No auth (a trusted endpoint on your network)' },
              ]}
            />
          )}
          {draft.auth_shape !== 'none' && (
            <Input
              label="API key"
              type="password"
              value={draft.api_key}
              onChange={e => setDraft(d => ({ ...d, api_key: e.target.value }))}
              autoComplete="off"
              required
            />
          )}
          {selectedPreset?.docs_url && (
            <a
              href={selectedPreset.docs_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-caption text-accent hover:underline"
            >
              <ExternalLink size={11} /> Where to get a key
            </a>
          )}
          {saveError && (
            <div role="alert" className={bannerClass}>
              Not saved — {saveError}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              loading={saving}
              disabled={saving || unfilled.length > 0 || !draft.name.trim()}
            >
              Verify and save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false)
                setSaveError(null)
              }}
            >
              Cancel
            </Button>
            <span className="text-caption text-content-tertiary">
              The key is sent to the provider once to verify it before anything is stored.
            </span>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={`Remove ${pendingDelete?.name ?? ''}?`}
        description="Its key is deleted. Any chat model pointing at it will fail with a stated reason until you pick another."
        confirmLabel="Remove"
        destructive
        onConfirm={() => pendingDelete && void remove(pendingDelete)}
      />
    </Section>
  )
}

function ProviderRow({
  provider,
  chatModel,
  api,
  onModelChanged,
  onDelete,
  onMakeDefault,
  onListingFetched,
  initiallyOpen = false,
}: {
  provider: Provider
  chatModel: string
  api: ProvidersApi
  onModelChanged: (model: string) => void
  onDelete: () => void
  onMakeDefault: () => void
  onListingFetched: () => void
  initiallyOpen?: boolean
}) {
  const [listing, setListing] = useState<ProviderListing | null>(null)
  const [listingError, setListingError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [open, setOpen] = useState(Boolean(initiallyOpen))
  const [filter, setFilter] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [switching, setSwitching] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  const loadModels = async () => {
    setLoadingModels(true)
    setListingError(null)
    try {
      setListing(await api.getProviderModels(provider.name))
    } catch (err) {
      setListing(null)
      setListingError(reasonOf(err))
    } finally {
      setLoadingModels(false)
      // The fetch just rewrote the row's listing state on the server; read
      // it back rather than keep showing what the save said.
      onListingFetched()
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && listing === null && !loadingModels) void loadModels()
  }

  // A row that starts open (the one just created) fetches its list at once.
  useEffect(() => {
    if (initiallyOpen) void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const use = async (modelId: string) => {
    // ALWAYS qualified — including the bundled ollama (`ollama:qwen3:8b`). A
    // bare id routes to whichever provider is the default, and this very
    // section lets the owner move the default; a bare local id written here
    // would silently start going to the cloud the moment they did.
    const qualified = `${provider.name}:${modelId}`
    setSwitching(modelId)
    setSwitchError(null)
    try {
      await api.putSetting('chat.model', qualified)
      onModelChanged(qualified)
    } catch (err) {
      setSwitchError(reasonOf(err))
    } finally {
      setSwitching(null)
    }
  }

  // A bare chat.model (written before S10-pre) still means the local
  // provider, so the ollama row recognises it as current.
  const isCurrent = (modelId: string) =>
    chatModel === `${provider.name}:${modelId}` ||
    (provider.adapter === 'ollama' && chatModel === modelId)

  const visible = (listing?.models ?? []).filter(
    m => !filter || m.id.toLowerCase().includes(filter.toLowerCase()) || m.name?.toLowerCase().includes(filter.toLowerCase()),
  )

  return (
    <div className="rounded-md border border-line p-3" data-testid={`provider-${provider.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-compact font-medium text-content-primary">{provider.name}</span>
        <Badge size="sm" color="neutral">
          {ADAPTER_LABELS[provider.adapter]}
        </Badge>
        {provider.is_default && (
          <Badge size="sm" color="accent" dot>
            default for bare model ids
          </Badge>
        )}
        {provider.listing === 'unavailable' && (
          <Badge size="sm" color="warning">
            no model listing
          </Badge>
        )}
        <span className="text-caption text-content-tertiary font-mono truncate">
          {provider.base_url}
        </span>
        <span className="text-caption text-content-tertiary">
          {AUTH_LABELS[provider.auth_shape]}
          {provider.api_key ? ` ${provider.api_key}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {/* THE affordance: the model list is what a provider is for, and
              nothing else on this row says it exists. */}
          <Button
            size="sm"
            variant={open ? 'ghost' : 'secondary'}
            icon={open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            onClick={toggle}
            aria-expanded={open}
            aria-controls={`provider-models-${provider.name}`}
            data-testid={`toggle-models-${provider.name}`}
          >
            {open
              ? provider.listing === 'unavailable' || listingError
                ? 'Hide'
                : 'Hide models'
              : provider.listing === 'unavailable'
                ? 'Pick a model'
                : 'Show models'}
          </Button>
          {!provider.is_default && (
            <Button size="sm" variant="ghost" onClick={onMakeDefault}>
              Make default
            </Button>
          )}
          {!provider.builtin && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 size={12} />}
              onClick={onDelete}
              aria-label={`remove ${provider.name}`}
            >
              Remove
            </Button>
          )}
        </span>
      </div>
      {/* The save's verdict, in the gateway's words, branched on the
          STRUCTURED key_proven — never on the wording of a note. Absent
          (not invented) for the bundled row, which is never verified
          through the registry. A row verified before the verdict existed
          (verified_at set, key_proven null, no note) reads "Checked", not
          "Verified": nothing proved the key. */}
      {provider.verified_at && (
        <p
          data-testid={`provider-status-${provider.name}`}
          className={`mt-1.5 inline-flex items-start gap-1.5 text-caption ${
            provider.key_proven === true
              ? 'text-success'
              : provider.key_proven === false
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-content-tertiary'
          }`}
        >
          {provider.key_proven === true ? (
            <Check size={12} className="shrink-0 mt-0.5" />
          ) : provider.key_proven === false ? (
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          ) : null}
          <span>
            {provider.key_proven === true ? 'Key verified' : 'Checked'}{' '}
            {formatRelativeTime(provider.verified_at)}
            {provider.verify_note
              ? ` — ${provider.verify_note}`
              : provider.key_proven === null
                ? ' — the key was not tested'
                : ''}
          </span>
        </p>
      )}
      {/* What the LAST listing fetch learned, when it is bad news: a
          refused listing (a revoked key, say) is a fact the verdict above
          cannot see. */}
      {provider.listing === 'unknown' && provider.listing_note && (
        <p
          data-testid={`provider-listing-warning-${provider.name}`}
          className="mt-1 inline-flex items-start gap-1.5 text-caption text-amber-600 dark:text-amber-400"
        >
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>{provider.listing_note}</span>
        </p>
      )}
      {provider.model_note && (
        <p className="mt-1 text-caption text-content-tertiary">{provider.model_note}</p>
      )}

      {open && (
        <div
          className="mt-3 space-y-2"
          id={`provider-models-${provider.name}`}
          data-testid={`provider-models-${provider.name}`}
        >
          {switchError && (
            <div role="alert" className={bannerClass}>
              {switchError}
            </div>
          )}
          {loadingModels && <Skeleton lines={2} />}
          {listingError && (
            <div className="space-y-2">
              <p className="text-caption text-content-tertiary">{listingError}</p>
              <form
                className="flex items-end gap-2"
                onSubmit={e => {
                  e.preventDefault()
                  if (manualModel.trim()) void use(manualModel.trim())
                }}
              >
                <Input
                  label={`Model id for ${provider.name}`}
                  value={manualModel}
                  onChange={e => setManualModel(e.target.value)}
                  placeholder={provider.model_note ?? 'model id'}
                />
                <Button type="submit" size="sm" disabled={!manualModel.trim()}>
                  Use
                </Button>
              </form>
            </div>
          )}
          {listing && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-caption text-content-tertiary">
                  {listing.models.length} models from {listing.source}, fetched{' '}
                  {new Date(listing.fetched_at).toLocaleTimeString()}
                  {listing.models.length > 0 ? ' — press Use to make one the chat model' : ''}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RefreshCw size={11} />}
                  onClick={() => void loadModels()}
                  aria-label={`refresh ${provider.name} models`}
                >
                  Refresh
                </Button>
                {listing.models.length > 12 && (
                  <Input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder="filter models"
                    aria-label="filter models"
                  />
                )}
              </div>
              <ul className="max-h-72 overflow-y-auto divide-y divide-line rounded-sm border border-line">
                {visible.slice(0, 200).map(model => {
                  const current = isCurrent(model.id)
                  const price = formatPrice(model)
                  const ctx = formatContext(model)
                  return (
                    <li
                      key={model.id}
                      className="flex flex-wrap items-center gap-2 px-3 py-1.5"
                      data-testid={`model-${model.id}`}
                    >
                      <span className="font-mono text-caption text-content-primary">{model.id}</span>
                      {model.name && model.name !== model.id && (
                        <span className="text-caption text-content-tertiary">{model.name}</span>
                      )}
                      {ctx && (
                        <Badge size="sm" color="neutral">
                          {ctx}
                        </Badge>
                      )}
                      {price && <span className="text-micro text-content-tertiary">{price}</span>}
                      <span className="ml-auto">
                        {current ? (
                          <Badge size="sm" color="success">
                            <Check size={10} /> current
                          </Badge>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={switching === model.id}
                            onClick={() => void use(model.id)}
                            aria-label={`use ${model.id}`}
                          >
                            Use
                          </Button>
                        )}
                      </span>
                    </li>
                  )
                })}
                {visible.length === 0 && (
                  <li className="px-3 py-2 text-caption text-content-tertiary">
                    {listing.models.length === 0
                      ? 'The provider listed no models.'
                      : 'Nothing matches the filter.'}
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
