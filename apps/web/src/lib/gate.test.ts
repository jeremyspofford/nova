import { describe, it, expect } from 'vitest'
import { gateOutcome, type GateFacts, type GateOutcome } from './gate'

const owner = { id: 'p1', name: 'Ada', role: 'owner' as const }

describe('gateOutcome', () => {
  const cases: Array<{ why: string; facts: GateFacts; expected: GateOutcome }> = [
    {
      why: 'nobody has registered yet — the wizard owns the whole app',
      facts: { hasUsers: false, me: null, onboardingCompleted: null },
      expected: 'onboarding',
    },
    {
      why: 'no users beats every other fact, even a stale session',
      facts: { hasUsers: false, me: owner, onboardingCompleted: true },
      expected: 'onboarding',
    },
    {
      why: 'an account exists but this browser has no session',
      facts: { hasUsers: true, me: null, onboardingCompleted: null },
      expected: 'login',
    },
    {
      why: 'signed in, setup never finished — resume the wizard',
      facts: { hasUsers: true, me: owner, onboardingCompleted: false },
      expected: 'onboarding',
    },
    {
      why: 'setup state unknown is not setup done',
      facts: { hasUsers: true, me: owner, onboardingCompleted: null },
      expected: 'onboarding',
    },
    {
      why: 'signed in and set up — the app',
      facts: { hasUsers: true, me: owner, onboardingCompleted: true },
      expected: 'app',
    },
  ]

  for (const { why, facts, expected } of cases) {
    it(`${expected}: ${why}`, () => {
      expect(gateOutcome(facts)).toBe(expected)
    })
  }
})
