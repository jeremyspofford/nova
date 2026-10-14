import { describe, it, expect } from 'vitest'
import {
  statusBadge,
  viewArgs,
  formatMs,
  formatRelativeTime,
  formatTimeUntil,
  workspacePathFrom,
  isWorkspacePathTool,
  mcpCallLabel,
  viewFacts,
  spanLabel,
} from './activityFormat'

describe('statusBadge', () => {
  it('maps a NULL status to unfinished, neutral, pulsing — never coerced to ok/error', () => {
    expect(statusBadge(null)).toEqual({ label: 'unfinished', color: 'neutral', pulse: true })
  })

  it('maps ok to success', () => {
    expect(statusBadge('ok')).toEqual({ label: 'ok', color: 'success', pulse: false })
  })

  it('maps error to danger', () => {
    expect(statusBadge('error')).toEqual({ label: 'error', color: 'danger', pulse: false })
  })

  it('maps interrupted to warning', () => {
    expect(statusBadge('interrupted')).toEqual({ label: 'interrupted', color: 'warning', pulse: false })
  })

  it('shows an unrecognised status verbatim rather than mislabeling it unfinished', () => {
    // Defensive only — the backend's CHECK constraint means this can never
    // really happen, but a real value must never be relabeled as an
    // absence just because this client has not seen it before.
    expect(statusBadge('mystery')).toEqual({ label: 'mystery', color: 'neutral', pulse: false })
  })
})

describe('viewArgs — the polymorphic args_redacted quirk', () => {
  it('renders the object shape as compact key:value lines', () => {
    expect(viewArgs({ path: 'a.md', content: 'hi' })).toEqual({
      kind: 'kv',
      lines: ['path: a.md', 'content: hi'],
    })
  })

  it('renders a nested value with JSON.stringify, not [object Object]', () => {
    expect(viewArgs({ query: { nested: true } })).toEqual({
      kind: 'kv',
      lines: ['query: {"nested":true}'],
    })
  })

  it('renders the clipped-string shape verbatim, in mono, not parsed', () => {
    const clipped = 'xxx… (+4800 more chars, 5000 total)'
    expect(viewArgs(clipped)).toEqual({ kind: 'raw', text: clipped })
  })

  it('renders an empty object as an explicit empty record, not a blank list', () => {
    expect(viewArgs({})).toEqual({ kind: 'raw', text: '{}' })
  })

  it('renders absent args as absent, never as an empty object', () => {
    expect(viewArgs(undefined)).toEqual({ kind: 'none' })
  })

  it('falls back to raw JSON for a shape the contract does not promise', () => {
    expect(viewArgs(42)).toEqual({ kind: 'raw', text: '42' })
    expect(viewArgs(null)).toEqual({ kind: 'raw', text: 'null' })
  })
})

describe('formatMs — never a fake zero', () => {
  it('renders null as null, not 0ms', () => {
    expect(formatMs(null)).toBeNull()
  })

  it('renders sub-second durations in ms', () => {
    expect(formatMs(0)).toBe('0ms')
    expect(formatMs(482)).toBe('482ms')
  })

  it('renders second-plus durations in seconds', () => {
    expect(formatMs(1000)).toBe('1s')
    expect(formatMs(1500)).toBe('1.5s')
    expect(formatMs(12300)).toBe('12.3s')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-08-28T12:00:00Z')

  it('says just now for anything under 5 seconds old', () => {
    expect(formatRelativeTime('2026-08-28T11:59:58Z', now)).toBe('just now')
  })

  it('counts seconds, then minutes, then hours, then days', () => {
    expect(formatRelativeTime('2026-08-28T11:59:30Z', now)).toBe('30s ago')
    expect(formatRelativeTime('2026-08-28T11:55:00Z', now)).toBe('5m ago')
    expect(formatRelativeTime('2026-08-28T09:00:00Z', now)).toBe('3h ago')
    expect(formatRelativeTime('2026-08-26T12:00:00Z', now)).toBe('2d ago')
  })

  it('falls back to a calendar date once it is more than a week old', () => {
    expect(formatRelativeTime('2026-08-01T12:00:00Z', now)).not.toMatch(/ago$/)
  })

  it('a stamp ahead of the browser clock still reads "just now": its callers show past events, and skew is not the future (epic wall-probe T10)', () => {
    expect(formatRelativeTime('2026-08-28T12:00:10Z', now)).toBe('just now')
    expect(formatRelativeTime('2026-08-28T12:01:00Z', now)).toBe('just now')
    expect(formatRelativeTime('2026-08-28T16:00:00Z', now)).toBe('just now')
    expect(formatRelativeTime('2026-09-20T12:00:00Z', now)).toBe('just now')
  })
})

describe('formatTimeUntil', () => {
  const now = new Date('2026-08-28T12:00:00Z')

  it('counts how far ahead a future time is: seconds, then minutes, then hours, then days', () => {
    expect(formatTimeUntil('2026-08-28T12:00:30Z', now)).toBe('in 30s')
    expect(formatTimeUntil('2026-08-28T12:05:00Z', now)).toBe('in 5m')
    expect(formatTimeUntil('2026-08-28T16:00:00Z', now)).toBe('in 4h')
    expect(formatTimeUntil('2026-08-30T12:00:00Z', now)).toBe('in 2d')
  })

  it('says "now" for a time under 5 seconds ahead or already past, never "ago"', () => {
    expect(formatTimeUntil('2026-08-28T12:00:03Z', now)).toBe('now')
    expect(formatTimeUntil('2026-08-28T12:00:00Z', now)).toBe('now')
    expect(formatTimeUntil('2026-08-28T11:00:00Z', now)).toBe('now')
  })
})

describe('isWorkspacePathTool', () => {
  it('names the two workspace tools whose args carry a linkable path', () => {
    expect(isWorkspacePathTool('workspace_write_file')).toBe(true)
    expect(isWorkspacePathTool('workspace_read_file')).toBe(true)
  })

  it('excludes workspace_list_files and every other tool', () => {
    expect(isWorkspacePathTool('workspace_list_files')).toBe(false)
    expect(isWorkspacePathTool('get_time')).toBe(false)
    expect(isWorkspacePathTool(null)).toBe(false)
  })
})

describe('workspacePathFrom — the same polymorphic args_redacted quirk', () => {
  it('extracts path from the object shape', () => {
    expect(workspacePathFrom({ path: 'a.md', content: 'hi' })).toBe('a.md')
  })

  it('returns null for the clipped-string shape — nothing to parse a path out of', () => {
    expect(workspacePathFrom('xxx… (+4800 more chars, 5000 total)')).toBeNull()
  })

  it('returns null when the object has no path field', () => {
    expect(workspacePathFrom({ content: 'hi' })).toBeNull()
  })

  it('returns null for an empty or non-string path', () => {
    expect(workspacePathFrom({ path: '' })).toBeNull()
    expect(workspacePathFrom({ path: 42 })).toBeNull()
  })

  it('returns null for undefined/null args', () => {
    expect(workspacePathFrom(undefined)).toBeNull()
    expect(workspacePathFrom(null)).toBeNull()
  })
})

describe('mcpCallLabel', () => {
  it('names the server and the tool of an mcp_call span', () => {
    expect(mcpCallLabel('mcp_call', { server: 'github', tool: 'get_job_logs', arguments: {} })).toBe('github · get_job_logs')
  })
  it('is null for any other span, or clipped arguments', () => {
    expect(mcpCallLabel('fetch_url', { server: 'x', tool: 'y' })).toBeNull()
    expect(mcpCallLabel('mcp_call', '{"server": "github", …')).toBeNull()
  })
})

// S29 T8: a tool span's meta.facts — the list chat._run_tool lifts from the
// call's facts sink (services/core/app/chat.py, span.meta["facts"]). Shapes
// from services/core/app/tools/devices.py: a run fact {run: {exit_code,
// device, argv, cwd}, target: argv joined}, a file fact {file: {op, device},
// target: path}, and everything else flat (connectivity {device, connected,
// known_as?}, {outside_worktree, tool}).
describe('viewFacts (S29 T8)', () => {
  it('C1 renders a run fact as its command, exit code, device and cwd', () => {
    expect(
      viewFacts([
        {
          run: { exit_code: 0, device: 'mini-pc', argv: ['python3', '--version'], cwd: '/srv/repo' },
          target: 'python3 --version',
        },
      ]),
    ).toEqual(['run: python3 --version · exit_code 0 · device mini-pc · cwd /srv/repo'])
  })

  it('C1 keeps a nonzero exit, says a missing exit code is none (never 0), and omits a null cwd', () => {
    expect(
      viewFacts([
        { run: { exit_code: 1, device: 'dell', argv: ['pytest'], cwd: null }, target: 'pytest' },
        { run: { exit_code: null, device: 'dell', argv: ['git', 'status'], cwd: null }, target: 'git status' },
      ]),
    ).toEqual(['run: pytest · exit_code 1 · device dell', 'run: git status · exit_code none · device dell'])
  })

  it('C2 renders a file fact as its op, path and device', () => {
    expect(
      viewFacts([
        { file: { op: 'read', device: 'dell' }, target: 'C:\\Users\\j\\README.md' },
        { file: { op: 'write', device: 'mini-pc' }, target: '/srv/repo/notes.md' },
      ]),
    ).toEqual(['file read: C:\\Users\\j\\README.md · device dell', 'file write: /srv/repo/notes.md · device mini-pc'])
  })

  it('C3 renders any other fact as key: value pairs, non-strings as JSON', () => {
    expect(
      viewFacts([
        { device: 'dell', connected: true, known_as: ['DESKTOP-1'] },
        { outside_worktree: '/home/j/workspace/nova', tool: 'device_run' },
      ]),
    ).toEqual([
      'device: dell · connected: true · known_as: ["DESKTOP-1"]',
      'outside_worktree: /home/j/workspace/nova · tool: device_run',
    ])
  })

  it('C3 keeps order: a device_run span\'s connectivity fact, then its run fact', () => {
    expect(
      viewFacts([
        { device: 'mini-pc', connected: true },
        { run: { exit_code: 0, device: 'mini-pc', argv: ['ls'], cwd: null }, target: 'ls' },
      ]),
    ).toEqual(['device: mini-pc · connected: true', 'run: ls · exit_code 0 · device mini-pc'])
  })

  it('C4 an unknown shape never throws and is shown verbatim, never dropped; absent or empty renders nothing', () => {
    expect(viewFacts(undefined)).toEqual([])
    expect(viewFacts(null)).toEqual([])
    expect(viewFacts([])).toEqual([])
    expect(viewFacts('clipped')).toEqual(['"clipped"'])
    expect(viewFacts({ device: 'dell' })).toEqual(['{"device":"dell"}'])
    expect(viewFacts([null, 3, 'x', ['a']])).toEqual(['null', '3', '"x"', '["a"]'])
  })

  it('C1 a run fact with no exit_code key at all says none, never 0 or undefined', () => {
    expect(viewFacts([{ run: { device: 'dell', argv: ['ls'] }, target: 'ls' }])).toEqual([
      'run: ls · exit_code none · device dell',
    ])
  })

  it('C4 a run or file key holding an array is not a run/file fact either', () => {
    expect(viewFacts([{ run: ['pytest'], target: 'pytest' }, { file: [], target: 'a.md' }])).toEqual([
      'run: ["pytest"] · target: pytest',
      'file: [] · target: a.md',
    ])
  })

  it('C4 a run or file key that is not an object falls back to key: value', () => {
    expect(viewFacts([{ run: 'x', target: 'y' }, { file: null, target: 'z' }])).toEqual([
      'run: x · target: y',
      'file: null · target: z',
    ])
  })
})

// T20 (verification 2-7): span kinds read as words, not llm_call / guard.
describe('spanLabel — T20 span kinds read as words', () => {
  // Every span kind services/core/app writes to turn_spans at b33570d9
  // (turn.span("<kind>", ...) in chat.py, beats.py, scheduler.py,
  // decisions.py, live_facts.py; wake.py BACKGROUND_WAKE_SPAN).
  const CORE_KINDS = [
    'llm_call', 'tool', 'guard', 'memory_recall', 'memory_ingest', 'agent_names',
    'round_retry', 'round_stop', 'agent_cap', 'agent_roster', 'skills_roster',
    'mcp_roster', 'model_swap', 'decisions', 'job', 'beat', 'urgent', 'checks',
    'distil', 'background_wake',
  ]

  it('C3 llm_call reads "Model call", whatever the span is named', () => {
    expect(spanLabel('llm_call', null)).toBe('Model call')
    expect(spanLabel('llm_call', 'openrouter:google/gemini-3.8-flash')).toBe('Model call')
  })

  it('C3 a guard reads "Guard: <its name in words>"', () => {
    expect(spanLabel('guard', 'delegation_claim')).toBe('Guard: delegation claim')
    expect(spanLabel('guard', 'narration')).toBe('Guard: narration')
    expect(spanLabel('guard', 'own_tool_handback')).toBe('Guard: own tool handback')
  })

  it('C3 a guard with no name reads "Guard", never "Guard: " or "Guard: null"', () => {
    expect(spanLabel('guard', null)).toBe('Guard')
    expect(spanLabel('guard', '')).toBe('Guard')
  })

  it('C4 every kind core writes reads as words: not the raw key, no underscore, capitalised', () => {
    for (const kind of CORE_KINDS) {
      const label = spanLabel(kind, null)
      expect(label, kind).not.toBe(kind)
      expect(label, kind).not.toMatch(/_/)
      expect(label.charAt(0), kind).toBe(label.charAt(0).toUpperCase())
      expect(label.trim().length, kind).toBeGreaterThan(0)
    }
  })

  it('C4 an unknown kind falls back to sentence-cased words, never empty, never thrown on', () => {
    expect(spanLabel('future_thing', null)).toBe('Future thing')
    expect(spanLabel('frobnicate', 'x')).toBe('Frobnicate')
    expect(() => spanLabel('', null)).not.toThrow()
  })
})
