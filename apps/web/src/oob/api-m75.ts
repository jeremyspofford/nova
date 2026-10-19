// Hub client calls for out-of-band management (FR-147; docs/23 §7; ADR-096 D6), in the
// conventions of src/api.ts: the Hub reaches the BMCs the owner registers (Redfish over HTTPS with
// a pinned certificate, IPMI through ipmitool) under /api/v1/oob. Every route is the owner's.
// Turning it on needs the explicit consent body `{confirm: true}`; the settings route refuses it.
// `createApi` spreads `oobApi(call)` into the client; until then `useOobApi` reads the calls from
// the same services object and is null when the client has none (an older client), so the views
// stay out of the page instead of failing it.
import type { z } from 'zod';
import type {
  OobAction,
  OobActionView,
  OobEndpointView,
  OobStatusView,
  createOobEndpointSchema,
  oobBiosApplySchema,
  oobBiosPlanSchema,
  oobBootNextSchema,
  updateOobEndpointSchema,
} from '@nova/shared';
import type { HubCall } from '../devices/api.ts';
import { useServices } from '../services.tsx';

const V1 = '/api/v1';
const enc = encodeURIComponent;

/** The body each action takes (`OOB_ACTION_BODY_SCHEMAS`): most take none. */
export type OobActionBody<A extends OobAction> = A extends 'bios.plan'
  ? z.input<typeof oobBiosPlanSchema>
  : A extends 'bios.apply'
    ? z.input<typeof oobBiosApplySchema>
    : A extends 'boot.next'
      ? z.input<typeof oobBootNextSchema>
      : Record<string, never>;

export function oobApi(call: HubCall) {
  return {
    /** Whether it is on, which kinds are built, the read actions and how many BMCs there are. */
    getOobStatus: () => call<OobStatusView>('GET', `${V1}/oob`),
    /** Only after the consent dialog: the Hub refuses anything but `{confirm: true}`. */
    enableOob: (consent: { confirm: true }) =>
      call<OobStatusView>('POST', `${V1}/oob/enable`, consent),
    /** Waiting approvals are withdrawn; BMCs and their credentials stay. */
    disableOob: () => call<OobStatusView>('POST', `${V1}/oob/disable`, {}),
    listOobEndpoints: () => call<{ items: OobEndpointView[] }>('GET', `${V1}/oob/endpoints`),
    /** Needs it on. Credentials go to the Hub's vault and are never returned. */
    createOobEndpoint: (body: z.input<typeof createOobEndpointSchema>) =>
      call<OobEndpointView>('POST', `${V1}/oob/endpoints`, body),
    getOobEndpoint: (id: string) => call<OobEndpointView>('GET', `${V1}/oob/endpoints/${enc(id)}`),
    /**
     * `tlsPin: null` forgets the pin (read again on the next check, to confirm again); an entered
     * pin counts as confirmed; a new address clears it. Waiting cards and approved plans of the
     * BMC are withdrawn (`endpoint_changed`): an approval names the BMC as it was.
     */
    updateOobEndpoint: (id: string, body: z.input<typeof updateOobEndpointSchema>) =>
      call<OobEndpointView>('PATCH', `${V1}/oob/endpoints/${enc(id)}`, body),
    /**
     * Accept the certificate fingerprint a first check read (SSH-style): only then does the Hub
     * send the BMC its credentials. 409 `pin_changed` when the BMC now presents another one.
     */
    confirmOobPin: (id: string, tlsPin: string) =>
      call<OobEndpointView>('POST', `${V1}/oob/endpoints/${enc(id)}/pin/confirm`, { tlsPin }),
    /** Works while it is off; waiting approvals for the BMC are withdrawn. */
    deleteOobEndpoint: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/oob/endpoints/${enc(id)}`),
    /**
     * Read actions come back `done` (or fail); `bios.apply` runs an approved plan; every other
     * action comes back `awaiting_approval` with its approval card (202).
     */
    oobAction: <A extends OobAction>(id: string, action: A, body?: OobActionBody<A>) =>
      call<{ action: OobActionView }>(
        'POST',
        `${V1}/oob/endpoints/${enc(id)}/actions/${action}`,
        body ?? {},
      ),
    /** The action log, newest first. */
    listOobActions: (q: { endpointId?: string; limit?: number } = {}) => {
      const p = new URLSearchParams();
      if (q.endpointId) p.set('endpointId', q.endpointId);
      if (q.limit) p.set('limit', String(q.limit));
      const s = p.toString();
      return call<{ items: OobActionView[] }>('GET', `${V1}/oob/actions${s ? `?${s}` : ''}`);
    },
    getOobAction: (id: string) => call<OobActionView>('GET', `${V1}/oob/actions/${enc(id)}`),
  };
}

export type OobApi = ReturnType<typeof oobApi>;

/** The calls of the app's client, or null when it has none of them yet. */
export function useOobApi(): OobApi | null {
  const api = useServices().api as unknown as Partial<OobApi>;
  return typeof api.getOobStatus === 'function' ? (api as OobApi) : null;
}
