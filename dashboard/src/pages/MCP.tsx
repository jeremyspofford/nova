import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, Trash2, RefreshCw,
  ChevronDown, ChevronRight, Pencil, ExternalLink, Puzzle, ShieldCheck,
} from 'lucide-react'
import {
  getMCPServers,
  createMCPServer,
  updateMCPServer,
  deleteMCPServer,
  reloadMCPServer,
  getMCPCatalog,
  installMCPServer,
  type MCPServer,
  type MCPCatalogTemplate,
  type BlastRadius,
} from '../api'
import { PageHeader } from '../components/layout/PageHeader'
import {
  Card, Button, Input, Label, Select, Badge, StatusDot,
  ConfirmDialog, EmptyState, SearchInput, Modal, Tooltip,
} from '../components/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnvPair {
  key: string
  value: string
  required?: boolean
  label?: string
  hint?: string
}

interface PrefillValues {
  name: string
  description: string
  transport: 'stdio' | 'http'
  command: string
  args: string
  url: string
  enabled: boolean
  envPairs: EnvPair[]
  note?: string
}

const DEFAULT_FORM: PrefillValues = {
  name: '',
  description: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  enabled: true,
  envPairs: [],
}

// ── Server form (add or edit) ─────────────────────────────────────────────────

function ServerForm({
  initialValues,
  serverId,
  onDone,
  title = 'New MCP Server',
}: {
  initialValues?: PrefillValues
  serverId?: string
  onDone: () => void
  title?: string
}) {
  const vals = initialValues ?? DEFAULT_FORM
  const [form, setForm] = useState({
    name: vals.name,
    description: vals.description,
    transport: vals.transport,
    command: vals.command,
    args: vals.args,
    url: vals.url,
    enabled: vals.enabled,
  })
  const [envPairs, setEnvPairs] = useState<EnvPair[]>(vals.envPairs)

  const mutation = useMutation({
    mutationFn: (data: Parameters<typeof createMCPServer>[0]) =>
      serverId ? updateMCPServer(serverId, data) : createMCPServer(data),
    onSuccess: onDone,
  })

  const handleSubmit = () => {
    const env: Record<string, string> = {}
    for (const { key, value } of envPairs) {
      if (key.trim()) env[key.trim()] = value
    }
    mutation.mutate({
      name: form.name.trim(),
      description: form.description.trim(),
      transport: form.transport as MCPServer['transport'],
      command: form.command.trim() || null,
      args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
      env,
      url: form.url.trim() || null,
      enabled: form.enabled,
    })
  }

  const isValid =
    form.name.trim() &&
    ((form.transport === 'stdio' && form.command.trim()) ||
      (form.transport === 'http' && form.url.trim()))

  const set = (key: string, value: unknown) =>
    setForm(f => ({ ...f, [key]: value }))

  const missingRequired = envPairs
    .filter(p => p.required && !p.value.trim())
    .map(p => p.key)

  return (
    <Card className="p-5 space-y-4">
      <p className="text-caption font-medium text-content-tertiary uppercase tracking-wider">
        {title}
      </p>

      {vals.note && (
        <div className="rounded-lg border border-warning/20 bg-warning-dim px-3 py-2">
          <p className="text-caption text-amber-700 dark:text-amber-400">{vals.note}</p>
        </div>
      )}

      {missingRequired.length > 0 && (
        <div className="rounded-lg border border-warning/20 bg-warning-dim px-3 py-2">
          <p className="text-caption text-amber-700 dark:text-amber-400">
            Fill in required variables before adding:{' '}
            <span className="font-mono font-medium">{missingRequired.join(', ')}</span>
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Name *</Label>
          <Input
            value={form.name}
            onChange={e => set('name', e.target.value)}
            placeholder="e.g. filesystem, brave-search"
          />
        </div>
        <div>
          <Label>Transport</Label>
          <Select
            value={form.transport}
            onChange={e => set('transport', e.target.value)}
          >
            <option value="stdio">stdio (subprocess)</option>
            <option value="http">http (remote)</option>
          </Select>
        </div>
      </div>

      {form.transport === 'stdio' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Command *</Label>
            <Input
              value={form.command}
              onChange={e => set('command', e.target.value)}
              placeholder="e.g. npx, uvx, node, python3"
            />
          </div>
          <div>
            <Label>
              Args <span className="text-content-tertiary">(space-separated)</span>
            </Label>
            <Input
              value={form.args}
              onChange={e => set('args', e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /workspace"
            />
          </div>
        </div>
      ) : (
        <div>
          <Label>URL *</Label>
          <Input
            value={form.url}
            onChange={e => set('url', e.target.value)}
            placeholder="http://localhost:3000"
          />
        </div>
      )}

      <div>
        <Label>Description</Label>
        <Input
          value={form.description}
          onChange={e => set('description', e.target.value)}
          placeholder="Optional -- shown in the server card"
        />
      </div>

      {/* Env vars */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-caption text-content-tertiary">Environment Variables</label>
          <button
            onClick={() => setEnvPairs(p => [...p, { key: '', value: '' }])}
            className="text-caption text-accent hover:text-accent-hover transition-colors"
          >
            + Add variable
          </button>
        </div>
        {envPairs.map((pair, i) => (
          <div key={i} className={`mb-2 rounded-sm ${pair.required ? 'border-l-2 border-warning pl-2' : ''}`}>
            {pair.label && (
              <div className="mb-1 flex items-center gap-1">
                <span className="text-caption text-content-tertiary">{pair.label}</span>
                {pair.required && <span className="text-caption text-danger">*</span>}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={pair.key}
                onChange={e =>
                  setEnvPairs(p => p.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
                }
                placeholder="KEY"
                className="flex-1 text-caption font-mono"
              />
              <Input
                value={pair.value}
                onChange={e =>
                  setEnvPairs(p => p.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                }
                placeholder={pair.required && !pair.value ? 'Required' : 'value'}
                className={`flex-1 text-caption font-mono ${pair.required && !pair.value.trim() ? 'border-warning' : ''}`}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEnvPairs(p => p.filter((_, j) => j !== i))}
                className="text-content-tertiary hover:text-danger shrink-0"
              >
                x
              </Button>
            </div>
            {pair.hint && (
              <p className="mt-0.5 text-caption text-content-tertiary">{pair.hint}</p>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-t border-border-subtle pt-3">
        <label className="flex items-center gap-2 text-caption text-content-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={e => set('enabled', e.target.checked)}
            className="rounded"
          />
          Connect immediately after adding
        </label>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
          <Button
            icon={<Plus size={13} />}
            onClick={handleSubmit}
            disabled={!isValid}
            loading={mutation.isPending}
          >
            {serverId ? 'Save Changes' : 'Add Server'}
          </Button>
        </div>
      </div>

      {mutation.isError && (
        <p className="text-caption text-danger">{String(mutation.error)}</p>
      )}
    </Card>
  )
}

// ── Server card ───────────────────────────────────────────────────────────────

function ServerCard({
  server,
  onDelete,
  onReload,
  reloading,
}: {
  server: MCPServer
  onDelete: () => void
  onReload: () => void
  reloading: boolean
}) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  const existingEnvPairs: EnvPair[] = Object.entries(server.env || {}).map(([key, value]) => ({
    key,
    value,
  }))

  const initialValues: PrefillValues = {
    name: server.name,
    description: server.description ?? '',
    transport: server.transport,
    command: server.command ?? '',
    args: (server.args ?? []).join(' '),
    url: server.url ?? '',
    enabled: server.enabled,
    envPairs: existingEnvPairs,
  }

  const handleEditDone = () => {
    setEditing(false)
    qc.invalidateQueries({ queryKey: ['mcp-servers'] })
  }

  const statusDot = !server.enabled ? 'neutral' as const
    : server.connected ? 'success' as const
    : 'danger' as const

  return (
    <Card className="overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-surface-card-hover transition-colors"
        onClick={() => !editing && setExpanded(v => !v)}
      >
        <StatusDot status={statusDot} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-compact font-medium text-content-primary">{server.name}</span>
            <Badge color="neutral" size="sm">{server.transport}</Badge>
            {server.connected && (
              <Badge color="success" size="sm">
                {server.tool_count} tool{server.tool_count !== 1 ? 's' : ''}
              </Badge>
            )}
            {!server.enabled && (
              <Badge color="neutral" size="sm">disabled</Badge>
            )}
          </div>
          {server.description && (
            <p className="mt-0.5 text-caption text-content-tertiary truncate">{server.description}</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 ml-2" onClick={e => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="sm"
            icon={<Pencil size={13} />}
            onClick={() => { setEditing(v => !v); setExpanded(false) }}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={13} className={reloading ? 'animate-spin' : ''} />}
            onClick={onReload}
            disabled={reloading}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={13} />}
            onClick={onDelete}
            className="text-content-tertiary hover:text-danger"
          />
        </div>

        {!editing && (
          <div className="text-content-tertiary">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        )}
      </div>

      {editing && (
        <div className="border-t border-border-subtle bg-surface-elevated/50 p-4">
          <ServerForm
            initialValues={initialValues}
            serverId={server.id}
            onDone={handleEditDone}
            title="Edit MCP Server"
          />
        </div>
      )}

      {expanded && !editing && (
        <div className="border-t border-border-subtle bg-surface-elevated px-4 py-3 space-y-2">
          {server.command && (
            <div className="text-caption">
              <span className="text-content-tertiary mr-1">Command:</span>
              <code className="text-content-secondary font-mono text-mono-sm">
                {server.command}
                {server.args && server.args.length > 0 ? ' ' + server.args.join(' ') : ''}
              </code>
            </div>
          )}
          {server.url && (
            <div className="text-caption">
              <span className="text-content-tertiary mr-1">URL:</span>
              <code className="text-content-secondary font-mono text-mono-sm">{server.url}</code>
            </div>
          )}
          {Object.keys(server.env || {}).length > 0 && (
            <div className="text-caption">
              <span className="text-content-tertiary mr-1">Env vars:</span>
              <code className="text-content-secondary font-mono text-mono-sm">{Object.keys(server.env).join(', ')}</code>
            </div>
          )}

          {(() => {
            const radii = distinctRadii(server.metadata?.tool_blast_radius as Record<string, BlastRadius> | undefined)
            return radii.length > 0 ? (
              <div className="flex items-center gap-1.5 pt-1">
                <span className="text-caption text-content-tertiary">Actions:</span>
                {radii.map(r => <BlastBadge key={r} radius={r} />)}
              </div>
            ) : null
          })()}

          {server.active_tools && server.active_tools.length > 0 && (
            <div className="pt-1">
              <p className="mb-1.5 text-caption text-content-tertiary">Available tools:</p>
              <div className="flex flex-wrap gap-1.5">
                {server.active_tools.map(t => (
                  <Badge key={t} color="accent" size="sm" className="font-mono">{t}</Badge>
                ))}
              </div>
            </div>
          )}

          {server.connected === false && server.enabled && (
            <p className="text-caption text-danger">
              Not connected -- click Reload to retry, or check the orchestrator logs.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Catalog card ─────────────────────────────────────────────────────────────

const BLAST: Record<BlastRadius, { label: string; color: 'neutral' | 'warning' | 'danger'; hint: string }> = {
  read: { label: 'read', color: 'neutral', hint: 'Read-only — runs without approval.' },
  propose: { label: 'propose', color: 'neutral', hint: 'Generates output only — no external side effects.' },
  mutate: { label: 'write', color: 'warning', hint: 'Changes state — requires your approval before it runs.' },
  destruct: { label: 'destructive', color: 'danger', hint: 'Irreversible — requires your approval before it runs.' },
}

function BlastBadge({ radius }: { radius: BlastRadius }) {
  const b = BLAST[radius]
  return (
    <Tooltip content={b.hint}>
      <span className="inline-flex"><Badge color={b.color} size="sm">{b.label}</Badge></span>
    </Tooltip>
  )
}

/** Distinct blast radii present in a tool_blast_radius map, worst-first. */
function distinctRadii(map: Record<string, BlastRadius> | undefined): BlastRadius[] {
  const present = new Set(Object.values(map ?? {}))
  return (['destruct', 'mutate', 'read'] as BlastRadius[]).filter(r => present.has(r))
}

function CatalogCard({
  tpl,
  onInstall,
}: {
  tpl: MCPCatalogTemplate
  onInstall: (tpl: MCPCatalogTemplate) => void
}) {
  const radii = distinctRadii(tpl.tool_blast_radius)
  return (
    <Card variant="hoverable" className="p-4 flex flex-col">
      <div className="flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="flex items-center gap-1.5 text-compact font-medium text-content-primary">
            {tpl.icon && <span aria-hidden>{tpl.icon}</span>}
            {tpl.name}
          </span>
          {tpl.docs_url && (
            <a
              href={tpl.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="shrink-0 text-content-tertiary hover:text-accent transition-colors"
              title="Documentation"
            >
              <ExternalLink size={12} />
            </a>
          )}
        </div>
        <p className="mt-1 text-caption text-content-secondary leading-relaxed">{tpl.description}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Badge color="neutral" size="sm">{tpl.category}</Badge>
          {radii.map(r => <BlastBadge key={r} radius={r} />)}
        </div>
      </div>
      <Button size="sm" className="w-full mt-4" onClick={() => onInstall(tpl)}>
        Install
      </Button>
    </Card>
  )
}

// ── Secure install modal (secrets → encrypted vault) ──────────────────────────

function InstallModal({
  tpl,
  onClose,
  onInstalled,
}: {
  tpl: MCPCatalogTemplate | null
  onClose: () => void
  onInstalled: () => void
}) {
  const [name, setName] = useState(tpl?.name ?? '')
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((tpl?.fields ?? []).map(f => [f.key, f.default ?? ''])),
  )
  const [enabled, setEnabled] = useState(true)

  const install = useMutation({
    mutationFn: () =>
      installMCPServer({ template_id: tpl!.id, name: name.trim() || undefined, fields: values, enabled }),
    onSuccess: onInstalled,
  })

  if (!tpl) return null

  const missing = tpl.fields
    .filter(f => (f.required ?? true) && !(values[f.key] ?? '').trim())
    .map(f => f.label)
  const hasSecret = tpl.fields.some(f => f.secret)

  return (
    <Modal
      open={!!tpl}
      onClose={onClose}
      size="md"
      title={`Install ${tpl.name}`}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-caption text-content-secondary cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="rounded" />
            Connect immediately
          </label>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              icon={<Plus size={13} />}
              onClick={() => install.mutate()}
              disabled={missing.length > 0}
              loading={install.isPending}
            >
              Install
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3 text-left">
        <p className="text-caption text-content-secondary">{tpl.description}</p>

        <div>
          <Label>Name</Label>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder={tpl.name} />
        </div>

        {tpl.fields.map(f => (
          <div key={f.key}>
            <Label>{f.label}{(f.required ?? true) ? ' *' : ''}</Label>
            <Input
              type={f.secret ? 'password' : 'text'}
              value={values[f.key] ?? ''}
              onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              autoComplete={f.secret ? 'new-password' : undefined}
            />
            {f.help && <p className="mt-0.5 text-caption text-content-tertiary">{f.help}</p>}
          </div>
        ))}

        {hasSecret && (
          <div className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-elevated px-3 py-2">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-success" />
            <p className="text-caption text-content-tertiary">
              Secrets are stored encrypted in Nova's vault — only a reference is written to the server config, never the value itself.
            </p>
          </div>
        )}

        {tpl.requires && (
          <p className="text-caption text-content-tertiary">Requires: {tpl.requires}</p>
        )}

        {install.isError && (
          <p className="text-caption text-danger">{String(install.error)}</p>
        )}
      </div>
    </Modal>
  )
}

// ── Help entries ─────────────────────────────────────────────────────────────

const HELP_ENTRIES = [
  { term: 'MCP', definition: 'Model Context Protocol — an open standard for connecting AI models to external tools and data sources.' },
  { term: 'Transport', definition: 'How Nova communicates with the MCP server — stdio runs it as a subprocess, HTTP connects to a remote URL.' },
  { term: 'Tool', definition: "A specific function an MCP server provides — e.g. 'search files', 'run SQL', 'fetch web page'." },
  { term: 'Server', definition: 'A program implementing the MCP protocol that provides one or more tools for Nova to use during tasks.' },
]

// ── MCP content (shared between standalone page and Integrations tab) ────────

export function MCPContent() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<MCPServer | null>(null)
  const [installTarget, setInstallTarget] = useState<MCPCatalogTemplate | null>(null)

  const { data: servers = [], isLoading, error } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: getMCPServers,
    refetchInterval: 15_000,
  })

  const { data: catalog = [] } = useQuery({
    queryKey: ['mcp-catalog'],
    queryFn: getMCPCatalog,
    staleTime: 5 * 60_000,
  })

  const deleteMutation = useMutation({
    mutationFn: deleteMCPServer,
    onSuccess: () => {
      setDeleteTarget(null)
      qc.invalidateQueries({ queryKey: ['mcp-servers'] })
    },
  })

  const reloadMutation = useMutation({
    mutationFn: reloadMCPServer,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-servers'] }),
  })

  const handleFormDone = () => {
    setShowForm(false)
    qc.invalidateQueries({ queryKey: ['mcp-servers'] })
  }

  const handleInstalled = () => {
    setInstallTarget(null)
    qc.invalidateQueries({ queryKey: ['mcp-servers'] })
  }

  const installedNames = new Set(servers.map(s => s.name.toLowerCase()))
  const categories = Array.from(new Set(catalog.map(t => t.category))).sort()

  const filteredCatalog = catalog.filter(tpl => {
    if (installedNames.has(tpl.name.toLowerCase())) return false
    if (categoryFilter && tpl.category !== categoryFilter) return false
    const q = search.toLowerCase()
    return !q ||
      tpl.name.toLowerCase().includes(q) ||
      tpl.description.toLowerCase().includes(q) ||
      tpl.category.includes(q)
  })

  return (
    <div className="space-y-5">
      {/* Actions */}
      <div className="flex items-center justify-end">
        <Button
          icon={<Plus size={14} />}
          variant="secondary"
          onClick={() => { setFormKey(k => k + 1); setShowForm(v => !v) }}
        >
          {showForm ? 'Cancel' : 'Add manually'}
        </Button>
      </div>

      {/* Manual add form (custom / advanced servers) */}
      {showForm && (
        <ServerForm key={formKey} onDone={handleFormDone} title="New MCP Server" />
      )}

      {/* Server list */}
      {isLoading && <Card className="p-8"><p className="text-compact text-content-tertiary text-center">Loading...</p></Card>}
      {error && <Card className="p-4"><p className="text-compact text-danger">{String(error)}</p></Card>}

      <div className="space-y-3">
        {servers.map(server => (
          <ServerCard
            key={server.id}
            server={server}
            onDelete={() => setDeleteTarget(server)}
            onReload={() => reloadMutation.mutate(server.id)}
            reloading={reloadMutation.isPending}
          />
        ))}

        {servers.length === 0 && !isLoading && (
          <Card className="py-8">
            <EmptyState
              icon={Puzzle}
              title="No integrations yet"
              description="Pick one from the catalog below, or add a custom MCP server manually."
            />
          </Card>
        )}
      </div>

      {/* Integration catalog */}
      <Card className="overflow-hidden">
        <div className="px-5 py-3">
          <p className="text-caption font-medium text-content-tertiary uppercase tracking-wider">
            Add an integration
          </p>
        </div>

        <div className="border-t border-border-subtle p-4 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <SearchInput value={search} onChange={setSearch} placeholder="Search integrations..." />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setCategoryFilter(null)}
                className={`rounded-full px-2.5 py-0.5 text-caption transition-colors ${
                  categoryFilter === null
                    ? 'bg-accent text-neutral-950'
                    : 'bg-surface-elevated text-content-tertiary hover:text-content-secondary'
                }`}
              >
                all
              </button>
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(c => (c === cat ? null : cat))}
                  className={`rounded-full px-2.5 py-0.5 text-caption transition-colors ${
                    categoryFilter === cat
                      ? 'bg-accent text-neutral-950'
                      : 'bg-surface-elevated text-content-tertiary hover:text-content-secondary'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {filteredCatalog.length === 0 ? (
            <p className="text-compact text-content-tertiary text-center py-4">
              {catalog.length === 0 ? 'Catalog unavailable.' : 'No matching integrations.'}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredCatalog.map(tpl => (
                <CatalogCard key={tpl.id} tpl={tpl} onInstall={setInstallTarget} />
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Secure install modal */}
      <InstallModal
        key={installTarget?.id ?? 'none'}
        tpl={installTarget}
        onClose={() => setInstallTarget(null)}
        onInstalled={handleInstalled}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Remove MCP Server"
        description={`Remove "${deleteTarget?.name}"? This will disconnect it immediately.`}
        confirmLabel="Remove"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        destructive
      />
    </div>
  )
}

// ── MCP page (standalone) ────────────────────────────────────────────────────

export function MCP() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect MCP servers to extend Nova with additional tools. Any server implementing the MCP spec can be added here."
        helpEntries={HELP_ENTRIES}
      />
      <MCPContent />
    </div>
  )
}
