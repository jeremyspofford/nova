// The fake Hub's M8 extensions part (FR-117), in memory, with the Hub's rules from
// apps/hub/src/sdk.ts + packages/core/src/sdk/service.ts:
// - every route is the owner's (403 `policy_denied` `{reason: owner_only}` for a member);
// - a bundle is "read" from the upload: the tests' bundles are JSON (a `FakeBundle`) in base64, or
//   a path in `bundlesOnHub`; a bundle whose signature does not match is refused at preview (400
//   `validation` `{reason: signature_invalid}`), one without extension.json too (`not_an_extension`),
//   one asking for the Hub's data (`fs_scope_refused`); a missing path answers `not found on the Hub`;
// - install needs a live preview (410 `request_expired`); managed policy that forbids unverified
//   installs refuses an unverified one (403 `policy_denied` `{reason: managed}`); an unverified one
//   needs `confirmSideload` (400 `validation` `{field, reason: sideload_confirmation_required}`); an
//   update keeps the extension's place and shows the permission diff in its preview;
// - SDK hooks are hook rows (source `extension`) in the hooks area's list, so `POST /hooks/:id/trust`
//   trusts them; an update changes their hashes (the bundle digest is part of it), so they need
//   trust again; the extension's view reads their status from there;
// - a running extension (enabled, and `sdk.enabled` on) contributes its commands, panels, themes,
//   keybindings, menus and status items; a command runs with `commandResults` (default ok);
// - secrets: only declared names (400 otherwise), never returned; uninstall removes them, and
//   `removeData` is recorded.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m8extensions: M8ExtensionsState`,
// `createHub` defaults it to `m8ExtensionsState()`, and `impl` spreads
// `...m8ExtensionsImpl(state.m8extensions, { setting, hooks })` (after the M4 part, whose
// `trustHook` it wraps). Until then tests use `renderWithExtensions` or `withExtensions`.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  resolveSetting,
  type ExtensionCommandResult,
  type ExtensionContributionsView,
  type ExtensionHookView,
  type ExtensionPermissionLine,
  type ExtensionPreviewView,
  type ExtensionView,
  type HookView,
  type InstallExtensionRequest,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError, type Api } from '../src/api.ts';
import type { ExtensionsApi } from '../src/extensions/api-m8.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import type { CommandRegistry } from '../src/commands.ts';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { MEMBER_ID, m7TeamState } from './fakes-m7-team.ts';

// ---- bundles ---------------------------------------------------------------------------------------

export interface FakeHookDef {
  id: string;
  event: string;
  matcher?: string | null;
  failClosed?: boolean;
  timeoutMs?: number;
}

/** What a `.novax` holds, as far as the fake Hub reads it. */
export interface FakeBundle {
  id: string;
  name: string;
  version: string;
  description?: string | null;
  /** `invalid`: the files do not match the signature (refused). */
  signature: 'verified' | 'unverified' | 'invalid';
  publisher?: { key: string; name: string } | null;
  digest?: string;
  permissions?: ExtensionPermissionLine[];
  hooks?: FakeHookDef[];
  secrets?: string[];
  notExtension?: boolean;
  fsRefused?: boolean;
  warnings?: string[];
  contributes?: Partial<Omit<ExtensionContributionsView, 'themes'>> & {
    themes?: Record<string, unknown>[];
  };
}

/** A bundle as a test file's text (the fake decodes uploads as this JSON). */
export function bundleFile(b: FakeBundle, name = `${b.id}-${b.version}.novax`): File {
  return new File([JSON.stringify(b)], name, { type: 'application/octet-stream' });
}

export const PUBLISHER_KEY = 'KWyGeoNcQVUoD7fIgkwppFWhQZbPo5ynx1JyVjt5-O0';

export function wordCount(over: Partial<FakeBundle> = {}): FakeBundle {
  return {
    id: 'com.examplelabs.word-count',
    name: 'Word count',
    version: '1.0.0',
    description: 'Counts the words, sentences and reading time of a text.',
    signature: 'verified',
    publisher: { key: PUBLISHER_KEY, name: 'Example Labs' },
    digest: 'a'.repeat(64),
    permissions: [
      {
        key: 'command:count',
        kind: 'command',
        text: 'Add the command “Count words”',
        sensitive: false,
      },
      {
        key: 'tool:count',
        kind: 'tool',
        text: 'Offer the tool count, which reads data',
        sensitive: false,
      },
    ],
    hooks: [],
    secrets: [],
    contributes: {
      commands: [{ extensionId: '', id: 'count', title: 'Count words' }],
      statusItems: [{ extensionId: '', id: 'words', text: '120 words', command: 'count' }],
      menus: [
        {
          extensionId: '',
          where: 'thread',
          items: [{ id: 'count-thread', title: 'Count words in this chat', command: 'count' }],
        },
      ],
      keybindings: [
        {
          extensionId: '',
          command: 'ext:com.examplelabs.word-count/count',
          key: 'ctrl+alt+w',
          when: null,
        },
      ],
      themes: [],
      panels: [],
    },
    ...over,
  };
}

/** UTF-8 text as base64, the way a browser sends a file's bytes. */
export function toBase64(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(data: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
}

// ---- state ----------------------------------------------------------------------------------------

interface Installed {
  view: ExtensionView;
  bundle: FakeBundle;
  secretValues: Map<string, string>;
}

export interface M8ExtensionsState {
  installed: Installed[];
  /** Bundles and folders on the Hub's disk, by path. */
  bundlesOnHub: Record<string, FakeBundle>;
  previews: Map<string, { bundle: FakeBundle; dev: boolean }>;
  /** `<extensionId>/<commandId>` → what running it answers (default: ok, no result). */
  commandResults: Record<string, ExtensionCommandResult>;
  /** Every uninstall, with whether its data went too. */
  uninstalls: { id: string; removeData: boolean }[];
  /** Every call answers 403 `owner_only` (a member signed in). */
  member: boolean;
  seq: number;
}

export function m8ExtensionsState(init: Partial<M8ExtensionsState> = {}): M8ExtensionsState {
  return {
    installed: [],
    bundlesOnHub: {},
    previews: new Map(),
    commandResults: {},
    uninstalls: [],
    member: false,
    seq: 0,
    ...init,
  };
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

export interface M8ExtensionsHelpers {
  setting: (key: string) => unknown;
  /** The hooks area's list (SDK hooks are rows of it). */
  hooks: { list: () => HookView[]; set: (list: HookView[]) => void };
}

const hookRef = (extId: string, hookId: string) => `hook:${extId}.${hookId}`;
const hashOf = (extId: string, h: FakeHookDef, digest: string) => {
  // A stable fake hash that changes with the bundle's digest (as the real one does).
  let x = 0;
  for (const c of `${extId}|${h.id}|${h.event}|${h.matcher ?? ''}|${digest}`)
    x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return `sha256:${x.toString(16).padStart(8, '0').repeat(8)}`;
};

function publisherView(b: FakeBundle, trusted: { name: string; key: string }[]) {
  const key = b.publisher?.key ?? null;
  const t = key ? trusted.find((p) => p.key === key) : undefined;
  return {
    key,
    name: t?.name ?? null,
    fingerprint: key ? key.slice(0, 16).toLowerCase() : null,
    trusted: !!t,
  };
}

export function m8ExtensionsImpl(st: M8ExtensionsState, h: M8ExtensionsHelpers) {
  const owner = () => {
    if (st.member)
      throw err(403, 'policy_denied', 'only the owner of this Hub can do that', {
        reason: 'owner_only',
      });
  };
  const trusted = () => {
    const v = h.setting('plugins.trustedPublishers');
    return Array.isArray(v) ? (v as { name: string; key: string }[]) : [];
  };
  const sdkOn = () => h.setting('sdk.enabled') !== false;
  const isVerified = (b: FakeBundle, dev: boolean) =>
    !dev &&
    b.signature === 'verified' &&
    !!b.publisher &&
    trusted().some((p) => p.key === b.publisher!.key);
  const unverifiedForbidden = () => {
    const r = h.setting('managed.restrict') as { layers?: { unverifiedInstalls?: boolean }[] };
    return (r.layers ?? []).some((l) => l.unverifiedInstalls === false);
  };
  const find = (id: string) => {
    const e = st.installed.find((x) => x.view.id === id);
    if (!e) throw err(404, 'not_found', 'extension not found');
    return e;
  };
  const hookViews = (e: Installed): ExtensionHookView[] => {
    const rows = h.hooks.list();
    return (e.bundle.hooks ?? []).map((d) => {
      const id = hookRef(e.view.id, d.id);
      const row = rows.find((r) => r.id === id);
      return {
        id,
        event: d.event,
        matcher: d.matcher ?? null,
        contentHash: hashOf(e.view.id, d, e.bundle.digest ?? ''),
        failClosed: d.failClosed ?? d.event === 'tool.pre',
        timeoutMs: d.timeoutMs ?? 30_000,
        status: row?.status ?? 'needs_trust',
      };
    });
  };
  const running = (e: Installed) => e.view.enabled && sdkOn() && e.view.status !== 'error';
  const view = (e: Installed): ExtensionView => {
    const c = e.bundle.contributes ?? {};
    const status: ExtensionView['status'] = !e.view.enabled
      ? 'disabled'
      : !sdkOn()
        ? 'stopped'
        : e.view.status === 'error'
          ? 'error'
          : 'running';
    return {
      ...e.view,
      verified: e.view.signature === 'verified' && publisherView(e.bundle, trusted()).trusted,
      publisher: publisherView(e.bundle, trusted()),
      status,
      hooks: hookViews(e),
      secrets: (e.bundle.secrets ?? []).map((name) => ({ name, set: e.secretValues.has(name) })),
      registered: {
        commands: c.commands?.length ?? 0,
        panels: c.panels?.length ?? 0,
        tools: 0,
        hooks: e.bundle.hooks?.length ?? 0,
        themes: c.themes?.length ?? 0,
        keybindings: c.keybindings?.length ?? 0,
        menus: c.menus?.length ?? 0,
        statusItems: c.statusItems?.length ?? 0,
        events: 0,
      },
    };
  };
  const readSource = (
    source: { kind: 'upload'; bundle: string } | { kind: 'path'; path: string },
  ) => {
    let b: FakeBundle;
    if (source.kind === 'path') {
      const found = st.bundlesOnHub[source.path];
      if (!found) throw err(400, 'validation', `not found on the Hub: ${source.path}`);
      b = found;
    } else {
      try {
        b = JSON.parse(fromBase64(source.bundle)) as FakeBundle;
      } catch {
        throw err(400, 'validation', 'This bundle was refused: it is not a .novax bundle.', {
          reason: 'signature_invalid',
          why: 'not_a_bundle',
        });
      }
    }
    if (b.signature === 'invalid')
      throw err(400, 'validation', 'This bundle was refused: its signature does not match.', {
        reason: 'signature_invalid',
        why: 'digest_mismatch',
      });
    if (b.notExtension)
      throw err(400, 'validation', 'not an extension: .nova-plugin/extension.json is missing', {
        reason: 'not_an_extension',
      });
    if (b.fsRefused)
      throw err(
        400,
        'validation',
        "extension.json permissions.fs: /data would reach the Hub's own data",
        {
          reason: 'fs_scope_refused',
        },
      );
    return b;
  };
  const syncHooks = (e: Installed, trust: { id: string; contentHash: string }[]) => {
    const keep = h.hooks
      .list()
      .filter((r) => !(r.source === 'extension' && r.pluginId === e.view.id));
    const rows: HookView[] = (e.bundle.hooks ?? []).map((d) => {
      const id = hookRef(e.view.id, d.id);
      const contentHash = hashOf(e.view.id, d, e.bundle.digest ?? '');
      const before = h.hooks.list().find((r) => r.id === id);
      const trustedNow = trust.some((t) => t.id === id && t.contentHash === contentHash);
      const stillTrusted = before?.status === 'trusted' && before.contentHash === contentHash;
      return {
        id,
        source: 'extension',
        pluginId: e.view.id,
        event: d.event as HookView['event'],
        matcher: d.matcher ?? null,
        handler: { type: 'mcp_tool', tool: `ext:${e.view.id}/hooks/${d.id}` },
        timeoutMs: d.timeoutMs ?? 30_000,
        contentHash,
        status: trustedNow || stillTrusted ? 'trusted' : 'needs_trust',
        enabled: e.view.enabled,
        lastRun: null,
        changedSinceTrust: !!before && before.status === 'trusted' && !stillTrusted && !trustedNow,
      };
    });
    h.hooks.set([...keep, ...rows]);
  };

  const api: ExtensionsApi = {
    listExtensions: async () => {
      owner();
      return { items: st.installed.map(view) };
    },
    getExtension: async (id) => {
      owner();
      return view(find(id));
    },
    previewExtension: async (source) => {
      owner();
      const b = readSource(source);
      const previewId = `xp-${++st.seq}`;
      st.previews.set(previewId, { bundle: b, dev: false });
      const current = st.installed.find((x) => x.view.id === b.id) ?? null;
      const verified = isVerified(b, false);
      const sideloadReason = verified
        ? null
        : !b.publisher
          ? 'the bundle is not signed'
          : 'it is signed by a key you do not trust';
      const lines = b.permissions ?? [];
      const diff = current
        ? {
            added: lines.filter((l) => !current.bundle.permissions?.some((x) => x.key === l.key)),
            removed: (current.bundle.permissions ?? []).filter(
              (l) => !lines.some((x) => x.key === l.key),
            ),
          }
        : null;
      const pv: ExtensionPreviewView = {
        previewId,
        id: b.id,
        name: b.name,
        version: b.version,
        description: b.description ?? null,
        api: 1,
        signature: verified ? 'verified' : 'unverified',
        verified,
        publisher: publisherView(b, trusted()),
        digest: b.digest ?? 'f'.repeat(64),
        sideloadReason,
        permissions: lines,
        diff,
        hooks: (b.hooks ?? []).map((d) => ({
          id: hookRef(b.id, d.id),
          event: d.event,
          matcher: d.matcher ?? null,
          contentHash: hashOf(b.id, d, b.digest ?? ''),
          failClosed: d.failClosed ?? d.event === 'tool.pre',
          timeoutMs: d.timeoutMs ?? 30_000,
          status: 'needs_trust',
        })),
        pluginHooks: [],
        warnings: [
          ...(verified
            ? []
            : [`Unverified: ${sideloadReason}. Install it only if you trust where it came from.`]),
          ...(b.warnings ?? []),
          ...(diff?.added.length
            ? [`This update asks for more: ${diff.added.map((l) => l.text).join('; ')}.`]
            : []),
        ],
        replaces: current ? { version: current.view.version } : null,
      };
      return pv;
    },
    installExtension: async (body: InstallExtensionRequest) => {
      owner();
      const p = st.previews.get(body.previewId);
      if (!p) throw err(410, 'request_expired', 'the extension preview expired; preview it again');
      const b = p.bundle;
      const verified = isVerified(b, p.dev);
      if (!verified && unverifiedForbidden())
        throw err(
          403,
          'policy_denied',
          'Installing an unverified extension is not allowed by your organization: only signed ones from trusted publishers install',
          { reason: 'managed' },
        );
      if (!verified && body.confirmSideload !== true)
        throw err(400, 'validation', 'confirm that you want to install an unverified extension', {
          field: 'confirmSideload',
          reason: 'sideload_confirmation_required',
        });
      st.previews.delete(body.previewId);
      const now = new Date().toISOString();
      const current = st.installed.find((x) => x.view.id === b.id);
      const e: Installed = {
        bundle: b,
        secretValues: current?.secretValues ?? new Map(),
        view: {
          id: b.id,
          name: b.name,
          version: b.version,
          description: b.description ?? null,
          api: 1,
          signature: p.dev ? 'dev' : verified ? 'verified' : 'unverified',
          verified,
          publisher: publisherView(b, trusted()),
          digest: b.digest ?? 'f'.repeat(64),
          enabled: body.enable ?? true,
          status: 'running',
          error: null,
          permissions: b.permissions ?? [],
          hooks: [],
          registered: {
            commands: 0,
            panels: 0,
            tools: 0,
            hooks: 0,
            themes: 0,
            keybindings: 0,
            menus: 0,
            statusItems: 0,
            events: 0,
          },
          secrets: [],
          installedAt: current?.view.installedAt ?? now,
          updatedAt: now,
        },
      };
      st.installed = [...st.installed.filter((x) => x.view.id !== b.id), e];
      syncHooks(e, body.trustHooks ?? []);
      return view(e);
    },
    setExtensionEnabled: async (id, enabled) => {
      owner();
      const e = find(id);
      e.view = { ...e.view, enabled, status: enabled ? 'running' : 'disabled', error: null };
      h.hooks.set(
        h.hooks
          .list()
          .map((r) => (r.source === 'extension' && r.pluginId === id ? { ...r, enabled } : r)),
      );
      return view(e);
    },
    uninstallExtension: async (id, opts = {}) => {
      owner();
      find(id);
      st.installed = st.installed.filter((x) => x.view.id !== id);
      h.hooks.set(h.hooks.list().filter((r) => !(r.source === 'extension' && r.pluginId === id)));
      st.uninstalls.push({ id, removeData: opts.removeData === true });
      return { ok: true } as const;
    },
    extensionContributions: async () => {
      owner();
      const out: ExtensionContributionsView = {
        commands: [],
        panels: [],
        themes: [],
        keybindings: [],
        menus: [],
        statusItems: [],
      };
      for (const e of st.installed) {
        if (!running(e)) continue;
        const c = e.bundle.contributes ?? {};
        const extensionId = e.view.id;
        out.commands.push(...(c.commands ?? []).map((x) => ({ ...x, extensionId })));
        out.panels.push(...(c.panels ?? []).map((x) => ({ ...x, extensionId })));
        out.themes.push(...(c.themes ?? []).map((theme) => ({ extensionId, theme })));
        out.keybindings.push(...(c.keybindings ?? []).map((x) => ({ ...x, extensionId })));
        out.menus.push(...(c.menus ?? []).map((x) => ({ ...x, extensionId })));
        out.statusItems.push(...(c.statusItems ?? []).map((x) => ({ ...x, extensionId })));
      }
      return out;
    },
    runExtensionCommand: async (id, command) => {
      owner();
      const e = st.installed.find((x) => x.view.id === id);
      if (
        !e ||
        !running(e) ||
        !(e.bundle.contributes?.commands ?? []).some((c) => c.id === command)
      )
        throw err(404, 'not_found', `the command ${command} is not available`);
      return st.commandResults[`${id}/${command}`] ?? { ok: true, result: null, error: null };
    },
    clickExtensionStatus: async (id, item) => {
      owner();
      const e = st.installed.find((x) => x.view.id === id);
      const s =
        e && running(e) ? e.bundle.contributes?.statusItems?.find((x) => x.id === item) : null;
      if (!e || !s) throw err(404, 'not_found', 'status item not found');
      if (s.command) return api.runExtensionCommand(id, s.command);
      return { ok: true, result: null, error: null };
    },
    setExtensionSecret: async (id, name, value) => {
      owner();
      const e = find(id);
      if (!(e.bundle.secrets ?? []).includes(name))
        throw err(400, 'validation', `${id} does not declare the secret ${name}`);
      e.secretValues.set(name, value);
      return { ok: true } as const;
    },
    clearExtensionSecret: async (id, name) => {
      owner();
      find(id).secretValues.delete(name);
      return { ok: true } as const;
    },
  };
  return api;
}

export type M8ExtensionsMocks = {
  [K in keyof ExtensionsApi]: Mock<ExtensionsApi[K]>;
} & ExtensionsApi;

/** Spread the extensions part over a fake Hub (what `createApi` will do once it spreads it). */
export function withExtensions(
  hub: ReturnType<typeof createHub>,
  init: Partial<M8ExtensionsState> = {},
): { state: M8ExtensionsState; api: M8ExtensionsMocks } {
  const state = m8ExtensionsState(init);
  const impl = m8ExtensionsImpl(state, {
    setting: (k) =>
      resolveSetting(k as never, { global: hub.state.settings, managed: hub.state.managed }).value,
    hooks: {
      list: () => hub.state.m4.hooks,
      set: (list) => {
        hub.state.m4.hooks = list;
      },
    },
  });
  const mocks = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as M8ExtensionsMocks;
  Object.assign(hub.api, mocks);
  return { state, api: mocks };
}

/** Install a bundle straight into the fake (as if previewed and installed earlier). */
export async function installed(
  ext: M8ExtensionsMocks,
  b: FakeBundle,
  opts: { trust?: boolean; enable?: boolean } = {},
): Promise<ExtensionView> {
  const p = await ext.previewExtension({ kind: 'upload', bundle: toBase64(JSON.stringify(b)) });
  const v = await ext.installExtension({
    previewId: p.previewId,
    confirmSideload: true,
    enable: opts.enable ?? true,
    ...(opts.trust
      ? { trustHooks: p.hooks.map((x) => ({ id: x.id, contentHash: x.contentHash })) }
      : {}),
  });
  ext.previewExtension.mockClear();
  ext.installExtension.mockClear();
  return v;
}

/**
 * Render `ui` with the main fake Hub's client and the extensions part spread over it. `member`
 * signs in as a member of the Hub: the team role says so and every extension call answers
 * `owner_only`.
 */
export async function renderWithExtensions(
  ui: ReactNode,
  opts: {
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
    member?: boolean;
    extensions?: Partial<M8ExtensionsState>;
    bundles?: { bundle: FakeBundle; trust?: boolean; enable?: boolean }[];
    registry?: CommandRegistry;
    /** Set up the rest of the fake Hub before rendering (entry points, files…). */
    prepare?: (hub: ReturnType<typeof createHub>) => void;
  } = {},
) {
  const hub = createHub(opts.member ? { m7team: m7TeamState({ me: MEMBER_ID }) } : {});
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  opts.prepare?.(hub);
  const ext = withExtensions(hub, { member: opts.member ?? false, ...opts.extensions });
  for (const b of opts.bundles ?? []) await installed(ext.api, b.bundle, b);
  const api = hub.api as unknown as Api;
  const registry = opts.registry ?? testRegistry();
  const { settings } = await hub.api.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, { children: ui }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry,
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { hub, ext: ext.api, state: ext.state, registry, ...utils };
}
