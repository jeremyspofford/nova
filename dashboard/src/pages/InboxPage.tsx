import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, CheckCheck, ChevronDown, ChevronRight, Inbox as InboxIcon, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api'
import { PageHeader } from '../components/layout/PageHeader'
import { useToast } from '../components/ToastProvider'
import { Badge, Button, ConfirmDialog, Skeleton } from '../components/ui'

interface InboxMessage {
  id: number
  created_at: string
  event: string
  title: string
  message: string
  ok: boolean
  detail: string
  read_at: string | null
  approval_id: string | null
  task_id: string | null
  approval_status: string | null
  task_status: string | null
}

interface InboxResponse {
  unread: number
  items: InboxMessage[]
}

const EVENT_LABEL: Record<string, string> = {
  agent_push: 'from Nova',
  task_complete: 'task done',
  task_failed: 'task failed',
  approval_requested: 'approval',
  checkpoint_requested: 'checkpoint',
  pending_human_review: 'review',
  clarification_needed: 'question',
  test: 'test',
}

const EVENT_COLOR: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  agent_push: 'info',
  task_complete: 'success',
  task_failed: 'danger',
  approval_requested: 'warning',
  checkpoint_requested: 'warning',
  pending_human_review: 'warning',
  clarification_needed: 'warning',
  test: 'neutral',
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** Live state of the item a message is about (approval or task), so old
 *  messages stop claiming something is "waiting" after it was resolved. */
interface RefInfo {
  label: string
  color: 'success' | 'warning' | 'danger' | 'info' | 'neutral'
  to: string
  linkLabel: string
  actionable: boolean
}

function refInfo(m: InboxMessage): RefInfo | null {
  if (m.approval_id && m.approval_status) {
    const to = '/approvals'
    const linkLabel = 'Open approvals'
    switch (m.approval_status) {
      case 'pending': return { label: 'awaiting your decision', color: 'warning', to, linkLabel, actionable: true }
      case 'approved': return { label: 'approved', color: 'success', to, linkLabel, actionable: false }
      case 'rejected': return { label: 'rejected', color: 'neutral', to, linkLabel, actionable: false }
      case 'timeout': return { label: 'expired unanswered', color: 'danger', to, linkLabel, actionable: false }
      case 'superseded': return { label: 'superseded', color: 'neutral', to, linkLabel, actionable: false }
      default: return null
    }
  }
  if (m.task_id && m.task_status) {
    const to = '/tasks'
    const linkLabel = 'Open tasks'
    switch (m.task_status) {
      case 'pending_human_review': return { label: 'needs your review', color: 'warning', to, linkLabel, actionable: true }
      case 'waiting_human': return { label: 'checkpoint waiting', color: 'warning', to: '/approvals', linkLabel: 'Open approvals', actionable: true }
      case 'clarification_needed': return { label: 'needs clarification', color: 'warning', to, linkLabel, actionable: true }
      case 'complete': return { label: 'task complete', color: 'success', to, linkLabel, actionable: false }
      case 'failed': return { label: 'task failed', color: 'danger', to, linkLabel, actionable: false }
      case 'cancelled': return { label: 'task cancelled', color: 'neutral', to, linkLabel, actionable: false }
      default: return { label: m.task_status.replace(/_/g, ' '), color: 'info', to, linkLabel, actionable: false }
    }
  }
  return null
}

export function InboxPage() {
  const qc = useQueryClient()
  const { addToast } = useToast()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [confirmClear, setConfirmClear] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['inbox'],
    queryFn: () => apiFetch<InboxResponse>('/api/v1/notify/inbox?limit=100'),
    refetchInterval: 10_000,
  })

  const markRead = useMutation({
    mutationFn: (body: { ids?: number[]; all?: boolean }) =>
      apiFetch<{ marked_read: number }>('/api/v1/notify/inbox/read', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox'] })
      qc.invalidateQueries({ queryKey: ['inbox-unread'] })
    },
  })

  const deleteAll = useMutation({
    mutationFn: () =>
      apiFetch<{ deleted: number }>('/api/v1/notify/inbox?all=true', { method: 'DELETE' }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['inbox'] })
      qc.invalidateQueries({ queryKey: ['inbox-unread'] })
      setConfirmClear(false)
      addToast({ variant: 'success', message: `Deleted ${res.deleted} message${res.deleted === 1 ? '' : 's'}.` })
    },
    onError: (e) => {
      setConfirmClear(false)
      addToast({ variant: 'error', message: `Couldn't delete messages: ${String(e)}` })
    },
  })

  const toggle = (m: InboxMessage) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(m.id)) {
        next.delete(m.id)
      } else {
        next.add(m.id)
        if (!m.read_at) markRead.mutate({ ids: [m.id] })
      }
      return next
    })
  }

  const items = data?.items ?? []
  const unread = data?.unread ?? 0

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inbox"
        description="Everything Nova sends you — briefings, task outcomes, questions — readable here even with no phone or push client set up"
        actions={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => markRead.mutate({ all: true })}
              disabled={unread === 0 || markRead.isPending}
            >
              <CheckCheck className="mr-1.5 h-4 w-4" />
              Mark all read{unread > 0 ? ` (${unread})` : ''}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmClear(true)}
              disabled={items.length === 0 || deleteAll.isPending}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              Delete all
            </Button>
          </div>
        }
      />

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Delete all inbox messages"
        description="Permanently delete every message in your Inbox. This also clears the notification delivery history in Settings → Notifications, since they share the same log."
        confirmLabel={deleteAll.isPending ? 'Deleting...' : 'Delete all'}
        onConfirm={() => deleteAll.mutate()}
        destructive
      />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-border-subtle py-12 text-center">
          <InboxIcon className="mx-auto h-8 w-8 text-content-tertiary" />
          <p className="mt-2 text-compact text-content-secondary">Nothing yet</p>
          <p className="text-caption text-content-tertiary">
            The morning briefing and anything Nova pushes will appear here.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {items.map(m => {
            const isOpen = expanded.has(m.id)
            const isUnread = !m.read_at
            const ref = refInfo(m)
            return (
              <div key={m.id}>
                <button
                  onClick={() => toggle(m)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-card"
                >
                  {isOpen
                    ? <ChevronDown className="h-4 w-4 shrink-0 text-content-tertiary" />
                    : <ChevronRight className="h-4 w-4 shrink-0 text-content-tertiary" />}
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${isUnread ? 'bg-accent' : 'bg-transparent'}`}
                    title={isUnread ? 'Unread' : undefined}
                  />
                  <span className={`min-w-0 flex-1 truncate text-compact ${isUnread ? 'font-semibold text-content-primary' : 'text-content-secondary'}`}>
                    {m.title}
                  </span>
                  {ref ? (
                    <Badge color={ref.color}>{ref.label}</Badge>
                  ) : (
                    <Badge color={EVENT_COLOR[m.event] ?? 'neutral'}>
                      {EVENT_LABEL[m.event] ?? m.event}
                    </Badge>
                  )}
                  {!m.ok && (
                    <span className="flex shrink-0 items-center gap-1 text-caption text-amber-500" title={m.detail}>
                      <AlertTriangle className="h-3.5 w-3.5" />
                      not pushed
                    </span>
                  )}
                  <span className="shrink-0 text-caption tabular-nums text-content-tertiary">
                    {fmt(m.created_at)}
                  </span>
                </button>
                {isOpen && (
                  <div className="border-t border-border-subtle bg-surface-secondary px-4 py-3 pl-11">
                    <p className="whitespace-pre-wrap text-compact text-content-primary">
                      {m.message || m.title}
                    </p>
                    {ref && (
                      <Link
                        to={ref.to}
                        className={`mt-2 inline-flex items-center gap-1 text-compact ${ref.actionable ? 'font-semibold text-accent hover:text-accent-hover' : 'text-content-secondary hover:text-content-primary'}`}
                      >
                        {ref.linkLabel}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    )}
                    {!m.ok && (
                      <p className="mt-2 text-caption text-amber-500">
                        Push delivery: {m.detail} — the message is only here in the Inbox.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
