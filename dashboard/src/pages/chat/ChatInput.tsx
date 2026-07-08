import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Paperclip, SlidersHorizontal, Mic, Loader2, Volume2, VolumeX, ALargeSmall, Globe, BookOpen, Settings2 } from 'lucide-react'
import clsx from 'clsx'
import { useChatStore } from '../../stores/chat-store'
import { useFileAttach } from '../../hooks/useFileAttach'
import { useAudioLevel } from '../../hooks/useAudioLevel'
import { useSpeechToText } from '../../hooks/useSpeechToText'
import { FilePreviewBar } from './FilePreviewBar'
import { OutputStylePicker } from './OutputStylePicker'
import { AudioLevelIndicator } from '../../components/ui/AudioLevelIndicator'
import { Tooltip } from '../../components/ui/Tooltip'
import { ModelPicker } from '../../components/ui/ModelPicker'
import { MorphButton } from '../../components/ui/MorphButton'
import type { ConversationState } from '../../hooks/useVoiceChat'

export interface VoiceControls {
  available: boolean
  isRecording: boolean
  isTranscribing: boolean
  isSpeaking: boolean
  recordingDuration: number
  toggleRecording: () => void
  muted: boolean
  setMuted: (m: boolean | ((prev: boolean) => boolean)) => void
  conversationMode: boolean
  setConversationMode: (m: boolean | ((prev: boolean) => boolean)) => void
  conversationState: ConversationState
  silenceCountdown: number
  silenceTimeoutMs: number
  mediaStream: MediaStream | null
}

interface Props {
  onSubmit: (text: string) => void
  isStreaming: boolean
  aiName: string
  models: Array<{ id: string; provider: string }>
  modelId: string
  onModelChange: (id: string) => void
  resolvedModel?: string
  hasMessages: boolean
  onManageModels: () => void
  voice?: VoiceControls
}

export function ChatInput({ onSubmit, isStreaming, aiName, models, modelId, onModelChange, resolvedModel, hasMessages, onManageModels, voice }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const {
    messages,
    draftInput: input,
    setDraftInput: setInput,
    drawerOpen,
    setDrawerOpen,
    prefillInput,
    setPrefillInput,
    webSearchEnabled,
    setWebSearchEnabled,
    deepResearchEnabled,
    setDeepResearchEnabled,
  } = useChatStore()

  // Prior user messages, oldest → newest, for Up/Down history recall.
  const userHistory = useMemo(
    () => messages.filter(m => m.role === 'user').map(m => m.content),
    [messages]
  )
  // -1 = editing the live draft; 0 = newest sent message, 1 = the one before, …
  const historyIdxRef = useRef(-1)
  const draftBeforeHistoryRef = useRef('')

  const { pendingFiles, addFiles, removeFile, openFilePicker } = useFileAttach()

  const TEXT_SIZES = ['small', 'medium', 'large'] as const
  const TEXT_LABELS: Record<string, string> = { small: 'S', medium: 'M', large: 'L' }
  const [textSize, setTextSize] = useState(() => localStorage.getItem('nova_text_size') || 'medium')
  const cycleTextSize = useCallback(() => {
    setTextSize(prev => {
      const idx = TEXT_SIZES.indexOf(prev as typeof TEXT_SIZES[number])
      const next = TEXT_SIZES[(idx + 1) % TEXT_SIZES.length]
      localStorage.setItem('nova_text_size', next)
      return next
    })
  }, [])

  const audioLevel = useAudioLevel(voice?.mediaStream ?? null)
  const { isListening: sttListening, transcript: liveTranscript, start: sttStart, stop: sttStop, isSupported: sttSupported } = useSpeechToText()

  useEffect(() => {
    if (!sttSupported || !voice) return
    if (voice.isRecording && !sttListening) sttStart()
    if (!voice.isRecording && sttListening) sttStop()
  }, [voice?.isRecording, sttListening, sttSupported, sttStart, sttStop])

  useEffect(() => {
    if (prefillInput) {
      setInput(prefillInput)
      setPrefillInput(null)
      setTimeout(() => {
        resizeTextarea()
        textareaRef.current?.focus()
      }, 0)
    }
  }, [prefillInput, setPrefillInput])

  const resizeTextarea = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const maxH = el.value.split('\n').length > 5 ? 400 : 200
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`
  }

  const handleSubmit = useCallback(() => {
    const text = input.trim()
    if (!text) return
    setInput('')
    historyIdxRef.current = -1
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    onSubmit(text)
  }, [input, onSubmit])

  // Load a history entry into the textarea and put the caret at the end.
  const recall = useCallback((text: string) => {
    setInput(text)
    requestAnimationFrame(() => {
      resizeTextarea()
      const el = textareaRef.current
      if (el) el.setSelectionRange(text.length, text.length)
    })
  }, [setInput])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
      return
    }

    const el = textareaRef.current
    if (!el || userHistory.length === 0) return
    const collapsed = el.selectionStart === el.selectionEnd

    // ArrowUp: recall an older message — only when the caret is on the first
    // line (or the box is empty), so normal within-message cursor movement and
    // multi-line editing are untouched.
    if (e.key === 'ArrowUp' && collapsed) {
      const onFirstLine = el.value.slice(0, el.selectionStart).indexOf('\n') === -1
      if (!onFirstLine) return
      const nextIdx = historyIdxRef.current + 1
      if (nextIdx >= userHistory.length) return  // already at the oldest
      if (historyIdxRef.current === -1) draftBeforeHistoryRef.current = input  // stash live draft
      historyIdxRef.current = nextIdx
      e.preventDefault()
      recall(userHistory[userHistory.length - 1 - nextIdx])
      return
    }

    // ArrowDown: move toward newer messages, then back to the stashed draft.
    if (e.key === 'ArrowDown' && collapsed && historyIdxRef.current !== -1) {
      const onLastLine = el.value.slice(el.selectionStart).indexOf('\n') === -1
      if (!onLastLine) return
      e.preventDefault()
      const nextIdx = historyIdxRef.current - 1
      historyIdxRef.current = nextIdx
      recall(nextIdx === -1
        ? draftBeforeHistoryRef.current
        : userHistory[userHistory.length - 1 - nextIdx])
      return
    }
  }

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const f = items[i].getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length > 0) {
        e.preventDefault()
        addFiles(files)
      }
    }
    el.addEventListener('paste', onPaste)
    return () => el.removeEventListener('paste', onPaste)
  }, [addFiles])

  useEffect(() => {
    const zone = dropZoneRef.current
    if (!zone) return
    const onDragOver = (e: DragEvent) => { e.preventDefault(); setIsDragging(true) }
    const onDragLeave = (e: DragEvent) => {
      if (!zone.contains(e.relatedTarget as Node)) setIsDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files)
    }
    zone.addEventListener('dragover', onDragOver)
    zone.addEventListener('dragleave', onDragLeave)
    zone.addEventListener('drop', onDrop)
    return () => {
      zone.removeEventListener('dragover', onDragOver)
      zone.removeEventListener('dragleave', onDragLeave)
      zone.removeEventListener('drop', onDrop)
    }
  }, [addFiles])

  useEffect(() => {
    if (!isStreaming && !voice?.conversationMode) {
      textareaRef.current?.focus()
      resizeTextarea()
    }
  }, [isStreaming, voice?.conversationMode])

  const silencePct = voice && voice.silenceCountdown > 0
    ? (voice.silenceCountdown / voice.silenceTimeoutMs) * 100
    : 0

  const iconBtn = 'flex items-center justify-center rounded-full min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 p-2.5 md:p-1.5 text-content-tertiary hover:text-content-primary hover:bg-surface-elevated/70 transition-colors duration-fast'
  const iconBtnActive = 'flex items-center justify-center rounded-full min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 p-2.5 md:p-1.5 text-accent hover:text-accent-hover hover:bg-accent-dim transition-colors duration-fast'

  return (
    <div ref={dropZoneRef} className="relative">
      {/* Unified input pill */}
      <div className={clsx(
        'glass-card rounded-3xl border overflow-hidden transition-colors duration-fast',
        isDragging ? 'border-accent' : 'border-border-subtle',
      )}>

        {/* Output style panel — slides in above textarea */}
        <div
          className="overflow-hidden transition-all duration-normal ease-out"
          style={{ maxHeight: drawerOpen ? '320px' : '0px', opacity: drawerOpen ? 1 : 0 }}
        >
          <div className="px-4 pt-4 pb-3 border-b border-border-subtle/60">
            <OutputStylePicker />
          </div>
        </div>

        {/* File previews */}
        <FilePreviewBar files={pendingFiles} onRemove={removeFile} />

        {/* Conversation mode status bar */}
        {voice?.conversationMode && (
          <div
            className="mx-3 mt-3 flex items-center gap-2 px-3 py-2 rounded-xl border text-sm relative overflow-hidden"
            style={{
              backgroundColor: voice.conversationState === 'listening' ? 'rgba(127,29,29,0.4)'
                : voice.conversationState === 'speaking' ? 'rgba(20,83,45,0.3)'
                : 'rgba(41,37,36,0.5)',
              borderColor: voice.conversationState === 'listening' ? 'rgba(239,68,68,0.2)'
                : voice.conversationState === 'speaking' ? 'rgba(34,197,94,0.2)'
                : 'rgba(255,255,255,0.06)',
            }}
          >
            {silencePct > 0 && (
              <div
                className="absolute inset-y-0 left-0 bg-amber-500/10 transition-all duration-100"
                style={{ width: `${100 - silencePct}%` }}
              />
            )}
            <div className="relative flex items-center gap-2 w-full">
              {voice.conversationState === 'listening' && (
                <>
                  <Mic size={14} className="text-red-400 shrink-0 animate-pulse" />
                  <AudioLevelIndicator level={audioLevel} bars={4} className="h-3.5 shrink-0" />
                  <span className="min-w-0 text-content-secondary truncate">{liveTranscript || 'Listening...'}</span>
                  <span className="text-content-tertiary shrink-0 ml-auto text-xs">{Math.floor(voice.recordingDuration / 1000)}s</span>
                </>
              )}
              {voice.conversationState === 'processing' && (
                <>
                  <Loader2 size={14} className="text-content-tertiary shrink-0 animate-spin" />
                  <span className="text-content-secondary">Thinking...</span>
                </>
              )}
              {voice.conversationState === 'speaking' && (
                <>
                  <Volume2 size={14} className="text-green-400 shrink-0" />
                  <span className="text-content-secondary">Speaking... interrupt anytime</span>
                </>
              )}
              {voice.conversationState === 'idle' && (
                <span className="text-content-tertiary">Conversation mode — waiting...</span>
              )}
            </div>
          </div>
        )}

        {/* Non-conversation recording indicator */}
        {voice && !voice.conversationMode && voice.isRecording && (
          <div className="mx-3 mt-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-danger-dim/50 border border-danger/20 text-sm">
            <Mic size={14} className="text-danger shrink-0 animate-pulse" />
            <AudioLevelIndicator level={audioLevel} bars={4} className="h-3.5 shrink-0" />
            <span className="min-w-0 text-content-secondary truncate">{liveTranscript || 'Listening...'}</span>
            <span className="text-content-tertiary shrink-0 ml-auto text-xs">{Math.floor(voice.recordingDuration / 1000)}s</span>
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => {
            // Typing over a recalled message drops out of history navigation:
            // the edited text becomes the live draft and Enter re-submits it.
            historyIdxRef.current = -1
            setInput(e.target.value)
            resizeTextarea()
          }}
          onKeyDown={handleKeyDown}
          placeholder={voice?.conversationMode ? 'Conversation mode active (Esc to exit)' : `Message ${aiName}...`}
          rows={1}
          disabled={voice?.conversationMode}
          className="w-full bg-transparent resize-none text-content-primary placeholder:text-content-tertiary outline-none px-4 pt-4 pb-2 disabled:opacity-50"
          style={{ minHeight: '44px', maxHeight: '400px', fontSize: '16px' }}
        />

        {/* Action row */}
        <div className="flex items-center justify-between px-3 pb-3 pt-1 gap-2">
          {/* Left: attach + feature toggles + output style */}
          <div className="flex items-center gap-1.5 md:gap-0.5">
            <Tooltip content="Attach file">
              <button type="button" onClick={openFilePicker} className={iconBtn}>
                <Paperclip size={15} />
              </button>
            </Tooltip>

            <span className="hidden md:inline-flex">
              <Tooltip content={webSearchEnabled ? 'Web search on' : 'Web search'}>
                <button
                  type="button"
                  onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                  className={webSearchEnabled ? iconBtnActive : iconBtn}
                >
                  <Globe size={15} />
                </button>
              </Tooltip>
            </span>

            <span className="hidden md:inline-flex">
              <Tooltip content={deepResearchEnabled ? 'Deep research on' : 'Deep research'}>
                <button
                  type="button"
                  onClick={() => setDeepResearchEnabled(!deepResearchEnabled)}
                  className={deepResearchEnabled ? iconBtnActive : iconBtn}
                >
                  <BookOpen size={15} />
                </button>
              </Tooltip>
            </span>

            <Tooltip content="Output style & instructions">
              <button
                type="button"
                onClick={() => setDrawerOpen(o => !o)}
                className={drawerOpen ? iconBtnActive : iconBtn}
              >
                <SlidersHorizontal size={15} />
              </button>
            </Tooltip>
          </div>

          {/* Right: text size + mute + model chip + manage + send/mic */}
          <div className="flex items-center gap-2 md:gap-1">
            <span className="hidden md:inline-flex">
              <Tooltip content={`Text size: ${textSize}`}>
                <button type="button" onClick={cycleTextSize} className={`${iconBtn} gap-0.5`}>
                  <ALargeSmall size={14} />
                  <span className="text-[10px] font-mono">{TEXT_LABELS[textSize]}</span>
                </button>
              </Tooltip>
            </span>

            {voice?.available && (
              <Tooltip content={voice.muted ? 'Unmute voice responses' : 'Mute voice responses'}>
                <button
                  type="button"
                  onClick={() => voice.setMuted(m => !m)}
                  className={voice.muted ? iconBtn : iconBtnActive}
                >
                  {voice.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                </button>
              </Tooltip>
            )}

            <ModelPicker
              value={modelId}
              onChange={onModelChange}
              models={models.map(m => ({ id: m.id, provider: m.provider }))}
              className="max-w-[200px] md:max-w-[160px]"
              buttonClassName="flex items-center justify-center gap-1 min-h-[44px] md:min-h-0 px-3 py-2 md:px-2 md:py-1 rounded-full text-xs md:text-[11px] font-mono text-content-tertiary hover:text-content-primary hover:bg-surface-elevated/70 transition-colors duration-fast bg-transparent border-0 outline-none cursor-pointer truncate max-w-[200px] md:max-w-[160px]"
            />

            <span className="hidden md:inline-flex">
              <Tooltip content="Manage models">
                <button type="button" onClick={onManageModels} className={iconBtn}>
                  <Settings2 size={13} />
                </button>
              </Tooltip>
            </span>

            <MorphButton
              hasText={!!input.trim()}
              isRecording={voice?.isRecording ?? false}
              isTranscribing={voice?.isTranscribing ?? false}
              conversationMode={voice?.conversationMode ?? false}
              voiceAvailable={!!voice?.available}
              insecureContext={!voice?.available && typeof window !== 'undefined' && !window.isSecureContext}
              onSend={handleSubmit}
              onToggleRecording={voice?.toggleRecording ?? (() => {})}
              onStartConversation={() => voice?.setConversationMode(true)}
              onStopConversation={() => voice?.setConversationMode(false)}
            />
          </div>
        </div>
      </div>

      {isDragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-accent-dim/60 rounded-3xl pointer-events-none">
          <p className="text-compact font-medium text-accent">Drop files here</p>
        </div>
      )}
    </div>
  )
}
