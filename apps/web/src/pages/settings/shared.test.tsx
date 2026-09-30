import { describe, expect, it } from 'vitest'
import { storedFrom } from './shared'

/**
 * The one reader of a settings write's answer, shared by every section that
 * writes a setting: what core says it stored, or a refusal that says why the
 * write cannot be shown as done — never the value that was sent.
 */
describe('storedFrom', () => {
  it('reads what core stored, and its note', () => {
    expect(storedFrom({ key: 'proactive.digest_at', value: '07:15', note: 'moved' }, 'proactive.digest_at')).toEqual({
      value: '07:15',
      note: 'moved',
    })
    expect(storedFrom({ key: 'decisions.local', value: false }, 'decisions.local', 'boolean').value).toBe(false)
  })

  it('refuses an answer that states no stored value', () => {
    for (const answer of [{}, null, 'ok', { key: 'decisions.local' }]) {
      expect(() => storedFrom(answer, 'decisions.local')).toThrow(
        'the write of decisions.local returned no stored value, so what is stored is unknown — reload the page',
      )
    }
  })

  it('refuses an answer about another setting', () => {
    expect(() => storedFrom({ key: 'decisions.cloud', value: true }, 'decisions.local')).toThrow(
      'the write of decisions.local answered about decisions.cloud instead',
    )
  })

  it('refuses a stored value of another type only where the setting\'s type is given', () => {
    expect(() => storedFrom({ key: 'decisions.local', value: 'true' }, 'decisions.local', 'boolean')).toThrow(
      'the write of decisions.local returned "true", which is not a boolean, so what is stored is unknown — reload the page',
    )
    expect(storedFrom({ key: 'decisions.local', value: 'true' }, 'decisions.local').value).toBe('true')
  })
})
