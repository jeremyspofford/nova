import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SkillsPage, type SkillsApi } from './SkillsPage'
import type { SkillDetail, SkillInfo, SkillTrial } from '../../lib/api'

function row(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: 'clear-notes',
    title: 'workspace_list_files → workspace_delete',
    summary: "asked as: 'clear the superseded notes' (2026-09-10)",
    status: 'draft',
    created_via: 'beat',
    step_names: ['workspace_list_files', 'workspace_delete'],
    flagged_reason: null,
    file_present: true,
    uses: { total: 0, watched: 0, rough: 0, unwatched: 0, last_used: null },
    created_at: '2026-09-11T10:00:00Z',
    updated_at: '2026-09-11T10:00:00Z',
    size: 200,
    modified: '2026-09-11T10:00:00Z',
    ...overrides,
  }
}

function detail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    ...row(),
    body: '1. list the files\n2. delete the ones superseded\n',
    source_turns: [{ id: 't1', present: true }],
    ...overrides,
  }
}

function api(overrides: Partial<SkillsApi> = {}): SkillsApi {
  return {
    listSkills: vi.fn(async () => [row()]),
    getSkill: vi.fn(async () => detail()),
    createSkill: vi.fn(async () => detail()),
    updateSkill: vi.fn(async () => detail()),
    deleteSkill: vi.fn(async () => ({ name: 'clear-notes', deleted: true, text: 'gone' })),
    trialSkill: vi.fn(async () => ({}) as SkillTrial),
    ...overrides,
  }
}

function show(props: { api?: SkillsApi } = {}) {
  return render(
    <MemoryRouter>
      <SkillsPage api={api()} {...props} />
    </MemoryRouter>,
  )
}

describe('SkillsPage', () => {
  it('lists a draft with the request it was distilled from', async () => {
    show()
    expect(await screen.findByText('clear-notes')).toBeTruthy()
    expect(screen.getByText(/clear the superseded notes/)).toBeTruthy()
    expect(screen.getByText('Draft')).toBeTruthy()
  })

  it('shows a file with no row as a file, and it has no detail to open', async () => {
    const only = api({
      listSkills: vi.fn(async () => [
        row({ name: 'by-hand', status: null, summary: null, uses: null, created_via: null }),
      ]),
    })
    render(
      <MemoryRouter>
        <SkillsPage api={only} />
      </MemoryRouter>,
    )
    expect(await screen.findByText('File only')).toBeTruthy()
    fireEvent.click(screen.getByText('by-hand'))
    await waitFor(() => expect(only.getSkill).not.toHaveBeenCalled())
  })

  it('says a source turn has aged out rather than linking to nothing', async () => {
    const swept = api({
      getSkill: vi.fn(async () => detail({ source_turns: [{ id: 'gone', present: false }] })),
    })
    render(
      <MemoryRouter>
        <SkillsPage api={swept} />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByText('clear-notes'))
    expect(await screen.findByText(/aged out of the ledger/)).toBeTruthy()
  })

  it('activating a draft is one PATCH through the store', async () => {
    const moving = api()
    render(
      <MemoryRouter>
        <SkillsPage api={moving} />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByText('clear-notes'))
    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }))
    await waitFor(() =>
      expect(moving.updateSkill).toHaveBeenCalledWith('clear-notes', { status: 'active' }),
    )
  })

  it('a flagged skill shows the reason the ledger wrote', async () => {
    const flagged = api({
      listSkills: vi.fn(async () => [row({ status: 'flagged' })]),
      getSkill: vi.fn(async () =>
        detail({ status: 'flagged', flagged_reason: '3 of the last 5 watched uses went badly' }),
      ),
    })
    render(
      <MemoryRouter>
        <SkillsPage api={flagged} />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByText('clear-notes'))
    expect(await screen.findByTestId('flagged-reason')).toBeTruthy()
  })

  it('a trial reports what the two runs did and refuses to call one better', async () => {
    const trialled = api({
      trialSkill: vi.fn(async () => ({
        skill: 'clear-notes',
        model: 'qwen3:8b',
        message: 'clear the superseded notes',
        sides: {
          with: {
            calls: 2,
            failed_calls: 0,
            read_the_skill: true,
            seconds: 3,
            ungradeable: false,
            no_unbacked_claim: true,
            turn_id: 'a',
          },
          without: {
            calls: 5,
            failed_calls: 1,
            read_the_skill: false,
            seconds: 7,
            ungradeable: false,
            no_unbacked_claim: true,
            turn_id: 'b',
          },
        },
      })),
    })
    render(
      <MemoryRouter>
        <SkillsPage api={trialled} />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByText('clear-notes'))
    fireEvent.click(await screen.findByRole('button', { name: 'Trial it' }))

    const panel = await screen.findByTestId('skill-trial')
    expect(panel.textContent).toContain('Fewer with it, in this one run each.')
    expect(panel.textContent).toContain('not that one way is better')
  })

  it('states a failed read instead of showing an empty page', async () => {
    const broken = api({
      listSkills: vi.fn(async () => {
        throw new Error('core is down')
      }),
    })
    render(
      <MemoryRouter>
        <SkillsPage api={broken} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('core is down')
  })
})
