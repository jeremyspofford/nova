// The fake Hub's M8 marketplace part (FR-049, FR-012), in memory, with the Hub's rules from
// apps/hub/src/market.ts + packages/core/src/market/service.ts:
// - every route is the owner's (403 `policy_denied` `{reason: owner_only}` for a member);
// - catalogs: the built-in sample catalog (verified by its pinned key, as examples/catalog ships
//   it: Release notes, the sample plugin, Word count, Stand-up update and Aurora) plus each
//   `plugins.catalogs` entry the test describes in `catalogStates`; a catalog whose signature is
//   `invalid` lists nothing and a preview from it is refused (400 `{reason:
//   catalog_signature_invalid}`);
// - search by text, kind and catalog; an item's details; installed version and update available;
// - preview: unknown item 404; no installer for its kind 400 `capability_missing` `{reason:
//   installer_missing, kind}`; a bundle that does not match its signature 400 `{reason:
//   bundle_invalid}`; policy (kind not allowed, managed unverified installs off, the owner's
//   sideload switch) makes `allowed: false` with `blockedBy`; an installed item gets the
//   permission diff (added, removed, changed; acceptance needed only for added or changed);
// - install: an expired preview 410; policy 403 `policy_denied` `{reason: <blockedBy>}`; an
//   Unverified item without `confirmSideload` 400 `{reason: sideload_confirmation_required}`; a
//   diff not accepted by its hash 400 `{reason: permission_diff_not_accepted}`; then 201. A theme
//   lands in `appearance.customThemes`, a pet among the installed pets;
// - remove: 404 when not installed; a theme leaves `appearance.customThemes`; ratings stay here.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m8market: M8MarketState`,
// `createHub` defaults it to `m8MarketState()`, and `impl` spreads
// `...m8MarketImpl(state.m8market, { setting, writeSetting })`. Until then tests use
// `renderWithMarket` or `withMarket`.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  resolveSetting,
  type ManagedPolicyView,
  type MarketCatalogSignature,
  type MarketCatalogView,
  type MarketInstallView,
  type MarketItemDetail,
  type MarketItemKind,
  type MarketPermissionDiff,
  type MarketPermissionLine,
  type MarketPetView,
  type MarketPreview,
  type MarketRatingView,
  type MarketUnverifiedReason,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError, type Api } from '../src/api.ts';
import type { MarketApi } from '../src/market/api-m8.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { MEMBER_ID, m7TeamState } from './fakes-m7-team.ts';

// ---- items ----------------------------------------------------------------------------------------

export interface FakeItem {
  detail: MarketItemDetail;
  /** What the artifact itself declares (the preview's permissions); the card shows `detail`. */
  own?: MarketPermissionLine[];
  reasons?: MarketUnverifiedReason[];
  /** The bundle does not match its signature: refused at preview. */
  bundleInvalid?: boolean;
  details?: Record<string, unknown>;
  warnings?: string[];
  /** For a pet: what installing it adds to the installed pets. */
  pet?: MarketPetView;
  /** For a theme: the theme file installing it saves. */
  theme?: Record<string, unknown>;
}

const line = (
  key: string,
  kind: MarketPermissionLine['kind'],
  text: string,
  detail: string | null = null,
): MarketPermissionLine => ({
  key,
  kind,
  text,
  detail,
});

export function item(
  over: Partial<MarketItemDetail> & Pick<MarketItemDetail, 'id' | 'name' | 'kind'>,
): MarketItemDetail {
  return {
    catalogId: 'nova-sample',
    version: '1.0.0',
    description: null,
    author: 'Example Labs',
    publisher: { name: 'Example Labs', key: 'KWyGeoNcQVUoD7fIgkwppFWhQZbPo5ynx1JyVjt5-O0' },
    categories: [],
    verified: true,
    permissions: [],
    screenshots: 0,
    homepage: null,
    installedVersion: null,
    updateAvailable: false,
    rating: null,
    versions: [over.version ?? '1.0.0'],
    changelog: [],
    components: { hooks: [], roles: [], browserExtensions: [], uiEntryPoints: [] },
    sha256: null,
    commit: null,
    ...over,
  };
}

export const AURORA_THEME = {
  schemaVersion: 1,
  id: 'com.examplelabs.aurora',
  name: 'Aurora',
  variant: 'dark',
  tokens: {
    '--u-bg': '#0b1426',
    '--u-surface': '#13203a',
    '--u-text': '#e6f0ff',
    '--u-accent': '#5ce1b5',
  },
};

/** The built-in sample catalog's items (examples/catalog/catalog.json). */
export function sampleItems(): FakeItem[] {
  return [
    {
      detail: item({
        kind: 'plugin',
        id: 'com.examplelabs.release-notes',
        name: 'Release notes',
        description: 'Drafts release notes and a changelog entry from the changes in your project.',
        categories: ['Writing', 'Developer tools'],
        homepage: 'https://examplelabs.example/release-notes',
        permissions: [line('fs:${project}', 'fs', 'Use files in ${project}')],
        changelog: [{ version: '1.0.0', date: '2026-10-01', notes: 'First release.' }],
        screenshots: 1,
      }),
      own: [
        line('fs:${project}', 'fs', 'Use files in ${project}'),
        line('action:write', 'action_default', 'Its tools that change data ask you first', 'ask'),
      ],
      details: {
        hooks: [],
        mcpServers: [],
        skills: [{ name: 'release-notes', description: 'Draft release notes.' }],
        roles: [],
        uiEntryPoints: [],
      },
    },
    {
      detail: item({
        kind: 'plugin',
        id: 'com.example.sample',
        name: 'Sample plugin',
        author: 'Nova examples',
        publisher: null,
        description: 'A skill, a slash command, a hook, an MCP server and an MCP App panel.',
        permissions: [
          line('net:api.example.com', 'network', 'Reach api.example.com on the network'),
        ],
        components: {
          hooks: [{ id: 'hook:com.example.sample.check-fetch', event: 'tool.pre' }],
          roles: [],
          browserExtensions: [],
          uiEntryPoints: [
            { kind: 'global', title: 'Sample panel' },
            { kind: 'thread', title: 'Sample panel' },
          ],
        },
      }),
      own: [line('net:api.example.com', 'network', 'Reach api.example.com on the network')],
      details: {
        hooks: [
          {
            id: 'hook:com.example.sample.check-fetch',
            event: 'tool.pre',
            matcher: 'mcp:sample.fetch_status',
            handler: { type: 'command', command: ['node', 'hooks/check.mjs'] },
            timeoutMs: 10_000,
            contentHash: `sha256:${'9'.repeat(64)}`,
          },
        ],
        mcpServers: [{ name: 'sample', transport: 'stdio', command: 'node', url: null }],
        skills: [{ name: 'greet', description: 'Say hello.' }],
        roles: [],
        uiEntryPoints: [],
      },
    },
    {
      detail: item({
        kind: 'plugin',
        id: 'com.examplelabs.word-count',
        name: 'Word count',
        description:
          'Counts the words, sentences and reading time of a text: a tool and a command.',
        categories: ['Writing', 'Extensions'],
      }),
      details: { hooks: [], mcpServers: [], skills: [], roles: [], uiEntryPoints: [] },
    },
    {
      detail: item({
        kind: 'skill',
        id: 'standup',
        name: 'Stand-up update',
        description: 'Turns what you did, plan and are blocked on into a short stand-up update.',
        categories: ['Writing'],
      }),
      details: { description: 'A short stand-up update.', allowedTools: [] },
    },
    {
      detail: item({
        kind: 'theme',
        id: 'com.examplelabs.aurora',
        name: 'Aurora',
        description: 'A deep blue dark theme with a mint accent.',
        categories: ['Dark'],
      }),
      details: { theme: AURORA_THEME },
      theme: AURORA_THEME,
    },
  ];
}

export const SAMPLE_CATALOG: MarketCatalogView = {
  id: 'nova-sample',
  name: 'Sample catalog',
  location: '/opt/nova/examples/catalog',
  kind: 'builtin',
  signature: 'verified',
  publisher: { name: null, key: 'u4qLjk3s9PZx0f2l5m8n1o4p7q0r3s6t9u2v5w8x1y4' },
  commit: null,
  items: 5,
  error: null,
};

// ---- state ----------------------------------------------------------------------------------------

export interface M8MarketState {
  /** Catalogs besides the sample one, by id, as the Hub reads them (a `plugins.catalogs` entry's). */
  catalogStates: Record<
    string,
    { signature: MarketCatalogSignature; error?: string | null; commit?: string | null }
  >;
  items: FakeItem[];
  installed: MarketInstallView[];
  /** The permissions each installed item has now (for the update diff). */
  installedLines: Record<string, MarketPermissionLine[]>;
  ratings: MarketRatingView[];
  pets: MarketPetView[];
  previews: Map<string, { it: FakeItem; diff: MarketPermissionDiff | null; verified: boolean }>;
  /** Kinds the Hub has an installer for (MCP only once the MCP area hands one over). */
  installers: MarketItemKind[];
  /** What `GET /api/v1/managed` answers. */
  managed: ManagedPolicyView;
  member: boolean;
  seq: number;
}

export function m8MarketState(init: Partial<M8MarketState> = {}): M8MarketState {
  return {
    catalogStates: {},
    items: sampleItems(),
    installed: [],
    installedLines: {},
    ratings: [],
    pets: [],
    previews: new Map(),
    installers: ['plugin', 'skill', 'theme', 'pet', 'mcp'],
    managed: {
      active: false,
      failClosed: null,
      sources: [],
      settings: [],
      restrict: [],
      ignored: [],
      checkedAt: '2026-10-19T09:00:00.000Z',
    },
    member: false,
    seq: 0,
    ...init,
  };
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

export interface M8MarketHelpers {
  setting: (key: string) => unknown;
  writeSetting: (key: string, value: unknown) => void;
}

const keyOf = (kind: string, id: string) => `${kind}:${id}`;

function compare(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

export function m8MarketImpl(st: M8MarketState, h: M8MarketHelpers) {
  const owner = () => {
    if (st.member)
      throw err(403, 'policy_denied', 'only the owner of this Hub can do that', {
        reason: 'owner_only',
      });
  };
  const userCatalogs = () =>
    (h.setting('plugins.catalogs') as {
      id: string;
      name: string;
      location: string;
      publisherKey?: string;
      commit?: string;
    }[]) ?? [];
  const catalogs = (): MarketCatalogView[] => [
    SAMPLE_CATALOG,
    ...userCatalogs().map((c) => {
      const s = st.catalogStates[c.id] ?? { signature: 'unsigned' as const };
      const location = c.location.trim();
      const kind: MarketCatalogView['kind'] =
        /\.git(#.*)?$/.test(location) || location.startsWith('git@')
          ? 'git'
          : location.startsWith('https://')
            ? 'url'
            : 'local';
      return {
        id: c.id,
        name: c.name,
        location: c.location,
        kind,
        signature: s.signature,
        publisher: c.publisherKey ? { name: null, key: c.publisherKey } : null,
        commit: s.commit ?? c.commit ?? null,
        items:
          s.signature === 'invalid'
            ? 0
            : st.items.filter((i) => i.detail.catalogId === c.id).length,
        error: s.signature === 'invalid' ? 'bad signature' : (s.error ?? null),
      };
    }),
  ];
  const catalogUsable = (id: string) => {
    const c = catalogs().find((x) => x.id === id);
    if (!c) throw err(404, 'not_found', `catalog ${id} not found`);
    if (c.signature === 'invalid')
      throw err(400, 'validation', `${c.name} is refused: bad signature`, {
        reason: 'catalog_signature_invalid',
        catalogId: id,
      });
    return c;
  };
  const restrictLayers = () =>
    (h.setting('managed.restrict') as { layers?: { unverifiedInstalls?: boolean }[] }).layers ?? [];
  const blocked = (
    kind: MarketItemKind,
    verified: boolean,
  ): { by: MarketPreview['blockedBy']; why: string | null } => {
    const kinds = h.setting('market.allowedKinds') as MarketItemKind[];
    if (!kinds.includes(kind))
      return { by: 'kind_not_allowed', why: `installing ${kind} items is turned off` };
    if (!verified && restrictLayers().some((l) => l.unverifiedInstalls === false))
      return { by: 'managed', why: 'your organization does not allow installing unverified items' };
    if (!verified && h.setting('market.allowSideload') === false)
      return {
        by: 'sideload_disabled',
        why: 'installing unverified items is turned off in Settings',
      };
    return { by: null, why: null };
  };
  const installedOf = (kind: string, id: string) =>
    st.installed.find((x) => x.kind === kind && x.itemId === id) ?? null;
  const card = (it: FakeItem): MarketItemDetail => {
    const inst = installedOf(it.detail.kind, it.detail.id);
    const rating =
      st.ratings.find((r) => r.kind === it.detail.kind && r.itemId === it.detail.id) ?? null;
    return {
      ...it.detail,
      installedVersion: inst?.version ?? null,
      updateAvailable: !!inst && compare(it.detail.version, inst.version) > 0,
      rating,
    };
  };
  const visible = () => {
    const ok = new Set(
      catalogs()
        .filter((c) => c.signature !== 'invalid')
        .map((c) => c.id),
    );
    return st.items.filter((i) => ok.has(i.detail.catalogId));
  };
  const find = (catalogId: string, kind: MarketItemKind, id: string) => {
    const it = st.items
      .filter(
        (i) => i.detail.catalogId === catalogId && i.detail.kind === kind && i.detail.id === id,
      )
      .sort((a, b) => compare(b.detail.version, a.detail.version))[0];
    if (!it) throw err(404, 'not_found', `${id} is not in ${catalogId}`);
    return it;
  };

  const api: MarketApi = {
    listMarketCatalogs: async () => {
      owner();
      return { items: catalogs() };
    },
    searchMarket: async (q = {}) => {
      owner();
      const text = (q.q ?? '').toLowerCase();
      const items = visible()
        .filter((i) => !q.kind || i.detail.kind === q.kind)
        .filter((i) => !q.catalogId || i.detail.catalogId === q.catalogId)
        .filter(
          (i) =>
            !text ||
            i.detail.name.toLowerCase().includes(text) ||
            (i.detail.description ?? '').toLowerCase().includes(text),
        )
        .map(card)
        .map(
          ({ versions: _v, changelog: _c, components: _p, sha256: _s, commit: _m, ...view }) =>
            view,
        );
      return { items };
    },
    getMarketItem: async (catalogId, kind, id) => {
      owner();
      catalogUsable(catalogId);
      return card(find(catalogId, kind, id));
    },
    marketScreenshotUrl: (catalogId, kind, id, n) =>
      `/api/v1/market/items/${encodeURIComponent(catalogId)}/${kind}/${encodeURIComponent(id)}/screenshots/${n}`,
    previewMarketItem: async (body) => {
      owner();
      if (!st.installers.includes(body.kind))
        throw err(
          400,
          'capability_missing',
          `installing ${body.kind} items is not available on this Hub`,
          {
            reason: 'installer_missing',
            kind: body.kind,
          },
        );
      catalogUsable(body.catalogId);
      const it = find(body.catalogId, body.kind, body.id);
      if (it.bundleInvalid)
        throw err(400, 'validation', `${it.detail.name} is refused: bad signature`, {
          reason: 'bundle_invalid',
          bundle: 'digest_mismatch',
        });
      const reasons = it.reasons ?? (it.detail.verified ? [] : ['catalog_unsigned']);
      const verified = reasons.length === 0;
      const lines = it.own ?? it.detail.permissions;
      const inst = installedOf(it.detail.kind, it.detail.id);
      let diff: MarketPermissionDiff | null = null;
      if (inst) {
        const before = st.installedLines[keyOf(inst.kind, inst.itemId)] ?? inst.permissions;
        const changed = lines
          .filter((l) => before.some((b) => b.key === l.key && b.detail !== l.detail))
          .map((l) => ({
            key: l.key,
            text: l.text,
            before: before.find((b) => b.key === l.key)?.detail ?? null,
            after: l.detail,
          }));
        diff = {
          fromVersion: inst.version,
          toVersion: it.detail.version,
          added: lines.filter((l) => !before.some((b) => b.key === l.key)),
          removed: before.filter((b) => !lines.some((l) => l.key === b.key)),
          changed,
          hash: `diff-${++st.seq}`,
        };
      }
      const block = blocked(it.detail.kind, verified);
      const previewId = `mp-${++st.seq}`;
      st.previews.set(previewId, { it, diff, verified });
      const p: MarketPreview = {
        previewId,
        catalogId: it.detail.catalogId,
        kind: it.detail.kind,
        id: it.detail.id,
        name: it.detail.name,
        version: it.detail.version,
        verification: {
          status: verified ? 'verified' : 'unverified',
          reasons,
          publisher: it.detail.publisher,
        },
        permissions: lines,
        diff,
        replaces: inst ? { version: inst.version } : null,
        requires: {
          sideloadConfirmation: !verified,
          permissionAcceptance: !!diff && (diff.added.length > 0 || diff.changed.length > 0),
        },
        allowed: block.by === null,
        blockedBy: block.by,
        details: it.details ?? {},
        warnings: [
          ...(it.warnings ?? []),
          ...(block.by === 'managed' && block.why ? [block.why] : []),
        ],
        expiresAt: '2026-10-19T10:00:00.000Z',
      };
      return p;
    },
    installMarketItem: async (body) => {
      owner();
      const p = st.previews.get(body.previewId);
      if (!p) throw err(410, 'request_expired', 'the preview expired; preview the item again');
      const { it, diff, verified } = p;
      const block = blocked(it.detail.kind, verified);
      if (block.by)
        throw err(403, 'policy_denied', block.why ?? 'refused by policy', { reason: block.by });
      if (!verified && body.confirmSideload !== true)
        throw err(
          400,
          'validation',
          'this item is not verified; confirm that you want to install it unverified',
          {
            field: 'confirmSideload',
            reason: 'sideload_confirmation_required',
          },
        );
      if (
        diff &&
        (diff.added.length || diff.changed.length) &&
        body.acceptPermissions !== diff.hash
      )
        throw err(400, 'validation', 'accept the permission changes of this update to install it', {
          field: 'acceptPermissions',
          reason: 'permission_diff_not_accepted',
          diffHash: diff.hash,
        });
      st.previews.delete(body.previewId);
      const now = '2026-10-19T09:30:00.000Z';
      const before = installedOf(it.detail.kind, it.detail.id);
      const view: MarketInstallView = {
        kind: it.detail.kind,
        itemId: it.detail.id,
        name: it.detail.name,
        version: it.detail.version,
        catalogId: it.detail.catalogId,
        origin: `${it.detail.catalogId}/${it.detail.id}@${it.detail.version}`,
        verified,
        publisherKey: it.detail.publisher?.key ?? null,
        sha256: null,
        commit: null,
        permissions: it.own ?? it.detail.permissions,
        installedAt: before?.installedAt ?? now,
        updatedAt: now,
      };
      st.installed = [...st.installed.filter((x) => x !== before), view];
      st.installedLines[keyOf(view.kind, view.itemId)] = view.permissions;
      if (it.theme) {
        const themes = (h.setting('appearance.customThemes') as { id?: unknown }[]).filter(
          (t) => t.id !== it.theme!.id,
        );
        h.writeSetting('appearance.customThemes', [...themes, it.theme]);
      }
      if (it.pet) st.pets = [...st.pets.filter((x) => x.id !== it.pet!.id), it.pet];
      return view;
    },
    listMarketInstalled: async () => {
      owner();
      return { items: st.installed };
    },
    removeMarketItem: async (kind, id) => {
      owner();
      const inst = installedOf(kind, id);
      if (!inst) throw err(404, 'not_found', `${id} is not installed`);
      st.installed = st.installed.filter((x) => x !== inst);
      if (kind === 'theme')
        h.writeSetting(
          'appearance.customThemes',
          (h.setting('appearance.customThemes') as { id?: unknown }[]).filter((t) => t.id !== id),
        );
      if (kind === 'pet') st.pets = st.pets.filter((p) => p.id !== id);
      return { ok: true } as const;
    },
    listMarketRatings: async () => {
      owner();
      return { items: st.ratings };
    },
    rateMarketItem: async (body) => {
      owner();
      const r: MarketRatingView = {
        kind: body.kind,
        itemId: body.itemId,
        stars: body.stars,
        review: body.review ?? null,
        updatedAt: '2026-10-19T09:40:00.000Z',
        shared: false,
      };
      st.ratings = [...st.ratings.filter((x) => !(x.kind === r.kind && x.itemId === r.itemId)), r];
      return r;
    },
    unrateMarketItem: async (kind, id) => {
      owner();
      st.ratings = st.ratings.filter((x) => !(x.kind === kind && x.itemId === id));
      return { ok: true } as const;
    },
    listMarketPets: async () => {
      owner();
      return { items: st.pets };
    },
    marketPetFrameUrl: (petId, frame) =>
      `/api/v1/market/pets/${encodeURIComponent(petId)}/files/${frame.split('/').map(encodeURIComponent).join('/')}`,
    marketPolicySources: async () => {
      owner();
      return st.managed;
    },
  };
  return api;
}

export type M8MarketMocks = { [K in keyof MarketApi]: Mock<MarketApi[K]> } & MarketApi;

/** Spread the marketplace part over a fake Hub (what `createApi` will do once it spreads it). */
export function withMarket(
  hub: ReturnType<typeof createHub>,
  init: Partial<M8MarketState> = {},
): { state: M8MarketState; api: M8MarketMocks } {
  const state = m8MarketState(init);
  const impl = m8MarketImpl(state, {
    setting: (k) =>
      resolveSetting(k as never, { global: hub.state.settings, managed: hub.state.managed }).value,
    writeSetting: (k, v) => {
      hub.state.settings = { ...hub.state.settings, [k]: v };
    },
  });
  const mocks = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as M8MarketMocks;
  Object.assign(hub.api, mocks);
  return { state, api: mocks };
}

/** A pet as the Hub lists it once installed. */
export function pet(over: Partial<MarketPetView> = {}): MarketPetView {
  return {
    id: 'com.examplelabs.pebble',
    name: 'Pebble',
    version: '1.0.0',
    states: {
      idle: { frames: ['frames/idle-1.webp', 'frames/idle-2.webp'], fps: 4, loop: true },
      thinking: { frames: ['frames/think.webp'], fps: 1, loop: true },
    },
    ...over,
  };
}

/**
 * Render `ui` with the main fake Hub's client and the marketplace part spread over it. `member`
 * signs in as a member: the team role says so and every marketplace call answers `owner_only`.
 */
export async function renderWithMarket(
  ui: ReactNode,
  opts: {
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
    member?: boolean;
    market?: Partial<M8MarketState>;
  } = {},
) {
  const hub = createHub(opts.member ? { m7team: m7TeamState({ me: MEMBER_ID }) } : {});
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  const market = withMarket(hub, { member: opts.member ?? false, ...opts.market });
  const api = hub.api as unknown as Api;
  const { settings } = await hub.api.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, { children: ui }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { hub, market: market.api, state: market.state, ...utils };
}
