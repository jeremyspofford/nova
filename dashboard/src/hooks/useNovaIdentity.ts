import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore, useCallback } from 'react'
import { getNovaIdentity } from '../api'

const AVATAR_KEY = 'nova-avatar'
const DEFAULT_AVATAR = '/nova-icon.jpg'

/** Cross-component reactive localStorage for the avatar. */
const avatarListeners = new Set<() => void>()
function subscribeAvatar(cb: () => void) {
  avatarListeners.add(cb)
  return () => { avatarListeners.delete(cb) }
}
function getAvatarSnapshot() {
  return localStorage.getItem(AVATAR_KEY) || DEFAULT_AVATAR
}
function notifyAvatar() {
  avatarListeners.forEach(cb => cb())
}

export function useNovaIdentity() {
  const { data } = useQuery({
    queryKey: ['nova-identity'],
    queryFn: getNovaIdentity,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 0,
  })

  const avatarUrl = useSyncExternalStore(subscribeAvatar, getAvatarSnapshot)

  const setAvatar = useCallback((dataUrl: string | null) => {
    if (dataUrl) {
      localStorage.setItem(AVATAR_KEY, dataUrl)
    } else {
      localStorage.removeItem(AVATAR_KEY)
    }
    notifyAvatar()
  }, [])

  return {
    name: data?.name ?? 'Nova',
    greeting: data?.greeting ?? '',
    avatarUrl,
    isDefaultAvatar: avatarUrl === DEFAULT_AVATAR,
    setAvatar,
  }
}
