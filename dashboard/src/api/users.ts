import { apiFetch } from '../api'

export interface UserListItem {
  id: string
  email: string
  display_name: string | null
  avatar_url: string | null
  role: string
  status: string
  expires_at: string | null
  created_at: string
  updated_at: string
  tenant_id: string
}

export interface InviteItem {
  id: string
  code: string
  email: string | null
  role: string
  account_expires_in_hours: number | null
  expires_at: string | null
  created_at: string
}

export interface InviteCreateRequest {
  role: string
  email?: string
  // null = the invite link never expires (always sent explicitly — an
  // omitted field used to silently become a 72h server default)
  expires_in_hours: number | null
  account_expires_in_hours?: number
}

export async function fetchUsers(): Promise<UserListItem[]> {
  return apiFetch<UserListItem[]>('/api/v1/admin/users')
}

export async function updateUser(
  userId: string,
  data: { role?: string; status?: string; expires_at?: string | null; display_name?: string; email?: string },
): Promise<UserListItem> {
  return apiFetch<UserListItem>(`/api/v1/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deactivateUser(userId: string): Promise<void> {
  await updateUser(userId, { status: 'deactivated' })
}

export async function reactivateUser(userId: string): Promise<void> {
  await updateUser(userId, { status: 'active' })
}

/** Hard delete — permanent. Conversations go with the user; tasks and audit
 * history are kept without attribution. */
export async function deleteUser(userId: string): Promise<void> {
  await apiFetch(`/api/v1/admin/users/${userId}`, { method: 'DELETE' })
}

export async function createInvite(data: InviteCreateRequest): Promise<InviteItem> {
  return apiFetch<InviteItem>('/api/v1/auth/invites', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function fetchInvites(): Promise<InviteItem[]> {
  return apiFetch<InviteItem[]>('/api/v1/auth/invites')
}

export async function revokeInvite(inviteId: string): Promise<void> {
  await apiFetch(`/api/v1/auth/invites/${inviteId}`, { method: 'DELETE' })
}
