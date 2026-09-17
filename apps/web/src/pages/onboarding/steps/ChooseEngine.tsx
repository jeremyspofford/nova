import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Cloud, Cpu, Server } from 'lucide-react'
import { Button, Input } from '../../../components/ui'
import { ApiError, getBackend, putBackend, type BackendWrite } from '../../../lib/api'
import type { EngineKind } from '../steps'

const ENGINES: {
  kind: EngineKind
  label: string
  description: string
  icon: typeof Server
}[] = [
  {
    kind: 'ollama',
    label: 'Bundled Ollama',
    description:
      'Runs models on this machine, in the container that shipped with Nova. Nothing leaves the house.',
    icon: Cpu,
  },
  {
    kind: 'remote',
    label: 'Remote endpoint',
    description:
      'An OpenAI-compatible server you already run — another box on the network, or one on your tailnet.',
    icon: Server,
  },
  {
    kind: 'cloud',
    label: 'Cloud (OpenAI-compatible)',
    description:
      'A hosted OpenAI-compatible API. Needs a key, and your conversations leave this machine.',
    icon: Cloud,
  },
]

/**
 * Choosing an engine IS writing it: core verifies the backend is live before
 * it saves, so a choice that lands means something actually answered. A 502
 * means nothing was saved — the reason is shown here and the option is
 * dropped from the list, because an option proven dead is worse than absent.
 */
export function ChooseEngine({
  onChosen,
  onBack,
}: {
  onChosen: (kind: EngineKind, model: string) => void
  onBack: () => void
}) {
  const [selected, setSelected] = useState<EngineKind>('ollama')
  const [url, setUrl] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState<Partial<Record<EngineKind, string>>>({})

  useEffect(() => {
    // Prefill from whatever is configured now. The stored api_key comes back
    // masked and is deliberately not prefilled — a masked key is not a key.
    getBackend()
      .then(config => {
        setSelected(config.kind)
        setUrl(config.url ?? '')
        setProvider(config.provider ?? '')
        setModel(config.model ?? '')
      })
      .catch(() => {
        /* No stored config to read yet — the defaults above stand. */
      })
  }, [])

  const available = ENGINES.filter(engine => !refused[engine.kind])

  const handleContinue = async () => {
    setError(null)
    setSaving(true)
    const payload: BackendWrite = { kind: selected }
    if (selected !== 'ollama') payload.url = url.trim()
    if (selected === 'cloud') {
      payload.api_key = apiKey
      payload.model = model.trim()
      if (provider.trim()) payload.provider = provider.trim()
    } else if (selected === 'remote' && model.trim()) {
      payload.model = model.trim()
    }

    try {
      const saved = await putBackend(payload)
      onChosen(saved.kind, saved.model ?? '')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      // 502 is core's "I could not reach it, so I did not save it". That is a
      // fact about this option, so the option goes away.
      if (err instanceof ApiError && err.status === 502) {
        setRefused(prev => ({ ...prev, [selected]: message }))
        const next = ENGINES.find(e => e.kind !== selected && !refused[e.kind])
        if (next) setSelected(next.kind)
      }
      setSaving(false)
    }
  }

  const incomplete =
    (selected !== 'ollama' && !url.trim()) ||
    (selected === 'cloud' && (!apiKey || !model.trim()))

  return (
    <div className="flex flex-col items-center py-12 px-6">
      <h2 className="text-h3 text-content-primary mb-2">Choose an engine</h2>
      <p className="text-compact text-content-secondary mb-6 text-center max-w-md">
        Nova checks the engine is answering before it saves. If it is not, nothing
        is stored and you stay on this step.
      </p>

      <div className="w-full max-w-sm space-y-3">
        {available.map(engine => {
          const isSelected = selected === engine.kind
          const Icon = engine.icon
          return (
            <button
              key={engine.kind}
              type="button"
              onClick={() => {
                setSelected(engine.kind)
                setError(null)
              }}
              className={clsx(
                'w-full text-left rounded-lg border p-4 transition-colors',
                isSelected ? 'border-accent bg-accent/5' : 'border-border-subtle hover:border-border',
              )}
            >
              <div className="flex items-start gap-3">
                <Icon
                  className={clsx(
                    'w-5 h-5 mt-0.5 shrink-0',
                    isSelected ? 'text-accent' : 'text-content-tertiary',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <span className="text-compact font-medium text-content-primary">
                    {engine.label}
                  </span>
                  <p className="text-caption text-content-secondary mt-1">{engine.description}</p>
                </div>
              </div>
            </button>
          )
        })}

        {available.length === 0 && (
          <p className="text-compact text-danger">
            Every engine was refused. Fix one of the reasons below and try again.
          </p>
        )}

        {selected !== 'ollama' && (
          <div className="space-y-3 pt-1">
            <Input
              label="Base URL"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="http://192.168.1.10:11434"
              description="Nova calls {url}/v1/… — the OpenAI-compatible root."
            />
            {selected === 'cloud' && (
              <>
                <Input
                  label="API key"
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  autoComplete="off"
                />
                <Input
                  label="Model"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder="the model id this provider expects"
                />
                <Input
                  label="Provider name (optional)"
                  value={provider}
                  onChange={e => setProvider(e.target.value)}
                  placeholder="for your own reference"
                />
              </>
            )}
            {selected === 'remote' && (
              <Input
                label="Model (optional)"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="leave blank to choose on the next step"
              />
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-sm bg-danger/10 border border-danger/30 px-3 py-2 text-caption text-danger"
          >
            {error}
          </div>
        )}

        {Object.entries(refused).map(([kind, reason]) => (
          <p key={kind} className="text-caption text-content-tertiary">
            {ENGINES.find(e => e.kind === kind)?.label} was removed: {reason}
          </p>
        ))}
      </div>

      <div className="flex gap-3 mt-8">
        <Button variant="outline" onClick={onBack} disabled={saving}>
          Back
        </Button>
        <Button onClick={handleContinue} loading={saving} disabled={incomplete || available.length === 0}>
          Test and continue
        </Button>
      </div>
    </div>
  )
}
