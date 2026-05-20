import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { discoverModels, type ProviderModelList } from '../api'
import { Modal } from './ui/Modal'
import { Checkbox } from './ui/Checkbox'
import { Button } from './ui/Button'
import { Save, RotateCcw } from 'lucide-react'

const STORAGE_KEY = 'nova_chat_hidden_models'

export function getHiddenModels(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw))
  } catch {
    return new Set()
  }
}

export function setHiddenModels(hidden: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden]))
}

type Props = {
  open: boolean
  onClose: () => void
  onSave: (hidden: Set<string>) => void
}

export function ModelManagerModal({ open, onClose, onSave }: Props) {
  const { data: providers, refetch } = useQuery({
    queryKey: ['model-catalog'],
    queryFn: () => discoverModels(),
    staleTime: 60_000,
  })

  // Always fetch fresh data when the modal opens
  useEffect(() => {
    if (open) refetch()
  }, [open, refetch])

  const availableProviders = useMemo(
    () => (providers ?? []).filter(p => p.available && p.models.length > 0),
    [providers],
  )

  const [hidden, setHidden] = useState<Set<string>>(() => getHiddenModels())
  const [dirty, setDirty] = useState(false)

  // Reset draft when modal opens
  useEffect(() => {
    if (open) {
      setHidden(getHiddenModels())
      setDirty(false)
    }
  }, [open])

  const toggle = (modelId: string) => {
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(modelId)) {
        next.delete(modelId)
      } else {
        next.add(modelId)
      }
      return next
    })
    setDirty(true)
  }

  const toggleProvider = (provider: ProviderModelList, allVisible: boolean) => {
    setHidden(prev => {
      const next = new Set(prev)
      for (const m of provider.models) {
        if (allVisible) {
          next.add(m.id)
        } else {
          next.delete(m.id)
        }
      }
      return next
    })
    setDirty(true)
  }

  const handleSave = () => {
    setHiddenModels(hidden)
    onSave(hidden)
    setDirty(false)
    onClose()
  }

  const handleReset = () => {
    setHidden(getHiddenModels())
    setDirty(false)
  }

  const handleShowAll = () => {
    setHidden(new Set())
    setDirty(true)
  }

  const totalModels = availableProviders.reduce((n, p) => n + p.models.length, 0)
  const visibleCount = totalModels - hidden.size

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Chat Models"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={handleShowAll}>
            Show all
          </Button>
          <div className="flex-1" />
          {dirty && (
            <Button variant="ghost" size="sm" onClick={handleReset} icon={<RotateCcw size={12} />}>
              Reset
            </Button>
          )}
          <Button size="sm" onClick={handleSave} disabled={!dirty} icon={<Save size={12} />}>
            Save
          </Button>
        </>
      }
    >
      <p className="text-caption text-content-tertiary mb-4">
        {visibleCount} of {totalModels} models visible in chat.
        Uncheck models you don't need to keep the picker clean.
      </p>

      <div className="space-y-5">
        {availableProviders.map(provider => {
          const allVisible = provider.models.every(m => !hidden.has(m.id))
          const noneVisible = provider.models.every(m => hidden.has(m.id))

          return (
            <div key={provider.slug}>
              <div className="flex items-center gap-2 mb-2">
                <Checkbox
                  checked={allVisible}
                  indeterminate={!allVisible && !noneVisible}
                  onChange={() => toggleProvider(provider, allVisible)}
                />
                <button
                  type="button"
                  onClick={() => toggleProvider(provider, allVisible)}
                  className="flex items-center gap-2 text-caption font-semibold text-content-secondary uppercase tracking-wide hover:text-content-primary transition-colors"
                >
                  {provider.name}
                  <span className="text-content-tertiary font-normal normal-case tracking-normal">
                    ({provider.models.filter(m => !hidden.has(m.id)).length}/{provider.models.length})
                  </span>
                </button>
              </div>

              <div className="grid grid-cols-1 gap-1 pl-4">
                {provider.models.map(model => (
                  <Checkbox
                    key={model.id}
                    checked={!hidden.has(model.id)}
                    onChange={() => toggle(model.id)}
                    label={model.id}
                  />
                ))}
              </div>
            </div>
          )
        })}

        {availableProviders.length === 0 && (
          <p className="text-caption text-content-tertiary text-center py-4">
            No models discovered. Check provider authentication in Settings.
          </p>
        )}
      </div>
    </Modal>
  )
}
