// How the computer-use views stay current (FR-093, FR-207, FR-087, FR-098): the screen service's
// events on the global stream. Views follow them through `useHubEvents` and refetch.
import type { EventEnvelope } from '@nova/shared';

export { useHubEvents } from '../spaces/events.ts';

/** Control state, grants, recorded actions and takeover of a computer. */
export const SCREEN_EVENTS = [
  'screen.control.changed',
  'screen.grant.changed',
  'screen.action',
  'computer.takeover.started',
  'computer.takeover.ended',
] as const;

/** The computer an event is about, or null. */
export function eventComputerId(env: EventEnvelope): string | null {
  const v = env.payload.computerId;
  return typeof v === 'string' && v ? v : null;
}
