// M7 Hub client calls of the devices area (FR-126, docs/22 §5 and §9), in the conventions of
// src/api.ts: what the Hub saw of each device's certificate on its last HTTPS call (mutual TLS
// for novad devices and compute nodes). `createApi` spreads `deviceTlsApi(call)` into the client
// next to `devicesApi(call)`; until then `useDeviceTlsApi` reads it from the same services object.
import type { DeviceTlsSummaryView } from '@nova/shared';
import { useServices } from '../services.tsx';
import type { HubCall } from './api.ts';

export function deviceTlsApi(call: HubCall) {
  return {
    /** Every device seen over HTTPS (newest first), whether one is required, and problems. */
    getDeviceTls: () => call<DeviceTlsSummaryView>('GET', '/api/v1/devices/tls'),
  };
}

export type DeviceTlsApi = ReturnType<typeof deviceTlsApi>;

/**
 * The call of the app's client, or null when this client has no such call yet (an older Hub
 * client): the certificate views then stay out of the page instead of failing it.
 */
export function useDeviceTlsApi(): DeviceTlsApi | null {
  const api = useServices().api as unknown as Partial<DeviceTlsApi>;
  return typeof api.getDeviceTls === 'function' ? (api as DeviceTlsApi) : null;
}
