import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Github, Link2, Plus, Trash2, RefreshCw, Loader2, Pencil, Webhook,
  Eye, EyeOff, AlertCircle, XCircle, CheckCircle2,
} from 'lucide-react'
import {
  listCredentials, createCredential, deleteCredential, testCredential,
  listWatchedRepos, createWatchedRepo, updateWatchedRepo, deleteWatchedRepo,
  registerGithubWebhook,
  type Credential, type CredentialHealth,
  type WatchedRepo, type WatchedRepoUpdatePayload,
} from '../../api'
import {
  Section, Button, Input, Modal, EmptyState, ConfirmDialog,
  Toast, Skeleton, StatusDot, Toggle, Select,
} from '../../components/ui'

// ── Health rendering ─────────────────────────────────────────────────────────

const HEALTH_LABEL: Record<CredentialHealth, string> = {
  healthy: 'Healthy',
  expired: 'Expired',
  revoked: 'Revoked',
  invalid: 'Invalid',
  unknown: 'Not validated',
}

function HealthBadge({ health }: { health: CredentialHealth }) {
  const status = health === 'healthy'
    ? 'success'
    : health === 'unknown'
      ? 'neutral'
      : 'danger'
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-content-secondary">
      <StatusDot status={status} size="sm" />
      {HEALTH_LABEL[health]}
    </span>
  )
}

// ── Add Credential Modal ─────────────────────────────────────────────────────

interface NewCredentialDraft {
  label: string
  secret: string
}

function AddCredentialModal({
  open, onClose, onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (cred: Credential) => void
}) {
  const [draft, setDraft] = useState<NewCredentialDraft>({ label: '', secret: '' })
  const [showSecret, setShowSecret] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => createCredential({
      provider_kind: 'github',
      auth_method: 'pat',
      label: draft.label.trim(),
      secret: draft.secret,
    }),
    onSuccess: (cred) => {
      onCreated(cred)
      setDraft({ label: '', secret: '' })
      setShowSecret(false)
      setError(null)
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  const canSubmit = draft.label.trim().length > 0 && draft.secret.length > 0 && !create.isPending

  return (
    <Modal
      open={open}
      onClose={() => { if (!create.isPending) { setError(null); onClose() } }}
      title="Add GitHub Credential"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!canSubmit}
            loading={create.isPending}
            icon={<Plus size={14} />}
          >
            Add &amp; Test
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-compact text-content-secondary">
          Paste a GitHub Personal Access Token. Nova will encrypt it locally and validate it against the GitHub API. Required scopes for CI triage:{' '}
          <code className="text-micro bg-surface-elevated px-1 py-0.5 rounded">repo</code>,{' '}
          <code className="text-micro bg-surface-elevated px-1 py-0.5 rounded">workflow</code>,{' '}
          <code className="text-micro bg-surface-elevated px-1 py-0.5 rounded">admin:repo_hook</code>.
        </p>

        <div>
          <label className="block text-caption font-medium text-content-secondary mb-1.5">
            Label
          </label>
          <Input
            value={draft.label}
            onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
            placeholder="e.g. nova-bot-pat"
            description="A name to recognize this credential later. Not sent to GitHub."
          />
        </div>

        <div>
          <label className="block text-caption font-medium text-content-secondary mb-1.5">
            Personal Access Token
          </label>
          <div className="relative">
            <Input
              type={showSecret ? 'text' : 'password'}
              value={draft.secret}
              onChange={e => setDraft(d => ({ ...d, secret: e.target.value }))}
              placeholder="ghp_..."
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowSecret(s => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-content-tertiary hover:text-content-primary p-1"
              aria-label={showSecret ? 'Hide token' : 'Show token'}
            >
              {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <p className="text-micro text-content-tertiary mt-1.5">
            Stored AES-256-GCM encrypted under your CREDENTIAL_MASTER_KEY. Nova never logs the value.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-danger/10 text-danger">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <p className="text-compact">{error}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Edit Watched Repo Modal ──────────────────────────────────────────────────

function EditWatchedRepoModal({
  repo, open, onClose,
}: {
  repo: WatchedRepo
  open: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<WatchedRepoUpdatePayload>({
    trigger_mode: repo.trigger_mode,
    polling_interval_min: repo.polling_interval_min,
    workflow_pattern: repo.workflow_pattern,
    active_hours_start: repo.active_hours_start,
    active_hours_end: repo.active_hours_end,
    daily_budget: repo.daily_budget,
  })
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => updateWatchedRepo(repo.id, draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['watched-repos', repo.credential_id] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  // active_hours columns return as "HH:MM:SS"; the time input wants "HH:MM"
  const trimSeconds = (v: string | null | undefined) => v ? v.slice(0, 5) : ''

  return (
    <Modal
      open={open}
      onClose={() => { if (!save.isPending) { setError(null); onClose() } }}
      title={`Edit ${repo.repo}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="text-caption text-content-secondary block mb-1.5">Trigger mode</label>
          <Select
            value={draft.trigger_mode ?? repo.trigger_mode}
            onChange={e => setDraft(d => ({ ...d, trigger_mode: e.target.value as WatchedRepo['trigger_mode'] }))}
          >
            <option value="webhook_with_polling_fallback">Webhook + polling fallback</option>
            <option value="webhook_only">Webhook only</option>
            <option value="polling_only">Polling only</option>
          </Select>
          <p className="text-micro text-content-tertiary mt-1">
            How Nova learns of failed CI runs. Webhook is realtime; polling is periodic.
          </p>
        </div>

        {(draft.trigger_mode ?? repo.trigger_mode) !== 'webhook_only' && (
          <div>
            <label className="text-caption text-content-secondary block mb-1.5">Polling interval (minutes)</label>
            <Input
              type="number"
              value={String(draft.polling_interval_min ?? repo.polling_interval_min)}
              onChange={e => setDraft(d => ({ ...d, polling_interval_min: Number(e.target.value) }))}
              min={1}
              max={1440}
            />
          </div>
        )}

        <div>
          <label className="text-caption text-content-secondary block mb-1.5">Workflow pattern (glob)</label>
          <Input
            value={draft.workflow_pattern ?? ''}
            onChange={e => setDraft(d => ({ ...d, workflow_pattern: e.target.value || null }))}
            placeholder="e.g. ci-*.yml — leave blank for any workflow"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-caption text-content-secondary block mb-1.5">Active hours start</label>
            <Input
              type="time"
              value={trimSeconds(draft.active_hours_start)}
              onChange={e => setDraft(d => ({ ...d, active_hours_start: e.target.value || null }))}
            />
          </div>
          <div>
            <label className="text-caption text-content-secondary block mb-1.5">Active hours end</label>
            <Input
              type="time"
              value={trimSeconds(draft.active_hours_end)}
              onChange={e => setDraft(d => ({ ...d, active_hours_end: e.target.value || null }))}
            />
          </div>
        </div>
        <p className="text-micro text-content-tertiary -mt-2">
          When set, Nova only triages within this window. Local server time. Leave both blank for 24/7.
        </p>

        <div>
          <label className="text-caption text-content-secondary block mb-1.5">Daily budget (max triage runs / 24h)</label>
          <Input
            type="number"
            value={String(draft.daily_budget ?? repo.daily_budget)}
            onChange={e => setDraft(d => ({ ...d, daily_budget: Number(e.target.value) }))}
            min={1}
            max={1000}
          />
          <p className="text-micro text-content-tertiary mt-1">
            Hard cap. Beyond this, Nova logs a budget_exceeded audit row and skips the failure.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-danger/10 text-danger">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <p className="text-compact">{error}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Register Webhook Modal ───────────────────────────────────────────────────

function RegisterWebhookModal({
  repo, open, onClose,
}: {
  repo: WatchedRepo
  open: boolean
  onClose: () => void
}) {
  const PERSIST_KEY = 'nova_webhook_public_base'
  const stored = (typeof window !== 'undefined' && localStorage.getItem(PERSIST_KEY)) || ''
  const [targetBase, setTargetBase] = useState(stored)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<
    | { kind: 'created'; hook_id: number; status: string }
    | { kind: 'pending'; approval_id: string }
    | null
  >(null)

  const trimmed = targetBase.trim().replace(/\/$/, '')
  const fullUrl = trimmed ? `${trimmed}/api/v1/webhooks/github` : ''

  // Reject obvious mistakes: the GitHub repo URL itself, or *.github.com,
  // or anything that already ends in /api/v1/webhooks/github (double-append).
  const validationError = ((): string | null => {
    if (!trimmed) return null
    if (!/^https?:\/\//.test(trimmed)) return 'Must start with http:// or https://'
    try {
      const u = new URL(trimmed)
      if (u.hostname === 'github.com' || u.hostname.endsWith('.github.com')) {
        return "That's the GitHub repo URL. Enter your Nova orchestrator's public URL instead — the host GitHub will POST events to."
      }
      if (u.pathname.includes('/api/v1/webhooks/github')) {
        return 'Enter the base URL only — Nova appends /api/v1/webhooks/github automatically.'
      }
      if (u.hostname === 'localhost' || u.hostname.startsWith('127.') || u.hostname.startsWith('192.168.') || u.hostname.startsWith('10.')) {
        return "GitHub can't reach private addresses. You need a public URL via Cloudflare Tunnel, Tailscale Funnel, or ngrok."
      }
      return null
    } catch {
      return 'Not a valid URL'
    }
  })()

  const register = useMutation({
    mutationFn: () => registerGithubWebhook({
      credential_id: repo.credential_id,
      repo: repo.repo,
      target_url: fullUrl,
    }),
    onSuccess: (res) => {
      localStorage.setItem(PERSIST_KEY, trimmed)
      if (res.status === 'consent_pending' && 'approval_id' in res) {
        setSuccess({ kind: 'pending', approval_id: res.approval_id })
      } else if ('hook_id' in res) {
        setSuccess({ kind: 'created', hook_id: res.hook_id, status: res.status })
      }
      setError(null)
    },
    onError: (e: Error) => setError(e.message),
  })

  const canSubmit = trimmed.length > 0 && !validationError && !register.isPending

  return (
    <Modal
      open={open}
      onClose={() => { if (!register.isPending) { setError(null); setSuccess(null); onClose() } }}
      title={`Register webhook for ${repo.repo}`}
      size="md"
      footer={
        success ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={register.isPending}>Cancel</Button>
            <Button
              onClick={() => register.mutate()}
              disabled={!canSubmit}
              loading={register.isPending}
              icon={<Webhook size={14} />}
            >
              Register
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {success ? (
          success.kind === 'created' ? (
            <div className="flex items-start gap-2 p-3 rounded-md bg-success/10 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="text-compact font-medium">Webhook registered</p>
                <p className="text-caption mt-1">
                  Hook #{success.hook_id} is <span className="font-mono">{success.status}</span> on
                  {' '}<span className="font-mono">{repo.repo}</span>. GitHub will start delivering
                  {' '}workflow_run events to your orchestrator. The next failed run will create
                  {' '}an approval card on the Approvals page.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 p-3 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="text-compact font-medium">Approval pending</p>
                <p className="text-caption mt-1">
                  Webhook creation for <span className="font-mono">{repo.repo}</span> is
                  {' '}awaiting your approval. Visit{' '}
                  <a href="/approvals" className="underline font-medium">Pending Approvals</a>
                  {' '}to approve and (optionally) remember the choice for this repo.
                </p>
              </div>
            </div>
          )
        ) : (
          <>
            <p className="text-compact text-content-secondary">
              GitHub will POST workflow events to <em>your Nova orchestrator</em>,
              {' '}so it needs a publicly-reachable URL pointing at this Nova
              {' '}instance — not the GitHub repo URL. Tailnet-only addresses
              {' '}don't work; you need a tunnel (Cloudflare Tunnel, Tailscale
              {' '}Funnel, ngrok) that exposes localhost:8000 publicly.
            </p>

            <div>
              <label className="text-caption text-content-secondary block mb-1.5">
                Nova orchestrator public base URL
              </label>
              <Input
                value={targetBase}
                onChange={e => setTargetBase(e.target.value)}
                placeholder="https://abc-def-ghi.trycloudflare.com"
                className="font-mono"
                error={validationError ?? undefined}
              />
              {fullUrl && !validationError && (
                <p className="text-micro text-content-tertiary mt-1.5">
                  Webhook target: <span className="font-mono text-content-secondary">{fullUrl}</span>
                </p>
              )}
              <p className="text-micro text-content-tertiary mt-1.5">
                Quick tunnel: <code className="bg-surface-elevated px-1 py-0.5 rounded">cloudflared tunnel --url http://localhost:8000</code>
                {' '}prints a fresh <code>*.trycloudflare.com</code> URL. Saved to this browser on success.
              </p>
            </div>

            <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <p className="text-caption">
                Webhook creation routes through the consent gate (MUTATE). On
                {' '}first registration for a repo without a saved rule, you'll
                {' '}see a pending approval card — approve and "remember" to
                {' '}skip the prompt for future re-registrations of this repo.
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-danger/10 text-danger">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <p className="text-compact">{error}</p>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

// ── Watched Repo row ─────────────────────────────────────────────────────────

function WatchedRepoRow({ repo, onChanged }: { repo: WatchedRepo; onChanged: () => void }) {
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [webhookOpen, setWebhookOpen] = useState(false)

  const toggle = useMutation({
    mutationFn: () => updateWatchedRepo(repo.id, { enabled: !repo.enabled }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['watched-repos', repo.credential_id] }); onChanged() },
  })

  const remove = useMutation({
    mutationFn: () => deleteWatchedRepo(repo.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['watched-repos', repo.credential_id] }); onChanged() },
  })

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-border-subtle bg-surface-elevated">
      <Github size={14} className="text-content-tertiary shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-compact font-mono text-content-primary truncate">{repo.repo}</div>
        <div className="flex items-center gap-3 text-micro text-content-tertiary mt-0.5 flex-wrap">
          <span>{TRIGGER_LABEL[repo.trigger_mode]}</span>
          <span>·</span>
          <span>{repo.daily_budget}/day</span>
          {repo.trigger_mode !== 'webhook_only' && (
            <>
              <span>·</span>
              <span>poll {repo.polling_interval_min}min</span>
            </>
          )}
          {repo.workflow_pattern && (
            <>
              <span>·</span>
              <span className="font-mono">{repo.workflow_pattern}</span>
            </>
          )}
          {repo.active_hours_start && repo.active_hours_end && (
            <>
              <span>·</span>
              <span>active {repo.active_hours_start.slice(0, 5)}–{repo.active_hours_end.slice(0, 5)}</span>
            </>
          )}
        </div>
      </div>
      <Toggle
        checked={repo.enabled}
        onChange={() => toggle.mutate()}
        disabled={toggle.isPending}
        size="sm"
      />
      {repo.trigger_mode !== 'polling_only' && (
        <button
          onClick={() => setWebhookOpen(true)}
          className="text-content-tertiary hover:text-accent p-1 transition-colors"
          title="Register GitHub webhook"
        >
          <Webhook size={14} />
        </button>
      )}
      <button
        onClick={() => setEditOpen(true)}
        className="text-content-tertiary hover:text-content-primary p-1 transition-colors"
        title="Edit"
      >
        <Pencil size={14} />
      </button>
      <button
        onClick={() => setConfirmDelete(true)}
        className="text-content-tertiary hover:text-danger p-1 transition-colors"
        title="Remove"
      >
        {remove.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
      </button>
      <ConfirmDialog
        open={confirmDelete}
        title={`Stop watching ${repo.repo}?`}
        description="Nova will no longer triage CI failures on this repo. The webhook (if any) is not removed automatically."
        confirmLabel="Stop watching"
        destructive
        onConfirm={() => { remove.mutate(); setConfirmDelete(false) }}
        onClose={() => setConfirmDelete(false)}
      />
      <EditWatchedRepoModal
        repo={repo}
        open={editOpen}
        onClose={() => setEditOpen(false)}
      />
      <RegisterWebhookModal
        repo={repo}
        open={webhookOpen}
        onClose={() => setWebhookOpen(false)}
      />
    </div>
  )
}

const TRIGGER_LABEL: Record<WatchedRepo['trigger_mode'], string> = {
  webhook_with_polling_fallback: 'Webhook + poll',
  webhook_only: 'Webhook only',
  polling_only: 'Polling only',
}

// ── Add Watched Repo inline form ─────────────────────────────────────────────

function AddRepoInline({ credentialId, onAdded }: { credentialId: string; onAdded: () => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [repo, setRepo] = useState('')
  const [triggerMode, setTriggerMode] = useState<WatchedRepo['trigger_mode']>('webhook_with_polling_fallback')
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: () => createWatchedRepo(credentialId, {
      repo: repo.trim(),
      trigger_mode: triggerMode,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['watched-repos', credentialId] })
      setRepo('')
      setOpen(false)
      setError(null)
      onAdded()
    },
    onError: (e: Error) => {
      // 409 from server when repo already watched
      if (e.message.includes('409')) setError(`${repo} is already being watched.`)
      else setError(e.message)
    },
  })

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-caption text-content-secondary hover:text-content-primary transition-colors px-3 py-2"
      >
        <Plus size={12} /> Watch a repo
      </button>
    )
  }

  return (
    <div className="space-y-2 px-3 py-3 rounded-md border border-border-subtle">
      <div className="flex items-center gap-2">
        <Input
          value={repo}
          onChange={e => { setRepo(e.target.value); setError(null) }}
          placeholder="owner/repo"
          className="flex-1 font-mono"
        />
        <Select
          value={triggerMode}
          onChange={e => setTriggerMode(e.target.value as WatchedRepo['trigger_mode'])}
        >
          <option value="webhook_with_polling_fallback">Webhook + poll</option>
          <option value="webhook_only">Webhook only</option>
          <option value="polling_only">Polling only</option>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => add.mutate()}
          disabled={!repo.includes('/') || add.isPending}
          loading={add.isPending}
        >
          Add
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { setOpen(false); setRepo(''); setError(null) }}
          disabled={add.isPending}
        >
          Cancel
        </Button>
        {error && <span className="text-caption text-danger ml-2">{error}</span>}
      </div>
    </div>
  )
}

// ── Watched Repos block (per credential) ─────────────────────────────────────

function WatchedReposBlock({ credentialId }: { credentialId: string }) {
  const { data: repos = [], isLoading } = useQuery({
    queryKey: ['watched-repos', credentialId],
    queryFn: () => listWatchedRepos(credentialId),
    staleTime: 10_000,
  })

  return (
    <div className="space-y-2 mt-4 pt-4 border-t border-border-subtle">
      <div className="flex items-center justify-between">
        <p className="text-caption font-semibold uppercase tracking-wider text-content-tertiary">
          Watched repos · {repos.length}
        </p>
      </div>

      {isLoading ? (
        <Skeleton lines={2} />
      ) : repos.length === 0 ? (
        <div className="px-3 py-3 rounded-md bg-surface-elevated text-caption text-content-tertiary">
          No repos watched yet. Nova won't triage CI failures until you add one.
        </div>
      ) : (
        <div className="space-y-1.5">
          {repos.map(r => (
            <WatchedRepoRow key={r.id} repo={r} onChanged={() => { /* invalidation handled in row */ }} />
          ))}
        </div>
      )}

      <AddRepoInline credentialId={credentialId} onAdded={() => { /* invalidation handled in form */ }} />
    </div>
  )
}

// ── Credential Card ──────────────────────────────────────────────────────────

function CredentialCard({ cred, onChanged }: { cred: Credential; onChanged: () => void }) {
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [toast, setToast] = useState<{ variant: 'success' | 'error'; message: string } | null>(null)

  const test = useMutation({
    mutationFn: () => testCredential(cred.id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['credentials'] })
      setToast({
        variant: res.health === 'healthy' ? 'success' : 'error',
        message: `Validation: ${HEALTH_LABEL[res.health]}`,
      })
    },
    onError: (e: Error) => setToast({ variant: 'error', message: e.message }),
  })

  const remove = useMutation({
    mutationFn: () => deleteCredential(cred.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['credentials'] }); onChanged() },
    onError: (e: Error) => setToast({ variant: 'error', message: e.message }),
  })

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card p-4">
      <div className="flex items-start gap-3">
        <Github size={20} className="text-content-secondary mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-compact font-semibold text-content-primary">{cred.label}</p>
            <span className="text-micro text-content-tertiary uppercase tracking-wider">
              {cred.provider_kind} · {cred.auth_method.replace('_', ' ')}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <HealthBadge health={cred.health} />
            <span className="text-micro text-content-tertiary">
              Created {new Date(cred.created_at).toLocaleDateString()}
            </span>
            {cred.last_validated_at && (
              <span className="text-micro text-content-tertiary">
                Last validated {new Date(cred.last_validated_at).toLocaleString()}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => test.mutate()}
            loading={test.isPending}
            icon={<RefreshCw size={12} />}
          >
            Test
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            icon={<Trash2 size={12} />}
          >
            Remove
          </Button>
        </div>
      </div>

      <WatchedReposBlock credentialId={cred.id} />

      <ConfirmDialog
        open={confirmDelete}
        title={`Remove credential "${cred.label}"?`}
        description="The encrypted token will be deleted. Any watched repos under this credential will become orphaned and Nova will stop triaging them."
        confirmLabel="Remove credential"
        destructive
        onConfirm={() => { remove.mutate(); setConfirmDelete(false) }}
        onClose={() => setConfirmDelete(false)}
      />

      {toast && (
        <Toast variant={toast.variant} message={toast.message} onDismiss={() => setToast(null)} />
      )}
    </div>
  )
}

// ── Section ──────────────────────────────────────────────────────────────────

export function ConnectedServicesSection() {
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [toast, setToast] = useState<{ variant: 'success' | 'error'; message: string } | null>(null)

  const { data: credentials = [], isLoading, error } = useQuery({
    queryKey: ['credentials'],
    queryFn: () => listCredentials(),
    staleTime: 30_000,
  })

  const handleCreated = async (cred: Credential) => {
    setToast({ variant: 'success', message: `Added ${cred.label}. Validating…` })
    qc.invalidateQueries({ queryKey: ['credentials'] })
    // Validate in the background — surface the result via toast
    try {
      const res = await testCredential(cred.id)
      qc.invalidateQueries({ queryKey: ['credentials'] })
      setToast({
        variant: res.health === 'healthy' ? 'success' : 'error',
        message: res.health === 'healthy'
          ? `${cred.label} is healthy.`
          : `${cred.label} validation: ${HEALTH_LABEL[res.health]}`,
      })
    } catch (e) {
      setToast({ variant: 'error', message: `Could not validate ${cred.label}: ${(e as Error).message}` })
    }
  }

  return (
    <Section
      icon={Link2}
      title="Connected Services"
      description="External accounts Nova can act on. Credentials are encrypted at rest. Add a GitHub PAT to enable CI triage and self-modification."
    >
      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-danger/10 text-danger mb-4">
          <XCircle size={14} className="mt-0.5 shrink-0" />
          <p className="text-compact">{(error as Error).message}</p>
        </div>
      )}

      {isLoading ? (
        <Skeleton lines={4} />
      ) : credentials.length === 0 ? (
        <EmptyState
          icon={Github}
          title="No connected services"
          description="Add a GitHub credential to enable CI triage. Nova diagnoses workflow failures and opens fix PRs after one-click approval."
          action={{ label: 'Add GitHub Credential', onClick: () => setAddOpen(true) }}
        />
      ) : (
        <div className="space-y-3">
          {credentials.map(c => (
            <CredentialCard
              key={c.id}
              cred={c}
              onChanged={() => qc.invalidateQueries({ queryKey: ['credentials'] })}
            />
          ))}
          <Button
            variant="outline"
            onClick={() => setAddOpen(true)}
            icon={<Plus size={14} />}
          >
            Add Credential
          </Button>
        </div>
      )}

      <AddCredentialModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={handleCreated}
      />

      {toast && (
        <Toast variant={toast.variant} message={toast.message} onDismiss={() => setToast(null)} />
      )}
    </Section>
  )
}
