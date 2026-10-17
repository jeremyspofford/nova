// How the Computers and Network views stay current: `computer.*` events, `egress.policy.changed`
// and `audit.appended` (kind `network`, one per proxy decision) on the global stream
// (contracts/events.md). Each view follows them while it is mounted.
import type { EventEnvelope } from '@nova/shared';
import { useHubStream } from '../hub-events.ts';

export const COMPUTER_EVENTS = [
  'computer.state.changed',
  'computer.snapshot.created',
  'computer.restored',
  'computer.takeover.started',
  'computer.takeover.ended',
] as const;

/** Follows the named events on the app's shared stream while mounted (src/hub-events.ts). */
export function useHubEvents(
  names: readonly string[],
  onEvent: (env: EventEnvelope) => void,
): void {
  useHubStream(names, onEvent);
}

/** The computer an event is about, if any. */
export function eventComputerId(env: EventEnvelope): string | null {
  const v = env.payload.computerId;
  return typeof v === 'string' && v ? v : null;
}

/** Whether an `audit.appended` event is a proxy decision (kind `network`). */
export function isNetworkAudit(env: EventEnvelope): boolean {
  return env.name === 'audit.appended' && env.payload.kind === 'network';
}
