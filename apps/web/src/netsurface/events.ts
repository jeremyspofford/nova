// How the Network surface stays current (FR-134..FR-139): the network, setup, trust and Relay
// events on the app's one shared stream (src/hub-events.ts). Each section follows the events it
// shows while it is mounted and refetches; nothing here opens a stream of its own.
import { useHubStream } from '../hub-events.ts';
import type { EventEnvelope } from '@nova/shared';

/** Endpoints advertised or withdrawn, transports up or down, a new primary, a change recorded. */
export const OVERVIEW_EVENTS = [
  'network.endpoints.changed',
  'network.transport.changed',
  'network.changed',
  'trust.changed',
  'relay.status.changed',
] as const;

export const SETUP_EVENTS = ['network.setup.step', 'network.changed'] as const;

export const TRUST_EVENTS = ['trust.changed'] as const;

export const RELAY_EVENTS = [
  'relay.status.changed',
  'relay.client.paired',
  'relay.client.revoked',
] as const;

/** A wake goes out (with `via`), or the helpers or their devices change. */
export const WAKE_EVENTS = [
  'device.wake.sent',
  'network.changed',
  'device.registered',
  'device.status.changed',
] as const;

/**
 * Follows the named events while mounted; `onOpen` runs when the stream (re)connects, so a view
 * fetches again whatever happened while it was closed.
 */
export function useNetworkEvents(
  names: readonly string[],
  onEvent: (env: EventEnvelope) => void,
  onOpen?: () => void,
): void {
  useHubStream(names, onEvent, onOpen);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** What a `network.transport.changed` event says about the primary transport. */
export function primaryChange(env: EventEnvelope): {
  primary: string | null;
  previous: string | null;
} {
  return { primary: str(env.payload.primary), previous: str(env.payload.previousPrimary) };
}

/** The run a `network.setup.step` event is about. */
export function eventRunId(env: EventEnvelope): string | null {
  return str(env.payload.runId);
}

/** A `device.wake.sent` event as a wake log entry. */
export function wakeFromEvent(env: EventEnvelope): {
  id: string;
  deviceId: string;
  mac: string | null;
  status: string;
  via: string | null;
  createdAt: string;
} | null {
  const deviceId = str(env.payload.deviceId);
  if (!deviceId) return null;
  return {
    id: str(env.payload.wakeRequestId) ?? env.id,
    deviceId,
    mac: str(env.payload.mac),
    status: str(env.payload.status) ?? 'sent',
    via: str(env.payload.via),
    createdAt: env.ts,
  };
}
