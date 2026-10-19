// M8 Hub client calls of the extensions area (FR-117; docs/14 §4-§5, docs/26 §3; ADR-097 D1-D3), in
// the conventions of src/api.ts: the installed extensions, the install preview (an uploaded
// `.novax` or a bundle or folder on the Hub), install, on and off, uninstall (with or without its
// data), the declared secrets (write-only), what running extensions add to the client, and running
// a contributed command or status item. Every route is the Hub owner's. `createApi` spreads
// `extensionsApi(call)` into the client; `useExtensionsApi` reads the calls from the services
// object, or null for a client without them (a test double, or a member's shell before it loads).
import type {
  ExtensionCommandResult,
  ExtensionContributionsView,
  ExtensionPreviewView,
  ExtensionSource,
  ExtensionView,
  InstallExtensionRequest,
} from '@nova/shared';
import type { HubCall } from '../devices/api.ts';
import { useServices } from '../services.tsx';

const V1 = '/api/v1';
const enc = encodeURIComponent;
const ext = (id: string) => `${V1}/extensions/${enc(id)}`;

export function extensionsApi(call: HubCall) {
  return {
    listExtensions: () => call<{ items: ExtensionView[] }>('GET', `${V1}/extensions`),
    getExtension: (id: string) => call<ExtensionView>('GET', ext(id)),
    /** Check a bundle and say what installing it would do; nothing is installed. */
    previewExtension: (source: ExtensionSource) =>
      call<ExtensionPreviewView>('POST', `${V1}/extensions/preview`, { source }),
    /** Install the previewed bundle; an unverified one needs `confirmSideload: true`. */
    installExtension: (body: InstallExtensionRequest) =>
      call<ExtensionView>('POST', `${V1}/extensions`, body),
    setExtensionEnabled: (id: string, enabled: boolean) =>
      call<ExtensionView>('PATCH', ext(id), { enabled }),
    /** Secrets always go; the extension's own data folder only with `removeData`. */
    uninstallExtension: (id: string, opts: { removeData?: boolean } = {}) =>
      call<{ ok: true }>('DELETE', `${ext(id)}${opts.removeData ? '?removeData=true' : ''}`),
    /** What running extensions add: commands, panels, themes, keybindings, menus, status items. */
    extensionContributions: () =>
      call<ExtensionContributionsView>('GET', `${V1}/extensions/contributions`),
    runExtensionCommand: (id: string, command: string, args?: unknown) =>
      call<ExtensionCommandResult>(
        'POST',
        `${ext(id)}/commands/${enc(command)}/run`,
        args === undefined ? {} : { args },
      ),
    clickExtensionStatus: (id: string, item: string) =>
      call<ExtensionCommandResult>('POST', `${ext(id)}/status/${enc(item)}/click`, {}),
    /** Write-only: the value goes to the Hub's vault and is never returned. */
    setExtensionSecret: (id: string, name: string, value: string) =>
      call<{ ok: true }>('PUT', `${ext(id)}/secrets/${enc(name)}`, { value }),
    clearExtensionSecret: (id: string, name: string) =>
      call<{ ok: true }>('DELETE', `${ext(id)}/secrets/${enc(name)}`),
  };
}

export type ExtensionsApi = ReturnType<typeof extensionsApi>;

/** The extension calls of the app's client, or null when it has none of them. */
export function useExtensionsApi(): ExtensionsApi | null {
  const api = useServices().api as unknown as Partial<ExtensionsApi>;
  return typeof api.listExtensions === 'function' &&
    typeof api.extensionContributions === 'function'
    ? (api as ExtensionsApi)
    : null;
}
