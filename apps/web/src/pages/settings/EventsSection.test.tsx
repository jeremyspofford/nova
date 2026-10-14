import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { EventsSection, CI_REPOS_KEY, type EventsApi } from './EventsSection'
import { senderTitle, sentWords } from './eventsFormat'
import type { EventSender, SettingDef } from '../../lib/api'

/**
 * Settings → Events (S37c T9, spec §2.1/§2.8): the programs that can start
 * her look. The owner said on 2026-10-13 that Schedules, Inbox and Activity
 * are hard for a person to read, so most of what is pinned here is what this
 * page SAYS: a sender by its name, "last sent 5 minutes ago", plain on/off —
 * and never a role key, a kind, an id, JSON or a raw timestamp. The key is
 * shown once, with a copy button and a plain warning, and nothing on the page
 * can show it again.
 */

const NOW = new Date('2026-10-14T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString()

function sender(over: Partial<EventSender> = {}): EventSender {
  return {
    name: 'backups',
    kind: 'token',
    role: 'event_backups',
    enabled: true,
    last_sent_at: minutesAgo(5),
    added_by: 'owner',
    created_at: '2026-10-13T09:00:00+00:00',
    token_waiting: false,
    ...over,
  }
}

const MONITOR = sender({ name: 'monitor', kind: 'monitor', role: 'event_monitor', last_sent_at: null, added_by: null })
const GITHUB_CI = sender({ name: 'github_ci', kind: 'poll', role: 'event_github_ci', last_sent_at: minutesAgo(180), added_by: null })
const KEY = 'k3y_THE_ONLY_COPY_9f8e7d'

const REPOS_DEF: SettingDef = {
  key: CI_REPOS_KEY,
  type: 'str',
  default: '',
  description: 'GitHub repos whose CI she watches',
  value: 'jeremyspofford/nova',
}

function fakeApi(over: Partial<EventsApi> = {}): EventsApi & Record<keyof EventsApi, ReturnType<typeof vi.fn>> {
  return {
    listEventSenders: vi.fn(async () => [GITHUB_CI, MONITOR, sender()]),
    addEventSender: vi.fn(async (name: string) => ({
      ...sender({ name, last_sent_at: null }),
      token: KEY,
      route: { registered: true, detail: `route event_${name} registered` },
    })),
    revealEventSenderToken: vi.fn(async (name: string) => ({ name, token: KEY })),
    setEventSenderEnabled: vi.fn(async (name: string, enabled: boolean) => sender({ name, enabled })),
    deleteEventSender: vi.fn(async (name: string) => ({
      deleted: name,
      failed_events: 0,
      route: { registered: true, detail: `route event_${name} removed` },
    })),
    putSetting: vi.fn(async (key: string, value: boolean | string | number) => ({ key, value })),
    ...over,
  } as never
}

/** Feeds the stored setting back in as the prop, as SettingsPage does. */
function Harness({ api, repos = REPOS_DEF }: { api: EventsApi; repos?: SettingDef | null }) {
  const [def, setDef] = useState<SettingDef | null>(repos)
  return (
    <EventsSection
      api={api}
      ciRepos={def}
      onSettingChanged={(key, value) => setDef(prev => (prev && prev.key === key ? { ...prev, value } : prev))}
      now={() => NOW}
    />
  )
}

const rowOf = (name: string) => screen.findByTestId(`event-sender-${name}`)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('eventsFormat', () => {
  it('says when a sender last sent in plain words', () => {
    expect(sentWords(null, NOW)).toBe('has not sent anything yet')
    expect(sentWords(minutesAgo(0), NOW)).toBe('last sent just now')
    expect(sentWords(minutesAgo(1), NOW)).toBe('last sent 1 minute ago')
    expect(sentWords(minutesAgo(5), NOW)).toBe('last sent 5 minutes ago')
    expect(sentWords(minutesAgo(60), NOW)).toBe('last sent 1 hour ago')
    expect(sentWords(minutesAgo(180), NOW)).toBe('last sent 3 hours ago')
    expect(sentWords(minutesAgo(60 * 24 * 2), NOW)).toBe('last sent 2 days ago')
    // Older than a week: the day, never "23 days ago" and never an ISO stamp.
    expect(sentWords('2026-09-01T08:00:00Z', NOW)).toMatch(/^last sent on 1 Sep$/)
    // A value that is not a time is not guessed at.
    expect(sentWords('not a time', NOW)).toBe('last sent at an unreadable time')
  })

  it('names the built-ins in words and a sender of his by its own name', () => {
    expect(senderTitle(MONITOR)).toBe('Monitoring')
    expect(senderTitle(GITHUB_CI)).toBe('GitHub CI')
    expect(senderTitle(sender())).toBe('backups')
  })
})

describe('EventsSection', () => {
  it('lists every sender in plain words — names, when it last sent, on or off — and nothing internal', async () => {
    render(<Harness api={fakeApi()} />)
    const mine = await rowOf('backups')
    expect(within(mine).getByText('backups')).toBeTruthy()
    expect(mine.textContent).toContain('last sent 5 minutes ago')
    expect(mine.textContent).toContain('added by you')
    expect((within(mine).getByRole('switch') as HTMLInputElement).checked).toBe(true)
    expect(mine.textContent).toContain('On')

    const monitor = await rowOf('monitor')
    expect(within(monitor).getByText('Monitoring')).toBeTruthy()
    expect(monitor.textContent).toContain('has not sent anything yet')
    const ci = await rowOf('github_ci')
    expect(within(ci).getByText('GitHub CI')).toBeTruthy()
    expect(ci.textContent).toContain('last sent 3 hours ago')

    const section = screen.getByTestId('events-section')
    const text = section.textContent ?? ''
    // No routing key, no kind, no raw stamp, no JSON, no "token" jargon.
    expect(text).not.toMatch(/event_/)
    expect(text).not.toMatch(/\bpoll\b|\bkind\b/)
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(text).not.toMatch(/[{}[\]]/)
    expect(text).not.toMatch(/token/i)
    expect(text).not.toContain('github_ci')
  })

  it('says each built-in is built in and what it sends, and offers no Delete for one', async () => {
    render(<Harness api={fakeApi()} />)
    const monitor = await rowOf('monitor')
    expect(monitor.textContent).toMatch(/built in/i)
    expect(monitor.textContent).toMatch(/checks/i)
    expect(within(monitor).queryByRole('button', { name: /delete/i })).toBeNull()
    const ci = await rowOf('github_ci')
    expect(ci.textContent).toMatch(/every 5 minutes/)
    expect(within(ci).queryByRole('button', { name: /delete/i })).toBeNull()
    // His own sender can be deleted.
    expect(within(await rowOf('backups')).getByRole('button', { name: 'Delete backups' })).toBeTruthy()
    // No key waits for any of them, so none offers one: not a built-in, not his own.
    for (const name of ['monitor', 'github_ci', 'backups']) {
      const row = await rowOf(name)
      expect(within(row).queryByRole('button', { name: 'Show its key' })).toBeNull()
      expect(row.textContent).not.toContain('Nova made a key for it')
    }
  })

  it('states a list it could not read', async () => {
    render(<Harness api={fakeApi({ listEventSenders: vi.fn(async () => { throw new Error('core refused (500)') }) })} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read the senders: core refused (500)')
  })

  it('adds a sender and shows its key once, with a copy button and a plain warning', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const api = fakeApi()
    render(<Harness api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a sender' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  backups_two ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(api.addEventSender).toHaveBeenCalledWith('backups_two'))

    const panel = await screen.findByTestId('event-key')
    expect(panel.textContent).toContain(KEY)
    expect(panel.textContent).toMatch(/will not be shown again/)
    // How a program sends: the address and the header, in one line to copy.
    expect(panel.textContent).toContain('/api/v1/events/backups_two')
    // The full address on this page's own origin, so the line works as pasted.
    expect(window.location.origin).toMatch(/^https?:\/\/\S+/)
    expect(panel.textContent).toContain(`${window.location.origin}/api/v1/events/backups_two`)
    expect(panel.textContent).toContain(`Authorization: Bearer ${KEY}`)
    fireEvent.click(within(panel).getByRole('button', { name: 'Copy the key' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(KEY))
    expect(await within(panel).findByText('Copied')).toBeTruthy()
    // The list was read again, so the new sender is on it.
    expect(api.listEventSenders).toHaveBeenCalledTimes(2)

    // Once he is done, the key is gone from the page and nothing brings it back.
    fireEvent.click(within(panel).getByRole('button', { name: 'Done, I saved it' }))
    expect(screen.queryByTestId('event-key')).toBeNull()
    expect(document.body.textContent).not.toContain(KEY)
    expect(api.revealEventSenderToken).not.toHaveBeenCalled()
  })

  it('says so when the key could not be copied, and keeps it on the page', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    render(<Harness api={fakeApi()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a sender' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const panel = await screen.findByTestId('event-key')
    fireEvent.click(within(panel).getByRole('button', { name: 'Copy the key' }))
    expect((await within(panel).findByText(/could not copy/i)).textContent).toMatch(/select it and copy it by hand/)
    expect(panel.textContent).toContain(KEY)
  })

  it("shows core's refusal of a name in its own words, and no key", async () => {
    const api = fakeApi({
      addEventSender: vi.fn(async () => {
        throw new Error("sender name 'Bad-Name' must be lowercase letters and underscores")
      }),
    })
    render(<Harness api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a sender' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad-Name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toContain("sender name 'Bad-Name' must be lowercase letters and underscores")
    expect(screen.queryByTestId('event-key')).toBeNull()
  })

  it('shows a key Nova made once, on his click, and states it when it was already shown', async () => {
    const waiting = sender({ name: 'uptime', added_by: 'nova', token_waiting: true })
    const api = fakeApi({ listEventSenders: vi.fn(async () => [waiting]) })
    render(<Harness api={api} />)
    const row = await rowOf('uptime')
    expect(row.textContent).toContain('added by Nova')
    // Nothing is fetched until he asks.
    expect(api.revealEventSenderToken).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByRole('button', { name: 'Show its key' }))
    await waitFor(() => expect(api.revealEventSenderToken).toHaveBeenCalledWith('uptime'))
    const panel = await screen.findByTestId('event-key')
    expect(panel.textContent).toContain(KEY)
    expect(panel.textContent).toMatch(/will not be shown again/)

    const gone = fakeApi({
      listEventSenders: vi.fn(async () => [waiting]),
      revealEventSenderToken: vi.fn(async () => {
        throw new Error("no token waits for 'uptime': it was shown once already, or never kept")
      }),
    })
    document.body.innerHTML = ''
    render(<Harness api={gone} />)
    fireEvent.click(within(await rowOf('uptime')).getByRole('button', { name: 'Show its key' }))
    expect((await screen.findByRole('alert')).textContent).toContain('it was shown once already')
    expect(screen.queryByTestId('event-key')).toBeNull()
  })

  it('switches a sender off and on, and shows what core stored, not the click', async () => {
    let stored = true
    const api = fakeApi({
      // Core stores the opposite of the click once, to prove the switch follows core.
      setEventSenderEnabled: vi.fn(async (name: string, enabled: boolean) => {
        stored = enabled
        return sender({ name, enabled: stored })
      }),
    })
    render(<Harness api={api} />)
    const row = await rowOf('backups')
    const toggle = within(row).getByRole('switch') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    await waitFor(() => expect(api.setEventSenderEnabled).toHaveBeenCalledWith('backups', false))
    await waitFor(() => expect((within(row).getByRole('switch') as HTMLInputElement).checked).toBe(false))
    expect(row.textContent).toContain('Off')
    expect(row.textContent).toMatch(/calls from it are refused/)

    const refusing = fakeApi({
      setEventSenderEnabled: vi.fn(async () => {
        throw new Error('no event sender named backups')
      }),
    })
    document.body.innerHTML = ''
    render(<Harness api={refusing} />)
    const again = await rowOf('backups')
    fireEvent.click(within(again).getByRole('switch'))
    expect((await screen.findByRole('alert')).textContent).toContain('no event sender named backups')
    expect((within(again).getByRole('switch') as HTMLInputElement).checked).toBe(true)
  })

  it('moves the switch with what core stored, even when that is not what was clicked', async () => {
    // A core that keeps the sender on whatever is asked: the switch must stay on.
    const api = fakeApi({ setEventSenderEnabled: vi.fn(async (name: string) => sender({ name, enabled: true })) })
    render(<Harness api={api} />)
    const row = await rowOf('backups')
    fireEvent.click(within(row).getByRole('switch'))
    await waitFor(() => expect(api.setEventSenderEnabled).toHaveBeenCalledWith('backups', false))
    await waitFor(() => expect((within(row).getByRole('switch') as HTMLInputElement).disabled).toBe(false))
    expect((within(row).getByRole('switch') as HTMLInputElement).checked).toBe(true)
    expect(row.textContent).not.toMatch(/calls from it are refused/)
  })

  it('deletes only after a confirmation in the row, and says what happened to waiting events', async () => {
    const api = fakeApi({
      deleteEventSender: vi.fn(async (name: string) => ({
        deleted: name,
        failed_events: 2,
        route: { registered: true, detail: `route event_${name} removed` },
      })),
    })
    render(<Harness api={api} />)
    const row = await rowOf('backups')
    fireEvent.click(within(row).getByRole('button', { name: 'Delete backups' }))
    // The confirmation is in the row (pages, not modals) and says the cost.
    expect(screen.queryByRole('dialog')).toBeNull()
    const confirm = within(row).getByTestId('event-sender-backups-confirm')
    expect(confirm.textContent).toMatch(/refused/)
    expect(api.deleteEventSender).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }))
    expect(within(row).queryByTestId('event-sender-backups-confirm')).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: 'Delete backups' }))
    fireEvent.click(within(within(row).getByTestId('event-sender-backups-confirm')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteEventSender).toHaveBeenCalledWith('backups'))
    expect((await screen.findByTestId('events-outcome')).textContent).toBe(
      'Deleted backups. 2 events that were still waiting will not be read.',
    )
    expect(api.listEventSenders).toHaveBeenCalledTimes(2)
  })

  it('states a delete that failed, and one whose routing could not be removed', async () => {
    const failing = fakeApi({ deleteEventSender: vi.fn(async () => { throw new Error('core refused (500)') }) })
    render(<Harness api={failing} />)
    fireEvent.click(within(await rowOf('backups')).getByRole('button', { name: 'Delete backups' }))
    fireEvent.click(within(screen.getByTestId('event-sender-backups-confirm')).getByRole('button', { name: 'Delete' }))
    expect((await screen.findByRole('alert')).textContent).toContain('core refused (500)')
    expect(screen.queryByTestId('events-outcome')).toBeNull()

    const routeLeft = fakeApi({
      deleteEventSender: vi.fn(async (name: string) => ({
        deleted: name,
        failed_events: 0,
        route: { registered: false, detail: 'the gateway could not be reached' },
      })),
    })
    document.body.innerHTML = ''
    render(<Harness api={routeLeft} />)
    fireEvent.click(within(await rowOf('backups')).getByRole('button', { name: 'Delete backups' }))
    fireEvent.click(within(screen.getByTestId('event-sender-backups-confirm')).getByRole('button', { name: 'Delete' }))
    const outcome = await screen.findByTestId('events-outcome')
    expect(outcome.textContent).toContain('Deleted backups.')
    expect(outcome.textContent).toContain('Its model order on Routing was not removed — the gateway could not be reached')
  })

  it('edits the repos GitHub CI watches and shows what core stored', async () => {
    const api = fakeApi({
      // Core normalises what it stores; the field must show core's value.
      putSetting: vi.fn(async (key: string) => ({ key, value: 'a/b, c/d' })),
    })
    render(<Harness api={api} />)
    const field = (await screen.findByLabelText('Repos GitHub CI watches')) as HTMLInputElement
    expect(field.value).toBe('jeremyspofford/nova')
    fireEvent.change(field, { target: { value: 'a/b c/d' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save repos' }))
    await waitFor(() => expect(api.putSetting).toHaveBeenCalledWith(CI_REPOS_KEY, 'a/b c/d'))
    await waitFor(() => expect(((screen.getByLabelText('Repos GitHub CI watches')) as HTMLInputElement).value).toBe('a/b, c/d'))
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it("shows core's refusal of a repo list in its own words", async () => {
    const api = fakeApi({
      putSetting: vi.fn(async () => {
        throw new Error("setting events.github_ci.repos: 'not a repo' is not owner/repo")
      }),
    })
    render(<Harness api={api} />)
    const field = await screen.findByLabelText('Repos GitHub CI watches')
    fireEvent.change(field, { target: { value: 'not a repo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save repos' }))
    expect(await screen.findByText("setting events.github_ci.repos: 'not a repo' is not owner/repo")).toBeTruthy()
    expect((screen.getByLabelText('Repos GitHub CI watches') as HTMLInputElement).value).toBe('not a repo')
  })

  it('says nobody is watched when the list is empty, and draws no field when core does not list the setting', async () => {
    render(<Harness api={fakeApi()} repos={{ ...REPOS_DEF, value: '' }} />)
    expect((await screen.findByTestId('events-ci-repos')).textContent).toMatch(/no repos are listed, so nothing is read/i)
    document.body.innerHTML = ''
    render(<Harness api={fakeApi()} repos={null} />)
    await rowOf('github_ci')
    expect(screen.queryByLabelText('Repos GitHub CI watches')).toBeNull()
  })
})
