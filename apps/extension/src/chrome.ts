// The part of the browser's extension API this extension uses, typed by hand (the repo carries
// no browser typings). Callback-free, promise-based Manifest V3 forms only. Tests give a fake
// with the same shape (test/fake-chrome.ts); nothing here reads cookies, passwords or storage of
// a page: the extension has no `cookies` permission and asks for no host access by default.

export interface ChromeEvent<A extends unknown[], R = void> {
  addListener(fn: (...args: A) => R): void;
}

export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<[unknown]>;
  onDisconnect: ChromeEvent<[]>;
}

export interface ChromeTab {
  id?: number;
  url?: string;
  /** The address a navigation is going to, before it commits. */
  pendingUrl?: string;
  status?: 'loading' | 'complete' | 'unloaded';
  title?: string;
  groupId?: number;
  windowId?: number;
}

export interface DebuggeeTarget {
  tabId: number;
}

export interface PermissionsSet {
  origins?: string[];
  permissions?: string[];
}

export interface HistoryItem {
  url?: string;
  title?: string;
  lastVisitTime?: number;
}

export interface ChromeApi {
  runtime: {
    connectNative(application: string): NativePort;
    getManifest(): { version: string };
    /** The last error of a callback API (set by the browser when a port fails). */
    lastError?: { message?: string } | undefined;
    /** Messages from our own pages (popup, prompt); `true` keeps the answer channel open. */
    onMessage: ChromeEvent<[unknown, unknown, (response: unknown) => void], boolean | undefined>;
    sendMessage(message: unknown): Promise<unknown>;
    getURL(path: string): string;
  };
  tabs: {
    get(tabId: number): Promise<ChromeTab>;
    query(q: { active?: boolean; currentWindow?: boolean }): Promise<ChromeTab[]>;
    create(p: { url: string; active?: boolean }): Promise<ChromeTab>;
    group(p: { tabIds: number[]; groupId?: number }): Promise<number>;
    onRemoved: ChromeEvent<[number]>;
  };
  tabGroups: {
    update(groupId: number, p: { title?: string; color?: string }): Promise<unknown>;
  };
  debugger: {
    attach(target: DebuggeeTarget, version: string): Promise<void>;
    detach(target: DebuggeeTarget): Promise<void>;
    sendCommand(target: DebuggeeTarget, method: string, params?: object): Promise<unknown>;
    onDetach: ChromeEvent<[DebuggeeTarget, string]>;
  };
  permissions: {
    contains(p: PermissionsSet): Promise<boolean>;
    request(p: PermissionsSet): Promise<boolean>;
    remove(p: PermissionsSet): Promise<boolean>;
    getAll(): Promise<PermissionsSet>;
    onAdded: ChromeEvent<[PermissionsSet]>;
    onRemoved: ChromeEvent<[PermissionsSet]>;
  };
  action: {
    setBadgeText(p: { tabId?: number; text: string }): Promise<void>;
    setBadgeBackgroundColor(p: { tabId?: number; color: string }): Promise<void>;
    setTitle(p: { tabId?: number; title: string }): Promise<void>;
  };
  windows: {
    create(p: { url: string; type: 'popup'; width: number; height: number }): Promise<{
      id?: number;
    }>;
  };
  /** Present only while the optional `history` permission is held (one request at a time). */
  history?: {
    search(q: { text: string; maxResults: number; startTime: number }): Promise<HistoryItem[]>;
  };
  storage: {
    session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}
