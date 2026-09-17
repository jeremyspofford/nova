import { describe, it, expect } from 'vitest'
import type { AgentSummary } from './api'
import { completeMention, mentionMatches, mentionQuery } from './mentions'

const AGENTS: AgentSummary[] = [
  { name: 'coder', purpose: 'writes and fixes code', role: 'agent_coder' },
  { name: 'mailer', purpose: 'drafts email', role: 'agent_mailer' },
  { name: 'cook', purpose: 'plans meals', role: 'agent_cook' },
]

describe('mentionQuery — the leading-@ token, the isSlashQuery discipline', () => {
  it('returns the token after a leading @; a bare @ is the empty query', () => {
    expect(mentionQuery('@cod')).toBe('cod')
    expect(mentionQuery('@coder')).toBe('coder')
    expect(mentionQuery('@')).toBe('')
  })

  it('tolerates leading whitespace, like the slash menu', () => {
    expect(mentionQuery('  @co')).toBe('co')
  })

  it('stands down the moment whitespace follows the token — the owner has moved on to the message', () => {
    expect(mentionQuery('@coder hi')).toBeNull()
    expect(mentionQuery('@coder ')).toBeNull()
    expect(mentionQuery('@coder\nfix it')).toBeNull()
  })

  it('never triggers on a mid-text @, an ordinary message, or a slash command', () => {
    expect(mentionQuery('mail @coder')).toBeNull()
    expect(mentionQuery('hello')).toBeNull()
    expect(mentionQuery('')).toBeNull()
    expect(mentionQuery('/clear')).toBeNull()
    expect(mentionQuery('a@b')).toBeNull()
  })
})

describe('mentionMatches', () => {
  it('offers the agents whose name starts with the query, case-insensitively on the typed side', () => {
    expect(mentionMatches('co', AGENTS).map(a => a.name)).toEqual(['coder', 'cook'])
    expect(mentionMatches('Co', AGENTS).map(a => a.name)).toEqual(['coder', 'cook'])
    expect(mentionMatches('m', AGENTS).map(a => a.name)).toEqual(['mailer'])
    expect(mentionMatches('zzz', AGENTS)).toEqual([])
  })

  it('a bare @ offers every agent', () => {
    expect(mentionMatches('', AGENTS)).toHaveLength(3)
  })

  it('offers nothing without a query, and nothing without a roster — a failed read is a menu that never opens', () => {
    expect(mentionMatches(null, AGENTS)).toEqual([])
    expect(mentionMatches('co', null)).toEqual([])
  })
})

describe('completeMention', () => {
  it('is the mention plus the space that closes the token', () => {
    expect(completeMention('coder')).toBe('@coder ')
    expect(mentionQuery(completeMention('coder'))).toBeNull()
  })
})
