import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { Plus, MessageSquare, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { listConversations, deleteConversation, deleteAllConversations } from '../../api'

interface ConversationListProps {
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDeleted: (id: string) => void
  onClearedAll?: () => void
}

export function ConversationList({ activeId, onSelect, onNew, onDeleted, onClearedAll }: ConversationListProps) {
  const queryClient = useQueryClient()
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [confirmClearAll, setConfirmClearAll] = useState(false)

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: listConversations,
    staleTime: 30_000,
    retry: 1,
  })

  async function handleDelete(id: string) {
    try {
      await deleteConversation(id)
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      onDeleted(id)
    } finally {
      setConfirmId(null)
    }
  }

  async function handleClearAll() {
    try {
      await deleteAllConversations()
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      onClearedAll?.()
    } finally {
      setConfirmClearAll(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border-subtle shrink-0">
        {confirmClearAll ? (
          <div className="flex items-center gap-1 w-full">
            <span className="text-micro text-content-secondary flex-1">Clear all chats?</span>
            <button
              onClick={handleClearAll}
              className="px-1.5 py-0.5 rounded text-micro text-danger hover:bg-danger/10 transition-colors"
            >
              Clear
            </button>
            <button
              onClick={() => setConfirmClearAll(false)}
              className="px-1.5 py-0.5 rounded text-micro text-content-tertiary hover:text-content-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <span className="text-compact font-medium text-content-secondary">Chats</span>
            <div className="flex items-center gap-0.5">
              {conversations.length > 0 && (
                <button
                  onClick={() => { setConfirmId(null); setConfirmClearAll(true) }}
                  className="p-1 rounded text-content-tertiary hover:text-danger transition-colors"
                  title="Clear all conversations"
                >
                  <Trash2 size={12} />
                </button>
              )}
              <button
                onClick={onNew}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-micro text-content-tertiary hover:text-content-primary hover:bg-surface-card transition-colors"
                title="New conversation"
              >
                <Plus size={13} />
                New
              </button>
            </div>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar py-1">
        {conversations.length === 0 ? (
          <p className="text-micro text-content-tertiary text-center py-8 px-3">No conversations yet</p>
        ) : (
          conversations.map(conv => (
            <div
              key={conv.id}
              className={clsx(
                'group relative transition-colors',
                conv.id === activeId ? 'bg-accent-dim' : 'hover:bg-surface-card',
              )}
            >
              <button
                onClick={() => { setConfirmId(null); onSelect(conv.id) }}
                className="w-full text-left px-3 py-2 pr-8"
              >
                <div className="flex items-start gap-2">
                  <MessageSquare
                    size={12}
                    className={clsx(
                      'mt-0.5 shrink-0',
                      conv.id === activeId ? 'text-accent' : 'text-content-tertiary',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className={clsx(
                      'text-compact truncate leading-snug',
                      conv.id === activeId
                        ? 'text-content-primary'
                        : 'text-content-secondary group-hover:text-content-primary',
                    )}>
                      {conv.title}
                    </p>
                    {conv.last_message_at && (
                      <p className="text-micro text-content-tertiary mt-0.5">
                        {formatDistanceToNow(new Date(conv.last_message_at), { addSuffix: true })}
                      </p>
                    )}
                  </div>
                </div>
              </button>

              {/* Delete control — hidden unless hovered or confirming */}
              <div className={clsx(
                'absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5',
                confirmId === conv.id ? 'flex' : 'opacity-0 group-hover:opacity-100 transition-opacity',
              )}>
                {confirmId === conv.id ? (
                  <>
                    <button
                      onClick={() => handleDelete(conv.id)}
                      className="px-1.5 py-0.5 rounded text-micro text-danger hover:bg-danger/10 transition-colors"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmId(null)}
                      className="px-1.5 py-0.5 rounded text-micro text-content-tertiary hover:text-content-primary transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmId(conv.id) }}
                    className="p-1 rounded text-content-tertiary hover:text-danger transition-colors"
                    title="Delete conversation"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
