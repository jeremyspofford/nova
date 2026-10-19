// M7.5 Hub client calls of the devices area (ADR-096 D1, D9; FR-126, FR-142, FR-145, FR-148,
// FR-150), in the conventions of src/api.ts: the management channel each novad device is reached
// on (mutual TLS or plain HTTP), a device's managed services, the novad build the Hub serves for
// it, its owner overrides with "push now", decommissioning it (an approval card, then the device
// wipes itself and is revoked), and a compute node's policy (quiet hours in a time zone, routing
// eligibility), state (VRAM, load, quiet now) and managed services. `createApi` spreads
// `deviceOpsApi(call)` into the client; until then `useDeviceOpsApi` reads the calls from the same
// services object and is null when the client has none, so these views stay out of the page.
import type { z } from 'zod';
import type {
  DeviceAvailableUpdateView,
  DeviceDecommissionView,
  DeviceManagementTlsSummaryView,
  DeviceOverridesView,
  DeviceServiceView,
  NodeDetailView,
  NodePolicy,
  NodePolicyInput,
  NodeServiceAction,
  NodeServiceName,
  NodeServiceView,
  deviceDecommissionSchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';
import type { HubCall } from './api.ts';

const V1 = '/api/v1';
const dev = (id: string) => `${V1}/devices/${encodeURIComponent(id)}`;

export function deviceOpsApi(call: HubCall) {
  return {
    /** Every novad device's management channel, the Hub's client certificate and problems. */
    getManagementTls: () =>
      call<DeviceManagementTlsSummaryView>('GET', `${V1}/devices/management-tls`),
    /** The services declared in novad's config; 400 `update_required` for an older novad. */
    listDeviceServices: (id: string) =>
      call<{ items: DeviceServiceView[] }>('GET', `${dev(id)}/services`),
    /** The novad build this Hub serves for the device's platform, against its version. */
    getAvailableUpdate: (id: string) =>
      call<DeviceAvailableUpdateView>('GET', `${dev(id)}/updates/available`),
    getDeviceOverrides: (id: string) => call<DeviceOverridesView>('GET', `${dev(id)}/overrides`),
    /** Send the overrides and policy now instead of with the next heartbeat (device online). */
    pushDeviceOverrides: (id: string) =>
      call<DeviceOverridesView>('POST', `${dev(id)}/overrides/push`, {}),
    /** The device's latest decommission, or null. */
    getDecommission: (id: string) =>
      call<{ decommission: DeviceDecommissionView | null }>('GET', `${dev(id)}/decommission`),
    /** Files the approval card (202); the device is told and revoked once it is allowed. */
    requestDecommission: (id: string, body: z.input<typeof deviceDecommissionSchema>) =>
      call<DeviceDecommissionView>('POST', `${dev(id)}/decommission`, body),
    /** A compute node's policy, whether it is quiet now, its VRAM and load. */
    getNodeDetail: (id: string) => call<NodeDetailView>('GET', `${dev(id)}/node`),
    /** Merged into the node's policy; the node takes it with its next heartbeat. */
    setNodePolicy: (id: string, body: NodePolicyInput) =>
      call<NodePolicy>('PUT', `${dev(id)}/node/policy`, body),
    /** `jobs` and, when the node manages one, the model `backend`; 400 for an older node. */
    listNodeServices: (id: string) =>
      call<{ items: NodeServiceView[] }>('GET', `${dev(id)}/node/services`),
    nodeServiceAction: (id: string, name: NodeServiceName, action: NodeServiceAction) =>
      call<{ service: NodeServiceView }>(
        'POST',
        `${dev(id)}/node/services/${encodeURIComponent(name)}/${action}`,
        {},
      ),
  };
}

export type DeviceOpsApi = ReturnType<typeof deviceOpsApi>;

/** The calls of the app's client, or null when it has none of them yet. */
export function useDeviceOpsApi(): DeviceOpsApi | null {
  const api = useServices().api as unknown as Partial<DeviceOpsApi>;
  return typeof api.getManagementTls === 'function' ? (api as DeviceOpsApi) : null;
}
