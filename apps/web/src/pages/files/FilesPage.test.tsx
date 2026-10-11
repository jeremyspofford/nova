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
    expect(await screen.findByText('milk')).toBeDefined()
    expect(screen.getByText('eggs')).toBeDefined()
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
      listing({ files: [{ path: 'blob.bin', size: 4096, modified: new Date().toISOString() }] }),
      { 'blob.bin': detail({ path: 'blob.bin', text: null, binary: true, size: 4096 }) },
    )
    render(<FilesPage api={api} />)
    fireEvent.click(await screen.findByTestId('files-row-blob.bin'))
    expect(await screen.findByText(/4096 bytes/)).toBeDefined()
    expect(screen.getByText(/not shown/i)).toBeDefined()
    expect(screen.getByText(/download to view/i)).toBeDefined()
  })

  it('shows the stated reason instead of contents for a too-large file', async () => {
    const api = fakeApi(
      listing({ files: [{ path: 'big.txt', size: 500000, modified: new Date().toISOString() }] }),
      { 'big.txt': detail({ path: 'big.txt', text: null, too_large: true, size: 500000 }) },
    )
    render(<FilesPage api={api} />)
    fireEvent.click(await screen.findByTestId('files-row-big.txt'))
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

describe('FilesPage — previews', () => {
  function open(path: string, d: Partial<WorkspaceFileDetail>) {
    const api = fakeApi(listing(), { [path]: detail({ path, ...d }) })
    render(<FilesPage api={api} initialPath={path} />)
  }

  it('renders markdown, not its syntax', async () => {
    open('notes.md', { text: '# Plan\n\nSome **bold** words\n' })
    const heading = await screen.findByRole('heading', { name: 'Plan' })
    expect(heading.tagName).toBe('H1')
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.queryByText(/# Plan/)).toBeNull()
  })

  it('switches a markdown file to its source and back', async () => {
    open('notes.md', { text: '# Plan\n' })
    await screen.findByRole('heading', { name: 'Plan' })
    fireEvent.click(screen.getByRole('button', { name: /source/i }))
    expect(screen.getByText('# Plan')).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Plan' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /rendered/i }))
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeDefined()
  })

  it('a markdown file too large to preview still says so', async () => {
    open('big.md', { text: null, too_large: true, size: 500000 })
    expect(await screen.findByText(/500000 bytes/)).toBeDefined()
  })

  it('displays an image from the inline raw URL, even though it is binary', async () => {
    open('pics/photo.png', { text: null, binary: true, size: 4096 })
    const img = (await screen.findByRole('img', { name: 'pics/photo.png' })) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/v1/workspace/raw?path=pics%2Fphoto.png&inline=1')
    expect(screen.queryByText(/not shown/i)).toBeNull()
  })

  it('displays an image too large for the text preview', async () => {
    open('huge.jpg', { text: null, too_large: true, size: 5_000_000 })
    expect(await screen.findByRole('img', { name: 'huge.jpg' })).toBeDefined()
  })

  it('shows an SVG as an image, not as its markup', async () => {
    open('chart.svg', { text: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    expect(await screen.findByRole('img', { name: 'chart.svg' })).toBeDefined()
    expect(screen.queryByText(/<svg/)).toBeNull()
  })

  it('displays a PDF in the browser viewer, with a link to open it full-screen', async () => {
    open('report.pdf', { text: null, binary: true, size: 90000 })
    const frame = await screen.findByTitle('report.pdf')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('/api/v1/workspace/raw?path=report.pdf&inline=1')
    const openLink = screen.getByTestId('open-file') as HTMLAnchorElement
    expect(openLink.getAttribute('href')).toBe('/api/v1/workspace/raw?path=report.pdf&inline=1')
    expect(openLink.getAttribute('target')).toBe('_blank')
  })

  it('says plainly that a Word document cannot be previewed', async () => {
    open('letter.docx', { text: null, binary: true, size: 12000 })
    expect(await screen.findByText(/word documents can.t be previewed/i)).toBeDefined()
    expect(screen.getByTestId('download-file')).toBeDefined()
  })

  it('highlights a code file by its extension, never as markdown', async () => {
    open('main.py', { text: '# not a heading\ndef f():\n    return 1\n' })
    const comment = await screen.findByText('# not a heading')
    expect(comment.className).toContain('hljs-comment')
    expect(screen.getByText('def').className).toContain('hljs-keyword')
    expect(screen.queryByRole('heading', { name: /not a heading/ })).toBeNull()
  })

  it('loads a grammar chat does not ship, then highlights', async () => {
    open('lib.rs', { text: 'fn main() {}\n' })
    const kw = await screen.findByText('fn')
    expect(kw.className).toContain('hljs-keyword')
  })

  it('a highlighted file never renders its contents as markup', async () => {
    open('page.html', { text: '<script>alert(1)</script><b>x</b>' })
    expect((await screen.findAllByText('script')).length).toBe(2)
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
  })

  it('leaves plain text unhighlighted', async () => {
    open('notes.txt', { text: 'def plain words\n' })
    const el = await screen.findByText(/def plain words/)
    expect(el.querySelector('.hljs-keyword')).toBeNull()
  })

  it('highlights markdown source as markdown', async () => {
    open('notes.md', { text: '# Plan\n' })
    await screen.findByRole('heading', { name: 'Plan' })
    fireEvent.click(screen.getByRole('button', { name: /source/i }))
    expect(screen.getByText('# Plan').className).toContain('hljs-section')
  })
})

describe('FilesPage — the open file is the page', () => {
  it("titles the page with the file's own name, not \"Files\"", async () => {
    const api = fakeApi(listing(), { 'cookbook/soup.md': detail({ path: 'cookbook/soup.md', text: 'hi' }) })
    render(<FilesPage api={api} initialPath="cookbook/soup.md" />)
    expect(await screen.findByRole('heading', { level: 1, name: 'soup.md' })).toBeDefined()
  })

  it('names the folder and size beside the back control', async () => {
    const api = fakeApi(listing(), { 'cookbook/soup.md': detail({ path: 'cookbook/soup.md', text: 'hi', size: 20 }) })
    render(<FilesPage api={api} initialPath="cookbook/soup.md" />)
    const meta = await screen.findByTestId('file-meta')
    expect(meta.textContent).toContain('cookbook')
    expect(meta.textContent).toContain('20 B')
  })
})

