// M7.5 Hub client calls of the firmware area (FR-146; docs/23 §6; ADR-096 D3-D4), in the
// conventions of src/api.ts: the two global toggles, the hardware support matrix, and per device
// the read-through view, plan (a dry run with a snapshot), approval, apply, rollback, history and
// the write-only BIOS admin password. Every route is the owner's. `createApi` spreads
// `firmwareApi(call)` into the client; `useFirmwareApi` reads the calls from the services object.
import type {
  FirmwareChangeInput,
  FirmwareChangeView,
  FirmwareHistoryView,
  FirmwarePolicyRequest,
  FirmwarePolicyView,
  FirmwareReadView,
  FirmwareSupportEntry,
} from '@nova/shared';
import type { HubCall } from '../devices/api.ts';
import { useServices } from '../services.tsx';

const V1 = '/api/v1';
const enc = encodeURIComponent;
const fw = (id: string) => `${V1}/devices/${enc(id)}/firmware`;

/** `GET /api/v1/devices/:id/firmware`: the view plus whether the Hub's vault holds a BIOS password. */
export type FirmwareRead = FirmwareReadView & { adminPasswordStored: boolean };

export function firmwareApi(call: HubCall) {
  return {
    /** The two toggles (`devices.firmware.allowChanges`, `...allowSecurityDegrading`). */
    getFirmwarePolicy: () => call<FirmwarePolicyView>('GET', `${V1}/devices/firmware/policy`),
    /** Turning either toggle on needs `confirm: true` (403 `consent_required` otherwise). */
    setFirmwarePolicy: (body: FirmwarePolicyRequest) =>
      call<FirmwarePolicyView>('PUT', `${V1}/devices/firmware/policy`, body),
    /** Which machines Nova can change firmware settings on. */
    getFirmwareSupport: () =>
      call<{ items: FirmwareSupportEntry[] }>('GET', `${V1}/devices/firmware/support`),
    /** Read through the device (cached 60 s on the Hub; `fresh` reads again). */
    readFirmware: (deviceId: string, opts: { fresh?: boolean } = {}) =>
      call<FirmwareRead>('GET', `${fw(deviceId)}${opts.fresh ? '?fresh=1' : ''}`),
    /** A dry run: the diff and a snapshot of the current values; nothing changes. */
    planFirmware: (deviceId: string, changes: FirmwareChangeInput[]) =>
      call<FirmwareChangeView>('POST', `${fw(deviceId)}/plan`, { changes }),
    getFirmwareChange: (deviceId: string, changeId: string) =>
      call<FirmwareChangeView>('GET', `${fw(deviceId)}/changes/${enc(changeId)}`),
    /** Open the Hub-only approval card for a planned change (or a denied/expired one again). */
    requestFirmwareApproval: (deviceId: string, changeId: string, note?: string) =>
      call<FirmwareChangeView>(
        'POST',
        `${fw(deviceId)}/changes/${enc(changeId)}/request-approval`,
        note ? { note } : {},
      ),
    /** Run an approved change; `reboot` restarts through novad with its watchdog armed. */
    applyFirmwareChange: (deviceId: string, changeId: string, opts: { reboot?: boolean } = {}) =>
      call<FirmwareChangeView>('POST', `${fw(deviceId)}/changes/${enc(changeId)}/apply`, {
        reboot: opts.reboot === true,
      }),
    /** Plan restoring a snapshot and open its own approval card; it runs with apply. */
    rollbackFirmwareSnapshot: (deviceId: string, snapshotId: string, note?: string) =>
      call<FirmwareChangeView>(
        'POST',
        `${fw(deviceId)}/snapshots/${enc(snapshotId)}/rollback`,
        note ? { note } : {},
      ),
    getFirmwareHistory: (deviceId: string, limit?: number) =>
      call<FirmwareHistoryView>('GET', `${fw(deviceId)}/history${limit ? `?limit=${limit}` : ''}`),
    /** Write-only: the password goes to the Hub's vault and is never returned. */
    setBiosPassword: (deviceId: string, password: string) =>
      call<{ stored: boolean }>('PUT', `${fw(deviceId)}/admin-password`, { password }),
    clearBiosPassword: (deviceId: string) =>
      call<{ stored: boolean }>('DELETE', `${fw(deviceId)}/admin-password`),
  };
}

export type FirmwareApi = ReturnType<typeof firmwareApi>;

/** The firmware calls of the app's client (see the file header). */
export function useFirmwareApi(): FirmwareApi {
  return useServices().api;
}
