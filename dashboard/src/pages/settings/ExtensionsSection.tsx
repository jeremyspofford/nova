// dashboard/src/pages/settings/ExtensionsSection.tsx
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Play, Plus, Power, Trash2 } from 'lucide-react'
import {
  createMCPServer,
  deleteMCPServer,
  listMCPServers,
  listMCPTools,
  restartMCPServer,
  setToolTierOverride,
  toggleMCPServer,
  type MCPServer,
  type MCPServerCreate,
  type MCPTool,
} from '../../api'

const TIERS = ['READ', 'MUTATE', 'DESTRUCT'] as const
type Tier = (typeof TIERS)[number]

const TIER_COLORS: Record<string, string> = {
  READ: 'text-teal-400',
  MUTATE: 'text-amber-400',
  DESTRUCT: 'text-red-400',
}

interface AddServerForm {
  name: string
  command: string
  args: string       // space-separated
  working_dir: string
  env_raw: string    // JSON object
}

const EMPTY_FORM: AddServerForm = {
  name: '',
  command: '',
  args: '',
  working_dir: '',
  env_raw: '',
}

// ── Tool row ─────────────────────────────────────────────────────────────────

function ToolRow({
  tool,
  serverId,
}: {
  tool: MCPTool
  serverId: string
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<string>(tool.effective_tier)

  const overrideMut = useMutation({
    mutationFn: (tier: string | null) =>
      setToolTierOverride(serverId, tool.name, tier),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-tools', serverId] })
      setEditing(false)
    },
  })

  const isOverride = tool.effective_tier !== tool.auto_tier

  return (
    <tr className="border-t border-stone-800 hover:bg-stone-800/30">
      <td className="px-3 py-2 font-mono text-xs text-stone-200">{tool.name}</td>
      <td className="px-3 py-2 text-xs text-stone-500 truncate max-w-xs">
        {tool.description || '—'}
      </td>
      <td className="px-3 py-2 text-xs">
        {editing ? (
          <div className="flex items-center gap-1">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="rounded bg-stone-900 border border-stone-700 px-2 py-0.5 text-xs text-stone-100"
            >
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              onClick={() => overrideMut.mutate(selected)}
              disabled={overrideMut.isPending}
              className="px-2 py-0.5 rounded bg-teal-600 text-xs text-white hover:bg-teal-500 disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => {
                overrideMut.mutate(null)
              }}
              disabled={overrideMut.isPending}
              className="px-2 py-0.5 rounded bg-stone-700 text-xs text-stone-300 hover:bg-stone-600 disabled:opacity-50"
              title="Reset to heuristic"
            >
              Reset
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-2 py-0.5 text-xs text-stone-500 hover:text-stone-300"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setSelected(tool.effective_tier)
              setEditing(true)
            }}
            className={`font-semibold ${TIER_COLORS[tool.effective_tier] ?? 'text-stone-400'} hover:underline`}
          >
            {tool.effective_tier}
            {isOverride && (
              <span className="ml-1 text-stone-500 font-normal">(override)</span>
            )}
          </button>
        )}
      </td>
    </tr>
  )
}

// ── Server row ────────────────────────────────────────────────────────────────

function ServerRow({
  server,
  onDelete,
}: {
  server: MCPServer
  onDelete: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const qc = useQueryClient()

  const { data: tools, isFetching: toolsFetching } = useQuery({
    queryKey: ['mcp-tools', server.id],
    queryFn: () => listMCPTools(server.id),
    enabled: expanded,
    staleTime: 10_000,
    retry: 1,
  })

  const restartMut = useMutation({
    mutationFn: () => restartMCPServer(server.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-servers'] })
      setError(null)
    },
    onError: (e: Error) => setError(e.message),
  })

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) => toggleMCPServer(server.id, enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-servers'] })
      setError(null)
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <div className="rounded-lg border border-stone-700 overflow-hidden">
      <div className="flex items-center gap-3 bg-stone-900 px-4 py-3">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-stone-500 hover:text-stone-300"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="flex-1 min-w-0">
          <span className="font-mono text-sm text-stone-100">{server.name}</span>
          <span className="ml-2 text-xs text-stone-500">
            {server.command} {server.args.join(' ')}
          </span>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded-full ${
            server.enabled
              ? 'bg-teal-900/40 text-teal-400'
              : 'bg-stone-800 text-stone-500'
          }`}
        >
          {server.enabled ? 'enabled' : 'disabled'}
        </span>
        <button
          onClick={() => toggleMut.mutate(!server.enabled)}
          disabled={toggleMut.isPending}
          title={server.enabled ? 'Disable' : 'Enable'}
          className={`p-1.5 rounded ${server.enabled ? 'text-teal-400 hover:text-teal-300' : 'text-stone-600 hover:text-stone-400'}`}
        >
          <Power size={14} />
        </button>
        <button
          onClick={() => restartMut.mutate()}
          disabled={restartMut.isPending || !server.enabled}
          title="Restart server"
          className="text-stone-500 hover:text-teal-400 disabled:opacity-40"
        >
          <Play size={14} />
        </button>
        <button
          onClick={() => onDelete(server.id)}
          title="Delete server"
          className="text-stone-500 hover:text-red-400"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {server.last_error && (
        <div className="px-4 py-1.5 bg-red-900/20 text-xs text-red-400 font-mono truncate">
          {server.last_error}
        </div>
      )}
      {error && (
        <div className="px-4 py-1.5 bg-red-900/20 text-xs text-red-400">
          {error}
        </div>
      )}

      {expanded && (
        <div className="border-t border-stone-800 bg-stone-950/50">
          {toolsFetching ? (
            <p className="px-4 py-3 text-xs text-stone-500">Loading tools...</p>
          ) : !tools || tools.length === 0 ? (
            <p className="px-4 py-3 text-xs text-stone-500 italic">
              No tools discovered. Start the server first.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-stone-800/60">
                <tr className="text-xs text-stone-500 uppercase tracking-wide">
                  <th className="px-3 py-1.5 text-left">Tool</th>
                  <th className="px-3 py-1.5 text-left">Description</th>
                  <th className="px-3 py-1.5 text-left">Tier</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((t) => (
                  <ToolRow key={t.name} tool={t} serverId={server.id} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main section ──────────────────────────────────────────────────────────────

export function ExtensionsSection() {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<AddServerForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const { data: servers = [], isLoading } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: () => listMCPServers(),
    staleTime: 5_000,
    retry: 1,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['mcp-servers'] })

  const createMut = useMutation({
    mutationFn: (body: MCPServerCreate) => createMCPServer(body),
    onSuccess: () => {
      invalidate()
      setShowAdd(false)
      setForm(EMPTY_FORM)
      setFormError(null)
    },
    onError: (e: Error) => setFormError(e.message),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteMCPServer(id),
    onSuccess: () => {
      invalidate()
      setDeleteTarget(null)
    },
  })

  function submitAdd() {
    if (!form.name.trim() || !form.command.trim()) {
      setFormError('Name and command are required.')
      return
    }
    const args = form.args.trim() ? form.args.trim().split(/\s+/) : []

    let env: Record<string, string> = {}
    if (form.env_raw.trim()) {
      try {
        env = JSON.parse(form.env_raw)
      } catch {
        setFormError('Env must be valid JSON')
        return
      }
    }

    createMut.mutate({
      name: form.name.trim(),
      command: form.command.trim(),
      args,
      env,
      working_dir: form.working_dir.trim() || undefined,
    })
  }

  const serverToDelete = servers.find((s) => s.id === deleteTarget)

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-stone-100">Extensions</h2>
          <p className="text-sm text-stone-400">
            MCP (Model Context Protocol) servers expose additional tools to Nova's agent.
          </p>
        </div>
        <button
          onClick={() => {
            setShowAdd(true)
            setFormError(null)
          }}
          className="flex items-center gap-1.5 rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-500"
        >
          <Plus size={14} /> Add server
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="rounded-lg border border-stone-700 bg-stone-800/60 p-4 space-y-3">
          <h3 className="text-sm font-medium text-stone-200">Add MCP server</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-stone-400 mb-1">Name</label>
              <input
                className="w-full rounded bg-stone-900 border border-stone-700 px-3 py-1.5 text-sm text-stone-100 font-mono placeholder:text-stone-600 focus:outline-none focus:ring-1 focus:ring-teal-500"
                placeholder="my-mcp-server"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-stone-400 mb-1">Command</label>
              <input
                className="w-full rounded bg-stone-900 border border-stone-700 px-3 py-1.5 text-sm text-stone-100 font-mono placeholder:text-stone-600 focus:outline-none focus:ring-1 focus:ring-teal-500"
                placeholder="node"
                value={form.command}
                onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-stone-400 mb-1">
              Arguments (space-separated)
            </label>
            <input
              className="w-full rounded bg-stone-900 border border-stone-700 px-3 py-1.5 text-sm text-stone-100 font-mono placeholder:text-stone-600 focus:outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="/app/server.js --port 9000"
              value={form.args}
              onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-xs text-stone-400 mb-1">
              Working directory (optional)
            </label>
            <input
              className="w-full rounded bg-stone-900 border border-stone-700 px-3 py-1.5 text-sm text-stone-100 font-mono placeholder:text-stone-600 focus:outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="/workspace/my-mcp-server"
              value={form.working_dir}
              onChange={(e) => setForm((f) => ({ ...f, working_dir: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-xs text-stone-400 mb-1">
              {'Env vars (JSON — use "${secret:name}" for secrets)'}
            </label>
            <textarea
              rows={3}
              className="w-full rounded bg-stone-900 border border-stone-700 px-3 py-1.5 text-sm text-stone-100 font-mono placeholder:text-stone-600 focus:outline-none focus:ring-1 focus:ring-teal-500 resize-none"
              placeholder={'{"API_KEY": "${secret:my_key}", "PORT": "9000"}'}
              value={form.env_raw}
              onChange={(e) => setForm((f) => ({ ...f, env_raw: e.target.value }))}
            />
          </div>
          {formError && <p className="text-xs text-red-400">{formError}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowAdd(false)
                setFormError(null)
              }}
              className="px-3 py-1.5 text-sm text-stone-400 hover:text-stone-200"
            >
              Cancel
            </button>
            <button
              onClick={submitAdd}
              disabled={createMut.isPending}
              className="px-3 py-1.5 rounded-md bg-teal-600 text-sm text-white hover:bg-teal-500 disabled:opacity-50"
            >
              {createMut.isPending ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteTarget && serverToDelete && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-900/20 p-4 space-y-3">
          <p className="text-sm text-amber-200">
            Delete <span className="font-mono font-semibold">{serverToDelete.name}</span>?
            The server process will be stopped and all tool overrides removed.
          </p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setDeleteTarget(null)}
              className="px-3 py-1.5 text-sm text-stone-400 hover:text-stone-200"
            >
              Cancel
            </button>
            <button
              onClick={() => deleteMut.mutate(deleteTarget)}
              className="px-3 py-1.5 rounded-md bg-red-700 text-sm text-white hover:bg-red-600"
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {/* Server list */}
      {isLoading ? (
        <p className="text-sm text-stone-400">Loading...</p>
      ) : servers.length === 0 ? (
        <p className="text-sm text-stone-500 italic">
          No MCP servers configured yet. Add one above.
        </p>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              onDelete={(id) => setDeleteTarget(id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
