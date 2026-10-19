// What running extensions add to the client (FR-117, docs/14 §4.1): one shared copy per Hub client
// of `GET /api/v1/extensions/contributions` (commands, panels, themes, keybindings, menus, status
// items) and the installed extensions' names, read once by every view that shows contributions
// (the command palette, the status bar, the context menus, the composer's + menu, Appearance and
// Keyboard). It is read again when an extension changes, starts, stops or changes what it
// registered, when the SDK switch changes, and when the event stream reconnects. A member, or a
// Hub without the extensions area, gets nothing (never an error in the shell).
import { useSyncExternalStore } from 'react';
import type { ExtensionContributionsView } from '@nova/shared';
import { subscribeHubEvents } from '../hub-events.ts';
import { useServices } from '../services.tsx';
import type { EventSourceFactory } from '../sse.ts';
import { useExtensionsApi, type ExtensionsApi } from './api-m8.ts';

/** Events after which the contributions are read again. */
export const CONTRIBUTION_EVENTS = [
  'extension.changed',
  'extension.status.changed',
  'extension.contributions.changed',
  'settings.changed',
] as const;

export interface ContributionsState {
  contributions: ExtensionContributionsView;
  /** Installed extensions' names by id (for categories and "From <name>"). */
  names: ReadonlyMap<string, string>;
  /** The first read finished (successfully or not). */
  loaded: boolean;
}

export const EMPTY_CONTRIBUTIONS: ExtensionContributionsView = {
  commands: [],
  panels: [],
  themes: [],
  keybindings: [],
  menus: [],
  statusItems: [],
};

const EMPTY: ContributionsState = {
  contributions: EMPTY_CONTRIBUTIONS,
  names: new Map(),
  loaded: false,
};

class ContributionsStore {
  readonly #api: ExtensionsApi;
  readonly #events: EventSourceFactory;
  readonly #listeners = new Set<() => void>();
  #state: ContributionsState = EMPTY;
  #running = false;
  #again = false;
  #offStream: (() => void) | null = null;

  constructor(api: ExtensionsApi, events: EventSourceFactory) {
    this.#api = api;
    this.#events = events;
  }

  snapshot = (): ContributionsState => this.#state;

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    if (this.#listeners.size === 1) this.#start();
    return () => {
      this.#listeners.delete(fn);
      if (this.#listeners.size === 0) this.#stop();
    };
  };

  /** Read again (one read at a time; a request during a read asks for one more). */
  refresh = (): void => {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    void (async () => {
      do {
        this.#again = false;
        const [c, list] = await Promise.allSettled([
          this.#api.extensionContributions(),
          this.#api.listExtensions(),
        ]);
        const contributions = c.status === 'fulfilled' ? c.value : EMPTY_CONTRIBUTIONS;
        const names = new Map(
          list.status === 'fulfilled' ? list.value.items.map((e) => [e.id, e.name]) : [],
        );
        this.#set({ contributions, names, loaded: true });
      } while (this.#again);
      this.#running = false;
    })();
  };

  #set(next: ContributionsState): void {
    this.#state = next;
    for (const fn of [...this.#listeners]) fn();
  }

  #start(): void {
    this.refresh();
    this.#offStream = subscribeHubEvents(this.#events, CONTRIBUTION_EVENTS, {
      onEvent: (env) => {
        if (env.name === 'settings.changed' && env.payload.key !== 'sdk.enabled') return;
        this.refresh();
      },
      onOpen: () => this.refresh(),
    });
  }

  #stop(): void {
    this.#offStream?.();
    this.#offStream = null;
  }
}

const stores = new WeakMap<ExtensionsApi, ContributionsStore>();

function storeFor(api: ExtensionsApi, events: EventSourceFactory): ContributionsStore {
  let s = stores.get(api);
  if (!s) {
    s = new ContributionsStore(api, events);
    stores.set(api, s);
  }
  return s;
}

const noop = () => () => undefined;
const empty = () => EMPTY;

/** The running extensions' contributions; empty for a client without the extensions calls. */
export function useExtensionContributions(): ContributionsState {
  const api = useExtensionsApi();
  const { eventSource } = useServices();
  const store = api ? storeFor(api, eventSource) : null;
  return useSyncExternalStore(store?.subscribe ?? noop, store?.snapshot ?? empty);
}

/** Read the contributions again now (after an install, an update or a switch). */
export function useRefreshContributions(): () => void {
  const api = useExtensionsApi();
  const { eventSource } = useServices();
  return api ? storeFor(api, eventSource).refresh : () => undefined;
}

/** "From Release notes": the name of the extension a contribution comes from. */
export function extensionName(state: ContributionsState, extensionId: string): string {
  return state.names.get(extensionId) ?? extensionId;
}
