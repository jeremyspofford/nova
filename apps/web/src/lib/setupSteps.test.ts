import { describe, it, expect } from 'vitest'
import { defaultOs, fillCode, formatCode, installSteps, OS_KEYS, parseCodeFragment, setupLink } from './setupSteps'

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
    expect(installSteps({ os: 'android', browser: 'samsung', phone: true }).map(s => s.label)).toEqual([
      'Android, another browser',
    ])
    expect(installSteps({ os: 'android', browser: 'firefox', phone: true }).map(s => s.label)).toEqual([
      'Android, another browser',
    ])
  })
})

describe('the one-liners (S42b P18)', () => {
  it('fills the code slot core left, dashed, and nothing else', () => {
    expect(fillCode('curl … && "$d/novad" install --hub https://x --code {CODE}', 'abcd2345')).toBe(
      'curl … && "$d/novad" install --hub https://x --code ABCD-2345',
    )
    expect(fillCode('no slot here', 'ABCD2345')).toBe('no slot here')
  })
  it('opens on the OS that was asked for, else the one this browser runs, else Linux', () => {
    expect(OS_KEYS).toEqual(['linux', 'macos', 'windows'])
    expect(defaultOs({ os: 'linux', browser: 'chrome', phone: false }, 'wsl')).toBe('windows')
    expect(defaultOs({ os: 'mac', browser: 'safari', phone: false })).toBe('macos')
    expect(defaultOs({ os: 'windows', browser: 'edge', phone: false })).toBe('windows')
    expect(defaultOs({ os: 'ios', browser: 'safari', phone: true })).toBe('linux')
  })
})

describe('fillCode — never fills anything but a canonical pairing code (S42b D3)', () => {
  const LINE = 'install --code {CODE}'

  it('refuses a value carrying shell injection, whatever shape it takes', () => {
    expect(fillCode(LINE, 'ABCD-2345"; rm -rf ~; "')).toBe(LINE)
    expect(fillCode(LINE, 'ABCD2345$(rm -rf ~)')).toBe(LINE)
    expect(fillCode(LINE, 'ABCD2345`rm -rf ~`')).toBe(LINE)
    expect(fillCode(LINE, 'ABCD2345\nrm -rf ~')).toBe(LINE)
    for (const bad of [
      'ABCD-2345"; rm -rf ~; "',
      'ABCD2345$(rm -rf ~)',
      'ABCD2345`rm -rf ~`',
      'ABCD2345\nrm -rf ~',
    ]) {
      expect(fillCode(LINE, bad)).not.toContain('rm')
      expect(fillCode(LINE, bad)).not.toContain('$(')
      expect(fillCode(LINE, bad)).not.toContain('`')
    }
  })

  it('a lower-case code with no dash is filled in its canonical form', () => {
    expect(fillCode(LINE, 'abcd2345')).toBe('install --code ABCD-2345')
  })

  it('a real code from each source (the /add fragment, already dashed; the mint response, undashed) fills all three OS lines', () => {
    const commands = {
      linux: 'L --code {CODE}',
      macos: 'M --code {CODE}',
      windows: 'W --code {CODE}',
    }
    for (const code of ['ABCD-2345', 'K7PQ9XYZ']) {
      const dashed = code.includes('-') ? code : `${code.slice(0, 4)}-${code.slice(4)}`
      expect(fillCode(commands.linux, code)).toBe(`L --code ${dashed}`)
      expect(fillCode(commands.macos, code)).toBe(`M --code ${dashed}`)
      expect(fillCode(commands.windows, code)).toBe(`W --code ${dashed}`)
    }
  })
})
