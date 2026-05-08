// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useFeatureFlag } from './useFeatureFlag'
import type { ReactNode } from 'react'

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useFeatureFlag', () => {
  it('returns the default value while fetching', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise(() => {})  // never resolves
    )
    const { result } = renderHook(
      () => useFeatureFlag('ui.surface_preset', 'chat_only'),
      { wrapper: makeWrapper() },
    )
    expect(result.current).toBe('chat_only')
  })

  it('returns the server value once fetched', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ 'ui.surface_preset': 'advanced' }), {
        status: 200,
      }),
    )
    const { result } = renderHook(
      () => useFeatureFlag('ui.surface_preset', 'chat_only'),
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(result.current).toBe('advanced'))
  })

  it('returns the default when the endpoint errors', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('boom', { status: 500 }),
    )
    const { result } = renderHook(
      () => useFeatureFlag('ui.surface_preset', 'chat_only'),
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(result.current).toBe('chat_only'))
  })

  it('returns the default when the key is missing from the response', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    const { result } = renderHook(
      () => useFeatureFlag('ui.surface_preset', 'chat_only'),
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(result.current).toBe('chat_only'))
  })
})
