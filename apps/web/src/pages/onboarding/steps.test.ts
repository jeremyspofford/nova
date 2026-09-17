import { describe, it, expect } from 'vitest'
import { wizardSteps, initialStep, nextStep, prevStep, STEP_LABELS } from './steps'

describe('wizardSteps', () => {
  it('is the full run on a fresh instance', () => {
    expect(wizardSteps({ hasUsers: false, engine: null })).toEqual([
      'welcome', 'account', 'timezone', 'hardware', 'engine', 'model', 'downloading', 'ready',
    ])
  })

  it('puts the timezone step right after the account step (S9: set during onboarding)', () => {
    const steps = wizardSteps({ hasUsers: false, engine: null })
    expect(steps.indexOf('timezone')).toBe(steps.indexOf('account') + 1)
  })

  it('hides the timezone step on a returning run — Settings → General is the re-run path', () => {
    // A returning run starts at Hardware and never reaches back, so listing
    // it would show a done-mark for a step that did not run.
    expect(wizardSteps({ hasUsers: true, engine: null })).not.toContain('timezone')
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
    expect(STEP_LABELS.timezone).toBe('Timezone')
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

describe('skipping to Ready and coming back', () => {
  it('can still reach the account step on a fresh instance', () => {
    const steps = wizardSteps({ hasUsers: false, engine: null })
    // Where "Back to setup" lands after a skip.
    const landing = initialStep(false)
    expect(landing).toBe('welcome')
    // The account step lives past it, so it is reachable going forward.
    expect(nextStep(steps, landing)).toBe('account')
  })

  it('does not send a returning run back through Welcome', () => {
    const landing = initialStep(true)
    expect(landing).toBe('hardware')
    expect(wizardSteps({ hasUsers: true, engine: null })).not.toContain('account')
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
    // Account and timezone are both hidden on a returning run.
    expect(nextStep(returning, 'welcome')).toBe('hardware')
  })

  it('jumps over a hidden step going back', () => {
    expect(prevStep(cloud, 'ready')).toBe('model')
    expect(prevStep(returning, 'hardware')).toBe('welcome')
  })

  it('has the one-shot account step directly behind timezone on the only run that shows it', () => {
    // Why the Timezone step renders no Back: core registers an owner once,
    // so there is nothing to go back TO — and no other run lists the step.
    expect(prevStep(ollama, 'timezone')).toBe('account')
    expect(prevStep(returning, 'timezone')).toBeNull()
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
