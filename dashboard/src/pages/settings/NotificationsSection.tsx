import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CheckCircle2, Copy, Loader2, Radio, Send, Smartphone, XCircle, Zap } from 'lucide-react'
import { apiFetch, updatePlatformConfig } from '../../api'
import { Button, Section, Toggle } from '../../components/ui'

interface NotifyConfig {
  enabled: boolean
  server_url: string
  topic: string
  subscribe_hint: string
  action_base_url: string
  // Live connections to the ntfy server (Android app, open web app).
  // 0 = publishes are cached but nothing receives them. null = unknown.
  connected_subscribers: number | null
}

interface DeliveryReceipt {
  created_at: string
  event: string
  title: string
  ok: boolean
  detail: string
}

export function NotificationsSection() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem('nova-notifications-enabled') === 'true')
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    'Notification' in window ? Notification.permission : 'unsupported'
  )
  const [copied, setCopied] = useState(false)

  const toggle = async (checked: boolean) => {
    if (checked) {
      // Enabling -- request permission first
      if ('Notification' in window && Notification.permission !== 'granted') {
        const result = await Notification.requestPermission()
        setPermission(result)
        if (result !== 'granted') return
      }
      localStorage.setItem('nova-notifications-enabled', 'true')
      setEnabled(true)
    } else {
      localStorage.setItem('nova-notifications-enabled', 'false')
      setEnabled(false)
    }
  }

  const qc = useQueryClient()
  const { data: pushConfig } = useQuery({
    queryKey: ['notify-config'],
    queryFn: () => apiFetch<NotifyConfig>('/api/v1/notify/config'),
  })

  const { data: receipts } = useQuery({
    queryKey: ['notify-log'],
    queryFn: () => apiFetch<DeliveryReceipt[]>('/api/v1/notify/log?limit=8'),
  })

  const testPush = useMutation({
    mutationFn: () => apiFetch<{ sent: boolean }>('/api/v1/notify/test', { method: 'POST' }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['notify-log'] })
      qc.invalidateQueries({ queryKey: ['notify-config'] })
    },
  })

  // Lockscreen actions: base URL the phone can reach the dashboard on.
  // null = untouched (show the server value); string = local edit in progress.
  const [actionUrlEdit, setActionUrlEdit] = useState<string | null>(null)
  const actionUrl = actionUrlEdit ?? pushConfig?.action_base_url ?? ''
  const saveActionUrl = useMutation({
    mutationFn: () =>
      updatePlatformConfig('notify.action_base_url', JSON.stringify(actionUrl.trim())),
    onSuccess: () => {
      setActionUrlEdit(null)
      qc.invalidateQueries({ queryKey: ['notify-config'] })
    },
  })

  const copyTopic = async () => {
    if (!pushConfig?.topic) return
    await navigator.clipboard.writeText(pushConfig.topic)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Section
      icon={Radio}
      title="Notifications"
      description="How Nova reaches you -- phone push via the bundled ntfy server, plus browser notifications"
    >
      {/* ── Phone push (ntfy) ─────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-content-tertiary" />
          <p className="text-compact font-medium text-content-primary">Push to your phone</p>
        </div>
        <p className="text-caption text-content-tertiary">
          Approvals, checkpoints, failures, and finished goal work are published to a private
          ntfy topic. Install the ntfy app (ntfy.sh), add this server and topic, and Nova can
          reach you anywhere your phone can reach this machine.
        </p>
        {pushConfig ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-md bg-surface-secondary px-3 py-2">
              <div className="min-w-0">
                <p className="text-caption text-content-tertiary">Topic (treat like a password)</p>
                <p className="truncate font-mono text-compact text-content-primary">{pushConfig.topic || 'not seeded yet'}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={copyTopic} disabled={!pushConfig.topic}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-caption text-content-tertiary">
              Subscribe URL: <span className="font-mono">{pushConfig.subscribe_hint}</span>
              {' '}(phones need <span className="font-mono">NTFY_BIND=0.0.0.0:</span> in .env, or Tailscale)
            </p>
            {pushConfig.connected_subscribers === 0 ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-caption text-amber-600 dark:text-amber-400">
                No device is connected to the ntfy server. Pushes are accepted and cached on
                the topic, but nothing receives them — subscribe with the ntfy app (or open{' '}
                <span className="font-mono">{pushConfig.server_url ? 'the ntfy web app on port 8290' : 'the ntfy web app'}</span>) to start getting them.
              </div>
            ) : pushConfig.connected_subscribers != null ? (
              <p className="flex items-center gap-1.5 text-caption text-emerald-500">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {pushConfig.connected_subscribers} device{pushConfig.connected_subscribers === 1 ? '' : 's'} connected and receiving pushes
                <span className="text-content-tertiary">(iOS polls and won't show here)</span>
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => testPush.mutate()} disabled={testPush.isPending}>
                {testPush.isPending
                  ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  : <Send className="mr-1.5 h-4 w-4" />}
                Send test notification
              </Button>
              {testPush.data && (
                <span className={`text-caption ${testPush.data.sent ? 'text-emerald-500' : 'text-red-500'}`}>
                  {testPush.data.sent
                    ? 'Accepted by ntfy -- delivered only to subscribed devices'
                    : 'Failed -- is the ntfy container running?'}
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-caption text-content-tertiary">Loading push configuration...</p>
        )}

        {/* ── Recent deliveries (receipts) ─────────────────────────────── */}
        {receipts && receipts.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <p className="text-caption font-medium text-content-secondary">Recent deliveries</p>
            <div className="divide-y divide-border-subtle rounded-md border border-border-subtle">
              {receipts.map((r, i) => (
                <div key={i} className="flex items-center gap-2.5 px-3 py-1.5">
                  {r.ok
                    ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    : <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />}
                  <span className="min-w-0 flex-1 truncate text-caption text-content-primary">{r.title}</span>
                  <span className="shrink-0 rounded bg-surface-secondary px-1.5 py-0.5 font-mono text-[10px] text-content-tertiary">{r.event}</span>
                  {!r.ok && <span className="max-w-[30%] truncate text-caption text-red-400">{r.detail}</span>}
                  <span className="shrink-0 text-caption tabular-nums text-content-tertiary">
                    {new Date(r.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-caption text-content-tertiary">
              A green check means the ntfy server accepted the publish; delivery to a device
              still requires an active subscription to the topic.
            </p>
          </div>
        )}
      </div>

      {/* ── Lockscreen actions ────────────────────────────────────────── */}
      <div className="mt-5 space-y-2 border-t border-border-subtle pt-4">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-content-tertiary" />
          <p className="text-compact font-medium text-content-primary">Lockscreen actions</p>
        </div>
        <p className="text-caption text-content-tertiary">
          Add Approve/Deny buttons to approval and checkpoint pushes. Set the dashboard URL
          your phone can reach (e.g. <span className="font-mono">http://192.168.1.20:3000</span> or
          a tailnet name). Each button carries a signed one-shot link scoped to that single
          decision. Leave empty to disable.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={actionUrl}
            onChange={e => setActionUrlEdit(e.target.value)}
            placeholder="http://<reachable-host>:3000"
            className="flex-1 rounded-md border border-border-subtle bg-surface-input px-3 py-2 font-mono text-compact text-content-primary"
          />
          <Button
            size="sm"
            onClick={() => saveActionUrl.mutate()}
            disabled={saveActionUrl.isPending || actionUrlEdit === null}
          >
            {saveActionUrl.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </Button>
        </div>
        {saveActionUrl.isError && (
          <p className="text-caption text-red-500">{(saveActionUrl.error as Error).message}</p>
        )}
      </div>

      {/* ── Browser notifications ─────────────────────────────────────── */}
      <div className="mt-5 flex items-center justify-between border-t border-border-subtle pt-4">
        <div>
          <p className="text-compact font-medium text-content-primary">Browser notifications</p>
          <p className="text-caption text-content-tertiary">
            {permission === 'unsupported' ? 'Not supported in this browser' :
             permission === 'denied' ? 'Blocked by browser -- check site permissions' :
             'Desktop notifications from this dashboard tab'}
          </p>
        </div>
        <Toggle
          checked={enabled}
          onChange={toggle}
          disabled={permission === 'unsupported' || permission === 'denied'}
        />
      </div>
    </Section>
  )
}
