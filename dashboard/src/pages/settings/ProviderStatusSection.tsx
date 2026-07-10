import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Eye, EyeOff, Save, AlertTriangle, Trash2, CheckCircle2 } from 'lucide-react'
import {
  getProviderStatus,
  testProvider,
  listPlatformSecrets,
  patchPlatformSecrets,
  deletePlatformSecret,
} from '../../api'
import { Section, Badge, Button, StatusDot, Card } from '../../components/ui'

const TYPE_BADGE_COLOR: Record<string, 'accent' | 'success' | 'warning' | 'info'> = {
  subscription: 'accent',
  free:         'success',
  paid:         'warning',
  local:        'info',
}

const TYPE_BADGE_LABEL: Record<string, string> = {
  subscription: 'Subscription',
  free:         'Free',
  paid:         'Paid',
  local:        'Local',
}

/**
 * Maps provider slug to the platform_secrets key for its API credential.
 * SEC-006a: keys live in the encrypted platform_secrets store via the
 * orchestrator's /api/v1/admin/secrets endpoints — never in writable .env.
 */
const PROVIDER_SECRET_KEY: Record<string, string> = {
  anthropic:    'ANTHROPIC_API_KEY',
  openai:       'OPENAI_API_KEY',
  groq:         'GROQ_API_KEY',
  gemini:       'GEMINI_API_KEY',
  cerebras:     'CEREBRAS_API_KEY',
  openrouter:   'OPENROUTER_API_KEY',
  github:       'GITHUB_TOKEN',
  nvidia:       'NVIDIA_NIM_API_KEY',
  'claude-max': 'CLAUDE_CODE_OAUTH_TOKEN',
  chatgpt:      'CHATGPT_ACCESS_TOKEN',
}

/** The gateway hot-reloads secrets via pubsub within ~a second of a save;
 *  refetch provider status after that window so availability dots flip
 *  without a manual reload. */
const HOT_RELOAD_REFETCH_MS = 1500

export function ProviderStatusSection() {
  const queryClient = useQueryClient()

  const { data: providers, isLoading } = useQuery({
    queryKey: ['provider-status'],
    queryFn: getProviderStatus,
    staleTime: 30_000,
  })

  const { data: secretList } = useQuery({
    queryKey: ['platform-secrets'],
    queryFn: listPlatformSecrets,
    staleTime: 30_000,
  })
  const configuredKeys = new Set((secretList?.keys ?? []).map(e => e.key))

  const [testing, setTesting] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; latency_ms: number; error?: string }>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  const [applyNote, setApplyNote] = useState<string | null>(null)

  const refetchAfterHotReload = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['platform-secrets'] })
    queryClient.invalidateQueries({ queryKey: ['provider-status'] })
    window.setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['provider-status'] })
    }, HOT_RELOAD_REFETCH_MS)
  }, [queryClient])

  const handleTest = useCallback(async (slug: string) => {
    setTesting(slug)
    try {
      const result = await testProvider(slug)
      setTestResults(prev => ({ ...prev, [slug]: result }))
    } catch (e) {
      setTestResults(prev => ({ ...prev, [slug]: { ok: false, latency_ms: 0, error: String(e) } }))
    } finally {
      setTesting(null)
    }
  }, [])

  const handleSaveKey = useCallback(async (slug: string) => {
    const secretKey = PROVIDER_SECRET_KEY[slug]
    const value = drafts[slug]
    if (!secretKey || value === undefined) return

    setSaving(slug)
    setSaveError(null)
    try {
      await patchPlatformSecrets({ [secretKey]: value })
      setEditing(null)
      setDrafts(prev => { const n = { ...prev }; delete n[slug]; return n })
      setApplyNote(`${secretKey} saved — applied live, no restart needed.`)
      refetchAfterHotReload()
    } catch (e) {
      setSaveError(`Failed to save ${slug} key: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(null)
    }
  }, [drafts, refetchAfterHotReload])

  const handleDeleteKey = useCallback(async (slug: string) => {
    const secretKey = PROVIDER_SECRET_KEY[slug]
    if (!secretKey) return
    if (!window.confirm(
      `Remove the ${secretKey} secret? The provider will stop working until ` +
      `you set a new value.`
    )) return

    setSaving(slug)
    setSaveError(null)
    try {
      await deletePlatformSecret(secretKey)
      setApplyNote(`${secretKey} removed — applied live, no restart needed.`)
      refetchAfterHotReload()
    } catch (e) {
      setSaveError(`Failed to remove ${slug} key: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(null)
    }
  }, [refetchAfterHotReload])

  return (
    <Section
      icon={Activity}
      title="Provider Status"
      description="LLM providers configured for this instance. Manage API keys and test connectivity."
    >
      {saveError && (
        <div className="flex items-start gap-2 rounded-sm border border-red-200 dark:border-red-800 bg-danger-dim px-3 py-2 text-compact text-red-700 dark:text-red-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}
      {applyNote && (
        <div className="flex items-start gap-2 rounded-sm border border-success/30 bg-success-dim px-3 py-2 text-compact text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <span>{applyNote}</span>
        </div>
      )}

      {isLoading ? (
        <p className="text-compact text-content-tertiary">Loading providers...</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(providers ?? []).map(p => {
            const badgeColor = TYPE_BADGE_COLOR[p.type] ?? 'neutral'
            const badgeLabel = TYPE_BADGE_LABEL[p.type] ?? p.type
            const result = testResults[p.slug]
            const secretKey = PROVIDER_SECRET_KEY[p.slug]
            const isEditing = editing === p.slug
            const hasKey = !!secretKey && configuredKeys.has(secretKey)
            const isLocal = p.type === 'local'

            return (
              <Card key={p.slug} variant="default" className="p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <StatusDot status={p.available ? 'success' : 'danger'} size="sm" />
                    <span className="text-compact font-medium text-content-primary">{p.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {!isLocal && secretKey && (
                      <Badge color={hasKey ? 'success' : 'neutral'} size="sm">
                        {hasKey ? 'Connected' : 'Not configured'}
                      </Badge>
                    )}
                    <Badge color={badgeColor as any} size="sm">{badgeLabel}</Badge>
                  </div>
                </div>

                <div className="flex items-center justify-between text-caption text-content-tertiary">
                  <span>{p.model_count} model{p.model_count !== 1 ? 's' : ''}</span>
                  <span className="font-mono truncate max-w-[140px]" title={p.default_model}>{p.default_model}</span>
                </div>

                {/* API key input */}
                {secretKey && !isLocal && (
                  <div className="space-y-1.5">
                    {isEditing ? (
                      <div className="flex items-center gap-1.5">
                        <div className="relative flex-1">
                          <input
                            type={showKey[p.slug] ? 'text' : 'password'}
                            value={drafts[p.slug] ?? ''}
                            onChange={e => setDrafts(prev => ({ ...prev, [p.slug]: e.target.value }))}
                            placeholder={`Paste ${secretKey}`}
                            className="h-9 w-full rounded-sm border border-border bg-surface-input px-3 pr-7 text-compact text-content-primary outline-none focus:border-border-focus focus:ring-2 focus:ring-accent-500/40"
                          />
                          <button
                            onClick={() => setShowKey(prev => ({ ...prev, [p.slug]: !prev[p.slug] }))}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-content-tertiary hover:text-content-primary transition-colors"
                          >
                            {showKey[p.slug] ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => handleSaveKey(p.slug)}
                          disabled={!drafts[p.slug]?.trim()}
                          loading={saving === p.slug}
                          icon={<Save size={10} />}
                        >
                          Save
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setEditing(null); setDrafts(prev => { const n = { ...prev }; delete n[p.slug]; return n }) }}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1.5">
                        {hasKey && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteKey(p.slug)}
                            loading={saving === p.slug}
                            icon={<Trash2 size={12} />}
                          >
                            Remove
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setEditing(p.slug)}>
                          {hasKey ? 'Change key' : 'Add key'}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleTest(p.slug)}
                    disabled={!p.available}
                    loading={testing === p.slug}
                  >
                    Test
                  </Button>
                  {result && (
                    <span className={`text-caption ${result.ok ? 'text-success' : 'text-danger'}`}>
                      {result.ok ? `${result.latency_ms}ms` : result.error ?? 'Failed'}
                    </span>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </Section>
  )
}
