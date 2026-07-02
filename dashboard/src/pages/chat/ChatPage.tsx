import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { streamChat, discoverModels, resolveModel, apiFetch, getOrCreateActiveConversation, readCachedModelCatalog, type ChatMessage, type ContentBlock, type StreamEvent, type ProviderModelList } from '../../api'
import { useChatStore, type Message } from '../../stores/chat-store'
import { cleanToolArtifacts } from '../../utils/cleanToolArtifacts'
import { useNovaIdentity } from '../../hooks/useNovaIdentity'
import { useVoiceChat } from '../../hooks/useVoiceChat'
import { ModelManagerModal, getHiddenModels } from '../../components/ModelManagerModal'
import { MessageBubble } from './MessageBubble'
import { ChatInput } from './ChatInput'
import { useMobileNav } from '../../hooks/useMobileNav'
import { useIsMobile } from '../../hooks/useIsMobile'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function Chat() {
  const {
    messages, setMessages,
    sessionId, setSessionId,
    conversationId, setConversationId,
    modelId, setModelId,
    error, setError,
    resetConversation,
    loadConversation,
    pendingFiles, setPendingFiles,
    outputStyle,
    customInstructions,
    webSearchEnabled,
    deepResearchEnabled,
    setDraftInput,
  } = useChatStore()
  const queryClient = useQueryClient()

  const { name: aiName, greeting } = useNovaIdentity()
  const [isStreaming, setIsStreaming] = useState(false)
  const [messageQueue, setMessageQueue] = useState<string[]>([])
  const [modelManagerOpen, setModelManagerOpen] = useState(false)
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => getHiddenModels())
  const { setHidden: setNavHidden } = useMobileNav()
  const isMobile = useIsMobile()
  const keyboardOpenRef = useRef(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // Track conversation switches to use instant scroll (no animation) on load
  const lastConversationId = useRef(conversationId)
  const needsInstantScroll = useRef(true)
  // Ref for messages so handleSubmit doesn't recreate on every message change
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const { data: providers } = useQuery({
    queryKey: ['model-catalog'],
    queryFn: () => discoverModels(),
    initialData: (): ProviderModelList[] | undefined => readCachedModelCatalog()?.data,
    initialDataUpdatedAt: () => readCachedModelCatalog()?.at,
    staleTime: 60_000,
  })
  const allModels = (providers ?? [])
    .filter(p => p.available)
    .flatMap(p => p.models.filter(m => m.registered).map(m => ({ id: m.id, provider: p.name })))
  const models = allModels.filter(m => !hiddenModels.has(m.id))

  const { data: resolved } = useQuery({
    queryKey: ['resolved-model'],
    queryFn: resolveModel,
    staleTime: 30_000,
  })

  // Default to the resolved model when no explicit model has been selected,
  // or when the current selection has been hidden
  useEffect(() => {
    const needsDefault = !modelId || modelId === 'auto' || (modelId && hiddenModels.has(modelId))
    if (needsDefault && resolved?.model) {
      setModelId(resolved.model)
    }
  }, [modelId, resolved, hiddenModels, setModelId])

  // ── Voice chat integration ──
  const silenceTimeoutMs = Number(localStorage.getItem('nova_voice_silence_timeout')) || 2000
  const bargeInThreshold = Number(localStorage.getItem('nova_voice_bargein_threshold')) || 0.15
  const pendingTranscriptRef = useRef<string | null>(null)
  const isStreamingRef = useRef(false)
  isStreamingRef.current = isStreaming
  const feedTextRef = useRef<(delta: string) => void>(() => {})
  const flushBufferRef = useRef<() => void>(() => {})

  const handleVoiceTranscript = useCallback((text: string) => {
    if (isStreamingRef.current) {
      pendingTranscriptRef.current = text
    } else {
      setDraftInput(text)
    }
  }, [setDraftInput])

  const handleVoiceError = useCallback((err: string) => {
    setError(err)
  }, [setError])

  const {
    isRecording, isTranscribing, isSpeaking, recordingDuration,
    toggleRecording, voiceAvailable, mediaStream,
    feedText, flushBuffer, stopAllPlayback,
    muted, setMuted,
    conversationMode, setConversationMode, conversationState, silenceCountdown,
  } = useVoiceChat({
    onTranscript: handleVoiceTranscript,
    onError: handleVoiceError,
    silenceTimeoutMs,
    bargeInThreshold,
  })

  feedTextRef.current = feedText
  flushBufferRef.current = flushBuffer

  useEffect(() => {
    if (conversationId !== lastConversationId.current) {
      needsInstantScroll.current = true
      lastConversationId.current = conversationId
    }
  }, [conversationId])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (needsInstantScroll.current) {
      el.scrollTop = el.scrollHeight
      needsInstantScroll.current = false
      return
    }
    // Only auto-scroll if user is near the bottom (within 150px).
    // This avoids hijacking scroll when the user is reading earlier messages.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 150) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  // Auto-load the active conversation on mount for authenticated users.
  // If a conversationId is already known, load messages for it.
  // Otherwise fetch/create the most recent conversation and load that.
  // Never call resetConversation on failure — just leave the user in a
  // working state so they can keep chatting even if the API is down.
  useEffect(() => {
    if (conversationId) {
      if (messages.length === 0 && !isStreaming) {
        loadConversation(conversationId).catch(() => {
          // Conversation no longer exists — try to get/create one silently
          getOrCreateActiveConversation().then(id => {
            loadConversation(id).catch(() => {})
          }).catch(() => {})
        })
      }
    } else {
      // No stored conversation — fetch or create the active one
      getOrCreateActiveConversation().then(id => {
        loadConversation(id).catch(() => {})
      }).catch(() => {
        // API unavailable — do nothing, user can still chat without persistence
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // Run once on mount only

  // Cross-device sync: refetch messages when tab/app regains focus.
  // Handles the case where messages were sent from another device.
  useEffect(() => {
    let lastRefresh = 0
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (isStreamingRef.current) return
      if (Date.now() - lastRefresh < 5_000) return
      lastRefresh = Date.now()
      if (conversationId) {
        loadConversation(conversationId).catch(() => {})
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [conversationId, loadConversation, queryClient])

  // Desktop: keyboard + scroll-based nav hiding.
  // Mobile (chat-only PWA): skip entirely — no nav bar to hide, h-[100dvh] handles keyboard.
  useEffect(() => {
    if (isMobile) return
    const vv = window.visualViewport
    if (!vv || !containerRef.current) return
    if (!('ontouchstart' in window)) return

    const onResize = () => {
      const keyboardOpen = vv.height < window.innerHeight - 100
      keyboardOpenRef.current = keyboardOpen
      setNavHidden(keyboardOpen)
      if (keyboardOpen) {
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
        })
      }
    }
    vv.addEventListener('resize', onResize)
    return () => {
      vv.removeEventListener('resize', onResize)
      keyboardOpenRef.current = false
      setNavHidden(false)
    }
  }, [setNavHidden, isMobile])

  // Desktop: auto-hide nav on scroll down
  useEffect(() => {
    if (isMobile) return
    const el = scrollContainerRef.current
    if (!el || !('ontouchstart' in window)) return

    let lastScrollTop = el.scrollTop
    const threshold = 10

    const onScroll = () => {
      if (keyboardOpenRef.current) return
      const delta = el.scrollTop - lastScrollTop
      if (Math.abs(delta) < threshold) return
      setNavHidden(delta > 0)
      lastScrollTop = el.scrollTop
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [setNavHidden, isMobile])

  const handleSubmit = useCallback(async (text: string, fromQueue = false) => {
    if (isStreaming && !fromQueue) {
      // Show user message immediately, queue for sequential processing
      const queuedMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        timestamp: new Date(),
      }
      setMessages(prev => [...prev, queuedMsg])
      setMessageQueue(q => [...q, text])
      return
    }

    setError(null)

    // Capture pending files before clearing (skip for queued messages)
    const attachments = (!fromQueue && pendingFiles.length > 0) ? [...pendingFiles] : undefined
    if (attachments) setPendingFiles([])

    const assistantMsgId = crypto.randomUUID()
    const assistantMsg: Message = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isStreaming: true,
    }

    // Always scroll to bottom when user sends a message
    needsInstantScroll.current = true
    if (fromQueue) {
      // User message already shown when queued
      setMessages(prev => [...prev, assistantMsg])
    } else {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        timestamp: new Date(),
        attachments,
      }
      setMessages(prev => [...prev, userMsg, assistantMsg])
    }
    setIsStreaming(true)

    // Auto-create conversation without one
    let activeConversationId = conversationId
    if (!activeConversationId) {
      try {
        const conv = await apiFetch<{ id: string }>('/api/v1/conversations', {
          method: 'POST',
          body: JSON.stringify({}),
        })
        activeConversationId = conv.id
        setConversationId(conv.id)
        setSessionId(conv.id)
      } catch {
        // Fallback: no conversation persistence
      }
    }

    const currentSessionId = activeConversationId ?? sessionId ?? (() => {
      const newId = crypto.randomUUID()
      setSessionId(newId)
      return newId
    })()

    // Build message history (read from ref to avoid dep-array churn)
    const history: ChatMessage[] = [
      ...messagesRef.current.map(m => ({ role: m.role as ChatMessage['role'], content: m.content })),
    ]

    // Build user message content — multimodal if attachments present
    let userContent: string | ContentBlock[] = text
    if (attachments && attachments.length > 0) {
      const blocks: ContentBlock[] = [{ type: 'text', text }]
      for (const att of attachments) {
        if (att.type === 'image') {
          // Convert to base64 data URL for vision models
          const data = await fileToBase64(att.file)
          blocks.push({ type: 'image_url', image_url: { url: data } })
        } else {
          // Read text file content and include inline
          const content = await att.file.text()
          blocks.push({ type: 'text', text: `Content of ${att.file.name}:\n\`\`\`\n${content}\n\`\`\`` })
        }
      }
      userContent = blocks
    }
    // For queued messages, user message is already in the messages array
    if (!fromQueue) {
      history.push({ role: 'user', content: userContent })
    }

    // Build stream options
    const streamOptions = {
      ...(outputStyle ? { output_style: outputStyle } : {}),
      ...(customInstructions.trim() ? { custom_instructions: customInstructions.trim() } : {}),
      ...(webSearchEnabled ? { web_search: true } : {}),
      ...(deepResearchEnabled ? { deep_research: true } : {}),
      ...(activeConversationId ? { conversation_id: activeConversationId } : {}),
    }

    try {
      let accumulated = ''
      let firstTextDelta = true
      for await (const event of streamChat(history, modelId || undefined, currentSessionId, streamOptions)) {
        if (typeof event === 'object' && 'status' in event) {
          const step = event.status
          setMessages(prev => prev.map(m => {
            if (m.id !== assistantMsgId) return m
            const steps = [...(m.activitySteps ?? [])]
            const idx = steps.findIndex(s => s.step === step.step)
            const enriched = { ...step, startedAt: idx >= 0 ? steps[idx].startedAt : Date.now() }
            if (idx >= 0) steps[idx] = enriched; else steps.push(enriched)
            return {
              ...m,
              activitySteps: steps,
              ...(step.model ? { modelUsed: step.model } : {}),
              ...(step.category ? { category: step.category } : {}),
            }
          }))
          continue
        }
        if (typeof event === 'object' && 'meta' in event) {
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? { ...m, modelUsed: event.meta.model, category: event.meta.category }
                : m
            )
          )
          continue
        }
        if (typeof event === 'object' && 'heartbeat' in event) {
          // Proof-of-life during a long silence — update elapsed so the status
          // line can show "still working (Ns)" instead of looking frozen.
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId ? { ...m, elapsedMs: event.heartbeat } : m
            )
          )
          continue
        }
        // Text delta — collapse activity feed on first token
        if (firstTextDelta) {
          firstTextDelta = false
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId ? { ...m, activityCollapsed: true } : m
            )
          )
        }
        accumulated += event
        feedTextRef.current(event as string)
      }
      // Stream complete — show the full response and mark all steps done
      needsInstantScroll.current = true
      setMessages(prev =>
        prev.map(m => {
          if (m.id !== assistantMsgId) return m
          const steps = m.activitySteps?.map(s =>
            s.state === 'running' ? { ...s, state: 'done' as const } : s
          )
          return { ...m, content: cleanToolArtifacts(accumulated), isStreaming: false, activitySteps: steps }
        })
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Self-heal a stale/orphaned conversation: if the backend can't find the
      // conversation we sent (e.g. it was reset, or belongs to another user),
      // drop the id so the ChatPage re-creates a fresh one for the next send.
      if (msg.includes('Conversation not found') || msg.startsWith('404')) {
        localStorage.removeItem('nova_active_conversation')
        setConversationId(null)
      }
      setError(msg)
      setMessages(prev =>
        prev.map(m => {
          if (m.id !== assistantMsgId) return m
          const steps = m.activitySteps?.map(s =>
            s.state === 'running' ? { ...s, state: 'done' as const } : s
          )
          return { ...m, content: `Error: ${msg}`, isStreaming: false, activitySteps: steps }
        })
      )
    } finally {
      flushBufferRef.current()
      setIsStreaming(false)
      if (conversationId) {
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
      }
    }
  }, [sessionId, conversationId, modelId, isStreaming, pendingFiles, outputStyle, customInstructions, webSearchEnabled, deepResearchEnabled, queryClient])

  // Process queued messages sequentially when streaming completes
  useEffect(() => {
    if (!isStreaming && messageQueue.length > 0) {
      const next = messageQueue[0]
      setMessageQueue(q => q.slice(1))
      handleSubmit(next, true)
    }
  }, [isStreaming, messageQueue, handleSubmit])

  // Drain pending voice transcript when streaming ends
  useEffect(() => {
    if (!isStreaming && pendingTranscriptRef.current) {
      const text = pendingTranscriptRef.current
      pendingTranscriptRef.current = null
      setDraftInput(text)
    }
  }, [isStreaming, setDraftInput])

  // Conversation mode: auto-listen when muted and stream finishes (TTS skipped)
  useEffect(() => {
    if (conversationMode && muted && !isStreaming && !isRecording && !isTranscribing && !isSpeaking) {
      const timer = setTimeout(() => {
        if (conversationMode && !isRecording) {
          toggleRecording()
        }
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [conversationMode, muted, isStreaming, isRecording, isTranscribing, isSpeaking, toggleRecording])

  // Compute streaming status text. Append an elapsed-seconds counter once a
  // turn has been silent for a few seconds so slow work reads as "still going"
  // rather than "frozen"; quick turns stay clean (no counter).
  const streamingStatus = isStreaming ? (() => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistant) return 'thinking\u2026'
    const elapsedS = lastAssistant.elapsedMs ? Math.round(lastAssistant.elapsedMs / 1000) : 0
    const suffix = elapsedS >= 4 ? ` (${elapsedS}s)` : ''
    if (lastAssistant.content) return 'typing\u2026'
    const steps = lastAssistant.activitySteps ?? []
    const running = steps.find(s => s.state === 'running')
    const labels: Record<string, string> = {
      classifying: 'classifying\u2026',
      memory: 'retrieving memories\u2026',
      generating: 'generating\u2026',
    }
    const base = running
      ? (labels[running.step] ?? `${running.detail || running.step}\u2026`)
      : 'thinking\u2026'
    return base + suffix
  })() : undefined

  const chatInputProps = {
    onSubmit: handleSubmit,
    isStreaming,
    aiName,
    models,
    modelId,
    onModelChange: setModelId,
    resolvedModel: resolved?.model,
    hasMessages: messages.length > 0,
    onManageModels: () => setModelManagerOpen(true),
    voice: voiceAvailable ? {
      available: true as const,
      isRecording,
      isTranscribing,
      isSpeaking,
      recordingDuration,
      toggleRecording,
      muted,
      setMuted,
      conversationMode,
      setConversationMode,
      conversationState,
      silenceCountdown,
      silenceTimeoutMs,
      mediaStream,
    } : undefined,
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Chat Area */}
      <div ref={containerRef} className="flex-1 flex flex-col min-w-0 overflow-hidden bg-surface-root dark:bg-transparent">
        {messages.length === 0 ? (
          /* Empty state: greeting centered, input pinned to bottom */
          <>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar flex items-end">
              <div className="mx-auto px-4 md:px-8 py-6 max-w-none md:max-w-3xl xl:max-w-4xl w-full">
                {greeting && (
                  <MessageBubble message={{
                    id: 'greeting',
                    role: 'assistant',
                    content: greeting,
                    timestamp: new Date(),
                  }} />
                )}
              </div>
            </div>
            <div className="shrink-0 w-full px-2 md:px-8 pb-[env(safe-area-inset-bottom)] md:pb-4">
              <div className="mx-auto max-w-none md:max-w-3xl xl:max-w-4xl">
                <ChatInput {...chatInputProps} />
              </div>
            </div>
          </>
        ) : (
          /* Active chat: scrollable messages + bottom-pinned input */
          <>
            <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
              <div className="mx-auto px-4 md:px-8 py-6 space-y-4 max-w-none md:max-w-3xl xl:max-w-4xl">
                {greeting && (
                  <MessageBubble message={{
                    id: 'greeting',
                    role: 'assistant',
                    content: greeting,
                    timestamp: new Date(),
                  }} />
                )}
                {messages.map((msg, idx) => (
                  <div key={msg.id}>
                    {/* Memory access dots between consecutive AI messages */}
                    {msg.role === 'assistant' && idx > 0 && messages[idx - 1]?.role === 'assistant' && (
                      <div className="flex justify-center gap-1.5 py-1 mb-6">
                        <div className="w-[3px] h-[3px] rounded-full bg-teal-500/30" />
                        <div className="w-[3px] h-[3px] rounded-full bg-teal-500/40" />
                        <div className="w-[3px] h-[3px] rounded-full bg-teal-500/20" />
                      </div>
                    )}
                    <MessageBubble message={msg} conversationMode={conversationMode} />
                  </div>
                ))}

                {error && (
                  <div className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger">
                    {error}
                  </div>
                )}

                <div ref={bottomRef} />
              </div>
            </div>

            {(streamingStatus || messageQueue.length > 0) && (
              <p className="text-caption text-content-tertiary text-center py-1 min-h-6">
                {streamingStatus && <>{aiName} is {streamingStatus}</>}
                {streamingStatus && messageQueue.length > 0 && ' \u00b7 '}
                {messageQueue.length > 0 && `${messageQueue.length} message${messageQueue.length > 1 ? 's' : ''} queued`}
              </p>
            )}

            <div className="shrink-0 w-full px-2 md:px-8 pb-[env(safe-area-inset-bottom)] md:pb-4">
              <div className="mx-auto max-w-none md:max-w-3xl xl:max-w-4xl">
                <ChatInput {...chatInputProps} />
              </div>
            </div>
          </>
        )}

        <ModelManagerModal
          open={modelManagerOpen}
          onClose={() => setModelManagerOpen(false)}
          onSave={setHiddenModels}
        />
      </div>

    </div>
  )
}
