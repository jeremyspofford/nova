// The desktop shell's main process (FR-008, FR-009, FR-214, ADR-001): a client of the Hub, never
// the Hub (ADR-031). It verifies the Hub against the pinned identity before anything is sent
// (FR-134), shows the Hub's own web UI in hardened windows, and adds what a browser tab cannot:
// the tray and quick overlay, global shortcuts, windows of their own, attach window, `nova://`
// links and OS notifications.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell as osShell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage,
  type Session,
} from 'electron';
import {
  shellCaptureAttachSchema,
  shellConnectSchema,
  shellDraftRefSchema,
  shellLocalChatSchema,
  shellOpenWindowSchema,
  shellQuickSendSchema,
  shellShortcutSetSchema,
  type ShellConfig,
  type ShellShortcutView,
  type ShellStatusItemView,
} from '@nova/shared';
import { isHubSender, isLocalSender, quickSend, sendCapture } from '../actions.ts';
import { externalUrl, navigationDecision, RateLimiter } from '../allowlist.ts';
import {
  captureFrontmost,
  draftView,
  type CaptureDraft,
  type WindowLocator,
} from '../capture/index.ts';
import { loadConfig, saveConfig } from '../config.ts';
import {
  connectHub,
  parseConnectInput,
  replacementMessage,
  replacementOf,
  type ConnectOk,
} from '../connect.ts';
import { deepLinkFromArgv, routeDeepLink } from '../deeplinks.ts';
import { glyphPng } from '../glyph.ts';
import { HubClient, HubError } from '../hub-client.ts';
import { LocalRuntime, LocalRuntimeError, runtimeEndpoints } from '../local-runtime.ts';
import { changesStatus, osNotification, osNotificationFor } from '../notify.ts';
import { appPath, windowMayShow } from '../routes.ts';
import { RequestHold } from '../hold.ts';
import { runEventLoop, type HubEvent } from '../sse.ts';
import { parseAccelerator, registerShortcuts, shortcutProblems } from '../shortcuts.ts';
import { quickRows, statusItems, statusMenuLabel, statusSummary } from '../status.ts';
import { getLocale, loadLocale, localeDirection, setCatalogLoader, setLocale } from '@nova/i18n';
import { CATALOG_DIR, catalogDirLoader, resolveDesktopLocale } from '../locale.ts';
import { MENU_TEXT, PAGE_TEXT, SHELL_TEXT, draftNotes, pageText } from '../text.ts';
import {
  currentThread,
  lastUsed,
  pathOfUrl,
  windowForDetach,
  windowForLink,
  type WindowInfo,
} from '../windows.ts';
import { isolatedRedact, locatorFor, screenshot } from './capture.ts';
import {
  HUB_PARTITION,
  hardenHubSession,
  hardenLocalSession,
  type HubBinding,
} from './sessions.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RENDERER_DIR = join(SRC, 'renderer');
const RENDERER_URL = pathToFileURL(RENDERER_DIR).href;
const HUB_PRELOAD = join(SRC, 'preload', 'hub.js');
const LOCAL_PRELOAD = join(SRC, 'preload', 'local.js');
const DRAFT_TTL_MS = 15 * 60_000;

type LocalKind = 'connect' | 'quick' | 'attach';

// Titles come from SHELL_TEXT.windows when a window opens (and follow the language after).
const LOCAL_WINDOWS: Record<LocalKind, Electron.BrowserWindowConstructorOptions> = {
  connect: { width: 640, height: 780 },
  quick: {
    width: 560,
    height: 540,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
  },
  attach: { width: 780, height: 860 },
};

interface ConnectPageState {
  link?: string;
  url?: string;
  pin?: string;
  problem?: string | null;
}

type Who = 'hub' | LocalKind[];

function messageOf(err: unknown): string {
  if (err instanceof HubError) {
    if (err.status === 401) return SHELL_TEXT.signInFirst;
    return err.message;
  }
  if (err && typeof err === 'object' && 'issues' in err) return SHELL_TEXT.invalidRequest;
  return errorText(err);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

function log(msg: string, err?: unknown): void {
  console.warn(`[nova-shell] ${msg}${err ? `: ${errorText(err)}` : ''}`);
}

export class Shell {
  readonly #dataDir: string;
  #config: ShellConfig;
  #hub: (HubBinding & { pin: string }) | null = null;
  #client: HubClient | null = null;
  #hubSession: Session | null = null;
  readonly #hubWindows = new Map<number, BrowserWindow>();
  readonly #focusedAt = new Map<number, number>();
  readonly #local = new Map<LocalKind, BrowserWindow>();
  #connectState: ConnectPageState = {};
  #shortcuts: ShellShortcutView[] = [];
  #status: ShellStatusItemView[] = [];
  #signedIn = false;
  readonly #drafts = new Map<string, { draft: CaptureDraft; at: number }>();
  #events: AbortController | null = null;
  #tray: Tray | null = null;
  #statusTimer: NodeJS.Timeout | null = null;
  #reverifying: Promise<HubBinding | null> | null = null;
  readonly #notifications = new Set<Notification>();
  #locator: WindowLocator | null = null;
  #trustProblem: string | null = null;
  // FR-128: this computer's novad local runtime, reached from here only, never from a page.
  readonly #localRuntime = new LocalRuntime({
    endpoints: () =>
      runtimeEndpoints({
        settings: this.#config.localRuntime,
        env: process.env,
        platform: process.platform,
        home: homedir(),
        uid: typeof process.getuid === 'function' ? process.getuid() : null,
      }),
  });
  #localChats = 0;
  /** The Hub's `appearance.locale` while it can be read (FR-016); null follows the OS. */
  #hubLocale: string | null = null;
  // Requests to a Hub not verified yet wait here (docs/21 §9): released once it passes, failed
  // when the check fails, after 8 s, or beyond 64 waiting.
  readonly #hold = new RequestHold({
    limit: 64,
    timeoutMs: 8000,
    onHold: () => this.#verifySoon(),
    onDenied: (count, reason) =>
      log(`${count} request(s) to the Hub were not sent: it is not verified (${reason})`),
  });
  #verifying = false;
  #lastVerify = 0;
  #retryTimer: NodeJS.Timeout | null = null;
  // A page may open the system browser or new windows, but not in a loop.
  readonly #externalLimit = new RateLimiter(5, 10_000);
  readonly #windowLimit = new RateLimiter(5, 10_000);
  #redaction: ReturnType<typeof isolatedRedact> | null = null;
  #started = false;
  #quitting = false;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
    const { config, problem } = loadConfig(dataDir);
    this.#config = config;
    if (problem) this.#connectState.problem = problem;
  }

  get started(): boolean {
    return this.#started;
  }

  // ---- start and stop --------------------------------------------------------------------------

  async start(argv: readonly string[]): Promise<void> {
    setCatalogLoader(catalogDirLoader(CATALOG_DIR));
    await this.#applyLocale();
    hardenLocalSession(session.defaultSession, RENDERER_URL);
    this.#hubSession = session.fromPartition(HUB_PARTITION);
    hardenHubSession(this.#hubSession, {
      hub: () => this.#hub,
      reverify: () => this.#reverify(),
      hold: (release) => this.#hold.hold(release),
    });
    this.#locator = locatorFor(process.platform);
    this.#redaction = isolatedRedact();
    this.#registerIpc();
    this.#buildAppMenu();
    this.#createTray();
    this.#applyShortcuts();
    this.#started = true;
    setInterval(() => this.#purgeDrafts(), 60_000).unref();

    const link = deepLinkFromArgv(argv);
    const target = link ? routeDeepLink(link) : null;
    if (link && target?.kind === 'add-device') return this.showConnect({ link });
    const hub = this.#config.hub;
    if (!hub) return this.showConnect({});
    const path = target?.kind === 'path' ? target.path : '/';
    const res = await connectHub({ origins: [hub.url], pin: hub.pin, joinPath: null });
    if (res.ok) {
      await this.#useHub(res);
      this.#createHubWindow(path);
      return;
    }
    if (res.reason !== 'unreachable')
      return this.showConnect({ url: hub.url, pin: hub.pin, problem: res.message });
    // The Hub is away (FR-128): open its web UI from its offline copy, send nothing to the Hub,
    // and verify it again in the background until it answers.
    const host = new URL(hub.url).hostname.replace(/^\[|\]$/g, '');
    this.#hub = {
      origin: hub.url,
      pin: hub.pin,
      verified: false,
      trust: hub.url.startsWith('http:')
        ? { kind: 'loopback-http', host }
        : { kind: 'pinned', host, listed: [], caSha256: hub.caSha256, caPem: null },
    };
    this.#createHubWindow(path);
    this.#retryVerify();
  }

  /** While the Hub is away, check it again every 15 s; a refusal (not an outage) stops and says why. */
  #retryVerify(): void {
    const hub = this.#hub;
    if (!hub || hub.verified || this.#quitting || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.#verifyNow();
    }, 15_000);
    this.#retryTimer.unref();
  }

  /** A held request wants the Hub: check it now unless a check ran in the last 5 s. */
  #verifySoon(): void {
    if (Date.now() - this.#lastVerify < 5000) return;
    void this.#verifyNow();
  }

  async #verifyNow(): Promise<void> {
    const hub = this.#hub;
    if (!hub || hub.verified || this.#verifying) return;
    this.#verifying = true;
    this.#lastVerify = Date.now();
    try {
      const res = await connectHub({ origins: [hub.origin], pin: hub.pin, joinPath: null });
      if (this.#hub !== hub) return;
      if (res.ok) {
        await this.#useHub(res);
        // The pages were cut off from the Hub: load them again now that it is verified.
        for (const w of this.#hubWindows.values()) w.webContents.reload();
        return;
      }
      // Still away: what waits fails now (the page falls back to its offline copy).
      this.#hold.fail(res.reason === 'unreachable' ? 'unreachable' : 'refused');
      if (res.reason === 'unreachable') return this.#retryVerify();
      this.showConnect({ url: hub.origin, pin: hub.pin, problem: res.message });
    } finally {
      this.#verifying = false;
    }
  }

  stop(): void {
    this.#quitting = true;
    this.#events?.abort();
    this.#hold.fail('closed');
    this.#redaction?.close();
    globalShortcut.unregisterAll();
  }

  quit(): void {
    this.#quitting = true;
    app.quit();
  }

  // ---- the Hub ------------------------------------------------------------------------------------

  async #useHub(res: ConnectOk): Promise<void> {
    const previous = this.#config.hub;
    // A Hub this shell has no record of, or another identity (even at the same address), must
    // never get what an earlier Hub left in the session: cookies, storage, cache, credentials,
    // open connections. The session can outlive shell.json (set aside, not saved, deleted).
    if (!previous || previous.pin !== res.pin) {
      for (const w of this.#hubWindows.values()) w.destroy();
      const ses = this.#hubSession;
      if (ses) {
        await ses.clearStorageData();
        await ses.clearCache();
        await ses.clearAuthCache();
        await ses.closeAllConnections();
      }
    }
    this.#hub = { origin: res.origin, trust: res.trust, pin: res.pin, verified: true };
    this.#config = {
      ...this.#config,
      hub: {
        url: res.origin,
        pin: res.pin,
        caSha256: res.trust.kind === 'pinned' ? res.trust.caSha256 : null,
      },
    };
    this.#save();
    const ses = this.#hubSession;
    this.#client = ses ? new HubClient(res.origin, (url, init) => ses.fetch(url, init)) : null;
    // One request first, alone: Chromium fails a page load whose certificate check runs at the
    // same time as one for a main-process request (seen with Electron 44), so the first check
    // completes and is cached before windows and the event stream connect.
    if (ses) {
      await ses
        .fetch(`${res.origin}/api/v1/health`, { credentials: 'omit' })
        .then((r) => r.body?.cancel())
        .catch((err: unknown) => log('the Hub did not answer', err));
    }
    this.#hold.open();
    this.#startEvents();
    this.#scheduleStatus(0);
  }

  /** The statement check again with a fresh nonce (docs/22 §5 step 7); one at a time. */
  #reverify(): Promise<HubBinding | null> {
    if (this.#reverifying) return this.#reverifying;
    const hub = this.#hub;
    if (!hub) return Promise.resolve(null);
    this.#reverifying = connectHub({ origins: [hub.origin], pin: hub.pin, joinPath: null })
      .then((res) => {
        const current = this.#hub;
        // Said once per problem, not once per refused connection.
        if (!res.ok && res.message !== this.#trustProblem)
          this.#notify(SHELL_TEXT.distrust, res.message);
        this.#trustProblem = res.ok ? null : res.message;
        if (!res.ok || !current || res.origin !== current.origin) return null;
        current.trust = res.trust;
        return current;
      })
      .finally(() => {
        this.#reverifying = null;
      });
    return this.#reverifying;
  }

  #save(): void {
    try {
      saveConfig(this.#dataDir, this.#config);
    } catch (err) {
      log('could not save the app settings', err);
    }
  }

  // ---- links and windows ----------------------------------------------------------------------------

  handleArgv(argv: readonly string[]): void {
    const link = deepLinkFromArgv(argv);
    if (link) this.handleLink(link);
    else this.openHome();
  }

  /** Route a `nova://` link (docs/04 §5.1) to the right window. */
  handleLink(url: string): void {
    const target = routeDeepLink(url);
    if (target?.kind === 'add-device') {
      const hub = this.#hub;
      // The Hub already verified with this very pin: straight to its join page.
      if (hub && target.hubUrl === hub.origin && target.pin === hub.pin)
        return this.openLink(target.path);
      // Any other Hub: the user confirms before the shell talks to it.
      return this.showConnect({ link: url });
    }
    this.openLink(target?.path ?? '/chat');
  }

  #infos(): WindowInfo[] {
    const origin = this.#hub?.origin ?? '';
    return [...this.#hubWindows.values()]
      .filter((w) => !w.isDestroyed())
      .map((w) => ({
        id: w.id,
        path: pathOfUrl(w.webContents.getURL(), origin) ?? '/',
        focusedAt: this.#focusedAt.get(w.id) ?? 0,
      }));
  }

  /** Open a path where it belongs: the window at that place, else the one used last. */
  openLink(path: string): void {
    if (!this.#hub) return this.showConnect({});
    const choice = windowForLink(this.#infos(), path);
    this.#apply(choice, path);
  }

  /** FR-009: a thread or panel in a window of its own. */
  openDetached(path: string): void {
    if (!this.#hub) return;
    this.#apply(windowForDetach(this.#infos(), path), path);
  }

  openHome(): void {
    if (!this.#hub) return this.showConnect({});
    const last = lastUsed(this.#infos());
    const win = last ? this.#hubWindows.get(last.id) : undefined;
    if (win) this.#focus(win);
    else this.#createHubWindow('/');
  }

  #apply(choice: ReturnType<typeof windowForLink>, path: string): void {
    const win = choice.kind === 'create' ? undefined : this.#hubWindows.get(choice.id);
    if (!win || !this.#hub) {
      this.#createHubWindow(path);
      return;
    }
    if (choice.kind === 'navigate') void win.loadURL(`${this.#hub.origin}${path}`);
    this.#focus(win);
  }

  #focus(win: BrowserWindow): void {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    this.#focusedAt.set(win.id, Date.now());
  }

  #icon(size: number): NativeImage {
    return nativeImage.createFromBuffer(glyphPng(size));
  }

  #createHubWindow(path: string): BrowserWindow | null {
    const hub = this.#hub;
    if (!hub) return null;
    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 420,
      minHeight: 360,
      show: false,
      title: 'Nova',
      icon: this.#icon(128),
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#111318' : '#ffffff',
      webPreferences: {
        partition: HUB_PARTITION,
        preload: HUB_PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        spellcheck: true,
        devTools: !app.isPackaged,
      },
    });
    const id = win.id;
    this.#hubWindows.set(id, win);
    this.#focusedAt.set(id, Date.now());
    this.#guardHub(win);
    win.on('focus', () => this.#focusedAt.set(id, Date.now()));
    win.on('closed', () => {
      this.#hubWindows.delete(id);
      this.#focusedAt.delete(id);
    });
    win.once('ready-to-show', () => win.show());
    // A sign-in in the page (setup code, Add Device) shows up as a navigation: refresh then.
    win.webContents.on('did-fail-load', (_e, code, description, url, mainFrame) => {
      if (mainFrame)
        log(`the Hub page did not load (${code} ${description}) ${url.split(/[?#]/)[0]}`);
    });
    win.webContents.on('did-navigate', () => this.#afterPageChange());
    win.webContents.on('did-navigate-in-page', () => this.#afterPageChange());
    void win
      .loadURL(`${hub.origin}${path}`)
      .catch((err: unknown) => log('the Hub page did not load', err));
    return win;
  }

  #afterPageChange(): void {
    if (!this.#signedIn) {
      this.#startEvents();
      this.#scheduleStatus(500);
    }
  }

  #guardHub(win: BrowserWindow): void {
    const wc = win.webContents;
    const origin = () => this.#hub?.origin ?? 'null:';
    // The top level shows app pages only: the API also serves untrusted documents (site
    // previews, app UIs) that must never run where `window.novaShell` lives.
    const topLevelOk = (url: string) =>
      navigationDecision(url, origin()) === 'allow' &&
      windowMayShow(pathOfUrl(url, origin()) ?? '');
    wc.on('will-navigate', (details) => {
      const decision = navigationDecision(details.url, origin());
      if (decision === 'allow' && topLevelOk(details.url)) return;
      details.preventDefault();
      if (decision === 'external') this.#openExternal(details.url);
    });
    wc.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) return;
      const url = details.url;
      if (url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:')) return;
      if (navigationDecision(url, origin()) !== 'allow') details.preventDefault();
    });
    wc.on('will-redirect', (details) => {
      const ok = details.isMainFrame
        ? topLevelOk(details.url)
        : navigationDecision(details.url, origin()) === 'allow';
      if (!ok) details.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      const decision = navigationDecision(url, origin());
      if (decision === 'allow') {
        const path = pathOfUrl(url, origin()) ?? '';
        const app = appPath(path);
        if (!this.#windowLimit.take())
          log('a page opened too many windows; this one was not opened');
        else if (app) this.openDetached(app);
        // A file of the Hub's ("open in a new tab"): saved, never shown where the bridge lives.
        else if (path.startsWith('/api/v1/')) wc.downloadURL(url);
      } else if (decision === 'external') this.#openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
  }

  #openExternal(url: string): void {
    const safe = externalUrl(url);
    if (!safe) return;
    if (!this.#externalLimit.take()) {
      log('a page opened too many links in the browser; this one was not opened');
      return;
    }
    void osShell.openExternal(safe).catch((err: unknown) => log('could not open a link', err));
  }

  // ---- the shell's own pages -------------------------------------------------------------------------

  #openLocal(kind: LocalKind, search = ''): BrowserWindow {
    const existing = this.#local.get(kind);
    const file = join(RENDERER_DIR, `${kind}.html`);
    if (existing && !existing.isDestroyed()) {
      if (search || kind === 'connect') void existing.loadFile(file, { search });
      existing.show();
      existing.focus();
      return existing;
    }
    const win = new BrowserWindow({
      ...LOCAL_WINDOWS[kind],
      title: SHELL_TEXT.windows[kind],
      show: false,
      icon: this.#icon(128),
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#111318' : '#ffffff',
      webPreferences: {
        preload: LOCAL_PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: true,
        devTools: !app.isPackaged,
      },
    });
    win.setMenu(null);
    if (kind === 'quick') this.#placeQuick(win);
    const wc = win.webContents;
    wc.on('will-navigate', (details) => {
      details.preventDefault();
      if (externalUrl(details.url)) this.#openExternal(details.url);
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (externalUrl(url)) this.#openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    this.#local.set(kind, win);
    win.on('closed', () => {
      if (this.#local.get(kind) === win) this.#local.delete(kind);
      // Closing the first-run page with no Hub leaves nothing to do.
      if (kind === 'connect' && !this.#hub && !this.#quitting) this.quit();
    });
    win.once('ready-to-show', () => win.show());
    void win.loadFile(file, search ? { search } : undefined);
    return win;
  }

  #placeQuick(win: BrowserWindow): void {
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const area = display.workArea;
      const [w = 560] = win.getSize();
      win.setPosition(
        Math.round(area.x + (area.width - w) / 2),
        Math.round(area.y + area.height * 0.12),
      );
    } catch {
      win.center();
    }
  }

  showConnect(state: ConnectPageState): void {
    this.#connectState = { ...this.#connectState, ...state };
    this.#openLocal('connect');
  }

  /** The quick overlay (FR-008); pressing the shortcut again while it is in front opens Nova. */
  toggleQuick(): void {
    if (!this.#hub) return this.showConnect({});
    const q = this.#local.get('quick');
    if (q && !q.isDestroyed() && q.isVisible() && q.isFocused()) {
      q.hide();
      this.openHome();
      return;
    }
    const win = this.#openLocal('quick');
    this.#placeQuick(win);
    this.#scheduleStatus(0);
  }

  newTask(): void {
    this.openLink('/work?new=1');
  }

  /** FR-214: capture the frontmost window into a draft the user reviews before anything is sent. */
  async attachWindow(from: 'shortcut' | 'tray' | 'overlay'): Promise<void> {
    if (!this.#hub) return this.showConnect({});
    if (from === 'shortcut' && BrowserWindow.getFocusedWindow()) {
      this.#notify(SHELL_TEXT.attachWindow, SHELL_TEXT.novaInFront);
      return;
    }
    if (from === 'overlay') this.#local.get('quick')?.hide();
    // The menu or overlay closes first, so the user's window is in front again.
    if (from !== 'shortcut') await new Promise((r) => setTimeout(r, 300));
    const locator = this.#locator;
    if (!locator) return;
    const res = await captureFrontmost(locator, screenshot, {
      excludedApps: this.#config.attach.excludedApps,
      ownNames: [app.getName()],
      ownPids: [process.pid],
      ...(this.#redaction ? { redact: this.#redaction.redact } : {}),
    });
    if (!res.ok) {
      this.#notify(SHELL_TEXT.attachWindow, res.message);
      return;
    }
    this.#purgeDrafts();
    this.#drafts.set(res.draft.id, { draft: res.draft, at: Date.now() });
    this.#openLocal('attach', `?draft=${res.draft.id}`);
  }

  #purgeDrafts(): void {
    const now = Date.now();
    for (const [id, d] of this.#drafts) if (now - d.at > DRAFT_TTL_MS) this.#drafts.delete(id);
  }

  // ---- status, events, notifications -----------------------------------------------------------------

  #scheduleStatus(delayMs = 400): void {
    if (this.#statusTimer) return;
    this.#statusTimer = setTimeout(() => {
      this.#statusTimer = null;
      void this.#refreshStatus();
    }, delayMs);
  }

  async #refreshStatus(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      this.#status = statusItems(await client.statusSources());
      const was = this.#signedIn;
      this.#signedIn = true;
      // Signed in now: the Hub's language setting can be read.
      if (!was) void this.#syncHubLocale();
    } catch (err) {
      if (err instanceof HubError && err.status === 401) {
        this.#signedIn = false;
        this.#status = [];
      } else log('the status list did not load', err);
    }
    this.#updateTray();
    const quick = this.#local.get('quick');
    if (quick && !quick.isDestroyed()) quick.webContents.send('quick.status', this.#quickState());
  }

  #quickState() {
    return {
      ok: true as const,
      hubUrl: this.#hub?.origin ?? null,
      signedIn: this.#signedIn,
      status: this.#status,
      currentThreadId: currentThread(this.#infos()),
      problems: shortcutProblems(this.#shortcuts),
      // Each status row's words, in the shell's language (FR-016).
      rows: quickRows(this.#status),
    };
  }

  // ---- language (FR-016) ---------------------------------------------------------------------------

  /** The Hub's language setting, read again (sign-in, `settings.changed`). */
  async #syncHubLocale(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      this.#hubLocale = await client.localeSetting();
    } catch (err) {
      log('the language setting did not load', err);
      return;
    }
    await this.#applyLocale();
  }

  #systemLanguages(): string[] {
    try {
      const list = app.getPreferredSystemLanguages();
      if (list.length) return list;
    } catch {
      // older platforms: the app locale below
    }
    return [app.getLocale()];
  }

  /** Switch to the locale the Hub setting or the OS asks for; menus, tray and pages follow. */
  async #applyLocale(): Promise<void> {
    const tag = resolveDesktopLocale(this.#hubLocale, this.#systemLanguages());
    if (tag === getLocale()) return;
    await loadLocale(tag).catch((err: unknown) => log('the translations did not load', err));
    setLocale(tag);
    if (!this.#started) return;
    this.#buildAppMenu();
    this.#updateTray();
    for (const [kind, win] of this.#local) {
      if (win.isDestroyed()) continue;
      win.setTitle(SHELL_TEXT.windows[kind]);
      win.webContents.send('shell.text', this.#pageText(kind));
    }
    const quick = this.#local.get('quick');
    if (quick && !quick.isDestroyed()) quick.webContents.send('quick.status', this.#quickState());
  }

  #pageText(kind: LocalKind) {
    const locale = getLocale();
    return { ok: true as const, lang: locale, dir: localeDirection(locale), text: pageText(kind) };
  }

  #startEvents(): void {
    this.#events?.abort();
    const hub = this.#hub;
    const ses = this.#hubSession;
    if (!hub || !ses || !hub.verified) return;
    const ctl = new AbortController();
    this.#events = ctl;
    void runEventLoop({
      signal: ctl.signal,
      open: (lastId, signal) =>
        ses.fetch(`${hub.origin}/api/v1/events/stream`, {
          headers: { accept: 'text/event-stream', ...(lastId ? { 'last-event-id': lastId } : {}) },
          credentials: 'include',
          signal,
        }),
      onEvent: (e) => this.#onEvent(e),
      onState: ({ connected, signedOut }) => {
        if (connected) this.#scheduleStatus(0);
        if (signedOut && this.#signedIn) {
          this.#signedIn = false;
          this.#updateTray();
        }
      },
    });
  }

  #onEvent(e: HubEvent): void {
    const req = osNotificationFor(e);
    if (req) {
      const client = this.#client;
      void (
        client ? client.notification(req.notificationId).catch(() => null) : Promise.resolve(null)
      ).then((stored) => {
        const n = osNotification(req, stored);
        this.#notify(n.title, n.body, n.path);
      });
    }
    if (changesStatus(e)) this.#scheduleStatus();
    if (e.name === 'settings.changed') void this.#syncHubLocale();
  }

  #notify(title: string, body: string, path?: string): void {
    if (!Notification.isSupported()) {
      log(`${title}: ${body}`);
      return;
    }
    const n = new Notification({ title, body, icon: this.#icon(64) });
    this.#notifications.add(n);
    n.on('click', () => {
      if (path) this.openLink(path);
    });
    n.on('close', () => this.#notifications.delete(n));
    n.show();
  }

  // ---- tray, menus, shortcuts ------------------------------------------------------------------------

  #trayImage(): NativeImage {
    const mac = process.platform === 'darwin';
    const badge = this.#status.some((s) => s.status === 'needs_input');
    const image = nativeImage.createFromBuffer(glyphPng(mac ? 16 : 32, { template: mac, badge }));
    if (mac) {
      image.addRepresentation({ scaleFactor: 2, buffer: glyphPng(32, { template: true, badge }) });
      image.setTemplateImage(true);
    }
    return image;
  }

  #createTray(): void {
    try {
      this.#tray = new Tray(this.#trayImage());
      this.#tray.setToolTip('Nova');
      this.#tray.on('click', () => this.toggleQuick());
      this.#updateTray();
    } catch (err) {
      log('no tray on this desktop', err);
      this.#tray = null;
    }
  }

  #updateTray(): void {
    const tray = this.#tray;
    if (!tray || tray.isDestroyed()) return;
    tray.setImage(this.#trayImage());
    tray.setToolTip(statusSummary(this.#status));
    const rows: MenuItemConstructorOptions[] = this.#status.slice(0, 6).map((item) => ({
      label: statusMenuLabel(item),
      click: () => this.openLink(item.path),
    }));
    if (rows.length === 0)
      rows.push({
        label: !this.#hub
          ? MENU_TEXT.notConnected
          : this.#signedIn
            ? MENU_TEXT.nothingWaiting
            : MENU_TEXT.signInToSee,
        enabled: false,
      });
    const problems: MenuItemConstructorOptions[] = shortcutProblems(this.#shortcuts).map((p) => ({
      label: p,
      enabled: false,
    }));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: MENU_TEXT.quickChat, click: () => this.toggleQuick() },
        { label: MENU_TEXT.newTask, click: () => this.newTask() },
        { label: MENU_TEXT.attachWindow, click: () => void this.attachWindow('tray') },
        { type: 'separator' },
        ...rows,
        { type: 'separator' },
        ...(problems.length ? [...problems, { type: 'separator' as const }] : []),
        { label: MENU_TEXT.openNova, click: () => this.openHome() },
        { label: MENU_TEXT.quitNova, click: () => this.quit() },
      ]),
    );
  }

  #buildAppMenu(): void {
    const mac = process.platform === 'darwin';
    const current = () => {
      const last = lastUsed(this.#infos());
      return last?.path ?? '/';
    };
    // No accelerators on these items: inside a window the web UI owns the keyboard (docs/04 §5).
    const template: MenuItemConstructorOptions[] = [
      ...(mac ? [{ role: 'appMenu' as const }] : []),
      {
        label: mac ? MENU_TEXT.file : 'Nova',
        submenu: [
          { id: 'quick-chat', label: MENU_TEXT.quickChat, click: () => this.toggleQuick() },
          { id: 'new-task', label: MENU_TEXT.newTask, click: () => this.newTask() },
          {
            id: 'new-window',
            label: MENU_TEXT.newWindow,
            click: () => this.openDetached(current()),
          },
          { type: 'separator' },
          {
            id: 'change-hub',
            label: MENU_TEXT.changeHub,
            click: () =>
              this.showConnect({
                url: this.#config.hub?.url ?? '',
                pin: this.#config.hub?.pin ?? '',
                problem: null,
              }),
          },
          { type: 'separator' },
          mac
            ? { role: 'close' }
            : { id: 'quit', label: MENU_TEXT.quitNova, click: () => this.quit() },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  #applyShortcuts(): void {
    this.#shortcuts = registerShortcuts(
      this.#config.shortcuts,
      {
        register: (accelerator, run) => globalShortcut.register(accelerator, run),
        unregisterAll: () => globalShortcut.unregisterAll(),
      },
      {
        quickChat: () => this.toggleQuick(),
        attachWindow: () => void this.attachWindow('shortcut'),
      },
      process.platform,
    );
    for (const p of shortcutProblems(this.#shortcuts)) log(p);
    this.#updateTray();
  }

  // ---- IPC (contracts/ipc-channels.md; payloads validated here, never in the page) ----------------------

  #allowed(event: IpcMainInvokeEvent, who: Who): boolean {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null) return false;
    if (who === 'hub') {
      const win = BrowserWindow.fromWebContents(event.sender);
      return (
        win !== null &&
        this.#hubWindows.get(win.id) === win &&
        // The frame's real origin: a sandboxed document at a Hub URL reports "null".
        isHubSender(frame.origin, this.#hub?.origin ?? null, true)
      );
    }
    return (
      who.some((k) => this.#local.get(k)?.webContents === event.sender) &&
      isLocalSender(frame.url, RENDERER_URL)
    );
  }

  #handle(
    channel: string,
    who: Who,
    fn: (payload: unknown, event: IpcMainInvokeEvent) => unknown,
  ): void {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!this.#allowed(event, who)) return { ok: false, message: SHELL_TEXT.notAllowed };
      try {
        return await fn(payload, event);
      } catch (err) {
        return { ok: false, message: messageOf(err) };
      }
    });
  }

  #requireClient(): HubClient {
    if (!this.#client) throw new Error(SHELL_TEXT.notConnected);
    return this.#client;
  }

  #registerIpc(): void {
    // Every page's words in the shell's language, with `lang` and `dir` (FR-016).
    this.#handle('shell.text', ['connect', 'quick', 'attach'], (_payload, event) => {
      const kind = [...this.#local].find(([, w]) => w.webContents === event.sender)?.[0];
      return kind ? this.#pageText(kind) : { ok: false, message: SHELL_TEXT.notAllowed };
    });

    // The first-run page.
    this.#handle('shell.connect.state', ['connect'], () => {
      const current = this.#config.hub?.url ?? null;
      return {
        ok: true,
        ...this.#connectState,
        current,
        currentText: current ? PAGE_TEXT.connect.usesHub({ url: current }) : null,
      };
    });
    this.#handle('shell.connect', ['connect'], async (payload) => {
      const req = shellConnectSchema.parse(payload);
      const target = parseConnectInput(req);
      if ('ok' in target) return { ok: false, reason: target.reason, message: target.message };
      // Another Hub: nothing is contacted until the user confirms the replacement by name.
      const replacing = replacementOf(this.#config.hub, target);
      if (replacing && req.replace !== true)
        return {
          ok: false,
          reason: 'confirm_replace',
          replace: replacing,
          message: replacementMessage(replacing),
          confirmLabel: PAGE_TEXT.connect.replaceWith({
            current: replacing.current,
            next: replacing.next,
          }),
        };
      const res = await connectHub(target);
      if (!res.ok) {
        this.#connectState = { ...req, problem: res.message };
        return { ok: false, reason: res.reason, message: res.message };
      }
      await this.#useHub(res);
      this.#connectState = {};
      const path = res.joinPath ?? '/';
      const connect = this.#local.get('connect');
      if (this.#hubWindows.size === 0) this.#createHubWindow(path);
      else this.openLink(path);
      connect?.close();
      return { ok: true, origin: res.origin };
    });

    // The quick overlay (FR-008).
    this.#handle('quick.state', ['quick'], () => this.#quickState());
    this.#handle('quick.send', ['quick'], async (payload) => {
      const req = shellQuickSendSchema.parse(payload);
      const sent = await quickSend(this.#requireClient(), req, currentThread(this.#infos()));
      this.#scheduleStatus(200);
      return { ok: true, ...sent };
    });
    this.#handle('quick.open', ['quick', 'attach'], (payload) => {
      const path = appPath(shellOpenWindowSchema.parse(payload).path);
      if (!path) return { ok: false, message: SHELL_TEXT.notAPlace };
      this.openLink(path);
      return { ok: true };
    });
    this.#handle('quick.newTask', ['quick'], () => {
      this.newTask();
      return { ok: true };
    });
    this.#handle('quick.home', ['quick'], () => {
      this.openHome();
      return { ok: true };
    });
    this.#handle('quick.attach', ['quick'], async () => {
      await this.attachWindow('overlay');
      return { ok: true };
    });

    // Attach window (FR-214): the preview, then Send or Discard.
    this.#handle('window.capture.draft', ['attach'], (payload) => {
      const { draftId } = shellDraftRefSchema.parse(payload);
      const d = this.#drafts.get(draftId);
      if (!d) return { ok: false, message: SHELL_TEXT.captureExpired };
      return {
        ok: true,
        draft: draftView(d.draft, currentThread(this.#infos())),
        notes: draftNotes(d.draft),
      };
    });
    this.#handle('window.capture.attach', ['attach'], async (payload) => {
      const req = shellCaptureAttachSchema.parse(payload);
      const d = this.#drafts.get(req.draftId);
      if (!d) return { ok: false, message: SHELL_TEXT.captureExpired };
      const sent = await sendCapture(
        this.#requireClient(),
        d.draft,
        req,
        currentThread(this.#infos()),
      );
      this.#drafts.delete(req.draftId);
      this.#local.get('attach')?.close();
      this.openLink(sent.path);
      this.#scheduleStatus(200);
      return { ok: true, ...sent };
    });
    this.#handle('window.capture.discard', ['attach'], (payload) => {
      const { draftId } = shellDraftRefSchema.parse(payload);
      this.#drafts.delete(draftId);
      this.#local.get('attach')?.close();
      return { ok: true };
    });

    // The bridge for the Hub's web UI (window.novaShell).
    this.#handle('shell.openWindow', 'hub', (payload) => {
      const path = appPath(shellOpenWindowSchema.parse(payload).path);
      if (!path) return { ok: false, message: SHELL_TEXT.notAPlace };
      this.openDetached(path);
      return { ok: true };
    });
    this.#handle('shortcut.global.list', 'hub', () => ({ ok: true, items: this.#shortcuts }));

    // Local models while the Hub is away (FR-128): models, and a chat whose text streams back to
    // the page that asked as `localRuntime.delta` messages carrying the request's id.
    this.#handle('localRuntime.models', 'hub', async () => ({
      ok: true,
      result: await this.#localRuntime.models(),
    }));
    this.#handle('localRuntime.chat', 'hub', async (payload, event) => {
      const req = shellLocalChatSchema.parse(payload);
      if (this.#localChats >= 4)
        return { ok: false, reason: 'failed', message: SHELL_TEXT.tooManyLocal };
      const wc = event.sender;
      const ctl = new AbortController();
      // The page that asked is gone: stop the model.
      const stop = () => ctl.abort();
      wc.once('destroyed', stop);
      wc.once('did-navigate', stop);
      this.#localChats++;
      try {
        const { text } = await this.#localRuntime.chat(
          req,
          (delta) => {
            if (!wc.isDestroyed()) wc.send('localRuntime.delta', { id: req.id, text: delta });
          },
          ctl.signal,
        );
        return { ok: true, text };
      } catch (err) {
        if (err instanceof LocalRuntimeError)
          return { ok: false, reason: err.reason, message: err.message };
        throw err;
      } finally {
        this.#localChats--;
        if (!wc.isDestroyed()) {
          wc.removeListener('destroyed', stop);
          wc.removeListener('did-navigate', stop);
        }
      }
    });
    this.#handle('shortcut.global.set', 'hub', (payload) => {
      const req = shellShortcutSetSchema.parse(payload);
      let accelerator: string | null = null;
      if (req.accelerator !== null) {
        const parsed = parseAccelerator(req.accelerator);
        if (!parsed.ok) return { ok: false, message: parsed.reason };
        accelerator = parsed.accelerator;
      }
      this.#config = {
        ...this.#config,
        shortcuts: { ...this.#config.shortcuts, [req.action]: accelerator },
      };
      this.#save();
      this.#applyShortcuts();
      return { ok: true, items: this.#shortcuts };
    });
  }
}
