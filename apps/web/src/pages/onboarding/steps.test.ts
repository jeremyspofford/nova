import { describe, it, expect } from 'vitest'
import { wizardSteps, initialStep, nextStep, prevStep, STEP_LABELS } from './steps'

describe('wizardSteps', () => {
  it('is the full run on a fresh instance', () => {
    expect(wizardSteps({ hasUsers: false, engine: null })).toEqual([
      'welcome', 'account', 'hardware', 'engine', 'model', 'downloading', 'ready',
    ])
  })

  it('hides CreateAccount once this instance has an owner', () => {
    const steps = wizardSteps({ hasUsers: true, engine: null })
    expect(steps).not.toContain('account')
    expect(steps).toContain('hardware')
  })

  it('keeps the download step for the bundled ollama engine', () => {
    expect(wizardSteps({ hasUsers: false, engine: 'ollama' })).toContain('downloading')
  })

  it('skips the download step for a remote endpoint — nothing to pull', () => {
    expect(wizardSteps({ hasUsers: false, engine: 'remote' })).not.toContain('downloading')
  })

  it('skips the download step for cloud — nothing to pull', () => {
    expect(wizardSteps({ hasUsers: false, engine: 'cloud' })).not.toContain('downloading')
  })

  it('labels every step it can produce', () => {
    for (const step of wizardSteps({ hasUsers: false, engine: null })) {
      expect(STEP_LABELS[step]).toBeTruthy()
    }
  })
})

describe('initialStep', () => {
  it('starts at the welcome screen on a fresh instance', () => {
    expect(initialStep(false)).toBe('welcome')
  })

  it('resumes at Hardware when the account already exists', () => {
    expect(initialStep(true)).toBe('hardware')
  })
})

describe('nextStep / prevStep', () => {
  const ollama = wizardSteps({ hasUsers: false, engine: 'ollama' })
  const cloud = wizardSteps({ hasUsers: false, engine: 'cloud' })
  const returning = wizardSteps({ hasUsers: true, engine: 'ollama' })

  it('walks forward through the visible steps', () => {
    expect(nextStep(ollama, 'welcome')).toBe('account')
    expect(nextStep(ollama, 'model')).toBe('downloading')
  })

  it('jumps over a hidden step going forward', () => {
    expect(nextStep(cloud, 'model')).toBe('ready')
    expect(nextStep(returning, 'welcome')).toBe('hardware')
  })

  it('jumps over a hidden step going back', () => {
    expect(prevStep(cloud, 'ready')).toBe('model')
    expect(prevStep(returning, 'hardware')).toBe('welcome')
  })

  it('has nowhere to go past the ends', () => {
    expect(nextStep(ollama, 'ready')).toBeNull()
    expect(prevStep(ollama, 'welcome')).toBeNull()
  })

  it('returns null for a step that is not in the list', () => {
    expect(nextStep(cloud, 'downloading')).toBeNull()
    expect(prevStep(cloud, 'downloading')).toBeNull()
  })
})
