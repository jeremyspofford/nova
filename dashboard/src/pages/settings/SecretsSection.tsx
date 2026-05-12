// dashboard/src/pages/settings/SecretsSection.tsx
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Edit2, Plus, Trash2 } from 'lucide-react'
import {
  createSecret,
  deleteSecret,
  listSecrets,
  type SecretInfo,
  updateSecret,
} from '../../api'

type FormMode = 'add' | 'edit'

interface SecretForm {
  name: string
  value: string
  purpose: string
}

const EMPTY_FORM: SecretForm = { name: '', value: '', purpose: '' }

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function SecretsSection() {
  const qc = useQueryClient()
  const [form, setForm] = useState<SecretForm>(EMPTY_FORM)
  const [mode, setMode] = useState<FormMode | null>(null)
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: secrets = [], isLoading } = useQuery({
    queryKey: ['secrets'],
    queryFn: listSecrets,
    staleTime: 5_000,
    retry: 1,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['secrets'] })

  const createMut = useMutation({
    mutationFn: createSecret,
    onSuccess: () => {
      invalidate()
      setMode(null)
      setForm(EMPTY_FORM)
      setError(null)
    },
    onError: (e: Error) => setError(e.message),
  })

  const updateMut = useMutation({
    mutationFn: ({ name, data }: { name: string; data: { value?: string; purpose?: string } }) =>
      updateSecret(name, data),
    onSuccess: () => {
      invalidate()
      setMode(null)
      setEditTarget(null)
      setForm(EMPTY_FORM)
      setError(null)
    },
    onError: (e: Error) => setError(e.message),
  })

  const deleteMut = useMutation({
    mutationFn: deleteSecret,
    onSuccess: () => {
      invalidate()
      setDeleteTarget(null)
    },
  })

  function openAdd() {
    setForm(EMPTY_FORM)
    setMode('add')
    setError(null)
  }

  function openEdit(secret: SecretInfo) {
    setForm({ name: secret.name, value: '', purpose: secret.purpose ?? '' })
    setEditTarget(secret.name)
    setMode('edit')
    setError(null)
  }

  function submitForm() {
    if (mode === 'add') {
      if (!form.name || !form.value) {
        setError('Name and value are required.')
        return
      }
      createMut.mutate({ name: form.name, value: form.value, purpose: form.purpose || undefined })
    } else if (mode === 'edit' && editTarget) {
      const data: { value?: string; purpose?: string } = {}
      if (form.value) data.value = form.value
      if (form.purpose !== '') data.purpose = form.purpose
      if (!data.value && data.purpose === undefined) {
        setError('Nothing to update.')
        return
      }
      updateMut.mutate({ name: editTarget, data })
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-stone-100">Secrets</h2>
          <p className="text-sm text-stone-400">
            Encrypted credentials referenced by Nova services as{' '}
            <code className="text-teal-400 text-xs">{'${secret:name}'}</code>
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-500"
        >
          <Plus size={14} /> Add secret
        </button>
      </div>

      {mode && (
        <div className="rounded-lg border border-stone-700 bg-stone-800/60 p-4 space-y-3">
          <h3 className="text-sm font-medium text-stone-200">
            {mode === 'add' ? 'Add secret' : `Edit — ${editTarget}`}
          </h3>
          {mode === 'add' && (
            <div>
              <label className="block text-xs text-stone-400 mb-1">Name</label>
              <input
                className="w-full rounded bg-stone-900 border border-stone-700 px-3 py-1.5 text-sm text-stone-100 font-mono placeholder:text-stone-600 focus:outline-none focus:ring-1 focus:ring-teal-500"
                placeholder="anthropic_api_key"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.toLowerCase() }))}
              />
            </div>
          )}
          <div>
            <label className="block text-xs text-stone-400 mb-1">
              {mode === 'edit' ? 'New value (leave blank to keep current)' : 'Value'}
            </label>
            <input
              type="password"
              className="w-full rounded bg-stone-900 border border-stone-700 px-3 py-1.5 text-sm text-stone-100 placeholder:text-stone-600 focus:outline-none focus:ring-1 focus:ring-teal-500"
              placeholder={mode === 'edit' ? '••••••••' : 'sk-ant-...'}
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              autoComplete="off"
            />
          </div>
          <div>
            <label className="block text-xs text-stone-400 mb-1">Purpose (optional)</label>
            <input
              className="w-full rounded bg-stone-900 border border-stone-700 px-3 py-1.5 text-sm text-stone-100 placeholder:text-stone-600 focus:outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="Used by llm-gateway for Anthropic"
              value={form.purpose}
              onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setMode(null)
                setError(null)
              }}
              className="px-3 py-1.5 text-sm text-stone-400 hover:text-stone-200"
            >
              Cancel
            </button>
            <button
              onClick={submitForm}
              disabled={createMut.isPending || updateMut.isPending}
              className="px-3 py-1.5 rounded-md bg-teal-600 text-sm text-white hover:bg-teal-500 disabled:opacity-50"
            >
              {mode === 'add' ? 'Save' : 'Update'}
            </button>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-900/20 p-4 space-y-3">
          <p className="text-sm text-amber-200">
            Delete <span className="font-mono font-semibold">{deleteTarget}</span>?
            Services using this secret will continue working until restarted.
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

      {isLoading ? (
        <p className="text-sm text-stone-400">Loading...</p>
      ) : secrets.length === 0 ? (
        <p className="text-sm text-stone-500 italic">No secrets stored yet.</p>
      ) : (
        <div className="rounded-lg border border-stone-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-stone-800 text-stone-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-left">Purpose</th>
                <th className="px-4 py-2 text-left">Last used</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-800">
              {secrets.map((s) => (
                <tr key={s.name} className="bg-stone-900/50 hover:bg-stone-800/40">
                  <td className="px-4 py-2.5 font-mono text-teal-300">{s.name}</td>
                  <td className="px-4 py-2.5 text-stone-400">{s.purpose ?? '—'}</td>
                  <td className="px-4 py-2.5 text-stone-500">{relativeTime(s.last_used)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => openEdit(s)}
                        className="text-stone-500 hover:text-stone-200"
                        title="Edit"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(s.name)}
                        className="text-stone-500 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
