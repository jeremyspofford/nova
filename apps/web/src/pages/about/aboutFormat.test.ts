import { describe, it, expect, expectTypeOf } from 'vitest'
import { remoteState } from './aboutFormat'
import type { About, AboutRemoteModelMachine } from '../../lib/api'

function remote(over: Partial<AboutRemoteModelMachine> = {}): AboutRemoteModelMachine {
  return {
    name: 'dell',
    host: '100.122.40.93',
    state: 'answering',
    reason: '16 models listed',
    walled_for_s: null,
    answering: true,
    models: 16,
    device: 'DELL-XPS-8950',
    device_said: 'runs on paired device DELL-XPS-8950',
    ...over,
  }
}

describe('T5 C1: the payload type', () => {
  it('AboutRemoteModelMachine carries exactly the nine fields core sends', () => {
    expectTypeOf<keyof AboutRemoteModelMachine>().toEqualTypeOf<
      'name' | 'host' | 'state' | 'reason' | 'walled_for_s' | 'answering' | 'models' | 'device' | 'device_said'
    >()
    expectTypeOf<AboutRemoteModelMachine['state']>().toEqualTypeOf<'answering' | 'failing' | 'walled' | 'unknown'>()
    expectTypeOf<AboutRemoteModelMachine['host']>().toEqualTypeOf<string | null>()
    expectTypeOf<AboutRemoteModelMachine['walled_for_s']>().toEqualTypeOf<number | null>()
    expectTypeOf<AboutRemoteModelMachine['device_said']>().toEqualTypeOf<string>()
  })

  it('every one of the nine fields has the type core sends', () => {
    expectTypeOf<AboutRemoteModelMachine>().toEqualTypeOf<{
      name: string
      host: string | null
      state: 'answering' | 'failing' | 'walled' | 'unknown'
      reason: string
      walled_for_s: number | null
      answering: boolean | null
      models: number | null
      device: string | null
      device_said: string
    }>()
  })

  it("About['model_machines'] carries remotes and remotes_reason beside machines and reason", () => {
    expectTypeOf<About['model_machines']['remotes']>().toEqualTypeOf<AboutRemoteModelMachine[] | null>()
    expectTypeOf<About['model_machines']['remotes_reason']>().toEqualTypeOf<string | null>()
  })
})

describe('T5 C2: answering, failing, unknown', () => {
  it.each([
    ['answering', 'Answering', 'success'],
    ['failing', 'Failing', 'danger'],
    ['unknown', 'Unknown', 'neutral'],
  ] as const)('%s -> %s / %s', (state, text, color) => {
    expect(remoteState(remote({ state }))).toEqual({ text, color })
  })
})

describe('T5 C3: walled says the floored minutes left', () => {
  it.each([
    [60, 'Walled for 1 min'],
    [119, 'Walled for 1 min'],
    [120, 'Walled for 2 min'],
    [3600, 'Walled for 60 min'],
    [0, 'Walled for <1 min'],
    [59, 'Walled for <1 min'],
  ])('walled_for_s %s -> %s / warning', (walled_for_s, text) => {
    expect(remoteState(remote({ state: 'walled', walled_for_s, answering: false }))).toEqual({ text, color: 'warning' })
  })

  it('a wall with no time left known says only "Walled"', () => {
    expect(remoteState(remote({ state: 'walled', walled_for_s: null, answering: false }))).toEqual({
      text: 'Walled',
      color: 'warning',
    })
  })
})

describe('T5 C4: never success unless state is answering', () => {
  it.each(['failing', 'walled', 'unknown', 'ready', 'Answering', ''])(
    'state %j with answering=true is not drawn as answering',
    state => {
      const r = remote({ state: state as AboutRemoteModelMachine['state'], answering: true, walled_for_s: 300 })
      const badge = remoteState(r)
      expect(badge.color).not.toBe('success')
      expect(badge.text).not.toBe('Answering')
    },
  )

  it('answering=false does not demote a state the gateway says is answering', () => {
    expect(remoteState(remote({ state: 'answering', answering: false }))).toEqual({ text: 'Answering', color: 'success' })
  })
})

describe('T5 C5: an unrecognised state degrades to Unknown', () => {
  it.each(['ready', 'on_fire', 'ANSWERING', ''])('state %j -> Unknown / neutral, no throw', state => {
    const r = remote({ state: state as AboutRemoteModelMachine['state'] })
    expect(() => remoteState(r)).not.toThrow()
    expect(remoteState(r)).toEqual({ text: 'Unknown', color: 'neutral' })
  })
})
