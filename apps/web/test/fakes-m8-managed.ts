// The fake Hub's M8 managed-policy part (FR-106), in memory, with the Hub's rules from
// apps/hub/src/managed.ts and packages/core/src/managed:
// - `GET /api/v1/managed` answers the view. The route is classified for members
//   (packages/core/src/team/routes.ts), but the handler still checks the owner, so a member gets
//   403 `policy_denied` `{reason: owner_only}`; `memberCanRead: true` gives a member the view (what
//   the classification intends);
// - `POST /api/v1/managed/reload` is the owner's (403 `owner_only` for a member) and reads the
//   policy again: `next` when a test set one, else the same policy (with a new `checkedAt`);
// - the managed settings layer is what the view sets plus `managed.restrict` (always present in
//   the Hub's layer, so always locked): `managedLayerOf(view)`; a reload updates the layer through
//   `setLayer`, as the Hub's `settingsLayer` does.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m8managed: M8ManagedState`,
// `createHub` defaults it to `m8ManagedState()`, and `impl` spreads
// `...m8ManagedImpl(state.m8managed, { maybeFail, isMember: () => state.m7team.me !== OWNER_ID,
// setLayer: (l) => { state.managed = l } })`. Until then tests use `renderWithManaged`, which
// spreads it over `createHub().api`.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import type { ManagedPolicyView, ManagedRestrict, ManagedSourceView } from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { ManagedApi } from '../src/managed/api-m8.ts';
import { ManagedLockNotes } from '../src/managed/ManagedNote.tsx';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { MEMBER_ID, m7TeamState } from './fakes-m7-team.ts';

export const LOCAL_PATH = '/etc/nova/managed-settings.json';
export const REMOTE_URL = 'https://policy.corp.example/nova.json';
const CHECKED = '2026-10-01T12:00:00.000Z';

export function localSource(over: Partial<ManagedSourceView> = {}): ManagedSourceView {
  return {
    channel: 'local',
    location: LOCAL_PATH,
    status: 'absent',
    problem: null,
    inForce: false,
    cached: false,
    serial: null,
    loadedAt: null,
    checkedAt: CHECKED,
    ...over,
  };
}

/** No policy file, no remote policy: nothing applies. */
export function noPolicy(): ManagedPolicyView {
  return {
    active: false,
    failClosed: null,
    sources: [localSource()],
    settings: [],
    restrict: [],
    egress: null,
    ignored: [],
    checkedAt: CHECKED,
  };
}

/**
 * J10 step 2: the policy file locks Bypass mode and network (and the theme), as the Hub compiles
 * `{settings: {'appearance.theme': 'dark'}, restrict: {permissionModes: {deny: ['bypass']},
 * egress: {mode: 'off'}}}`.
 */
export function lockPolicy(over: Partial<ManagedPolicyView> = {}): ManagedPolicyView {
  const restrict: ManagedRestrict = {
    permissionModes: { deny: ['bypass'] },
    egress: { mode: 'off' },
  };
  return {
    active: true,
    failClosed: null,
    sources: [
      localSource({
        status: 'active',
        inForce: true,
        serial: 3,
        loadedAt: CHECKED,
      }),
    ],
    settings: [
      { key: 'appearance.theme', value: 'dark', channel: 'local', derivedFrom: null },
      {
        key: 'code.allowBypass',
        value: false,
        channel: 'local',
        derivedFrom: 'restrict.permissionModes',
      },
      {
        key: 'tools.approvalPolicy',
        value: 'defaults',
        channel: 'local',
        derivedFrom: 'restrict.permissionModes',
      },
      { key: 'network.egressMode', value: 'off', channel: 'local', derivedFrom: 'restrict.egress' },
    ],
    restrict: [{ channel: 'local', restrict }],
    ignored: [
      {
        channel: 'local',
        key: 'relay.url',
        reason: 'unordered',
        message:
          'relay.url is security-relevant and Nova cannot tell whether this value tightens it, so managed policy cannot set it',
      },
      {
        channel: 'local',
        key: 'privacy.crashReports',
        reason: 'loosens',
        message:
          'privacy.crashReports: managed policy can only tighten security settings, and this value is looser than the default',
      },
    ],
    checkedAt: CHECKED,
    ...over,
    egress: over.egress ?? null,
  };
}

/** What the Hub's managed settings layer carries for a view. */
export function managedLayerOf(view: ManagedPolicyView): Record<string, unknown> {
  return {
    ...Object.fromEntries(view.settings.map((s) => [s.key, s.value])),
    'managed.restrict': {
      layers: view.restrict.map((r) => r.restrict),
      failClosed: view.failClosed,
    },
  };
}

export interface M8ManagedState {
  view: ManagedPolicyView;
  /** What the next reload reads; null: the same policy. */
  next: ManagedPolicyView | null;
  /** The Hub answers members the view (the route's classification). */
  memberCanRead: boolean;
}

export function m8ManagedState(init: Partial<M8ManagedState> = {}): M8ManagedState {
  return { view: noPolicy(), next: null, memberCanRead: false, ...init };
}

const ownerOnly = () =>
  new ApiError(403, {
    code: 'policy_denied',
    message: "only the Hub's owner can see or reload its managed policy",
    retryable: false,
    details: { reason: 'owner_only' },
  });

export function m8ManagedImpl(
  st: M8ManagedState,
  helpers: {
    maybeFail?: (name: never) => void;
    isMember: () => boolean;
    setLayer?: (layer: Record<string, unknown>) => void;
  },
): ManagedApi {
  const fail = (name: string) => helpers.maybeFail?.(name as never);
  return {
    getManagedPolicy: async () => {
      fail('getManagedPolicy');
      if (helpers.isMember() && !st.memberCanRead) throw ownerOnly();
      return structuredClone(st.view);
    },
    reloadManagedPolicy: async () => {
      fail('reloadManagedPolicy');
      if (helpers.isMember()) throw ownerOnly();
      const now = new Date(Date.parse(st.view.checkedAt) + 60_000).toISOString();
      const base = st.next ?? st.view;
      st.next = null;
      st.view = {
        ...base,
        checkedAt: now,
        sources: base.sources.map((s) => ({ ...s, checkedAt: now })),
      };
      helpers.setLayer?.(managedLayerOf(st.view));
      return structuredClone(st.view);
    },
  };
}

export type ManagedMocks = { [K in keyof ManagedApi]: Mock<ManagedApi[K]> };

/**
 * Render `ui` with the main fake Hub's client and the managed part spread over it (what
 * `createApi` will do). The Hub's settings carry the view's managed layer; `as: 'member'` signs in
 * as Alex.
 */
export async function renderWithManaged(
  ui: ReactNode,
  opts: {
    managed?: Partial<M8ManagedState>;
    as?: 'owner' | 'member';
    settings?: Record<string, unknown>;
    /** Without the managed calls (an older Hub client). */
    unsupported?: boolean;
    /** Runs before the first render (to make the first load fail, say). */
    prepare?: (mocks: ManagedMocks) => void;
  } = {},
) {
  const member = opts.as === 'member';
  const hub = createHub(member ? { m7team: m7TeamState({ me: MEMBER_ID }) } : {});
  const state = m8ManagedState(opts.managed);
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = managedLayerOf(state.view);
  const impl = m8ManagedImpl(state, {
    isMember: () => member,
    setLayer: (l) => {
      hub.state.managed = l;
    },
  });
  const mocks = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as ManagedMocks;
  opts.prepare?.(mocks);
  // An older client lacks the managed calls the base fake hub now has: drop them.
  const older = Object.fromEntries(
    Object.entries(hub.api).filter(([k]) => !(k in mocks)),
  ) as typeof hub.api;
  const api = opts.unsupported ? older : { ...hub.api, ...mocks };
  const { settings } = await hub.api.settings();
  // As App.tsx: locked @nova/ui fields draw the note that names the policy's source.
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, {
      children: createElement(ManagedLockNotes, { children: ui }),
    }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { hub, api: mocks, state, ...utils };
}
