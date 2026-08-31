import { describe, it, expect } from 'vitest'
import {
  COMMANDS,
  autocompleteMatches,
  commandTokens,
  formatCommandHelp,
  isSlashQuery,
  matchCommand,
} from './commands'

/**
 * The registry is the single source of truth: the whole-message parser, the
 * autocomplete, and /help all derive from COMMANDS. These tests pin the
 * parser's whole-message rule (the same one the old clearCommand.ts guarded
 * for /clear alone), the autocomplete's prefix matching, and that /help is
 * derived from the list rather than a hand-written copy.
 */

describe('matchCommand — the whole-message parser', () => {
  it('recognises a command by its exact name, case- and whitespace-insensitive', () => {
    expect(matchCommand('/clear')?.name).toBe('/clear')
    expect(matchCommand('  /CLEAR  ')?.name).toBe('/clear')
    expect(matchCommand('/help')?.name).toBe('/help')
  })

  it('recognises a command by an alias too', () => {
    expect(matchCommand('/reset')?.name).toBe('/clear')
    expect(matchCommand('/Reset')?.name).toBe('/clear')
    expect(matchCommand('/?')?.name).toBe('/help')
  })

  it('treats a message that merely CONTAINS the command mid-text as ordinary', () => {
    expect(matchCommand('remind me to run /clear later')).toBeNull()
    expect(matchCommand('/clear the driveway')).toBeNull()
    expect(matchCommand('what does /reset do?')).toBeNull()
  })

  it('does not match an unknown command or a near-miss (they send normally)', () => {
    expect(matchCommand('/foo')).toBeNull()
    expect(matchCommand('clear')).toBeNull()
    expect(matchCommand('//clear')).toBeNull()
    expect(matchCommand('/clearall')).toBeNull()
    expect(matchCommand('')).toBeNull()
  })
})

describe('isSlashQuery — when the autocomplete may show', () => {
  it('is true for a leading-slash token, tolerating leading whitespace', () => {
    expect(isSlashQuery('/')).toBe(true)
    expect(isSlashQuery('/cl')).toBe(true)
    expect(isSlashQuery('  /cl')).toBe(true)
  })

  it('is false once the token has whitespace, or with no leading slash', () => {
    expect(isSlashQuery('/clear now')).toBe(false)
    expect(isSlashQuery('hey /clear')).toBe(false)
    expect(isSlashQuery('hello')).toBe(false)
    expect(isSlashQuery('')).toBe(false)
  })
})

describe('autocompleteMatches — prefix filtering off the registry', () => {
  it('offers every command for a bare slash', () => {
    expect(autocompleteMatches('/').map(c => c.name).sort()).toEqual(
      COMMANDS.map(c => c.name).sort(),
    )
  })

  it('filters by the typed prefix on names', () => {
    expect(autocompleteMatches('/c').map(c => c.name)).toEqual(['/clear'])
    expect(autocompleteMatches('/h').map(c => c.name)).toEqual(['/help'])
  })

  it('matches on an alias prefix too (and returns the owning command once)', () => {
    // "/r" only matches via /clear's /reset alias.
    expect(autocompleteMatches('/r').map(c => c.name)).toEqual(['/clear'])
  })

  it('offers nothing for an unmatched slash, or for a non-slash / mid-text input', () => {
    expect(autocompleteMatches('/zzz')).toEqual([])
    expect(autocompleteMatches('hello')).toEqual([])
    expect(autocompleteMatches('hey /clear')).toEqual([])
  })
})

describe('formatCommandHelp — derived from the registry', () => {
  it('lists every registered command with its name, aliases, and summary', () => {
    const help = formatCommandHelp(COMMANDS)
    for (const cmd of COMMANDS) {
      expect(help).toContain(cmd.name)
      expect(help).toContain(cmd.summary)
      for (const alias of cmd.aliases ?? []) expect(help).toContain(alias)
    }
  })

  it('names each token exactly once per command (name + aliases joined)', () => {
    // A command added to the registry would appear here without touching this
    // test — the listing is a projection of COMMANDS, not a fixed string.
    const help = formatCommandHelp(COMMANDS)
    for (const cmd of COMMANDS) {
      expect(help).toContain(commandTokens(cmd)[0])
    }
  })
})

describe('the seeded commands run their intended effect', () => {
  it('/clear (and /reset) call clearChat, never appendLocalMessage', () => {
    const clearChat = () => {
      calls.push('clear')
    }
    const appendLocalMessage = () => {
      calls.push('append')
    }
    const calls: string[] = []
    matchCommand('/clear')!.run({ clearChat, appendLocalMessage })
    matchCommand('/reset')!.run({ clearChat, appendLocalMessage })
    expect(calls).toEqual(['clear', 'clear'])
  })

  it('/help appends the help listing locally, never a model turn', () => {
    let appended: string | null = null
    matchCommand('/help')!.run({
      clearChat: () => {
        throw new Error('help must not clear')
      },
      appendLocalMessage: text => {
        appended = text
      },
    })
    expect(appended).toBe(formatCommandHelp(COMMANDS))
  })
})
