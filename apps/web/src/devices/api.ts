// Hub client calls for devices running `novad` (docs/23; FR-141..FR-150, FR-210, FR-081), in the
// conventions of src/api.ts. `createApi` spreads `devicesApi(call)` into the client, so `Api`
// includes these; until then `useDevicesApi` reads them from the same services object. The M2
// compute-node calls (`listNodes`, `revokeNode`) stay in src/api.ts.
import type { z } from 'zod';
import type {
  AgentDeviceConnectionView,
  AgentView,
  DeviceAccessRequestView,
  DeviceCapabilityStatus,
  DeviceDirent,
  DeviceEnrollToken,
  DeviceModuleView,
  DeviceUpdateView,
  DeviceView,
  DeviceWakeView,
  StagedWriteView,
  connectAgentDeviceSchema,
  deviceAccessRequestSchema,
  deviceGrantSchema,
  devicePowerSchema,
  enrollDeviceSchema,
  pushDeviceUpdatesSchema,
  updateDeviceSchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const dev = (id: string) => `${V1}/devices/${enc(id)}`;

/** `GET …/capabilities`: the device's version, its capability statuses and its document. */
export interface DeviceCapabilitiesResult {
  novadVersion: string | null;
  updateRequired: boolean;
  items: DeviceCapabilityStatus[];
  document: Record<string, unknown> | null;
}

/** What the device answers about power; fields are the device's and may be missing. */
export type DevicePowerResult = Record<string, unknown>;

/** A managed service as the device reports it (`{name, kind, state}` and more). */
export type DeviceServiceResult = Record<string, unknown>;

export interface DeviceDirListing {
  path: string;
  entries: DeviceDirent[];
  truncated: boolean;
}

export interface DeviceFileContent {
  path: string;
  contentBase64: string;
  size: number;
  sha256: string;
  truncated: boolean;
}

/** A local MCP server's entry as the device lists it; untrusted (FR-189). */
export type DeviceMcpServer = Record<string, unknown>;

export type StagedStatus = StagedWriteView['status'];

export function devicesApi(call: HubCall) {
  return {
    // ---- the registry (FR-142, FR-148, FR-150) --------------------------------------------------
    listNovadDevices: () => call<{ items: DeviceView[] }>('GET', `${V1}/devices/novad`),
    /** A one-use enrollment command (15 min); creating it is the owner's approval. */
    enrollNovadDevice: (body: z.input<typeof enrollDeviceSchema>) =>
      call<DeviceEnrollToken>('POST', `${V1}/devices/novad/enroll`, body),
    getNovadDevice: (id: string) => call<DeviceView>('GET', dev(id)),
    /** Name, Hub overrides (replaced whole), policy (merged by key) or update channel. */
    updateNovadDevice: (id: string, body: z.input<typeof updateDeviceSchema>) =>
      call<DeviceView>('PATCH', dev(id), body),
    /** The credential and management token go at once; connections and grants end. */
    revokeNovadDevice: (id: string) => call<{ ok: true }>('POST', `${dev(id)}/revoke`),
    getDeviceCapabilities: (id: string) =>
      call<DeviceCapabilitiesResult>('GET', `${dev(id)}/capabilities`),

    // ---- modules, services, power, wake (FR-141, FR-144, FR-145) --------------------------------
    deviceModuleAction: (
      id: string,
      name: string,
      action: 'start' | 'stop' | 'restart' | 'rollback',
    ) =>
      call<{ module: DeviceModuleView }>('POST', `${dev(id)}/modules/${enc(name)}/${action}`, {}),
    deviceServiceAction: (
      id: string,
      name: string,
      action: 'start' | 'stop' | 'restart' | 'status',
    ) =>
      call<{ service: DeviceServiceResult }>(
        'POST',
        `${dev(id)}/services/${enc(name)}/${action}`,
        {},
      ),
    getDevicePower: (id: string) => call<DevicePowerResult>('GET', `${dev(id)}/power`),
    /** WoL plans and changes (applied only with `apply`), sleep, restart, shutdown. */
    devicePowerAction: (id: string, body: z.input<typeof devicePowerSchema>) =>
      call<DevicePowerResult>('POST', `${dev(id)}/power`, body),
    /** A magic packet; 429 `rate_limited` past `devices.wakesPerHour`. */
    wakeDevice: (id: string) => call<DeviceWakeView>('POST', `${dev(id)}/wake`, {}),

    // ---- updates (FR-148) -----------------------------------------------------------------------
    listDeviceUpdates: (id: string) =>
      call<{ items: DeviceUpdateView[] }>('GET', `${dev(id)}/updates`),
    /** Signed bundles, applied in order; the supervisor (`novad`) goes last. */
    pushDeviceUpdates: (id: string, body: z.input<typeof pushDeviceUpdatesSchema>) =>
      call<{ items: DeviceUpdateView[] }>('POST', `${dev(id)}/updates`, body),

    // ---- files, grants and access requests (FR-210) ---------------------------------------------
    listDeviceFiles: (id: string, path: string) =>
      call<DeviceDirListing>('GET', `${dev(id)}/files${query({ path })}`),
    readDeviceFile: (id: string, path: string, maxBytes?: number) =>
      call<DeviceFileContent>('GET', `${dev(id)}/files/content${query({ path, maxBytes })}`),
    /** The Hub's copy of the device's grants and pending requests. */
    listDeviceGrants: (id: string) =>
      call<{ items: DeviceAccessRequestView[] }>('GET', `${dev(id)}/grants`),
    createDeviceGrant: (id: string, body: z.input<typeof deviceGrantSchema>) =>
      call<DeviceAccessRequestView>('POST', `${dev(id)}/grants`, body),
    revokeDeviceGrant: (id: string, grantId: string) =>
      call<{ ok: true }>('DELETE', `${dev(id)}/grants/${enc(grantId)}`),
    /** For the signed-in user (no grantee) the folder is granted at once. */
    requestDeviceAccess: (id: string, body: z.input<typeof deviceAccessRequestSchema>) =>
      call<DeviceAccessRequestView>('POST', `${dev(id)}/access-requests`, body),

    // ---- staged writes (FR-210) -----------------------------------------------------------------
    listStagedWrites: (id: string, q: { status?: StagedStatus; sessionRef?: string } = {}) =>
      call<{ items: StagedWriteView[] }>('GET', `${dev(id)}/staged${query({ ...q })}`),
    getStagedWrite: (id: string, stagedId: string) =>
      call<StagedWriteView>('GET', `${dev(id)}/staged/${enc(stagedId)}`),
    /** 409 `conflict` when the file changed since staging (the write becomes `conflict`). */
    commitStagedWrite: (id: string, stagedId: string) =>
      call<StagedWriteView>('POST', `${dev(id)}/staged/${enc(stagedId)}/commit`, {}),
    discardStagedWrite: (id: string, stagedId: string) =>
      call<StagedWriteView>('POST', `${dev(id)}/staged/${enc(stagedId)}/discard`, {}),

    // ---- local MCP servers (FR-210) -------------------------------------------------------------
    /** The servers granted to the signed-in user, with their tools. Calls are for agents. */
    listDeviceMcp: (id: string) => call<{ servers: DeviceMcpServer[] }>('GET', `${dev(id)}/mcp`),

    // ---- agents' connected computers (FR-081) ---------------------------------------------------
    listDeviceConnections: (q: { agentId?: string; deviceId?: string } = {}) =>
      call<{ items: AgentDeviceConnectionView[] }>(
        'GET',
        `${V1}/devices/connections${query({ ...q })}`,
      ),
    /** 409 `conflict` (`agent_connected`) when the agent has another computer, unless `replace`. */
    connectDevice: (body: z.input<typeof connectAgentDeviceSchema>) =>
      call<AgentDeviceConnectionView>('POST', `${V1}/devices/connections`, body),
    disconnectDevice: (connectionId: string) =>
      call<AgentDeviceConnectionView>('DELETE', `${V1}/devices/connections/${enc(connectionId)}`),
    /** The account's agents, to pick one for a connection or a grant. */
    listDeviceAgentChoices: () => call<{ items: AgentView[] }>('GET', `${V1}/agents`),
  };
}

export type DevicesApi = ReturnType<typeof devicesApi>;

/** The devices calls of the app's client (part of `Api` once `createApi` spreads them in). */
export function useDevicesApi(): DevicesApi {
  const api: unknown = useServices().api;
  return api as DevicesApi;
}
