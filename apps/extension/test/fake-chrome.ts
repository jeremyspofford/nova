// A fake of the browser's extension API subset the bridge uses (src/chrome.ts): tabs, groups,
// the debugger, permissions, the badge, a native port the test plays the host on, session
// storage, history while its permission is held, and our own pages' messages.
import type {
  ChromeApi,
  ChromeEvent,
  ChromeTab,
  HistoryItem,
  NativePort,
  PermissionsSet,
} from '../src/chrome.ts';

class Event<A extends unknown[], R = void> implements ChromeEvent<A, R> {
  readonly listeners: ((...args: A) => R)[] = [];
  addListener(fn: (...args: A) => R): void {
    this.listeners.push(fn);
  }
  fire(...args: A): R[] {
    return this.listeners.map((fn) => fn(...args));
  }
}

export class FakePort implements NativePort {
  readonly sent: Record<string, unknown>[] = [];
  readonly onMessage = new Event<[unknown]>();
  readonly onDisconnect = new Event<[]>();
  disconnected = false;
  postMessage(message: unknown): void {
    this.sent.push(message as Record<string, unknown>);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  /** The host sends a message. */
  receive(message: unknown): void {
    this.onMessage.fire(message);
  }
  events(): Record<string, unknown>[] {
    return this.sent
      .filter((m) => m.type === 'event')
      .map((m) => m.event as Record<string, unknown>);
  }
}

export class FakeChrome {
  readonly ports: FakePort[] = [];
  connectError: string | null = null;
  lastError: { message?: string } | undefined = undefined;
  readonly tabs = new Map<number, ChromeTab>();
  readonly groups = new Map<number, { title?: string; color?: string }>();
  nextTab = 100;
  nextGroup = 1;
  readonly attached = new Set<number>();
  readonly commands: { tabId: number; method: string; params: unknown }[] = [];
  readonly origins = new Set<string>();
  readonly perms = new Set<string>();
  /** What `permissions.request` answers (the user's choice in the browser's prompt). */
  grantRequests = true;
  readonly badges = new Map<number, string>();
  readonly titles = new Map<number, string>();
  readonly windows: string[] = [];
  readonly session = new Map<string, unknown>();
  historyItems: HistoryItem[] = [];
  readonly historySearches: { text: string; maxResults: number }[] = [];
  readonly onMessage = new Event<[unknown, unknown, (r: unknown) => void], boolean | undefined>();
  readonly onRemoved = new Event<[number]>();
  readonly onDetach = new Event<[{ tabId: number }, string]>();
  readonly onAdded = new Event<[PermissionsSet]>();
  readonly onPermRemoved = new Event<[PermissionsSet]>();

  get port(): FakePort {
    const p = this.ports.at(-1);
    if (!p) throw new Error('no port');
    return p;
  }

  addTab(url: string, title = ''): number {
    const id = this.nextTab++;
    this.tabs.set(id, { id, url, title, groupId: -1 });
    return id;
  }

  /** The user (or the browser) withdraws a site's permission. */
  withdraw(origin: string): void {
    this.origins.delete(origin);
    this.onPermRemoved.fire({ origins: [origin] });
  }

  api(): ChromeApi {
    // The API's getters (lastError, history) read the fake's live state.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const has = (p: { origins?: string[]; permissions?: string[] }) =>
      (p.origins ?? []).every((o) => self.origins.has(o) || self.origins.has('<all_urls>')) &&
      (p.permissions ?? []).every((x) => self.perms.has(x));
    return {
      runtime: {
        connectNative: () => {
          if (self.connectError) throw new Error(self.connectError);
          const p = new FakePort();
          self.ports.push(p);
          return p;
        },
        getManifest: () => ({ version: '0.7.5' }),
        get lastError() {
          return self.lastError;
        },
        onMessage: self.onMessage,
        sendMessage: () => Promise.resolve(undefined),
        getURL: (path) => `chrome-extension://nova/${path}`,
      },
      tabs: {
        get: (id) => {
          const t = self.tabs.get(id);
          return t
            ? Promise.resolve({ ...t })
            : Promise.reject(new Error(`No tab with id: ${id}.`));
        },
        query: () => Promise.resolve([...self.tabs.values()].slice(0, 1)),
        create: (p) => {
          const id = self.addTab(p.url);
          return Promise.resolve({ ...self.tabs.get(id)! });
        },
        group: (p) => {
          if (p.groupId !== undefined && !self.groups.has(p.groupId))
            return Promise.reject(new Error('No group with id'));
          const gid = p.groupId ?? self.nextGroup++;
          if (!self.groups.has(gid)) self.groups.set(gid, {});
          for (const id of p.tabIds) self.tabs.get(id)!.groupId = gid;
          return Promise.resolve(gid);
        },
        onRemoved: self.onRemoved,
      },
      tabGroups: {
        update: (gid, p) => {
          self.groups.set(gid, { ...self.groups.get(gid), ...p });
          return Promise.resolve({});
        },
      },
      debugger: {
        attach: (t) => {
          if (self.attached.has(t.tabId))
            return Promise.reject(new Error('Another debugger is already attached to the tab'));
          self.attached.add(t.tabId);
          return Promise.resolve();
        },
        detach: (t) => {
          self.attached.delete(t.tabId);
          return Promise.resolve();
        },
        sendCommand: (t, method, params) => {
          self.commands.push({ tabId: t.tabId, method, params });
          if (method === 'Page.navigate') {
            const tab = self.tabs.get(t.tabId)!;
            tab.url = (params as { url: string }).url;
          }
          return Promise.resolve({ ok: method });
        },
        onDetach: self.onDetach,
      },
      permissions: {
        contains: (p) => Promise.resolve(has(p)),
        request: (p) => {
          if (!self.grantRequests) return Promise.resolve(false);
          for (const o of p.origins ?? []) self.origins.add(o);
          for (const x of p.permissions ?? []) self.perms.add(x);
          if (p.origins?.length) self.onAdded.fire({ origins: p.origins });
          return Promise.resolve(true);
        },
        remove: (p) => {
          for (const x of p.permissions ?? []) self.perms.delete(x);
          for (const o of p.origins ?? []) self.origins.delete(o);
          return Promise.resolve(true);
        },
        getAll: () => Promise.resolve({ origins: [...self.origins], permissions: [...self.perms] }),
        onAdded: self.onAdded,
        onRemoved: self.onPermRemoved,
      },
      action: {
        setBadgeText: (p) => {
          if (p.tabId !== undefined) self.badges.set(p.tabId, p.text);
          return Promise.resolve();
        },
        setBadgeBackgroundColor: () => Promise.resolve(),
        setTitle: (p) => {
          if (p.tabId !== undefined) self.titles.set(p.tabId, p.title);
          return Promise.resolve();
        },
      },
      windows: {
        create: (p) => {
          self.windows.push(p.url);
          return Promise.resolve({ id: self.windows.length });
        },
      },
      get history() {
        return self.perms.has('history')
          ? {
              search: (q: { text: string; maxResults: number }) => {
                self.historySearches.push({ text: q.text, maxResults: q.maxResults });
                return Promise.resolve(self.historyItems);
              },
            }
          : undefined;
      },
      storage: {
        session: {
          get: (key) =>
            Promise.resolve(self.session.has(key) ? { [key]: self.session.get(key) } : {}),
          set: (items) => {
            for (const [k, v] of Object.entries(items)) self.session.set(k, structuredClone(v));
            return Promise.resolve();
          },
        },
      },
    };
  }
}
