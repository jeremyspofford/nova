import { useCallback, useEffect, useState } from 'react'
import { Download, ExternalLink, Laptop, MonitorSmartphone, RefreshCw, Server, Smartphone } from 'lucide-react'
import clsx from 'clsx'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, Card, StatusDot } from '../../components/ui'
import {
  getAbout as apiGetAbout,
  reasonOf,
  startUpdate as apiStartUpdate,
  type About,
  type AboutAgent,
  type AboutClient,
  type AboutRemoteModelMachine,
} from '../../lib/api'
import { formatRelativeTime } from '../activity/activityFormat'
import { agentState, attemptState, buildLabel, canStartUpdate, machineState, plural, remoteState, serviceColor, updateHeadline } from './aboutFormat'

/**
 * What this instance of Nova is, read live from core (app/about.py): the
 * build it runs, whether GitHub has anything newer, and what it is made of —
 * the hub, the other machines running her agent, the machines that run
 * models, and the apps and browsers people use her from.
 *
 * Nothing here is written down: every row is a reading, and a reading that
 * could not be taken says why instead of showing an empty list. `nova_about`
 * is the same read in her words, so the page and she cannot disagree.
 */
/** How often the page re-reads while an update is in flight. */
export const UPDATE_POLL_MS = 10_000

export function AboutPage({
  getAbout = apiGetAbout,
  startUpdate = apiStartUpdate,
}: { getAbout?: typeof apiGetAbout; startUpdate?: typeof apiStartUpdate } = {}) {
  const [about, setAbout] = useState<About | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  // Why an update did not start is said in the Updates card, next to the
  // button that was pressed — not at the top of the page, out of sight.
  const [startError, setStartError] = useState<string | null>(null)
  // While an update runs, core restarts under the page: a read that fails
  // then is the restart, said as such, not an error to alarm anyone with.
  const [restarting, setRestarting] = useState(false)

  const load = useCallback(
    async (refresh: boolean) => {
      setError(null)
      setChecking(refresh)
      try {
        setAbout(await getAbout({ refresh }))
      } catch (err) {
        setError(reasonOf(err))
      } finally {
        setChecking(false)
      }
    },
    [getAbout],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  const inFlight = about?.last_update?.outcome === 'sent'
  useEffect(() => {
    if (!inFlight) return
    const id = setInterval(() => {
      getAbout({ refresh: false })
        .then(a => {
          setRestarting(false)
          setAbout(a)
        })
        .catch(() => setRestarting(true))
    }, UPDATE_POLL_MS)
    return () => clearInterval(id)
  }, [inFlight, getAbout])

  const update = useCallback(async () => {
    setStartError(null)
    setStarting(true)
    try {
      const { update: attempt } = await startUpdate()
      setAbout(a => (a ? { ...a, last_update: attempt } : a))
    } catch (err) {
      setStartError(reasonOf(err))
    } finally {
      setStarting(false)
    }
  }, [startUpdate])

  return (
    <div className="space-y-6" data-testid="about-page">
      <PageHeader
        title="About Nova"
        description="What this instance is, read live: the build it runs, whether there is anything newer, and the machines and apps it is made of."
      />

      {error && (
        <div role="alert" className="rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger">
          {error}
        </div>
      )}

      {about && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <UpdatesCard
              about={about}
              onUpdate={update}
              onCheck={() => void load(true)}
              checking={checking}
              starting={starting}
              startError={startError}
              restarting={restarting}
            />
            <BuildCard about={about} />
          </div>
          <Architecture about={about} />
        </>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="w-32 shrink-0 text-caption text-content-tertiary">{label}</dt>
      <dd className="min-w-0 break-words text-compact text-content-primary">{children}</dd>
    </div>
  )
}

function When({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-content-tertiary">not recorded</span>
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{formatRelativeTime(iso)}</time>
}

function BuildCard({ about }: { about: About }) {
  const b = about.build
  return (
    <Card header={{ title: 'This build' }} data-testid="about-build">
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-h2 text-content-primary" data-testid="about-version">
            {buildLabel(b)}
          </span>
          {b.dirty && <Badge color="warning">plus uncommitted changes</Badge>}
        </div>
        {b.commit ? (
          <dl className="space-y-2">
            <Row label="Commit">
              {b.commit_url ? (
                <a className="font-mono text-accent hover:underline" href={b.commit_url} target="_blank" rel="noreferrer">
                  {b.short}
                </a>
              ) : (
                <span className="font-mono">{b.short}</span>
              )}
            </Row>
            <Row label="Committed"><When iso={b.committed_at} /></Row>
            <Row label="Brought up"><When iso={b.installed_at} /></Row>
            <Row label="Source">
              {b.repo ? `${b.repo}${b.branch ? ` · ${b.branch}` : ''}` : <span className="text-content-tertiary">not a GitHub checkout</span>}
            </Row>
          </dl>
        ) : (
          <p className="text-compact text-content-secondary">{b.reason}</p>
        )}
      </div>
    </Card>
  )
}

/** The newest few; the rest are a count and a link to GitHub's own list. */
const SHOWN_COMMITS = 8

function UpdatesCard({ about, onUpdate, onCheck, checking, starting, startError, restarting }: {
  about: About
  onUpdate: () => void
  onCheck: () => void
  checking: boolean
  starting: boolean
  startError: string | null
  restarting: boolean
}) {
  const u = about.updates
  const headline = updateHeadline(u, about.build.branch)
  const last = about.last_update
  const [confirming, setConfirming] = useState(false)
  const canStart = canStartUpdate(u, last)
  // The card's own header carries both actions: checking and updating are
  // the two things this card is for, so they sit where the eye lands first.
  const actions = (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="ghost"
        icon={<RefreshCw size={12} className={clsx(checking && 'animate-spin')} />}
        onClick={onCheck}
        disabled={checking}
        className="whitespace-nowrap"
        aria-label="Check for updates"
      >
        Check<span className="hidden sm:inline">&nbsp;for updates</span>
      </Button>
      {canStart && !confirming && (
        <Button
          size="sm"
          icon={<Download size={12} />}
          onClick={() => setConfirming(true)}
          disabled={starting}
          className="whitespace-nowrap"
        >
          {starting ? 'Starting…' : 'Update now'}
        </Button>
      )}
    </div>
  )
  return (
    <Card header={{ title: 'Updates', action: actions }} data-testid="about-updates">
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color={headline.color} dot>
            {headline.text}
          </Badge>
          <span className="text-caption text-content-tertiary">
            checked <When iso={u.checked_at} />
          </span>
        </div>
        {canStart && confirming && (
          <div className="space-y-2 rounded-md border border-border-subtle p-3" data-testid="about-update-confirm">
            <p className="text-compact text-content-secondary">
              The hub backs up, pulls {u.behind_by} {plural(u.behind_by ?? 0, 'commit')}, rebuilds and restarts
              Nova. It takes a few minutes and Nova is unreachable while it restarts; a failed rebuild is rolled back.
            </p>
            <div className="flex gap-2">
              <Button size="sm" icon={<Download size={12} />} onClick={() => { setConfirming(false); onUpdate() }}>
                Start the update
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {startError && (
          <div role="alert" className="rounded-sm border border-danger/30 bg-danger-dim px-3 py-2 text-compact text-danger">
            The update did not start: {startError}
          </div>
        )}
        {last && <LastUpdate about={about} restarting={restarting} />}
        {u.reason && <p className="text-compact text-content-secondary">{u.reason}</p>}
        {u.commits.length > 0 && (
          <ul className="space-y-1.5" data-testid="about-new-commits">
            {u.commits.slice(0, SHOWN_COMMITS).map(c => (
              <li key={c.sha} className="flex gap-3 text-compact">
                <span className="shrink-0 font-mono text-content-tertiary">{c.short}</span>
                <span className="min-w-0 truncate text-content-primary" title={c.message}>
                  {c.message}
                </span>
              </li>
            ))}
            {(u.behind_by ?? 0) > Math.min(u.commits.length, SHOWN_COMMITS) && (
              <li className="text-caption text-content-tertiary">
                … and {(u.behind_by ?? 0) - Math.min(u.commits.length, SHOWN_COMMITS)} more
              </li>
            )}
          </ul>
        )}
        {u.compare_url && u.state !== 'up_to_date' && (
          <a className="inline-flex items-center gap-1 text-caption text-accent hover:underline" href={u.compare_url} target="_blank" rel="noreferrer">
            See the changes on GitHub <ExternalLink size={11} />
          </a>
        )}
        {u.state === 'diverged' && (
          <p className="text-caption text-content-tertiary">
            An update only fast-forwards; a diverged checkout is merged by hand on the hub.
          </p>
        )}
      </div>
    </Card>
  )
}

function LastUpdate({ about, restarting }: { about: About; restarting: boolean }) {
  const last = about.last_update!
  const state = attemptState(last)
  return (
    <div className="space-y-1 rounded-md bg-surface-elevated/40 px-3 py-2" data-testid="about-last-update">
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="sm" color={state.color} dot>{state.text}</Badge>
        <span className="text-caption text-content-tertiary">
          asked by {last.requested_by}, <When iso={last.started_at} />
        </span>
      </div>
      {last.outcome === 'sent' && (
        <p className="text-caption text-content-tertiary">
          {restarting
            ? 'Nova is restarting — this page reads again every few seconds.'
            : 'Backing up, pulling and rebuilding on the hub. It is confirmed only when the installer reports to the new Nova and that Nova runs the new commit.'}
        </p>
      )}
      {last.reason && last.outcome !== 'sent' && last.outcome !== 'confirmed' && (
        <p className="text-caption text-content-secondary">{last.reason}</p>
      )}
      {last.log_path && (last.outcome === 'failed' || last.outcome === 'not_confirmed') && (
        <p className="text-caption text-content-tertiary">
          Log on {last.device}: <code className="font-mono">{last.log_path}</code>
        </p>
      )}
    </div>
  )
}

function Tier({ title, hint, children, testid }: { title: string; hint?: string; children: React.ReactNode; testid: string }) {
  return (
    <section className="space-y-2" data-testid={testid}>
      <div className="flex items-baseline gap-2">
        <h3 className="text-caption font-medium uppercase tracking-wider text-content-tertiary">{title}</h3>
        {hint && <span className="text-caption text-content-tertiary">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

/** A short vertical line between tiers: the picture is clients → hub →
 *  machines, which is also how a request travels. */
function Connector() {
  return <div aria-hidden className="mx-auto h-5 w-px bg-border" />
}

function Node({ icon, title, subtitle, badge, children }: {
  icon: React.ReactNode
  title: string
  subtitle?: string | null
  badge?: { text: string; color: Parameters<typeof Badge>[0]['color'] }
  children?: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-border-subtle bg-surface-card px-4 py-3 dark:border-white/[0.08]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-content-tertiary">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-compact font-semibold text-content-primary">{title}</span>
            {badge && (
              <Badge size="sm" color={badge.color} dot>
                {badge.text}
              </Badge>
            )}
          </div>
          {subtitle && <div className="truncate text-caption text-content-tertiary">{subtitle}</div>}
          {children}
        </div>
      </div>
    </div>
  )
}

function AgentNode({ agent }: { agent: AboutAgent }) {
  const state = agentState(agent)
  return (
    <Node
      icon={<Laptop size={16} />}
      title={agent.name}
      subtitle={[agent.os ?? agent.platform, agent.hostname].filter(Boolean).join(' · ')}
      badge={state}
    >
      <div className="mt-1 text-caption text-content-tertiary">
        {agent.connected ? 'agent connected' : <>last seen <When iso={agent.last_seen} /></>}
        {agent.build_state === 'behind' && ' · agent behind the hub’s build'}
      </div>
    </Node>
  )
}

/** A model server on another machine (a gateway provider, not one of the
 *  hub's engines), told apart by the device it runs on. */
function RemoteNode({ remote }: { remote: AboutRemoteModelMachine }) {
  // An answering machine's reason is the gateway's "N models listed" note:
  // the subtitle already carries the count, so it is not said twice.
  const reason = remote.state === 'answering' && remote.models !== null ? null : remote.reason
  return (
    <Node
      icon={<Server size={16} />}
      title={remote.name}
      subtitle={[
        remote.device ? `on ${remote.device}` : remote.device_said,
        remote.host,
        remote.models !== null ? `${remote.models} ${plural(remote.models, 'model')}` : null,
      ].filter(Boolean).join(' · ')}
      badge={remoteState(remote)}
    >
      {reason && <div className="mt-1 text-caption text-content-tertiary">{reason}</div>}
    </Node>
  )
}

function ClientNode({ client }: { client: AboutClient }) {
  const Icon = client.kind === 'installed app' || client.device === 'iPhone' || client.device === 'Android'
    ? Smartphone
    : MonitorSmartphone
  return (
    <Node icon={<Icon size={16} />} title={client.label} subtitle={client.person}>
      <div className="mt-1 text-caption text-content-tertiary">
        last used <When iso={client.last_seen} />
      </div>
    </Node>
  )
}

function Architecture({ about }: { about: About }) {
  const { hub, satellites, model_machines: models, services, clients } = about
  return (
    <Card header={{ title: 'Architecture' }} data-testid="about-architecture">
      <div className="space-y-1 p-5">
        <Tier
          title="Where she is used from"
          hint={`signed-in apps and browsers, last ${clients.window_days} days`}
          testid="about-clients"
        >
          {clients.clients.length === 0 ? (
            <p className="text-compact text-content-tertiary">None recorded yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {clients.clients.map((c, i) => <ClientNode key={i} client={c} />)}
            </div>
          )}
          {clients.unseen > 0 && (
            <p className="text-caption text-content-tertiary">
              Plus {clients.unseen} signed-in {plural(clients.unseen, 'session')} not used since clients started being recorded.
            </p>
          )}
        </Tier>

        <Connector />

        <Tier title="The hub" hint="this host" testid="about-hub">
          <Node icon={<Server size={16} />} title={hub.agent?.name ?? 'Hub'} subtitle={hub.address ?? `no tailnet address — ${hub.address_reason ?? 'unknown'}`}>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {services.map(s => (
                <span key={s.name} className="inline-flex items-center gap-1.5 text-caption text-content-secondary" title={s.reason ?? undefined}>
                  <StatusDot size="sm" status={serviceColor(s) === 'success' ? 'success' : 'danger'} />
                  {s.name}
                  {s.state !== 'up' && <span className="text-danger">{s.state}</span>}
                </span>
              ))}
            </div>
            <div className="mt-1 text-caption text-content-tertiary">
              {hub.agent
                ? <>its own agent: {hub.agent.connected ? 'connected' : <>not connected, last seen <When iso={hub.agent.last_seen} /></>}</>
                : 'no agent paired on the hub itself'}
            </div>
          </Node>
        </Tier>

        <Connector />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Tier title="Machines running her agent" testid="about-satellites">
            {satellites.length === 0 ? (
              <p className="text-compact text-content-tertiary">None besides the hub.</p>
            ) : (
              <div className="space-y-2">{satellites.map(a => <AgentNode key={a.name} agent={a} />)}</div>
            )}
          </Tier>
          <Tier title="Machines running models" hint="the gateway’s last reading" testid="about-models">
            {/* The engines and the remote machines are two readings: each
                says its own reason, and one unread never hides the other. */}
            {models.machines === null && <p className="text-compact text-danger">Could not be read: {models.reason}</p>}
            {models.remotes === null && (
              <p className="text-compact text-danger">Remote model machines could not be read: {models.remotes_reason}</p>
            )}
            {models.machines?.length === 0 && models.remotes?.length === 0 ? (
              <p className="text-compact text-content-tertiary">None.</p>
            ) : (
              <div className="space-y-2">
                {(models.machines ?? []).map(m => (
                  <Node
                    key={m.name}
                    icon={<Server size={16} />}
                    title={m.name}
                    subtitle={[m.runtime, m.compute, m.models !== null ? `${m.models} ${plural(m.models, 'model')}` : null].filter(Boolean).join(' · ')}
                    badge={machineState(m)}
                  >
                    {m.reason && <div className="mt-1 text-caption text-content-tertiary">{m.reason}</div>}
                  </Node>
                ))}
                {(models.remotes ?? []).map(r => (
                  <RemoteNode key={`remote:${r.name}`} remote={r} />
                ))}
              </div>
            )}
          </Tier>
        </div>
      </div>
    </Card>
  )
}
