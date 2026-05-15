import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { Plus, MessageSquare } from 'lucide-react'
import clsx from 'clsx'
import { listConversations } from '../../api'

interface ConversationListProps {
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}

export function ConversationList({ activeId, onSelect, onNew }: ConversationListProps) {
  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: listConversations,
    staleTime: 30_000,
    retry: 1,
  })

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border-subtle shrink-0">
        <span className="text-compact font-medium text-content-secondary">Chats</span>
        <button
          onClick={onNew}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-micro text-content-tertiary hover:text-content-primary hover:bg-surface-card transition-colors"
          title="New conversation"
        >
          <Plus size={13} />
          New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar py-1">
        {conversations.length === 0 ? (
          <p className="text-micro text-content-tertiary text-center py-8 px-3">No conversations yet</p>
        ) : (
          conversations.map(conv => (
            <button
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={clsx(
                'w-full text-left px-3 py-2 transition-colors group',
                conv.id === activeId
                  ? 'bg-accent-dim'
                  : 'hover:bg-surface-card',
              )}
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
                    conv.id === activeId ? 'text-content-primary' : 'text-content-secondary group-hover:text-content-primary',
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
          ))
        )}
      </div>
    </div>
  )
}
