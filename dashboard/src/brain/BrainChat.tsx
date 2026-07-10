/**
 * BrainChat — a slide-in chat drawer for the Brain page.
 *
 * Shares the app-wide chat store and streaming client with /chat, so it IS
 * the same conversation — and every turn's memory retrieval streams back
 * through the SSE feed and lights the graph behind it. Talk while watching
 * it think.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, SendHorizonal, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import {
  discoverModels, getOrCreateActiveConversation, readCachedModelCatalog,
  streamChat, type ChatMessage, type ProviderModelList,
} from '../api'
import { useNovaIdentity } from '../hooks/useNovaIdentity'
import { newMsgId, useChatStore, type Message } from '../stores/chat-store'
import { MessageBubble } from '../pages/chat/MessageBubble'
import { Button, Select, Textarea } from '../components/ui'

const MIN_W = 320
const MAX_W = 720
const clampW = (w: number) => Math.max(MIN_W, Math.min(MAX_W, Math.round(w)))

export function BrainChat({ open, width, onWidthChange, onClose }: {
  open: boolean
  width: number
  onWidthChange: (w: number) => void
  onClose: () => void
}) {
  const { name: aiName } = useNovaIdentity()
  const {
    messages, setMessages,
    sessionId, setSessionId,
    conversationId, setConversationId,
    modelId, setModelId,
    setError,
  } = useChatStore()

  // same catalog + store key as /chat, so the picker stays in sync with it
  const { data: providers } = useQuery({
    queryKey: ['model-catalog'],
    queryFn: () => discoverModels(),
    initialData: (): ProviderModelList[] | undefined => readCachedModelCatalog()?.data,
    initialDataUpdatedAt: () => readCachedModelCatalog()?.at,
    staleTime: 60_000,
  })
  const models = (providers ?? [])
    .filter(p => p.available)
    .flatMap(p => p.models.filter(m => m.registered).map(m => ({ id: m.id, provider: p.name })))

  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, open])

  const send = async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')
    setStreaming(true)
    setError(null)

    const userMsg: Message = {
      id: newMsgId(), role: 'user', content: text, timestamp: new Date(),
    }
    const assistantId = newMsgId()
    setMessages(prev => [
      ...prev, userMsg,
      { id: assistantId, role: 'assistant', content: '', timestamp: new Date(), isStreaming: true, activitySteps: [] },
    ])

    try {
      let conv = conversationId
      if (!conv) {
        conv = await getOrCreateActiveConversation()
        setConversationId(conv)
      }
      const history: ChatMessage[] = [...messages, userMsg]
        .slice(-20)
        .filter(m => typeof m.content === 'string' && m.content)
        .map(m => ({ role: m.role, content: m.content }))

      let accumulated = ''
      for await (const event of streamChat(history, modelId || undefined, sessionId, { conversation_id: conv })) {
        if (typeof event === 'object' && 'status' in event) {
          const step = event.status
          setMessages(prev => prev.map(m => {
            if (m.id !== assistantId) return m
            const steps = [...(m.activitySteps ?? [])]
            const idx = steps.findIndex(s => s.step === step.step)
            const enriched = { ...step, startedAt: idx >= 0 ? steps[idx].startedAt : Date.now() }
            if (idx >= 0) steps[idx] = enriched; else steps.push(enriched)
            return { ...m, activitySteps: steps, ...(step.model ? { modelUsed: step.model } : {}) }
          }))
          continue
        }
        if (typeof event === 'object' && 'meta' in event) {
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, modelUsed: event.meta.model, category: event.meta.category } : m))
          continue
        }
        if (typeof event === 'object' && ('heartbeat' in event || 'think' in event)) continue
        accumulated += event
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: accumulated, activityCollapsed: true } : m))
      }
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, isStreaming: false } : m))
    } catch (err) {
      setError(String(err))
      setMessages(prev => prev.map(m =>
        m.id === assistantId
          ? { ...m, isStreaming: false, content: m.content || `⚠ ${String(err)}` }
          : m))
    } finally {
      setStreaming(false)
    }
  }

  return (
    <aside
      className={`absolute top-12 right-0 bottom-0 z-30 flex max-w-[calc(100%-16px)] flex-col
                  border-l border-white/[0.10] bg-[rgba(10,22,21,0.85)] backdrop-blur-2xl
                  shadow-[0_8px_40px_rgba(0,0,0,0.5)] transition-transform duration-200
                  ${open ? 'translate-x-0' : 'translate-x-full'}`}
      style={{ width }}
      aria-label={`Chat with ${aiName}`}
      aria-hidden={!open}
    >
      {/* drag handle: resize the drawer — double-click resets, arrow keys nudge */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat drawer"
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        className="absolute inset-y-0 -left-1 z-10 w-2.5 cursor-col-resize outline-none
                   hover:bg-teal-400/25 active:bg-teal-400/40 focus-visible:bg-teal-400/40"
        onPointerDown={e => {
          e.preventDefault()
          resizeRef.current = { startX: e.clientX, startW: width }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          const r = resizeRef.current
          if (r) onWidthChange(clampW(r.startW + r.startX - e.clientX))
        }}
        onPointerUp={e => {
          resizeRef.current = null
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        onPointerCancel={e => {
          resizeRef.current = null
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        onDoubleClick={() => onWidthChange(400)}
        onKeyDown={e => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); onWidthChange(clampW(width + 24)) }
          if (e.key === 'ArrowRight') { e.preventDefault(); onWidthChange(clampW(width - 24)) }
        }}
      />
      <div className="flex items-center gap-2 border-b border-white/[0.08] px-4 py-2.5">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-content-secondary">
          Chat · <span className="text-teal-400">{aiName}</span>
        </span>
        <Link to="/chat" className="ml-auto text-content-tertiary hover:text-content-primary" title="Open full chat">
          <ExternalLink size={14} />
        </Link>
        <button
          className="rounded px-1.5 py-1 text-content-tertiary hover:bg-white/[0.06] hover:text-content-primary"
          onClick={onClose}
          aria-label="Close chat"
        >
          <X size={15} />
        </button>
      </div>

      <div ref={scrollRef} className="custom-scrollbar flex-1 space-y-3 overflow-y-auto px-3 py-3"
           style={{ zoom: 0.82 }}>
        {messages.length === 0 && (
          <p className="px-2 pt-6 text-center text-compact text-content-tertiary">
            Same conversation as the Chat page — ask something and watch the
            graph behind this drawer light up as {aiName} retrieves memories.
          </p>
        )}
        {messages.map(m => <MessageBubble key={m.id} message={m} />)}
      </div>

      <div className="border-t border-white/[0.08] p-3 space-y-3">
        <Select
          value={modelId}
          onChange={e => setModelId(e.target.value)}
          className="h-7 w-full font-mono text-[11px]"
          aria-label="Model"
        >
          <option value="">auto (routing decides)</option>
          {models.map(m => (
            <option key={m.id} value={m.id}>{m.id} · {m.provider}</option>
          ))}
        </Select>
        <div className="flex items-center gap-2">
          <Textarea
            rows={2}
            value={input}
            placeholder={`Message ${aiName}…`}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
            className="flex-1 resize-none text-compact"
          />
          <Button
            size="sm"
            icon={<SendHorizonal size={14} />}
            onClick={send}
            disabled={!input.trim() || streaming}
            loading={streaming}
            aria-label="Send"
          />
        </div>
      </div>
    </aside>
  )
}
