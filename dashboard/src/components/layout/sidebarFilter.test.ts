import { describe, expect, it } from 'vitest'
import { filterNavItemsByPreset, type NavItemForFilter } from './sidebarFilter'

const items: NavItemForFilter[] = [
  { key: 'chat',     presetVisibility: undefined },
  { key: 'tasks',    presetVisibility: ['standard', 'advanced'] },
  { key: 'pods',     presetVisibility: ['advanced'] },
  { key: 'settings', presetVisibility: undefined },
]

describe('filterNavItemsByPreset', () => {
  it('keeps items without presetVisibility at every preset', () => {
    const got = filterNavItemsByPreset(items, 'chat_only').map(i => i.key)
    expect(got).toContain('chat')
    expect(got).toContain('settings')
  })

  it('hides items not listed in the active preset', () => {
    const got = filterNavItemsByPreset(items, 'chat_only').map(i => i.key)
    expect(got).not.toContain('tasks')
    expect(got).not.toContain('pods')
  })

  it('shows tasks at standard but still hides pods', () => {
    const got = filterNavItemsByPreset(items, 'standard').map(i => i.key)
    expect(got).toContain('tasks')
    expect(got).not.toContain('pods')
  })

  it('shows everything at advanced', () => {
    const got = filterNavItemsByPreset(items, 'advanced').map(i => i.key)
    expect(got).toEqual(['chat', 'tasks', 'pods', 'settings'])
  })
})
