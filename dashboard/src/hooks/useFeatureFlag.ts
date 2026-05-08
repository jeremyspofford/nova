import { useQuery } from '@tanstack/react-query'
import { getPublicFlags } from '../api'

/**
 * Read a server-declared feature flag from the browser.
 *
 * Backed by a single cached fetch of all public flags (TanStack Query,
 * staleTime: 30s, retry: 1, refetchOnWindowFocus: true). Returns the
 * caller's `defaultValue` while loading, on error, or when the key is
 * missing from the public allowlist server-side.
 *
 * Type-narrow the return: pass a literal `defaultValue` to lock T to
 * the union of expected variants.
 */
export function useFeatureFlag<T>(key: string, defaultValue: T): T {
  const { data } = useQuery({
    queryKey: ['feature-flags', 'public'],
    queryFn: getPublicFlags,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: true,
  })
  if (!data || !(key in data)) return defaultValue
  return data[key] as T
}
