// How the fallback and bridge views stay current (FR-209, FR-096): the browser area's M7.5 events
// on the global stream, and the request broker's for the fallback's offer. Each view follows the
// events it cares about while mounted (through `useHubEvents`).
import type { EventEnvelope } from '@nova/shared';

/** A consent was granted or revoked, or a fallback session started or ended. */
export const FALLBACK_EVENTS = ['browser.fallback.changed'] as const;

/** The bridge connected or left, a tab was shared or unshared, a grant changed. */
export const BRIDGE_EVENTS = ['browser.bridge.changed', 'browser.bridge.grant.changed'] as const;

/** A question was asked, answered or expired. */
export const REQUEST_EVENTS = ['request.created', 'request.resolved', 'request.expired'] as const;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The device an event is about, when it names one. */
export function eventDevice(env: EventEnvelope): string | null {
  return str(env.payload.deviceId);
}

/** The computer an event is about, when it names one. */
export function eventComputer(env: EventEnvelope): string | null {
  return str(env.payload.computerId);
}
