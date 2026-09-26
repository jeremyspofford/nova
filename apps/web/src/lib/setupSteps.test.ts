import { describe, it, expect } from 'vitest'
import { formatCode, installSteps, parseCodeFragment, setupLink } from './setupSteps'

const ADDRESS = 'https://nova.fake-tailnet.ts.net'

describe('parseCodeFragment (Review Focus 2)', () => {
  it.each([
    ['#ABCD-2345', 'ABCD-2345'],
    ['#abcd2345', 'ABCD-2345'],
    ['#ABCD-2345?x=1', 'ABCD-2345'],
    ['#code=ABCD2345', 'ABCD-2345'],
    ['#', null],
    ['', null],
    ['#garbage', null],
    ['#A1B2-C3D4', null],
    ['#%E0%A4%A', null],
  ])('%s -> %s', (hash, want) => {
    expect(parseCodeFragment(hash)).toBe(want)
  })
})

describe('setupLink', () => {
  it('puts a machine code in the fragment, dashed, and nowhere else', () => {
    expect(setupLink('add_machine', ADDRESS, 'abcd2345')).toBe(`${ADDRESS}/add#ABCD-2345`)
    expect(setupLink('add_model_server', ADDRESS, 'ABCD-2345')).toBe(`${ADDRESS}/add#ABCD-2345`)
    expect(setupLink('install_pwa', `${ADDRESS}/`, 'ABCD2345')).toBe(`${ADDRESS}/install`)
    expect(setupLink('get_app', ADDRESS)).toBe(`${ADDRESS}/app`)
  })
  it('formats a code the way it is read aloud', () => {
    expect(formatCode('abcd2345')).toBe('ABCD-2345')
    expect(formatCode('ABCD 2345')).toBe('ABCD-2345')
  })
})

describe('installSteps', () => {
  it('gives one list for a known platform and every list for an unknown one', () => {
    expect(installSteps({ os: 'ios', browser: 'safari', phone: true }).map(s => s.label)).toEqual([
      'iPhone or iPad, Safari',
    ])
    expect(installSteps({ os: 'windows', browser: 'firefox', phone: false })[0].label).toBe(
      'Windows, Firefox',
    )
    expect(installSteps({ os: 'unknown', browser: 'other', phone: false }).length).toBeGreaterThan(5)
  })
  it('cites where each named browser\'s wording was checked', () => {
    for (const list of installSteps({ os: 'unknown', browser: 'other', phone: false })) {
      if (list.label.endsWith('another browser')) continue
      expect(list.steps[0].source).toMatch(/^https:\/\//)
    }
  })
  it('sends Samsung Internet and Firefox on Android to the shared "Android, another browser" steps', () => {
    const other = installSteps({ os: 'android', browser: 'other', phone: true })
    expect(installSteps({ os: 'android', browser: 'samsung', phone: true })).toEqual(other)
    expect(installSteps({ os: 'android', browser: 'firefox', phone: true })).toEqual(other)
  })
})
