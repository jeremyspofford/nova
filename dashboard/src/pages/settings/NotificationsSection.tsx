import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Loader2, Radio, Send, Smartphone, Zap } from 'lucide-react'
import { apiFetch, updatePlatformConfig } from '../../api'
import { Button, Section, Toggle } from '../../components/ui'

interface NotifyConfig {
  enabled: boolean
  server_url: string
  topic: string
  subscribe_hint: string
  action_base_url: string
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

  const testPush = useMutation({
    mutationFn: () => apiFetch<{ sent: boolean }>('/api/v1/notify/test', { method: 'POST' }),
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
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => testPush.mutate()} disabled={testPush.isPending}>
                {testPush.isPending
                  ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  : <Send className="mr-1.5 h-4 w-4" />}
                Send test notification
              </Button>
              {testPush.data && (
                <span className={`text-caption ${testPush.data.sent ? 'text-emerald-500' : 'text-red-500'}`}>
                  {testPush.data.sent ? 'Sent -- check your subscribed devices' : 'Failed -- is the ntfy container running?'}
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-caption text-content-tertiary">Loading push configuration...</p>
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
