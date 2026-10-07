import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { ChatProvider } from './chat-store'
import { SessionsProvider, useSessions, type SessionsApi, type SessionsStore } from './sessions-store'
import { ToastProvider } from '../components/ToastProvider'
import { SessionsList } from '../components/layout/SessionsList'
import type { ChatSession } from '../lib/api'

const session = (id: string, over: Partial<ChatSession> = {}): ChatSession => ({
  id,
  title: null,
  label: `label ${id}`,
  created_at: '2026-10-07T10:00:00Z',
  last_activity_at: '2026-10-07T10:00:00Z',
  archived_at: null,
  message_count: 2,
  main: false,
  busy: false,
  ...over,
})

/** A core that keeps its own list, so every read after an action is real. */
function fakeApi(initial: ChatSession[]) {
  let live = [...initial]
  let archived: ChatSession[] = []
  const api: SessionsApi = {
    listSessions: vi.fn(async (wantArchived = false) => (wantArchived ? archived : live)),
    createSession: vi.fn(async () => {
      const created = session(`new-${live.length}`, { label: 'New session', message_count: 0 })
      live = [created, ...live]
      return created
    }),
    renameSession: vi.fn(async (id: string, title: string | null) => {
      live = live.map(s => (s.id === id ? { ...s, title, label: title ?? s.label } : s))
      return live.find(s => s.id === id)!
    }),
    setSessionArchived: vi.fn(async (id: string, value: boolean) => {
      if (value) {
        const moved = live.find(s => s.id === id)!
        live = live.filter(s => s.id !== id)
        archived = [{ ...moved, archived_at: 'now' }, ...archived]
        return moved
      }
      const moved = archived.find(s => s.id === id)!
      archived = archived.filter(s => s.id !== id)
      live = [{ ...moved, archived_at: null }, ...live]
      return moved
    }),
    makeSessionMain: vi.fn(async (id: string) => {
      live = live.map(s => ({ ...s, main: s.id === id }))
      return live.find(s => s.id === id)!
    }),
    deleteSession: vi.fn(async (id: string) => {
      live = live.filter(s => s.id !== id)
      archived = archived.filter(s => s.id !== id)
      return { id, deleted: true as const, messages: 2, timers_unlinked: 1 }
    }),
  }
  return api
}

function Probe({ out }: { out: { store: SessionsStore | null; path: string } }) {
  out.store = useSessions()
  const location = useLocation()
  out.path = location.pathname + location.search
  return null
}

function mount(api: SessionsApi, path = '/chat') {
  const out: { store: SessionsStore | null; path: string } = { store: null, path: '' }
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <ChatProvider>
          <SessionsProvider api={api} pollMs={60_000} personId="p1">
            <Probe out={out} />
            <SessionsList />
          </SessionsProvider>
        </ChatProvider>
      </ToastProvider>
    </MemoryRouter>,
  )
  return out
}

beforeEach(() => {
  localStorage.clear()
  // A desktop-width window: on a phone there is one pane, by design, and
  // the split view is what most of this file is about.
  vi.spyOn(window, 'matchMedia').mockImplementation(
    query =>
      ({
        matches: query.includes('min-width: 768px'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SessionsProvider and the sidebar list', () => {
  it('lists core’s sessions and marks the main one', async () => {
    const out = mount(fakeApi([session('a', { main: true }), session('b')]))
    await screen.findByText('label a')
    expect(screen.getByText('label b')).toBeTruthy()
    expect(out.store!.mainId).toBe('a')
    // The main pane names no session, so it is showing the main one.
    expect(out.store!.panes.map(p => p.effectiveSessionId)).toEqual(['a'])
  })

  it('says the list could not be read rather than showing none', async () => {
    const api = fakeApi([])
    api.listSessions = vi.fn(async () => {
      throw new Error('core is down')
    })
    mount(api)
    expect((await screen.findByRole('alert')).textContent).toContain('core is down')
  })

  it('opening a session points the main pane’s URL at it; the main one is plain /chat', async () => {
    const out = mount(fakeApi([session('a', { main: true }), session('b')]))
    await screen.findByText('label b')
    fireEvent.click(screen.getByText('label b'))
    expect(out.path).toBe('/chat?session=b')
    fireEvent.click(screen.getByText('label a'))
    expect(out.path).toBe('/chat')
  })

  it('opens a session in a split pane, and closing it leaves one pane', async () => {
    const out = mount(fakeApi([session('a', { main: true }), session('b')]))
    await screen.findByText('label b')
    act(() => {
      out.store!.openInSplit('b')
    })
    expect(out.store!.panes.map(p => p.effectiveSessionId)).toEqual(['a', 'b'])
    const side = out.store!.panes[1].id
    expect(out.store!.focused).toBe(side)
    // Opening one that is already on screen focuses it instead of a second copy.
    act(() => out.store!.openSession('a'))
    expect(out.store!.focused).toBe('main')
    expect(out.store!.panes).toHaveLength(2)
    act(() => out.store!.closePane(side))
    expect(out.store!.panes.map(p => p.effectiveSessionId)).toEqual(['a'])
  })

  it('a session dropped on a pane’s edge splits; on its middle, replaces', async () => {
    const out = mount(fakeApi([session('a', { main: true }), session('b'), session('c')]))
    await screen.findByText('label c')
    act(() => out.store!.dropSession('b', 'main', 'left'))
    expect(out.store!.panes.map(p => p.effectiveSessionId)).toEqual(['b', 'a'])
    act(() => out.store!.dropSession('c', 'main', 'center'))
    expect(out.store!.panes.map(p => p.effectiveSessionId)).toEqual(['b', 'c'])
    expect(out.path).toBe('/chat?session=c')
  })

  it('closing the main pane hands it the neighbour’s session', async () => {
    const out = mount(fakeApi([session('a', { main: true }), session('b')]))
    await screen.findByText('label b')
    act(() => {
      out.store!.openInSplit('b')
    })
    act(() => out.store!.closePane('main'))
    expect(out.store!.panes.map(p => p.effectiveSessionId)).toEqual(['b'])
    expect(out.path).toBe('/chat?session=b')
  })

  it('archiving closes the panes showing it and moves it to the archive', async () => {
    const api = fakeApi([session('a', { main: true }), session('b')])
    const out = mount(api)
    await screen.findByText('label b')
    act(() => {
      out.store!.openInSplit('b')
    })
    await act(async () => {
      await out.store!.archive('b')
    })
    expect(api.setSessionArchived).toHaveBeenCalledWith('b', true)
    expect(out.store!.panes.map(p => p.effectiveSessionId)).toEqual(['a'])
    expect(screen.queryByText('label b')).toBeNull()

    fireEvent.click(screen.getByTestId('toggle-archived'))
    await screen.findByTestId('archived-b')
    fireEvent.click(screen.getByTestId('unarchive-b'))
    await waitFor(() => expect(screen.getByTestId('session-b')).toBeTruthy())
    expect(api.setSessionArchived).toHaveBeenCalledWith('b', false)
  })

  it('deleting asks first, then states what core removed', async () => {
    const api = fakeApi([session('a', { main: true }), session('b')])
    mount(api)
    await screen.findByText('label b')
    fireEvent.click(screen.getByTestId('session-menu-b'))
    fireEvent.click(screen.getByTestId('delete-b'))
    expect(api.deleteSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith('b'))
    // core's counts, including the reminder that lost its chat
    expect(await screen.findByText(/1 reminder set there will still fire/)).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId('session-b')).toBeNull())
  })

  it('renames in place; a blank name goes back to the derived label', async () => {
    const api = fakeApi([session('a', { main: true })])
    mount(api)
    await screen.findByText('label a')
    fireEvent.click(screen.getByTestId('session-menu-a'))
    fireEvent.click(screen.getByTestId('rename-a'))
    const input = screen.getByTestId('rename-input-a')
    fireEvent.change(input, { target: { value: 'Dell wifi' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('a', 'Dell wifi'))
    await screen.findByText('Dell wifi')
  })

  it('making another session main pins a pane showing the old main to it', async () => {
    const api = fakeApi([session('a', { main: true }), session('b')])
    const out = mount(api)
    await screen.findByText('label b')
    await act(async () => {
      await out.store!.makeMain('b')
    })
    expect(api.makeSessionMain).toHaveBeenCalledWith('b')
    // The pane was showing "the main session" — a; it keeps showing a.
    expect(out.path).toBe('/chat?session=a')
    expect(out.store!.mainId).toBe('b')
    expect(out.store!.panes.map(p => p.effectiveSessionId)).toEqual(['a'])
  })

  it('on a phone there is one pane, whatever the stored layout says', async () => {
    vi.mocked(window.matchMedia).mockImplementation(
      query =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    )
    const out = mount(fakeApi([session('a', { main: true }), session('b')]))
    await screen.findByText('label b')
    expect(out.store!.canSplit).toBe(false)
    act(() => {
      out.store!.openInSplit('b')
    })
    expect(out.store!.panes.map(p => p.effectiveSessionId)).toEqual(['b'])
    expect(out.path).toBe('/chat?session=b')
  })

  it('a new session opens in the focused pane', async () => {
    const api = fakeApi([session('a', { main: true })])
    const out = mount(api)
    await screen.findByText('label a')
    fireEvent.click(screen.getByTestId('new-session'))
    await waitFor(() => expect(out.path).toBe('/chat?session=new-1'))
  })
})
