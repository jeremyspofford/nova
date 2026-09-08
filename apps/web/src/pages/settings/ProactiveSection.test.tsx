import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  ProactiveSection,
  ENABLED_KEY,
  DIGEST_AT_KEY,
  MAX_NOTICES_KEY,
  type ProactiveApi,
} from './ProactiveSection'
import type { SettingWritten } from '../../lib/api'

/**
 * Settings → Proactive, through the same dependency-injection seam the other
 * sections use. The point of nearly every test here is the same one: what the
 * section shows is what CORE said it stored, and a refusal is core's own
 * sentence — never a message composed in the browser, and never the value the
 * operator typed.
 *
 * The harness is deliberately stateful: it feeds `onChanged`'s value straight
 * back in as the prop, exactly as SettingsPage does. A section that only
 * looked right because it kept its own optimistic copy would fail here.
 */
const CORE_REFUSES_HOUR =
  "setting proactive.digest_at: it is the local time of day her digest is written — " +
  "day needs \"at\" as HH:MM (24-hour), got '24:00'"

const CORE_REFUSES_ZERO =
  'setting proactive.max_notices_per_day: at least one notice has to fit in a digest, got 0 — ' +
  'a digest that may carry none would tell him nothing, and would look like a quiet day'

const RETIMED =
  'the digest beat now fires 2026-09-09 07:15 America/New_York (every day at 07:15)'

/** A fake core: it stores what it is given and echoes what it stored. */
function fakeApi(
  overrides: {
    refuse?: (key: string, value: unknown) => string | null
    note?: (key: string, value: unknown) => string | undefined
    /** Stores something OTHER than what was sent — the page must show this. */
    stores?: (key: string, value: unknown) => unknown
  } = {},
): ProactiveApi & { putSetting: ReturnType<typeof vi.fn> } {
  return {
    putSetting: vi.fn(async (key: string, value: boolean | string | number) => {
      const refusal = overrides.refuse?.(key, value)
      if (refusal) throw new Error(refusal)
      const stored = overrides.stores ? overrides.stores(key, value) : value
      const written: SettingWritten = { key, value: stored }
      const note = overrides.note?.(key, value)
      return note === undefined ? written : { ...written, note }
    }),
  }
}

function Harness({
  api,
  enabled = false,
  digestAt = '08:00',
  maxNoticesPerDay = 20,
}: {
  api: ProactiveApi
  enabled?: boolean
  digestAt?: string
  maxNoticesPerDay?: number
}) {
  const [values, setValues] = useState({ enabled, digestAt, maxNoticesPerDay })
  return (
    <ProactiveSection
      enabled={values.enabled}
      digestAt={values.digestAt}
      maxNoticesPerDay={values.maxNoticesPerDay}
      api={api}
      onChanged={(key, value) =>
        setValues(prev => ({
          ...prev,
          ...(key === ENABLED_KEY ? { enabled: value === true } : {}),
          ...(key === DIGEST_AT_KEY ? { digestAt: String(value) } : {}),
          ...(key === MAX_NOTICES_KEY ? { maxNoticesPerDay: Number(value) } : {}),
        }))
      }
    />
  )
}

const switchEl = () => screen.getByRole('switch') as HTMLInputElement
const hourField = () => screen.getByLabelText('Daily digest at') as HTMLInputElement
const capField = () => screen.getByLabelText('Most findings in one digest') as HTMLInputElement

describe('ProactiveSection — the switch', () => {
  it('renders the stored values and says the engine is off while it is', () => {
    render(<Harness api={fakeApi()} enabled={false} digestAt="08:00" maxNoticesPerDay={20} />)

    expect(switchEl().checked).toBe(false)
    expect(hourField().value).toBe('08:00')
    expect(capField().value).toBe('20')
    expect(screen.getByTestId('proactive-off')).toBeDefined()
    // The two other settings stay editable while it is off: you configure it,
    // then switch it on.
    expect(hourField().disabled).toBe(false)
    expect(capField().disabled).toBe(false)
  })

  it('states what turning it on means before it is turned on', () => {
    render(<Harness api={fakeApi()} />)
    const meaning = screen.getByTestId('proactive-meaning').textContent ?? ''
    expect(meaning).toContain('every hour')
    expect(meaning).toContain('tells you afterwards')
    expect(meaning).toContain('one digest a day')
    expect(meaning).toContain('stack being down')
  })

  it('writes proactive.enabled and re-renders from the answer', async () => {
    const api = fakeApi()
    render(<Harness api={api} enabled={false} />)

    fireEvent.click(switchEl())

    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith(ENABLED_KEY, true))
    await waitFor(() => expect(switchEl().checked).toBe(true))
    expect(screen.queryByTestId('proactive-off')).toBeNull()
  })

  it('shows what core stored, not what was clicked', async () => {
    // Core answers that it stored `false` — the switch must follow the answer.
    const api = fakeApi({ stores: () => false })
    render(<Harness api={api} enabled={false} />)

    fireEvent.click(switchEl())

    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith(ENABLED_KEY, true))
    await waitFor(() => expect(switchEl().checked).toBe(false))
    expect(screen.getByTestId('proactive-off')).toBeDefined()
  })

  it('leaves the switch where it was when the write is refused, and says why', async () => {
    const api = fakeApi({ refuse: () => 'could not reach Nova — connection refused' })
    render(<Harness api={api} enabled={false} />)

    fireEvent.click(switchEl())

    await waitFor(() =>
      expect(screen.getByTestId('proactive-enabled-error').textContent).toContain(
        'could not reach Nova — connection refused',
      ),
    )
    expect(switchEl().checked).toBe(false)
  })

  it('refuses to call a write done when the answer does not say what was stored', async () => {
    // A response with no stored value is not a success: the section says so
    // rather than rendering the value it just typed.
    const api = { putSetting: vi.fn(async () => ({}) as unknown as SettingWritten) }
    render(<Harness api={api} enabled={false} />)

    fireEvent.click(switchEl())

    await waitFor(() =>
      expect(screen.getByTestId('proactive-enabled-error').textContent).toContain(
        'returned no stored value',
      ),
    )
    expect(switchEl().checked).toBe(false)
  })
})

describe('ProactiveSection — the digest hour', () => {
  it('saves the hour and shows core\'s note about where the beat landed', async () => {
    const api = fakeApi({ note: key => (key === DIGEST_AT_KEY ? RETIMED : undefined) })
    render(<Harness api={api} enabled digestAt="08:00" />)

    fireEvent.change(hourField(), { target: { value: '07:15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith(DIGEST_AT_KEY, '07:15'))
    await waitFor(() => expect(screen.getByTestId('proactive-digest-note').textContent).toBe(RETIMED))
    expect(hourField().value).toBe('07:15')
  })

  it('re-renders the hour core stored, not the one that was typed', async () => {
    const api = fakeApi({ stores: (key, value) => (key === DIGEST_AT_KEY ? '07:00' : value) })
    render(<Harness api={api} enabled digestAt="08:00" />)

    fireEvent.change(hourField(), { target: { value: '07:15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(hourField().value).toBe('07:00'))
  })

  it('shows a refusal in core\'s own words and keeps what was typed', async () => {
    const api = fakeApi({ refuse: key => (key === DIGEST_AT_KEY ? CORE_REFUSES_HOUR : null) })
    render(<Harness api={api} enabled digestAt="08:00" />)

    fireEvent.change(hourField(), { target: { value: '24:00' } })
    const typed = hourField().value
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      // Verbatim — core's sentence, not a generic "invalid".
      expect(screen.getByTestId('proactive-digest-error').textContent).toContain(CORE_REFUSES_HOUR),
    )
    expect(api.putSetting).toHaveBeenCalledWith(DIGEST_AT_KEY, typed)
    // The field is still the operator's, so it can be corrected.
    expect(hourField().value).toBe(typed)
    expect(screen.queryByTestId('proactive-digest-note')).toBeNull()
  })

  it('is editable while the engine is off', async () => {
    const api = fakeApi()
    render(<Harness api={api} enabled={false} digestAt="08:00" />)

    fireEvent.change(hourField(), { target: { value: '06:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith(DIGEST_AT_KEY, '06:30'))
    await waitFor(() => expect(hourField().value).toBe('06:30'))
    // Still off — configuring it is not switching it on.
    expect(switchEl().checked).toBe(false)
    expect(screen.getByTestId('proactive-off')).toBeDefined()
  })
})

describe('ProactiveSection — the daily cap', () => {
  it('says what happens to what does not fit', () => {
    render(<Harness api={fakeApi()} enabled />)
    const words = screen.getByTestId('proactive-overflow').textContent ?? ''
    expect(words).toContain('not dropped')
    expect(words).toContain('next day')
  })

  it('saves the number and renders what core stored', async () => {
    const api = fakeApi()
    render(<Harness api={api} enabled maxNoticesPerDay={20} />)

    fireEvent.change(capField(), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // Sent as a number: core's registry types this key int, and a string
    // would be refused by type before its own validator ever ran.
    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith(MAX_NOTICES_KEY, 5))
    await waitFor(() => expect(capField().value).toBe('5'))
  })

  it('refuses nothing itself — a value core would reject is still sent, and core\'s words are shown', async () => {
    const api = fakeApi({ refuse: (key, value) => (value === 0 ? CORE_REFUSES_ZERO : null) })
    render(<Harness api={api} enabled maxNoticesPerDay={20} />)

    fireEvent.change(capField(), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The write HAPPENED: there is one validator, and it is core.
    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith(MAX_NOTICES_KEY, 0))
    await waitFor(() =>
      expect(screen.getByTestId('proactive-max-error').textContent).toContain(CORE_REFUSES_ZERO),
    )
    expect(capField().value).toBe('0')
  })

  it('sends an unparseable entry as typed rather than deciding for core', async () => {
    const api = fakeApi({
      refuse: (key, value) =>
        typeof value === 'string'
          ? `setting ${key} expects int, got str: ${JSON.stringify(value)}`
          : null,
    })
    render(<Harness api={api} enabled maxNoticesPerDay={20} />)

    fireEvent.change(capField(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith(MAX_NOTICES_KEY, ''))
    await waitFor(() =>
      expect(screen.getByTestId('proactive-max-error').textContent).toContain('expects int, got str'),
    )
  })
})

describe('ProactiveSection — where the rest of it lives', () => {
  it('links to the inbox and to the schedules the beats run on', () => {
    render(<Harness api={fakeApi()} enabled />)

    const inbox = screen.getByTestId('proactive-inbox-link')
    expect(inbox.querySelector('a')?.getAttribute('href')).toBe('/inbox')
    expect(inbox.textContent).toContain('what she has noticed')

    const schedules = screen.getByTestId('proactive-schedules-link')
    expect(schedules.querySelector('a')?.getAttribute('href')).toBe('/schedules')
    expect(schedules.textContent).toContain('pause or retime')
  })
})
