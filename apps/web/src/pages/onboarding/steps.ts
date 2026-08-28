/**
 * Which wizard steps exist for this run, derived from two facts: whether
 * this instance already has an owner, and which engine was chosen.
 *
 * Kept as a pure module so the "CreateAccount only on a fresh instance" and
 * "remote/cloud have nothing to download" rules are testable without
 * mounting the wizard.
 */

export type WizardStep =
  | 'welcome'
  | 'account'
  | 'hardware'
  | 'engine'
  | 'model'
  | 'downloading'
  | 'ready'

// Type-only import: erased at compile time, so this module keeps no runtime
// dependency on the API layer while still using its one definition of the kind.
export type { EngineKind } from '../../lib/api'
import type { EngineKind } from '../../lib/api'

const STEP_ORDER: WizardStep[] = [
  'welcome',
  'account',
  'hardware',
  'engine',
  'model',
  'downloading',
  'ready',
]

export const STEP_LABELS: Record<WizardStep, string> = {
  welcome: 'Welcome',
  account: 'Account',
  hardware: 'Hardware',
  engine: 'Engine',
  model: 'Model',
  downloading: 'Download',
  ready: 'Ready',
}

export function wizardSteps({
  hasUsers,
  engine,
}: {
  hasUsers: boolean
  engine: EngineKind | null
}): WizardStep[] {
  return STEP_ORDER.filter(step => {
    // The account step mints the FIRST owner and nothing else.
    if (step === 'account') return !hasUsers
    // Only the bundled ollama pulls weights; a remote or cloud endpoint
    // already has its model.
    if (step === 'downloading') return engine !== 'remote' && engine !== 'cloud'
    return true
  })
}

/**
 * Where a run starts. An instance that already has an owner is resuming an
 * unfinished setup, so it lands on Hardware rather than re-greeting someone
 * who has already been greeted.
 */
export function initialStep(hasUsers: boolean): WizardStep {
  return hasUsers ? 'hardware' : 'welcome'
}

export function nextStep(steps: WizardStep[], current: WizardStep): WizardStep | null {
  const index = steps.indexOf(current)
  if (index === -1) return null
  return steps[index + 1] ?? null
}

export function prevStep(steps: WizardStep[], current: WizardStep): WizardStep | null {
  const index = steps.indexOf(current)
  if (index <= 0) return null
  return steps[index - 1] ?? null
}
