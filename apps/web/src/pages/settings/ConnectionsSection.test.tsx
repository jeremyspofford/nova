import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { ConnectionsSection, type ConnectionsApi } from './ConnectionsSection'
import type { McpPreset, McpServer } from '../../lib/api'

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    name: 'github',
    title: 'GitHub',
    origin: 'https://api.githubcopilot.com',
    protocol: '2026-07-28',
    added_by: 'owner',
    has_token: true,
    header_names: ['X-MCP-Toolsets'],
    tool_count: 2,
    tools: [
      { name: 'actions_list', description: 'List runs' },
      { name: 'get_job_logs', description: 'Read a log' },
    ],
    tools_fetched_at: new Date().toISOString(),
    tools_changed_at: null,
    last_ok_at: new Date(Date.now() - 60_000).toISOString(),
    last_error: null,
    last_error_at: null,
    failing: false,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

const PRESET: McpPreset = {
  id: 'github-ci',
  label: 'GitHub (CI)',
  name: 'github',
  url: 'https://api.githubcopilot.com/mcp/',
  headers: { 'X-MCP-Toolsets': 'actions' },
  token_hint: 'A fine-grained token with Actions: Read.',
}

function fakeApi(overrides: Partial<ConnectionsApi> = {}): ConnectionsApi {
  return {
    listMcpServers: vi.fn(async () => [server()]),
    getMcpPresets: vi.fn(async () => [PRESET]),
    addMcpServer: vi.fn(async () => ({ server: server(), replaced: null, rejected: [], notice: null })),
    testMcpServer: vi.fn(async () => server()),
    removeMcpServer: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('ConnectionsSection', () => {
  it('lists a server by name, origin, protocol and who added it — never a token', async () => {
    render(<ConnectionsSection api={fakeApi({ listMcpServers: vi.fn(async () => [server({ added_by: 'nova' })]) })} />)
    const row = await screen.findByTestId('connection-github')
    expect(within(row).getByText('github')).toBeTruthy()
    expect(within(row).getByText('https://api.githubcopilot.com')).toBeTruthy()
    expect(within(row).getByText('2026-07-28')).toBeTruthy()
    expect(row.textContent).toContain('added by Nova')
    expect(row.textContent).toContain('token saved')
  })

  it('shows a failing server as failing, with its reason', async () => {
    const failing = server({ failing: true, last_error: 'could not reach github', last_error_at: new Date().toISOString() })
    render(<ConnectionsSection api={fakeApi({ listMcpServers: vi.fn(async () => [failing]) })} />)
    const row = await screen.findByTestId('connection-github')
    expect(within(row).getByText('failing')).toBeTruthy()
    expect(row.textContent).toContain('could not reach github')
  })

  it('opens the tool list on demand', async () => {
    render(<ConnectionsSection api={fakeApi()} />)
    fireEvent.click(await screen.findByRole('button', { name: /2 tools/ }))
    expect(within(screen.getByTestId('connection-tools-github')).getByText('get_job_logs')).toBeTruthy()
  })

  it('offers "Connect a server" only once the first load has settled', async () => {
    // The same race PR #89 fixed in ProvidersSection: a button rendered
    // before load() resolves can be clicked (or just looks live) before
    // there is a server list or a preset list behind it. A presets/servers
    // answer held back makes the race certain rather than a timing fluke.
    let release: (value: McpServer[]) => void = () => {}
    const slowServers = vi.fn(
      () =>
        new Promise<McpServer[]>(resolve => {
          release = resolve
        }),
    )
    render(<ConnectionsSection api={fakeApi({ listMcpServers: slowServers })} />)
    await waitFor(() => expect(slowServers).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Connect a server' })).toBeNull()
    release([server()])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect a server' })).toBeTruthy())
  })

  it('fills the form from the GitHub preset and sends the token as a password field', async () => {
    const api = fakeApi()
    render(<ConnectionsSection api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a server' }))
    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: 'github-ci' } })
    expect((screen.getByLabelText('MCP endpoint URL') as HTMLInputElement).value).toBe(
      'https://api.githubcopilot.com/mcp/',
    )
    const token = screen.getByLabelText('Token') as HTMLInputElement
    expect(token.type).toBe('password')
    fireEvent.change(token, { target: { value: 'ghp_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() =>
      expect(api.addMcpServer).toHaveBeenCalledWith({
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        token: 'ghp_x',
        headers: { 'X-MCP-Toolsets': 'actions' },
      }),
    )
  })

  it('says why a server was not saved', async () => {
    const api = fakeApi({
      addMcpServer: vi.fn(async () => {
        throw new Error('github was not connected: could not reach github. Nothing was saved.')
      }),
    })
    render(<ConnectionsSection api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a server' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'github' } })
    fireEvent.change(screen.getByLabelText('MCP endpoint URL'), { target: { value: 'https://x.invalid/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText(/Nothing was saved/)).toBeTruthy()
  })

  it('shows the rejected tools after a save, with "and N more" when the server bounded the list', async () => {
    // Task 9 carry: POST /servers returns at most 20 rejected tools plus
    // rejected_more when more were left out. The form is where the owner
    // finds out a server was only partly usable, so it must say so.
    const api = fakeApi({
      addMcpServer: vi.fn(async () => ({
        server: server(),
        replaced: null,
        rejected: [
          { name: 'bad_tool_1', reason: 'no description' },
          { name: 'bad_tool_2', reason: 'args schema is not an object' },
        ],
        rejected_more: 5,
        notice: null,
      })),
    })
    render(<ConnectionsSection api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a server' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'github' } })
    fireEvent.change(screen.getByLabelText('MCP endpoint URL'), { target: { value: 'https://x.invalid/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('bad_tool_1')).toBeTruthy()
    expect(screen.getByText('bad_tool_2')).toBeTruthy()
    expect(screen.getByText(/and 5 more/)).toBeTruthy()
  })

  it('removes a server only after the confirm', async () => {
    const api = fakeApi()
    render(<ConnectionsSection api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: /remove github/i }))
    expect(api.removeMcpServer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.removeMcpServer).toHaveBeenCalledWith('github'))
  })
})
