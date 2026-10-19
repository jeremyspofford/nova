// M7.5 Hub client calls of the boot area (FR-143; docs/23 §5.2; ADR-096 D2, D3, D5), in the
// conventions of src/api.ts: a device's boot status with its profiles, trials and requests;
// profiles; trying one once (an approval card first), making a confirmed trial the default (an
// approval card too) and clearing a pending one-shot (always allowed); and network boot: the
// device's boot token (shown once) and the images the Hub offers. `createApi` spreads
// `bootApi(call)` into the client; `useBootApi` reads the calls from the services object.
import type {
  BootAttemptView,
  BootImageView,
  BootProfileView,
  BootRequestView,
  CreateBootProfileInput,
  DeviceBootView,
  PxeTokenCreatedView,
  PxeTokenView,
  UpdateBootProfileInput,
} from '@nova/shared';
import type { HubCall } from '../devices/api.ts';
import { useServices } from '../services.tsx';

const V1 = '/api/v1';
const enc = encodeURIComponent;
const boot = (id: string) => `${V1}/devices/${enc(id)}/boot`;

/** `GET /api/v1/devices/boot-images`: whether PXE is on, the Hub folder and its images. */
export interface BootImagesResult {
  enabled: boolean;
  folder: string;
  items: BootImageView[];
}

export function bootApi(call: HubCall) {
  return {
    /** The device's own status (or why it could not be read) with the Hub's records. */
    getDeviceBoot: (deviceId: string) => call<DeviceBootView>('GET', boot(deviceId)),
    listBootProfiles: (deviceId: string) =>
      call<{ items: BootProfileView[] }>('GET', `${boot(deviceId)}/profiles`),
    createBootProfile: (deviceId: string, body: CreateBootProfileInput) =>
      call<BootProfileView>('POST', `${boot(deviceId)}/profiles`, body),
    updateBootProfile: (deviceId: string, profileId: string, body: UpdateBootProfileInput) =>
      call<BootProfileView>('PATCH', `${boot(deviceId)}/profiles/${enc(profileId)}`, body),
    deleteBootProfile: (deviceId: string, profileId: string) =>
      call<{ ok: true }>('DELETE', `${boot(deviceId)}/profiles/${enc(profileId)}`),
    /** Ask to boot a profile once (202): a request waiting for its approval card. */
    tryBootProfile: (
      deviceId: string,
      profileId: string,
      body: { watchdogSeconds?: number; reboot?: boolean } = {},
    ) => call<BootRequestView>('POST', `${boot(deviceId)}/profiles/${enc(profileId)}/try`, body),
    getBootAttempt: (deviceId: string, attemptId: string) =>
      call<BootAttemptView>('GET', `${boot(deviceId)}/attempts/${enc(attemptId)}`),
    /**
     * Ask to make a confirmed trial the default (202): a request waiting for its approval. A trial
     * the device could not verify (`verified: false`) needs `confirmUnverified`.
     */
    commitBootAttempt: (
      deviceId: string,
      attemptId: string,
      opts: { confirmUnverified?: boolean } = {},
    ) =>
      call<BootRequestView>(
        'POST',
        `${boot(deviceId)}/attempts/${enc(attemptId)}/commit`,
        opts.confirmUnverified ? { confirmUnverified: true } : {},
      ),
    /** Clear a pending one-shot: a safety action, sent at once, whatever the toggle says. */
    revertBoot: (deviceId: string) => call<BootRequestView>('POST', `${boot(deviceId)}/revert`, {}),
    getBootRequest: (deviceId: string, requestId: string) =>
      call<BootRequestView>('GET', `${boot(deviceId)}/requests/${enc(requestId)}`),
    listBootImages: () => call<BootImagesResult>('GET', `${V1}/devices/boot-images`),
    /** A new boot token, replacing the old one; its value is in this answer only. */
    createPxeToken: (deviceId: string) =>
      call<PxeTokenCreatedView>('POST', `${boot(deviceId)}/pxe/token`, {}),
    revokePxeToken: (deviceId: string) =>
      call<PxeTokenView>('DELETE', `${boot(deviceId)}/pxe/token`),
  };
}

export type BootApi = ReturnType<typeof bootApi>;

/** The boot calls of the app's client (see the file header). */
export function useBootApi(): BootApi {
  return useServices().api;
}
