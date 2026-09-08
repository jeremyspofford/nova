import type { Notice } from '../../lib/api'

/**
 * One notice, shaped exactly as GET /api/v1/notices returns it — the
 * agentFixture idiom, so a test says only what it is actually about and every
 * other field is a plausible row rather than an omission that quietly changes
 * what is being tested.
 *
 * The default is the honest starting state of a finding: raised (written
 * down, nobody told yet), live (no check has stopped finding it), seen once,
 * with an empty delivery receipt because no rung has reported.
 */
export function noticeFixture(overrides: Partial<Notice> = {}): Notice {
  const now = new Date().toISOString()
  return {
    id: 'n1',
    check_name: 'stack_service_unreachable',
    title: 'the gateway is not answering',
    facts: { service: 'gateway' },
    urgent: false,
    acted: false,
    acted_note: null,
    acted_turn_id: null,
    repeats: 1,
    state: 'raised',
    delivery: {},
    failed_reason: null,
    first_seen_at: now,
    last_seen_at: now,
    cleared_at: null,
    delivered_at: null,
    seen_at: null,
    muted_at: null,
    ...overrides,
  }
}
