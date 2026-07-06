import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { Pencil, Plus, Trash2, Users as UsersIcon } from 'lucide-react'
import { fetchUsers, updateUser, deactivateUser, createInvite, fetchInvites, revokeInvite, type InviteCreateRequest, type UserListItem } from '../api/users'
import { useTabHash } from '../hooks/useTabHash'
import { ROLE_DESCRIPTIONS, ROLE_HIERARCHY, ROLE_LABELS, canAssignRole, type Role } from '../lib/roles'
import type { SemanticColor } from '../lib/design-tokens'
import { useAuth } from '../stores/auth-store'
import { PageHeader } from '../components/layout/PageHeader'
import {
  Card, Button, Input, Select, Badge, Avatar, Tabs,
  Modal, CopyableId, ConfirmDialog, EmptyState,
} from '../components/ui'

type Tab = 'users' | 'invitations'

const ROLE_BADGE_COLORS: Record<Role, SemanticColor> = {
  owner: 'warning',
  admin: 'info',
  member: 'success',
  viewer: 'accent',
  guest: 'neutral',
}

const INVITE_EXPIRY_OPTIONS = [
  { label: '24 hours', hours: 24 },
  { label: '72 hours', hours: 72 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
  { label: 'Never', hours: 0 },
]

const ACCOUNT_EXPIRY_OPTIONS = [
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
  { label: 'Never', hours: 0 },
]

export function Users() {
  const [tab, setTab] = useTabHash<Tab>('users', ['users', 'invitations'])
  const { user: currentUser } = useAuth()
  const currentRole = (currentUser?.role ?? 'viewer') as Role

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Manage users and invite new people to your Nova instance."
      />

      <Tabs
        tabs={[
          { id: 'users', label: 'Users' },
          { id: 'invitations', label: 'Invitations' },
        ]}
        activeTab={tab}
        onChange={(id) => setTab(id as Tab)}
      />

      {tab === 'users' ? (
        <UsersTab currentRole={currentRole} currentUserId={currentUser?.id} />
      ) : (
        <InvitationsTab currentRole={currentRole} />
      )}
    </div>
  )
}

export function UsersTab({ currentRole, currentUserId }: { currentRole: Role; currentUserId?: string }) {
  const qc = useQueryClient()
  const { data: users = [], isLoading, error } = useQuery({ queryKey: ['users'], queryFn: fetchUsers })
  const [deactivateTarget, setDeactivateTarget] = useState<{ id: string; name: string } | null>(null)
  const [editTarget, setEditTarget] = useState<UserListItem | null>(null)

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof updateUser>[1] }) => updateUser(id, data),
    onSuccess: () => {
      setEditTarget(null)
      qc.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: deactivateUser,
    onSuccess: () => {
      setDeactivateTarget(null)
      qc.invalidateQueries({ queryKey: ['users'] })
    },
  })

  const assignableRoles = ROLE_HIERARCHY.filter(r => canAssignRole(currentRole, r))

  if (isLoading) return <Card className="p-8"><p className="text-compact text-content-tertiary text-center">Loading...</p></Card>
  if (error) return <Card className="p-4"><p className="text-compact text-danger">{String(error)}</p></Card>

  if (users.length === 0) {
    return (
      <Card className="py-8">
        <EmptyState
          icon={UsersIcon}
          title="No users found"
          description="Users will appear here once they register or are invited."
        />
      </Card>
    )
  }

  return (
    <>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-compact">
            <thead>
              <tr className="bg-surface-elevated">
                <th className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">User</th>
                <th className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">Role</th>
                <th className="hidden sm:table-cell px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">Status</th>
                <th className="hidden md:table-cell px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">Expires</th>
                <th className="hidden md:table-cell px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">Last Updated</th>
                <th className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {users.map(u => {
                const role = u.role as Role
                const isOwner = role === 'owner'
                // Load-bearing identities, not accounts: ambient/break-glass
                // sessions (admin@local) and the brain's journal owner
                // (cortex@system.nova). No password, not editable.
                const isSystem = u.email === 'admin@local' || u.email === 'cortex@system.nova'
                return (
                  <tr key={u.id} className="hover:bg-surface-card-hover transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.display_name || u.email} src={u.avatar_url ?? undefined} />
                        <div>
                          <p className="font-medium text-content-primary">{u.display_name || 'Unnamed'}</p>
                          <p className="text-caption text-content-tertiary">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Badge color={ROLE_BADGE_COLORS[role] ?? 'neutral'}>
                          {ROLE_LABELS[role] || role}
                        </Badge>
                        {isSystem && (
                          <span title="Internal identity Nova relies on — no password, not editable">
                            <Badge color="neutral">System</Badge>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-content-secondary text-caption capitalize">
                      {u.status}
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-content-tertiary text-caption">
                      {u.expires_at
                        ? formatDistanceToNow(new Date(u.expires_at), { addSuffix: true })
                        : 'Never'}
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-content-tertiary text-caption">
                      {formatDistanceToNow(new Date(u.updated_at), { addSuffix: true })}
                    </td>
                    <td className="px-4 py-3">
                      {isSystem ? (
                        <span className="text-caption text-content-tertiary">Managed by Nova</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Pencil size={14} />}
                            onClick={() => setEditTarget(u)}
                          >
                            Edit
                          </Button>
                          {!isOwner && u.id !== currentUserId && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger"
                              onClick={() => setDeactivateTarget({ id: u.id, name: u.display_name || u.email })}
                            >
                              Deactivate
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <ConfirmDialog
        open={!!deactivateTarget}
        onClose={() => setDeactivateTarget(null)}
        title="Deactivate User"
        description={`Are you sure you want to deactivate "${deactivateTarget?.name}"? They will lose access to this Nova instance.`}
        confirmLabel="Deactivate"
        onConfirm={() => deactivateTarget && deactivateMutation.mutate(deactivateTarget.id)}
        destructive
      />

      {editTarget && (
        <EditUserModal
          key={editTarget.id}
          user={editTarget}
          currentRole={currentRole}
          currentUserId={currentUserId}
          saving={updateMutation.isPending}
          error={updateMutation.isError ? String(updateMutation.error) : null}
          onClose={() => { setEditTarget(null); updateMutation.reset() }}
          onSave={(data) => updateMutation.mutate({ id: editTarget.id, data })}
        />
      )}
    </>
  )
}

function EditUserModal({ user, currentRole, currentUserId, saving, error, onClose, onSave }: {
  user: UserListItem
  currentRole: Role
  currentUserId?: string
  saving: boolean
  error: string | null
  onClose: () => void
  onSave: (data: Parameters<typeof updateUser>[1]) => void
}) {
  const role = user.role as Role
  const roleLocked = role === 'owner' || user.id === currentUserId
  const assignableRoles = ROLE_HIERARCHY.filter(r => canAssignRole(currentRole, r))

  const [name, setName] = useState(user.display_name ?? '')
  const [email, setEmail] = useState(user.email)
  const [newRole, setNewRole] = useState<Role>(role)
  // datetime-local wants "YYYY-MM-DDTHH:mm" in local time
  const toLocalInput = (iso: string) => {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const [expiryMode, setExpiryMode] = useState<'never' | 'date'>(user.expires_at ? 'date' : 'never')
  const [expiryDate, setExpiryDate] = useState(user.expires_at ? toLocalInput(user.expires_at) : '')

  const handleSave = () => {
    const data: Parameters<typeof updateUser>[1] = {}
    if (name !== (user.display_name ?? '')) data.display_name = name
    if (email.trim().toLowerCase() !== user.email.toLowerCase()) data.email = email.trim()
    if (!roleLocked && newRole !== role) data.role = newRole
    if (expiryMode === 'never') {
      if (user.expires_at) data.expires_at = ''  // clear → never expires
    } else if (expiryDate) {
      const iso = new Date(expiryDate).toISOString()
      if (iso !== user.expires_at) data.expires_at = iso
    }
    if (Object.keys(data).length === 0) { onClose(); return }
    onSave(data)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${user.display_name || user.email}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} loading={saving} disabled={saving}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Display name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Name"
        />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
        <div>
          <label className="block text-caption font-medium text-content-secondary mb-1">Role</label>
          <Select
            value={newRole}
            onChange={e => setNewRole(e.target.value as Role)}
            disabled={roleLocked}
          >
            {assignableRoles.map(r => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
            {!assignableRoles.includes(role) && (
              <option value={role}>{ROLE_LABELS[role] || role}</option>
            )}
          </Select>
          <p className="mt-1.5 text-caption text-content-tertiary">
            {roleLocked
              ? (role === 'owner' ? 'The owner role cannot be changed here.' : 'You cannot change your own role.')
              : ROLE_DESCRIPTIONS[newRole]}
          </p>
        </div>
        <div>
          <label className="block text-caption font-medium text-content-secondary mb-1">Account expiry</label>
          <div className="flex items-center gap-2">
            <Select
              value={expiryMode}
              onChange={e => setExpiryMode(e.target.value as 'never' | 'date')}
              className="w-28"
            >
              <option value="never">Never</option>
              <option value="date">On date</option>
            </Select>
            {expiryMode === 'date' && (
              <input
                type="datetime-local"
                value={expiryDate}
                onChange={e => setExpiryDate(e.target.value)}
                className="h-9 flex-1 rounded-sm border border-border bg-surface-input px-3 text-compact text-content-primary outline-none focus:border-border-focus"
              />
            )}
          </div>
          <p className="mt-1.5 text-caption text-content-tertiary">
            Expired accounts are signed out and blocked until an admin extends them.
          </p>
        </div>
        {error && <p className="text-caption text-danger">{error}</p>}
      </div>
    </Modal>
  )
}

export function InvitationsTab({ currentRole }: { currentRole: Role }) {
  const qc = useQueryClient()
  const { data: invites = [], isLoading, error } = useQuery({ queryKey: ['invites'], queryFn: fetchInvites })

  const [showForm, setShowForm] = useState(false)
  const [inviteRole, setInviteRole] = useState<Role>('member')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteExpiry, setInviteExpiry] = useState(72)
  const [accountExpiry, setAccountExpiry] = useState(168)
  const [newInviteLink, setNewInviteLink] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<{ id: string } | null>(null)

  const assignableRoles = ROLE_HIERARCHY.filter(r => canAssignRole(currentRole, r))

  const createMutation = useMutation({
    mutationFn: (data: InviteCreateRequest) => createInvite(data),
    onSuccess: (invite) => {
      const link = `${window.location.origin}/invite/${invite.code}`
      setNewInviteLink(link)
      setInviteEmail('')
      setShowForm(false)
      qc.invalidateQueries({ queryKey: ['invites'] })
    },
  })

  const revokeMutation = useMutation({
    mutationFn: revokeInvite,
    onSuccess: () => {
      setRevokeTarget(null)
      qc.invalidateQueries({ queryKey: ['invites'] })
    },
  })

  const handleGenerate = () => {
    const data: InviteCreateRequest = {
      role: inviteRole,
      // Always explicit: null = never. Omitting the field used to fall into
      // a silent 72h server default, turning "Never" into 3 days.
      expires_in_hours: inviteExpiry > 0 ? inviteExpiry : null,
      ...(inviteEmail.trim() && { email: inviteEmail.trim() }),
      ...(inviteRole === 'guest' && accountExpiry > 0 && { account_expires_in_hours: accountExpiry }),
    }
    createMutation.mutate(data)
  }

  return (
    <div className="space-y-4">
      {/* New invite link revealed */}
      {newInviteLink && (
        <Card className="border-success/30 bg-success-dim p-4">
          <p className="text-compact font-medium text-content-primary mb-2">
            Invite created -- share this link
          </p>
          <CopyableId id={newInviteLink} truncate={999} />
          <button
            onClick={() => setNewInviteLink(null)}
            className="mt-2 text-caption text-content-tertiary hover:text-content-secondary transition-colors"
          >
            Dismiss
          </button>
        </Card>
      )}

      <Button
        icon={<Plus size={14} />}
        onClick={() => setShowForm(true)}
      >
        Create Invite
      </Button>

      {/* Create invite modal */}
      <Modal
        open={showForm}
        onClose={() => { setShowForm(false); createMutation.reset() }}
        title="New Invitation"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button
              onClick={handleGenerate}
              disabled={createMutation.isPending}
              loading={createMutation.isPending}
            >
              Generate
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="block text-caption font-medium text-content-secondary mb-1">Role</label>
            <div className="space-y-1 rounded-md border border-border-subtle p-1">
              {assignableRoles.map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setInviteRole(r)}
                  className={`w-full rounded px-2.5 py-1.5 text-left transition-colors ${
                    inviteRole === r ? 'bg-accent-dim' : 'hover:bg-surface-card-hover'
                  }`}
                >
                  <span className={`text-compact font-medium ${inviteRole === r ? 'text-accent' : 'text-content-primary'}`}>
                    {ROLE_LABELS[r]}
                  </span>
                  <span className="ml-2 text-caption text-content-tertiary">
                    {ROLE_DESCRIPTIONS[r]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="sm:col-span-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-caption text-amber-600 dark:text-amber-400">
            Heads up: today every user shares this instance's memory, goals, tasks, and
            Inbox — roles gate management actions, not data. Invite only people you'd
            share Nova's full context with. Per-user isolation is on the roadmap.
          </div>

          <div>
            <label className="block text-caption font-medium text-content-secondary mb-1">Email (optional)</label>
            <Input
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="user@example.com"
            />
          </div>

          <div>
            <label className="block text-caption font-medium text-content-secondary mb-1">Invite link expiry</label>
            <Select
              value={inviteExpiry}
              onChange={e => setInviteExpiry(Number(e.target.value))}
            >
              {INVITE_EXPIRY_OPTIONS.map(o => (
                <option key={o.hours} value={o.hours}>{o.label}</option>
              ))}
            </Select>
          </div>

          {inviteRole === 'guest' && (
            <div>
              <label className="block text-caption font-medium text-content-secondary mb-1">Account expiry</label>
              <Select
                value={accountExpiry}
                onChange={e => setAccountExpiry(Number(e.target.value))}
              >
                {ACCOUNT_EXPIRY_OPTIONS.map(o => (
                  <option key={o.hours} value={o.hours}>{o.label}</option>
                ))}
              </Select>
            </div>
          )}
        </div>
        {createMutation.isError && (
          <p className="mt-3 text-caption text-danger">{String(createMutation.error)}</p>
        )}
      </Modal>

      {/* Invites table */}
      {isLoading && <Card className="p-8"><p className="text-compact text-content-tertiary text-center">Loading...</p></Card>}
      {error && <Card className="p-4"><p className="text-compact text-danger">{String(error)}</p></Card>}

      {!isLoading && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-compact">
              <thead>
                <tr className="bg-surface-elevated">
                  <th className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">Role</th>
                  <th className="hidden sm:table-cell px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">Email</th>
                  <th className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">Invite link</th>
                  <th className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">Expires</th>
                  <th className="hidden md:table-cell px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider">Created</th>
                  <th className="px-4 py-3 text-left text-caption font-medium text-content-tertiary uppercase tracking-wider"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {invites.map(inv => {
                  const role = inv.role as Role
                  return (
                    <tr key={inv.id} className="hover:bg-surface-card-hover transition-colors">
                      <td className="px-4 py-3">
                        <Badge color={ROLE_BADGE_COLORS[role] ?? 'neutral'}>
                          {ROLE_LABELS[role] || role}
                        </Badge>
                      </td>
                      <td className="hidden sm:table-cell px-4 py-3 text-content-tertiary text-caption">
                        {inv.email || '--'}
                      </td>
                      <td className="px-4 py-3">
                        <CopyableId id={`${window.location.origin}/invite/${inv.code}`} truncate={28} />
                      </td>
                      <td className="px-4 py-3 text-content-secondary text-caption">
                        {inv.expires_at
                          ? formatDistanceToNow(new Date(inv.expires_at), { addSuffix: true })
                          : 'Never'}
                      </td>
                      <td className="hidden md:table-cell px-4 py-3 text-content-tertiary text-caption">
                        {formatDistanceToNow(new Date(inv.created_at), { addSuffix: true })}
                      </td>
                      <td className="px-4 py-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Trash2 size={14} />}
                          onClick={() => setRevokeTarget({ id: inv.id })}
                          className="text-content-tertiary hover:text-danger"
                        />
                      </td>
                    </tr>
                  )
                })}
                {invites.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-content-tertiary text-compact">
                      No pending invitations
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        title="Revoke Invitation"
        description="Are you sure you want to revoke this invitation? The invite link will stop working immediately."
        confirmLabel="Revoke"
        onConfirm={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
        destructive
      />
    </div>
  )
}
