import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { FilesPage } from './FilesPage'
import type { WorkspaceFileDetail, WorkspaceFileListing } from '../../lib/api'

function listing(overrides: Partial<WorkspaceFileListing> = {}): WorkspaceFileListing {
  return { files: [], total: 0, truncated: false, ...overrides }
}

function detail(overrides: Partial<WorkspaceFileDetail> = {}): WorkspaceFileDetail {
  return {
    path: 'groceries.md',
    size: 20,
    modified: new Date().toISOString(),
    text: '- milk\n- eggs\n',
    binary: false,
    too_large: false,
    ...overrides,
  }
}

function fakeApi(list: WorkspaceFileListing, details: Record<string, WorkspaceFileDetail> = {}) {
  return {
    getWorkspaceFiles: vi.fn(async () => list),
    getWorkspaceFile: vi.fn(async (path: string) => {
      const found = details[path]
      if (!found) throw new Error(`no detail stubbed for ${path}`)
      return found
    }),
  }
}

describe('FilesPage — the list', () => {
  it('shows the EmptyState when the workspace has nothing in it', async () => {
    render(<FilesPage api={fakeApi(listing())} />)
    expect(await screen.findByText(/nothing here yet/i)).toBeDefined()
  })

  it('renders a row per file with its path, size and modified time', async () => {
    render(
      <FilesPage
        api={fakeApi(
          listing({
            files: [{ path: 'lists/groceries.md', size: 42, modified: new Date().toISOString() }],
            total: 1,
          }),
        )}
      />,
    )
    const row = await screen.findByTestId('files-row-lists/groceries.md')
    expect(within(row).getByText('lists/groceries.md')).toBeDefined()
    expect(within(row).getByText(/42 B/)).toBeDefined()
  })

  it('states the truncation rather than silently showing a partial list', async () => {
    render(
      <FilesPage
        api={fakeApi(
          listing({
            files: [{ path: 'a.md', size: 1, modified: new Date().toISOString() }],
            total: 600,
            truncated: true,
          }),
        )}
      />,
    )
    await screen.findByTestId('files-row-a.md')
    expect(screen.getByText(/600/)).toBeDefined()
  })

  it('surfaces a load failure instead of rendering an empty list', async () => {
    const api = {
      getWorkspaceFiles: vi.fn(async () => {
        throw new Error('core is not answering')
      }),
      getWorkspaceFile: vi.fn(),
    }
    render(<FilesPage api={api} />)
    expect(await screen.findByText(/core is not answering/i)).toBeDefined()
  })
})

describe('FilesPage — detail', () => {
  it('opens a file on row click: real path, contents, and a working Download link', async () => {
    const api = fakeApi(
      listing({
        files: [{ path: 'groceries.md', size: 14, modified: new Date().toISOString() }],
        total: 1,
      }),
      { 'groceries.md': detail() },
    )
    render(<FilesPage api={api} />)
    fireEvent.click(await screen.findByTestId('files-row-groceries.md'))

    expect(api.getWorkspaceFile).toHaveBeenCalledWith('groceries.md')
    expect(await screen.findByText(/- milk/)).toBeDefined()
    expect(screen.getByText(/- eggs/)).toBeDefined()
    expect(screen.getByText('groceries.md')).toBeDefined()
    const download = screen.getByTestId('download-file') as HTMLAnchorElement
    expect(download.getAttribute('href')).toBe('/api/v1/workspace/raw?path=groceries.md')
  })

  it('opens directly to a path passed in as initialPath (the Activity link)', async () => {
    const api = fakeApi(listing(), { 'notes.md': detail({ path: 'notes.md', text: 'hi' }) })
    render(<FilesPage api={api} initialPath="notes.md" />)
    expect(await screen.findByText('hi')).toBeDefined()
    expect(api.getWorkspaceFile).toHaveBeenCalledWith('notes.md')
  })

  it('shows the stated reason instead of contents for a binary file', async () => {
    const api = fakeApi(
      listing({ files: [{ path: 'photo.png', size: 4096, modified: new Date().toISOString() }] }),
      { 'photo.png': detail({ path: 'photo.png', text: null, binary: true, size: 4096 }) },
    )
    render(<FilesPage api={api} />)
    fireEvent.click(await screen.findByTestId('files-row-photo.png'))
    expect(await screen.findByText(/4096 bytes/)).toBeDefined()
    expect(screen.getByText(/not shown/i)).toBeDefined()
    expect(screen.getByText(/download to view/i)).toBeDefined()
  })

  it('shows the stated reason instead of contents for a too-large file', async () => {
    const api = fakeApi(
      listing({ files: [{ path: 'big.md', size: 500000, modified: new Date().toISOString() }] }),
      { 'big.md': detail({ path: 'big.md', text: null, too_large: true, size: 500000 }) },
    )
    render(<FilesPage api={api} />)
    fireEvent.click(await screen.findByTestId('files-row-big.md'))
    expect(await screen.findByText(/500000 bytes/)).toBeDefined()
    expect(screen.getByText(/too large/i)).toBeDefined()
  })

  it('returns to the list without re-fetching it', async () => {
    const api = fakeApi(
      listing({ files: [{ path: 'a.md', size: 1, modified: new Date().toISOString() }], total: 1 }),
      { 'a.md': detail({ path: 'a.md' }) },
    )
    render(<FilesPage api={api} />)
    fireEvent.click(await screen.findByTestId('files-row-a.md'))
    await screen.findByTestId('download-file')

    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(await screen.findByTestId('files-row-a.md')).toBeDefined()
    expect(api.getWorkspaceFiles).toHaveBeenCalledTimes(1)
  })

  it('surfaces a detail load failure instead of hanging on the Skeleton', async () => {
    const api = {
      getWorkspaceFiles: vi.fn(async () => listing({ files: [{ path: 'a.md', size: 1, modified: 'x' }] })),
      getWorkspaceFile: vi.fn(async () => {
        throw new Error('gone missing between listing and open')
      }),
    }
    render(<FilesPage api={api} />)
    fireEvent.click(await screen.findByTestId('files-row-a.md'))
    expect(await screen.findByText(/gone missing between listing and open/i)).toBeDefined()
  })
})
