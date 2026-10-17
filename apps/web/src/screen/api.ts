// Hub client calls for computer use (FR-093, FR-207, FR-098, FR-087, FR-075; docs/11 §5, §6), in
// the conventions of src/api.ts. `createApi` spreads `screenApi(call)` into the client, so `Api`
// includes these; until then `useScreenApi` reads them from the same services object.
//
// The live view is a WebSocket at `screenLivePath(id, surface)` (opened with the services'
// `webSocket` factory; the session cookie goes with the handshake). The Hub sends
// `{type:'state', status}` on open and on every change, `{type:'frame', surface, image, ...}`
// every 2 s, `{type:'input.ack', ok, error}` and `{type:'error', error:{code,message}}`; the
// client sends `{type:'input', action}` (desktop), `{type:'input', browser}` (browser page),
// `{type:'kill'}` and `{type:'refresh'}`.
import type { z } from 'zod';
import type {
  AppshotView,
  ComputerView,
  ScreenActionView,
  ScreenGrantView,
  ScreenObservationView,
  ScreenStatusView,
  ScreenTakeoverView,
  appshotCreateSchema,
  screenGrantSchema,
  takeoverInputSchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export type ScreenSurface = 'desktop' | 'browser';

const V1 = '/api/v1';
const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const computer = (id: string) => `${V1}/computers/${enc(id)}`;

export function screenApi(call: HubCall) {
  return {
    /** The computers whose control state the global indicator follows. */
    listScreenComputers: () => call<{ items: ComputerView[] }>('GET', `${V1}/computers`),

    // ---- status, enablement, kill key (FR-093, FR-207) -----------------------------------------
    screenStatus: (id: string) => call<ScreenStatusView>('GET', `${computer(id)}/screen`),
    /** The explicit enablement toggle; turning it off stops control like the kill key. */
    setScreenControl: (id: string, enabled: boolean) =>
      call<ScreenStatusView>('PUT', `${computer(id)}/screen/control`, { enabled }),
    /** The kill key: control stops at once and stays stopped until resumed. */
    killScreen: (id: string) => call<ScreenStatusView>('POST', `${computer(id)}/screen/kill`, {}),
    resumeScreen: (id: string) =>
      call<ScreenStatusView>('POST', `${computer(id)}/screen/resume`, {}),
    /** A screenshot with the windows and their tiers; 409 when there is no controlled desktop. */
    screenObservation: (id: string) =>
      call<ScreenObservationView>('GET', `${computer(id)}/screen/observation`),
    /** The current frame as a PNG from the Hub; `nonce` defeats caching between refreshes. */
    screenFrameUrl: (id: string, surface: ScreenSurface, nonce = 0) =>
      `${computer(id)}/screen/frame${query({ surface, n: nonce || undefined })}`,

    // ---- grants (FR-207) -----------------------------------------------------------------------
    listScreenGrants: (id: string, all = false) =>
      call<{ items: ScreenGrantView[] }>(
        'GET',
        `${computer(id)}/screen/grants${query({ all: all ? 'true' : undefined })}`,
      ),
    /** 403 `policy_denied` for an app Nova never controls; an active grant is renewed instead. */
    grantScreenApp: (id: string, body: z.input<typeof screenGrantSchema>) =>
      call<ScreenGrantView>('POST', `${computer(id)}/screen/grants`, body),
    /** 409 for a revoked grant. */
    renewScreenGrant: (id: string, grantId: string) =>
      call<ScreenGrantView>('POST', `${computer(id)}/screen/grants/${enc(grantId)}/renew`, {}),
    revokeScreenGrant: (id: string, grantId: string) =>
      call<ScreenGrantView>('DELETE', `${computer(id)}/screen/grants/${enc(grantId)}`),

    // ---- recorded actions (FR-098) -------------------------------------------------------------
    /** Newest first; `before` pages back from an action id. */
    listScreenActions: (id: string, q: { limit?: number; before?: string } = {}) =>
      call<{ items: ScreenActionView[] }>(
        'GET',
        `${computer(id)}/screen/actions${query({ ...q })}`,
      ),
    screenShotUrl: (id: string, actionId: string, which: 'before' | 'after') =>
      `${computer(id)}/screen/actions/${enc(actionId)}/${which}`,

    // ---- takeover (FR-087) ---------------------------------------------------------------------
    getTakeover: (id: string) =>
      call<{ takeover: ScreenTakeoverView | null }>('GET', `${computer(id)}/takeover`),
    /** 409 when it is already taken over, or the browser cannot be taken over. */
    startTakeover: (id: string, surface: ScreenSurface = 'desktop') =>
      call<ScreenTakeoverView>('POST', `${computer(id)}/takeover`, { surface }),
    takeoverInput: (id: string, body: z.input<typeof takeoverInputSchema>) =>
      call<{ ok: boolean; error: string | null }>('POST', `${computer(id)}/takeover/input`, body),
    /** Return control: the agent resumes and observes again. 409 when not taken over. */
    endTakeover: (id: string) =>
      call<ScreenTakeoverView>('POST', `${computer(id)}/takeover/end`, {}),
    /** The live view's socket path, for the services' `webSocket` factory. */
    screenLivePath: (id: string, surface: ScreenSurface) =>
      `${computer(id)}/screen/live${query({ surface })}`,

    // ---- appshots (FR-075) ---------------------------------------------------------------------
    captureAppshot: (id: string, body: z.input<typeof appshotCreateSchema> = {}) =>
      call<AppshotView>('POST', `${computer(id)}/appshots`, body),
    listAppshots: (q: { computerId?: string; threadId?: string; limit?: number } = {}) =>
      call<{ items: AppshotView[] }>('GET', `${V1}/appshots${query({ ...q })}`),
    getAppshot: (appshotId: string) => call<AppshotView>('GET', `${V1}/appshots/${enc(appshotId)}`),
    /** The appshot's image (its artifact's content). */
    appshotImageUrl: (artifactId: string) => `${V1}/artifacts/${enc(artifactId)}/content`,
  };
}

export type ScreenApi = ReturnType<typeof screenApi>;

/** The screen calls of the app's client (part of `Api` once `createApi` spreads them in). */
export function useScreenApi(): ScreenApi {
  const api: unknown = useServices().api;
  return api as ScreenApi;
}
