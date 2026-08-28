import type { Role } from './roles'

export interface Person {
  id: string
  name: string
  role: Role
}

/**
 * The three facts the app gate is allowed to reason about, in the order
 * core answers them: GET /auth/state, GET /auth/me, GET /settings.
 *
 * `onboardingCompleted` is null when it has not been read — an
 * unauthenticated browser never gets to ask. Null is deliberately NOT
 * treated as done: an unknown setup state is an unfinished setup.
 */
export interface GateFacts {
  hasUsers: boolean
  me: Person | null
  onboardingCompleted: boolean | null
}

export type GateOutcome = 'onboarding' | 'login' | 'app'

export function gateOutcome(facts: GateFacts): GateOutcome {
  // No owner yet: nothing else can be true enough to matter — a leftover
  // cookie for a person who no longer exists must not open the app.
  if (!facts.hasUsers) return 'onboarding'
  if (facts.me === null) return 'login'
  if (facts.onboardingCompleted !== true) return 'onboarding'
  return 'app'
}
