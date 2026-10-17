// How the Devices views stay current (docs/23, FR-141..FR-150, FR-210, FR-081): the `device.*`
// events the devices area emits on the global stream, plus `approval.decided` (a folder-access
// card answered anywhere). The Devices surface opens one stream (`DeviceEventsProvider`) and every
// view under it subscribes to that; a view used elsewhere (the agent's computer panel) opens its
// own. Views refetch on the events they care about.
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { EventEnvelope } from '@nova/shared';
import { useServices } from '../services.tsx';
import { subscribeHubEvents } from '../hub-events.ts';

export const DEVICE_EVENTS = [
  'device.registered',
  'device.status.changed',
  'device.capabilities.changed',
  'device.module.changed',
  'device.overrides.changed',
  'device.service.changed',
  'device.power.requested',
  'device.wake.sent',
  'device.update.result',
  'device.access.requested',
  'device.access.decided',
  'device.grant.revoked',
  'device.write.staged',
  'device.write.conflict',
  'device.write.committed',
  'device.write.discarded',
  'device.connection.changed',
] as const;

/** Everything the Devices surface listens for on its one stream. */
const ALL_EVENTS: readonly string[] = [...DEVICE_EVENTS, 'approval.decided'];

/** Events that change what a device's registry row shows. */
export const DEVICE_ROW_EVENTS: readonly string[] = [
  'device.registered',
  'device.status.changed',
  'device.capabilities.changed',
  'device.module.changed',
  'device.overrides.changed',
  'device.update.result',
];

export const GRANT_EVENTS: readonly string[] = [
  'device.access.requested',
  'device.access.decided',
  'device.grant.revoked',
];

export const STAGED_EVENTS: readonly string[] = [
  'device.write.staged',
  'device.write.conflict',
  'device.write.committed',
  'device.write.discarded',
];

type Listener = (env: EventEnvelope) => void;

interface DeviceBus {
  subscribe: (fn: Listener) => () => void;
}

const BusCtx = createContext<DeviceBus | null>(null);

/** One stream for the Devices surface; views below it subscribe instead of opening their own. */
export function DeviceEventsProvider({ children }: { children: ReactNode }) {
  const { eventSource } = useServices();
  const [subs] = useState(() => new Set<Listener>());
  const [bus] = useState<DeviceBus>(() => ({
    subscribe: (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  }));
  useEffect(
    () =>
      subscribeHubEvents(eventSource, ALL_EVENTS, {
        onEvent: (env) => {
          for (const fn of [...subs]) fn(env);
        },
      }),
    [subs, eventSource],
  );
  return createElement(BusCtx.Provider, { value: bus }, children);
}

/** Follows the named events while mounted (through the surface's stream when there is one). */
export function useDeviceEvents(names: readonly string[], onEvent: Listener): void {
  const bus = useContext(BusCtx);
  const { eventSource } = useServices();
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  const key = names.join(',');
  useEffect(() => {
    const wanted = new Set(key.split(','));
    if (bus)
      return bus.subscribe((env) => {
        if (wanted.has(env.name)) handler.current(env);
      });
    return subscribeHubEvents(eventSource, [...wanted], {
      onEvent: (env) => handler.current(env),
    });
  }, [key, bus, eventSource]);
}

/** The device an event is about, when it names one. */
export function eventDeviceId(env: EventEnvelope): string | null {
  const v = env.payload.deviceId;
  return typeof v === 'string' && v ? v : null;
}
