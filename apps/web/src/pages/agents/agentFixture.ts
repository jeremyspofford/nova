import type { Agent } from '../../lib/api'

/**
 * A full `Agent` row for tests — the shape GET /api/v1/agents returns, with
 * every derived field present and idle/empty by default. Shared by the
 * agents pages' tests and by any test whose fake `listAgents` must answer
 * the full row (the `@` menu's, the Routing page's), so widening the API
 * type never means re-typing the row in each file.
 */
export function agentFixture(overrides: Partial<Agent> = {}): Agent {
  const name = overrides.name ?? 'coder'
  return {
    id: `id-${name}`,
    name,
    purpose: 'writes and reviews code in the workspace',
    instructions: 'Work only under your folder. Report what you changed.',
    tools: ['workspace_read_file', 'workspace_write_file'],
    skills: [],
    unknown_tools: [],
    monthly_cap_usd: null,
    max_tool_rounds: 8,
    read_shared_memory: false,
    role: `agent_${name}`,
    folder: `agents/${name}/`,
    log_conversation_id: null,
    created_via: 'page',
    created_at: '2026-09-08T09:00:00Z',
    updated_at: '2026-09-08T09:00:00Z',
    bound_timers: [],
    spent_month_usd: 0,
    spend_note: null,
    last_active: null,
    state: { working: false, doing: null, since: null, turn_id: null },
    ...overrides,
  }
}
