import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { apiFetch, type ToolApprovalRequest } from '../api'

export interface EngramSummary {
  id: string
  type: string
  preview: string
  source_type?: string
}

export interface ActivityStep {
  step: string
  state: 'running' | 'done'
  detail?: string
  elapsed_ms?: number
  model?: string
  category?: string | null
  startedAt?: number  // Date.now(), set client-side for live timer
  engram_ids?: string[]  // IDs of engrams retrieved during memory step
  engram_summaries?: EngramSummary[]  // Brief info about retrieved engrams
}

export interface AttachedFile {
  id: string
  file: File
  previewUrl: string | null  // blob URL for images, null for text files
  type: 'image' | 'text'
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  isStreaming?: boolean
  modelUsed?: string
  category?: string
  activitySteps?: ActivityStep[]
  activityCollapsed?: boolean
  attachments?: AttachedFile[]
  pendingApprovals?: ToolApprovalRequest[]
  metadata?: Record<string, unknown>
}

interface ChatStore {
  messages: Message[]
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  sessionId: string | undefined
  setSessionId: React.Dispatch<React.SetStateAction<string | undefined>>
  conversationId: string | null
  setConversationId: React.Dispatch<React.SetStateAction<string | null>>
  modelId: string
  setModelId: React.Dispatch<React.SetStateAction<string>>
  error: string | null
  setError: React.Dispatch<React.SetStateAction<string | null>>
  resetConversation: () => void
  loadConversation: (id: string) => Promise<void>
  newConversation: () => Promise<void>

  // Draft input text (survives navigation)
  draftInput: string
  setDraftInput: React.Dispatch<React.SetStateAction<string>>

  // Pre-fill input from external pages (e.g. "Discuss" on Tasks page)
  prefillInput: string | null
  setPrefillInput: React.Dispatch<React.SetStateAction<string | null>>

  // Drawer & input controls
  pendingFiles: AttachedFile[]
  setPendingFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>
  drawerOpen: boolean
  setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>
  outputStyle: string
  setOutputStyle: React.Dispatch<React.SetStateAction<string>>
  customInstructions: string
  setCustomInstructions: React.Dispatch<React.SetStateAction<string>>
  webSearchEnabled: boolean
  setWebSearchEnabled: React.Dispatch<React.SetStateAction<boolean>>
  deepResearchEnabled: boolean
  setDeepResearchEnabled: React.Dispatch<React.SetStateAction<boolean>>

  // Sidebar state
  sidebarCollapsed: boolean
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>
}

const STORAGE_KEY = 'nova_chat_history'

/** Check if there's a legacy localStorage chat to potentially migrate. */
export function hasLegacyChat(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return false
    const data = JSON.parse(raw)
    return Array.isArray(data?.messages) && data.messages.length > 0
  } catch {
    return false
  }
}

export function getLegacyChat(): { sessionId: string | undefined; messages: Array<{ role: string; content: string; timestamp: string; modelUsed?: string }> } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function clearLegacyChat() {
  localStorage.removeItem(STORAGE_KEY)
}

const ChatContext = createContext<ChatStore | null>(null)

export function ChatProvider({ children }: { children: ReactNode }) {
  const activeConvId = localStorage.getItem('nova_active_conversation')

  const [messages, setMessages] = useState<Message[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(
    activeConvId ?? undefined
  )
  const [conversationId, setConversationId] = useState<string | null>(activeConvId)
  const [modelId, _setModelId] = useState(
    () => localStorage.getItem('nova_chat_model') ?? ''
  )
  const setModelId: React.Dispatch<React.SetStateAction<string>> = useCallback((val) => {
    _setModelId(prev => {
      const next = typeof val === 'function' ? val(prev) : val
      localStorage.setItem('nova_chat_model', next)
      return next
    })
  }, [])
  const [error, setError] = useState<string | null>(null)

  // Refs for current values — needed by resetConversation's stable callback
  const messagesRef = useRef(messages)
  const sessionIdRef = useRef(sessionId)
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  const [draftInput, setDraftInput] = useState('')
  const [prefillInput, setPrefillInput] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [outputStyle, setOutputStyle] = useState(
    () => localStorage.getItem('nova_output_style') ?? ''
  )
  const [customInstructions, setCustomInstructions] = useState(
    () => localStorage.getItem('nova_custom_instructions') ?? ''
  )
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [deepResearchEnabled, setDeepResearchEnabled] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('nova_sidebar_collapsed') === 'true'
  )

  // Persist active conversation ID across page refreshes (authenticated)
  useEffect(() => {
    if (conversationId) {
      localStorage.setItem('nova_active_conversation', conversationId)
    } else {
      localStorage.removeItem('nova_active_conversation')
    }
  }, [conversationId])

  // Persist sidebar state
  useEffect(() => {
    localStorage.setItem('nova_sidebar_collapsed', String(sidebarCollapsed))
  }, [sidebarCollapsed])

  const loadConversation = useCallback(async (id: string) => {
    try {
      const msgs = await apiFetch<Array<{
        id?: string; role: string; content: string; model_used?: string; metadata?: Record<string, unknown>; created_at: string
      }>>(`/api/v1/tasks/${id}/messages`)
      setMessages(msgs.map(m => ({
        id: m.id ?? crypto.randomUUID(),
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: new Date(m.created_at),
        modelUsed: m.model_used ?? undefined,
        metadata: m.metadata,
      })))
      setConversationId(id)
      setSessionId(id)  // conversation ID = session ID for memory compatibility
      setError(null)
      setPendingFiles([])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversation')
    }
  }, [])

  const newConversation = useCallback(async () => {
    try {
      const conv = await apiFetch<{ id: string }>('/api/v1/conversations', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setMessages([])
      setConversationId(conv.id)
      setSessionId(conv.id)
      setError(null)
      setPendingFiles([])
    } catch {
      // Fallback: local-only conversation (e.g. REQUIRE_AUTH=false)
      setMessages([])
      setConversationId(null)
      setSessionId(undefined)
      setError(null)
      setPendingFiles([])
    }
  }, [])

  const resetConversation = useCallback(() => {
    setMessages([])
    setConversationId(null)
    setSessionId(undefined)
    setError(null)
    setPendingFiles([])
    setDraftInput('')
  }, [])

  return (
    <ChatContext.Provider value={{
      messages, setMessages,
      sessionId, setSessionId,
      conversationId, setConversationId,
      modelId, setModelId,
      error, setError,
      resetConversation,
      loadConversation,
      newConversation,
      draftInput, setDraftInput,
      prefillInput, setPrefillInput,
      pendingFiles, setPendingFiles,
      drawerOpen, setDrawerOpen,
      outputStyle, setOutputStyle,
      customInstructions, setCustomInstructions,
      webSearchEnabled, setWebSearchEnabled,
      deepResearchEnabled, setDeepResearchEnabled,
      sidebarCollapsed, setSidebarCollapsed,
    }}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChatStore(): ChatStore {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChatStore must be used within ChatProvider')
  return ctx
}
