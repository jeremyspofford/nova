import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { ModelSelector } from './ModelSelector'
import {
  getInstalledModels as apiGetInstalledModels,
  getSuggestion as apiGetSuggestion,
  putSetting as apiPutSetting,
} from '../../lib/api'

/**
 * The compact control row that sits with the chat input (rendered just below it
 * by ChatPage). It holds what used to live in the chat header: the model
 * selector (now switchable inline, not a read-only badge) and the "Clear chat"
 * control. The header no longer carries either — there is exactly one of each,
 * here.
 *
 * The Clear control keeps its light two-step confirm (destructive, so it never
 * fires on a single click) and calls the store's `clearChat`, which empties the
 * transcript only after the clear API returns ok — a failed clear surfaces its
 * reason and leaves the transcript intact (no fake success).
 *
 * `modelApi` is passed straight through to ModelSelector's DI seam so a test can
 * inject a fake catalog/switch; production leaves it defaulted.
 */

interface ModelApi {
  getInstalledModels: typeof apiGetInstalledModels
  getSuggestion: typeof apiGetSuggestion
  putSetting: typeof apiPutSetting
}

export function ChatControls({
  currentModel,
  onModelChanged,
  clearChat,
  modelApi,
}: {
  currentModel: string
  onModelChanged: (model: string) => void
  clearChat: () => Promise<void>
  modelApi?: ModelApi
}) {
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

  const confirmClear = async () => {
    setClearError(null)
    try {
      await clearChat()
      setConfirmingClear(false)
    } catch (err) {
      // The transcript stays exactly as it is until the server confirms the
      // delete; the reason is shown, not swallowed.
      setClearError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div data-testid="chat-controls">
      <div className="flex items-center justify-between gap-3 px-1">
        <ModelSelector
          currentModel={currentModel}
          onModelChanged={onModelChanged}
          api={modelApi}
        />

        {confirmingClear ? (
          <span className="flex items-center gap-2" role="group" aria-label="Confirm clear chat">
            <span className="text-micro text-content-tertiary">Clear this chat?</span>
            <button
              type="button"
              onClick={confirmClear}
              data-testid="chat-clear-confirm"
              className="rounded-sm px-2 py-1 text-micro text-danger hover:bg-danger-dim transition-colors duration-fast"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingClear(false)
                setClearError(null)
              }}
              data-testid="chat-clear-cancel"
              className="rounded-sm px-2 py-1 text-micro text-content-tertiary hover:bg-surface-elevated transition-colors duration-fast"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingClear(true)}
            data-testid="chat-clear"
            aria-label="Clear chat"
            title="Clear chat"
            className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-micro text-content-tertiary hover:text-content-primary hover:bg-surface-elevated transition-colors duration-fast"
          >
            <Trash2 size={14} />
            <span className="hidden sm:inline">Clear</span>
          </button>
        )}
      </div>

      {clearError && (
        <p role="alert" className="mt-1 px-1 text-micro text-danger">
          Could not clear this chat: {clearError}
        </p>
      )}
    </div>
  )
}
