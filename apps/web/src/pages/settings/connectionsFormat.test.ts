import { describe, it, expect } from 'vitest'
import { addedByLabel, headersFromRows, statusLine } from './connectionsFormat'
import type { McpServer } from '../../lib/api'

const NOW = new Date('2026-09-30T12:00:00Z')

function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    name: 'github',
    title: 'GitHub',
    origin: 'https://api.githubcopilot.com',
    protocol: '2026-07-28',
    added_by: 'owner',
    has_token: true,
    header_names: [],
    tool_count: 0,
    tools: [],
    tools_fetched_at: null,
    tools_changed_at: null,
    last_ok_at: null,
    last_error: null,
    last_error_at: null,
    failing: false,
    created_at: null,
    ...overrides,
  }
}

describe('connectionsFormat', () => {
  it('names who added a server in the owner\'s words', () => {
    expect(addedByLabel(server())).toBe('added by you')
    expect(addedByLabel(server({ added_by: 'nova' }))).toBe('added by Nova')
  })

  it('says a failure newer than the last success, with its reason', () => {
    const failing = server({ failing: true, last_error: 'could not reach github', last_error_at: '2026-09-30T11:00:00Z' })
    expect(statusLine(failing, NOW)).toBe('last call failed 1h ago: could not reach github')
    expect(statusLine(server({ last_ok_at: '2026-09-30T11:59:00Z' }), NOW)).toBe('answered 1m ago')
    expect(statusLine(server(), NOW)).toBe('not called yet')
  })

  it('turns the form\'s header rows into the object the route takes', () => {
    expect(headersFromRows([{ name: ' X-MCP-Toolsets ', value: 'actions' }, { name: '', value: 'dropped' }])).toEqual({
      'X-MCP-Toolsets': 'actions',
    })
  })
})
