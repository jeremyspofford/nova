import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Badge, Button, ConfirmDialog, Input, Section, Select, Skeleton } from '../../components/ui'
import {
  addMcpServer as apiAddMcpServer,
  getMcpPresets as apiGetMcpPresets,
  listMcpServers as apiListMcpServers,
  removeMcpServer as apiRemoveMcpServer,
  testMcpServer as apiTestMcpServer,
  type McpAdded,
  type McpPreset,
  type McpServer,
} from '../../lib/api'
import { addedByLabel, headersFromRows, statusLine, type HeaderRow } from './connectionsFormat'

/**
 * Settings → Connections (S37a): the MCP servers Nova can use.
 *
 * A server is asked what it offers before it is saved (core refuses with the
 * reason, and nothing is saved), a token is written once and never shown
 * again, and nothing here is an approval: she can connect and remove servers
 * herself, and when she replaces or removes one the owner added, his Inbox
 * says so (owner ruling 2026-09-03).
 */

export type ConnectionsApi = {
  listMcpServers: () => Promise<McpServer[]>
  getMcpPresets: () => Promise<McpPreset[]>
  addMcpServer: typeof apiAddMcpServer
  testMcpServer: (name: string) => Promise<McpServer>
  removeMcpServer: (name: string) => Promise<void>
}

const DEFAULT_API: ConnectionsApi = {
  listMcpServers: apiListMcpServers,
  getMcpPresets: apiGetMcpPresets,
  addMcpServer: apiAddMcpServer,
  testMcpServer: apiTestMcpServer,
  removeMcpServer: apiRemoveMcpServer,
}

const bannerClass = 'rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger'

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function ConnectionsSection({ api = DEFAULT_API }: { api?: ConnectionsApi }) {
  const [servers, setServers] = useState<McpServer[] | null>(null)
  const [presets, setPresets] = useState<McpPreset[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<McpServer | null>(null)

  const load = useCallback(async () => {
    try {
      const [list, offered] = await Promise.all([api.listMcpServers(), api.getMcpPresets()])
      setServers(list)
      setPresets(offered)
      setLoadError(null)
    } catch (err) {
      setLoadError(reasonOf(err))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async (server: McpServer) => {
    setPendingRemove(null)
    try {
      await api.removeMcpServer(server.name)
      setActionError(null)
      await load()
    } catch (err) {
      setActionError(reasonOf(err))
    }
  }

  return (
    <Section
      id="connections"
      icon={Plug}
      title="Connections"
      description="Services Nova can use through MCP, like GitHub. A server is asked what it offers before it is saved, and a token is never shown again. Nova can connect servers herself; when she replaces or removes one you added, your Inbox says so."
    >
      {loadError && (
        <div role="alert" className={bannerClass}>
          Could not read the connections: {loadError}
        </div>
      )}
      {actionError && (
        <div role="alert" className={bannerClass}>
          {actionError}
        </div>
      )}
      {servers === null && !loadError ? (
        <Skeleton lines={3} />
      ) : (
        <div className="space-y-3" data-testid="connections-list">
          {servers !== null && servers.length === 0 && (
            <p className="text-caption text-content-tertiary">Nothing is connected yet.</p>
          )}
          {(servers ?? []).map(server => (
            <ServerRow
              key={server.name}
              server={server}
              api={api}
              onChanged={load}
              onError={setActionError}
              onRemove={() => setPendingRemove(server)}
            />
          ))}
        </div>
      )}
      <div className="mt-4">
        {/* Offered only once the first load has settled (ruling F6 — the
            same race PR #89 fixed in ProvidersSection): before load()
            resolves, `servers` is still null and `presets` is still [], so a
            click here would open the form with nothing to prefill from. A
            failed load still offers it, exactly as ProvidersSection does. */}
        {servers === null && !loadError ? null : !adding ? (
          <Button variant="secondary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
            Connect a server
          </Button>
        ) : (
          <AddServerForm
            presets={presets}
            api={api}
            onDone={async () => {
              setAdding(false)
              await load()
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
      <ConfirmDialog
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        title={`Remove ${pendingRemove?.name ?? ''}?`}
        description="Its token is deleted, and Nova can no longer run its tools."
        confirmLabel="Remove"
        destructive
        onConfirm={() => pendingRemove && void remove(pendingRemove)}
      />
    </Section>
  )
}

function ServerRow({
  server,
  api,
  onChanged,
  onError,
  onRemove,
}: {
  server: McpServer
  api: ConnectionsApi
  onChanged: () => Promise<void>
  onError: (reason: string | null) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [testing, setTesting] = useState(false)

  const test = async () => {
    setTesting(true)
    try {
      await api.testMcpServer(server.name)
      onError(null)
    } catch (err) {
      onError(reasonOf(err))
    } finally {
      setTesting(false)
      await onChanged()
    }
  }

  return (
    <div className="rounded-md border border-line p-3" data-testid={`connection-${server.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-content-primary">{server.name}</span>
        {server.title && server.title.toLowerCase() !== server.name && (
          <span className="text-caption text-content-secondary">{server.title}</span>
        )}
        {server.protocol && (
          <Badge size="sm" color="neutral">
            {server.protocol}
          </Badge>
        )}
        <Badge size="sm" color={server.failing ? 'danger' : 'success'}>
          {server.failing ? 'failing' : 'ok'}
        </Badge>
      </div>
      <div className="mt-1 break-all text-caption text-content-tertiary">{server.origin}</div>
      <div className="mt-1 text-caption text-content-secondary">
        {addedByLabel(server)} · {statusLine(server)}
        {server.has_token ? ' · token saved' : ''}
        {server.header_names.length > 0 ? ` · headers: ${server.header_names.join(', ')}` : ''}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon={open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          onClick={() => setOpen(value => !value)}
          aria-expanded={open}
        >
          {server.tool_count} {server.tool_count === 1 ? 'tool' : 'tools'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={12} />}
          loading={testing}
          onClick={() => void test()}
          aria-label={`Test ${server.name}`}
        >
          Test
        </Button>
        <Button variant="ghost" size="sm" icon={<Trash2 size={12} />} onClick={onRemove} aria-label={`Remove ${server.name}`}>
          Remove
        </Button>
      </div>
      {open && (
        <ul className="mt-2 space-y-1" data-testid={`connection-tools-${server.name}`}>
          {server.tools.map(tool => (
            <li key={tool.name} className="text-caption">
              <span className="font-mono text-content-primary">{tool.name}</span>
              {tool.description && <span className="text-content-tertiary"> — {tool.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AddServerForm({
  presets,
  api,
  onDone,
  onCancel,
}: {
  presets: McpPreset[]
  api: ConnectionsApi
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [preset, setPreset] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [headers, setHeaders] = useState<HeaderRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Set only once a save succeeded AND the server left tools out (Task 9
  // carry): what it rejected, and how many more it bounded away, is the
  // one thing the owner cannot see from the row that then appears below —
  // so the form stays up to say it, instead of closing straight to a row
  // that just looks like it worked.
  const [added, setAdded] = useState<McpAdded | null>(null)
  const chosen = presets.find(p => p.id === preset)

  const choose = (id: string) => {
    setPreset(id)
    const found = presets.find(p => p.id === id)
    if (found) {
      setName(found.name)
      setUrl(found.url)
      setHeaders(Object.entries(found.headers).map(([key, value]) => ({ name: key, value })))
    }
  }

  const setHeader = (index: number, patch: Partial<HeaderRow>) =>
    setHeaders(rows => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const created = await api.addMcpServer({
        name: name.trim(),
        url: url.trim(),
        token: token.trim() || undefined,
        headers: headersFromRows(headers),
      })
      setToken('')
      // Fix round 1, M3: a replace is an outcome the owner must see where he
      // acted, even with nothing rejected — so the confirmation view is also
      // what shows it, rather than closing straight back to a row that gives
      // no sign anything but an ordinary add just happened.
      if (created.rejected.length > 0 || created.replaced) {
        setAdded(created)
      } else {
        await onDone()
      }
    } catch (err) {
      setError(reasonOf(err))
    } finally {
      setSaving(false)
    }
  }

  if (added) {
    // Fix round 1, item 1: the true total is the capped list the server
    // bothered to NAME plus however many more it bounded away — never just
    // `added.rejected.length`, which is at most 20 regardless of how many
    // were actually rejected and says so right next to a sentence giving a
    // smaller number than the "and N more" line below it.
    const count = added.rejected.length + (added.rejected_more ?? 0)
    return (
      <div className="space-y-3 rounded-md border border-line p-3" data-testid="connection-form">
        <p className="text-compact text-content-primary">
          Connected {added.server.name}.
          {added.rejected.length > 0 && ` ${count} ${count === 1 ? 'tool' : 'tools'} could not be used:`}
        </p>
        {added.replaced && (
          <p className="text-compact text-content-secondary">
            It replaced the {added.server.name} that{' '}
            {added.replaced.added_by === 'nova' ? 'Nova' : 'you'} had added, at {added.replaced.origin}.
          </p>
        )}
        {added.rejected.length > 0 && (
          <>
            <ul className="space-y-1 text-caption text-content-secondary" data-testid="rejected-tools">
              {added.rejected.map(r => (
                <li key={r.name}>
                  <span className="font-mono text-content-primary">{r.name}</span> — {r.reason}
                </li>
              ))}
            </ul>
            {typeof added.rejected_more === 'number' && added.rejected_more > 0 && (
              <p className="text-caption text-content-tertiary">and {added.rejected_more} more</p>
            )}
            {/* Ruling T10-A: the local state in this form is not where this
                lives — the governance ledger is, so leaving this tab (or
                this never having been read) does not lose it. */}
            <p className="text-caption text-content-tertiary">
              These are also recorded in Governance.
            </p>
          </>
        )}
        <Button type="button" onClick={() => void onDone()}>
          Done
        </Button>
      </div>
    )
  }

  return (
    <form
      onSubmit={event => void submit(event)}
      className="space-y-3 rounded-md border border-line p-3"
      data-testid="connection-form"
    >
      <Select
        label="Start from"
        value={preset}
        onChange={event => choose(event.target.value)}
        items={[{ value: '', label: 'Any MCP server' }, ...presets.map(p => ({ value: p.id, label: p.label }))]}
      />
      {chosen && <p className="text-caption text-content-tertiary">{chosen.token_hint}</p>}
      <Input label="Name" value={name} onChange={event => setName(event.target.value)} placeholder="github" required />
      <Input
        label="MCP endpoint URL"
        value={url}
        onChange={event => setUrl(event.target.value)}
        placeholder="https://host/mcp"
        required
      />
      <Input
        label="Token"
        type="password"
        autoComplete="off"
        value={token}
        onChange={event => setToken(event.target.value)}
        description="Sent as Authorization: Bearer. Saved, never shown again."
      />
      {headers.map((row, index) => (
        <div key={index} className="flex flex-wrap gap-2">
          <Input aria-label="Header name" value={row.name} onChange={event => setHeader(index, { name: event.target.value })} />
          <Input aria-label="Header value" value={row.value} onChange={event => setHeader(index, { value: event.target.value })} />
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" onClick={() => setHeaders(rows => [...rows, { name: '', value: '' }])}>
        Add a header
      </Button>
      {error && (
        <div role="alert" className={bannerClass}>
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" loading={saving}>
          Connect
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
