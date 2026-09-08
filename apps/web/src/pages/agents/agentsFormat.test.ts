import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '../../lib/api'
import {
  agentRole,
  capWords,
  deleteDescription,
  deletedSummary,
  logPairs,
  spendWords,
  statePill,
} from './agentsFormat'

describe('statePill — the server-derived state, never a stored flag', () => {
  it('idle is idle, no pulse', () => {
    expect(statePill({ working: false, doing: null, since: null, turn_id: null })).toEqual({
      label: 'idle',
      color: 'neutral',
      pulse: false,
    })
  })

  it('working says what it is doing and pulses', () => {
    expect(
      statePill({ working: true, doing: 'writing haiku.md', since: '2026-09-08T10:00:00Z', turn_id: 't1' }),
    ).toEqual({ label: 'working · writing haiku.md', color: 'accent', pulse: true })
  })

  it('working with no word for it is still working', () => {
    expect(statePill({ working: true, doing: null, since: null, turn_id: 't1' }).label).toBe('working')
  })
})

describe('spendWords — money is money, unknown is unknown', () => {
  it('a figure is money, and a real 0 is $0.00', () => {
    expect(spendWords(1.5, null)).toEqual({ text: '$1.50', unreadable: false, title: undefined })
    expect(spendWords(0, null).text).toBe('$0.00')
  })

  it('a null figure is unreadable with the server\'s reason as the title — never 0', () => {
    const words = spendWords(null, 'ledger unreadable — the gateway is not answering')
    expect(words.text).toBe('spend unreadable')
    expect(words.unreadable).toBe(true)
    expect(words.title).toBe('ledger unreadable — the gateway is not answering')
    expect(words.text).not.toContain('0')
  })
})

describe('capWords', () => {
  it('names the cap per month or says uncapped', () => {
    expect(capWords(null)).toBe('uncapped')
    expect(capWords(5)).toBe('$5.00 / month')
  })
})

describe('deleteDescription — derived from the bound timers', () => {
  it('names each timer a delete will pause', () => {
    expect(
      deleteDescription('coder', [
        { id: 'a', title: 'nightly review' },
        { id: 'b', title: 'weekly digest' },
      ]),
    ).toBe(
      'Delete coder? This will pause 2 scheduled timers: nightly review, weekly digest. Its folder, notes and log stay.',
    )
  })

  it('singular for one timer', () => {
    expect(deleteDescription('coder', [{ id: 'a', title: 'nightly review' }])).toBe(
      'Delete coder? This will pause 1 scheduled timer: nightly review. Its folder, notes and log stay.',
    )
  })

  it('says plainly when nothing is bound', () => {
    expect(deleteDescription('coder', [])).toBe(
      'Delete coder? No timers are bound to it. Its folder, notes and log stay.',
    )
  })
})

describe('deletedSummary — the server\'s structured answer, in one line', () => {
  const remains = 'its folder agents/coder/, its memory notes and its log conversation were left in place'

  it('lists what was paused and what remains', () => {
    expect(
      deletedSummary({
        deleted: 'coder',
        paused_timers: [
          { id: 'a', title: 'nightly review', already_paused: null },
          { id: 'b', title: 'weekly digest', already_paused: 'paused from the Schedules page' },
        ],
        route: { registered: true, detail: 'route agent_coder removed' },
        remains,
        text: 'deleted agent coder — …',
      }),
    ).toBe(`Deleted coder — paused 2 timers (nightly review, weekly digest); ${remains}.`)
  })

  it('never says "paused 0 timers"', () => {
    const line = deletedSummary({
      deleted: 'coder',
      paused_timers: [],
      route: { registered: true, detail: 'route agent_coder removed' },
      remains,
      text: '',
    })
    expect(line).toBe(`Deleted coder — no timers were bound to it; ${remains}.`)
    expect(line).not.toContain('0 timers')
  })
})

describe('logPairs — briefs and the reports that answer them', () => {
  const row = (id: string, role: string, content: string): StoredMessage => ({
    id,
    role,
    content,
    created_at: '2026-09-08T10:00:00Z',
  })

  it('a user row opens a pair; assistant rows attach to it, in order', () => {
    const pairs = logPairs([
      row('1', 'user', 'write a haiku'),
      row('2', 'assistant', 'done: haiku.md'),
      row('3', 'user', 'review it'),
      row('4', 'assistant', 'reviewed'),
      row('5', 'assistant', 'and one more note'),
    ])
    expect(pairs.map(p => [p.brief?.id, p.reports.map(r => r.id)])).toEqual([
      ['1', ['2']],
      ['3', ['4', '5']],
    ])
  })

  it('a brief with no report yet keeps an empty reports list — visible as such', () => {
    const pairs = logPairs([row('1', 'user', 'write a haiku')])
    expect(pairs).toEqual([{ brief: pairs[0].brief, reports: [] }])
    expect(pairs[0].reports).toEqual([])
  })

  it('a report with no brief before it is shown, not dropped', () => {
    const pairs = logPairs([row('9', 'assistant', 'orphan')])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].brief).toBeNull()
    expect(pairs[0].reports[0].content).toBe('orphan')
  })

  it('an empty log is an empty list', () => {
    expect(logPairs([])).toEqual([])
  })
})

describe('agentRole', () => {
  it('shows only an agent\'s derived role, never a built-in or an absence', () => {
    expect(agentRole('agent_coder')).toBe('agent_coder')
    expect(agentRole('chat')).toBeNull()
    expect(agentRole(null)).toBeNull()
    expect(agentRole(undefined)).toBeNull()
  })
})
