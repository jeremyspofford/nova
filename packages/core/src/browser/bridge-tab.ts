// A tab of the user's own browser as an agent browser (FR-209 with FR-096; ADR-096 D8): the
// browser controller drives it like any other through the extension bridge, with DevTools protocol
// commands sent by `cdp.send` (the extension attaches `chrome.debugger` to that one tab, which
// shows the browser's own "being debugged" banner, and badges it). The fallback opens a tab in the
// Nova tab group, or uses a tab the user shared on the site.
//
// Every command names the host it was checked for (`expectHost`; null only for about:blank, whose
// grant is the session's site), and the extension runs it only while the tab is on exactly that
// host, a pending navigation included: a tab that moved since the driver last looked (a redirect,
// a slow click, the user) gets nothing. Page scripts are the extension's own, named here and never
// sent as code. After an action the driver waits for the tab's navigation to commit, then follows
// it only onto an allowed and granted site; anywhere else the session refuses everything but a
// navigation back. Keys carry no modifier but Shift (no paste, copy or cut of the clipboard).
//
// What it never does: read cookies, storage or passwords (`storageState` and `cookies` are
// empty), run developer-protocol scripts or page tools, download or upload files, take user input
// (the user has their own browser), or act in another OS user's browser (the user is pinned at
// launch).
import { BROWSER_BRIDGE_SCRIPTS, type BrowserBridgeScript } from '@nova/shared';
import type { Logger } from '@nova/telemetry';
import type { ExtensionBridgeService } from './bridge.ts';
import { hostOf } from './session.ts';
import type {
  BrowserDriver,
  BrowserTakeoverInput,
  DriverLaunchOptions,
  DriverSession,
  PageElement,
  PageSnapshot,
  StorageState,
} from './types.ts';

const REF = /^e\d{1,5}$/;
const KEY = /^[A-Za-z0-9+_ -]{1,40}$/;
const POLL_MS = 150;
/** How long `#settle` waits for a navigation to commit and load. */
const COMMIT_WAIT_MS = 10_000;
/** What an extension script answers on another host than the one expected. */
const WRONG_HOST = '__novaWrongHost';

/** Named keys: DOM `key`, `code` and the Windows virtual key code the protocol wants. */
const NAMED_KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
};
/** Shift only: Control, Alt and Meta make shortcuts (paste, copy, cut the user's clipboard). */
const SHIFT = 8;

function unsupported(what: string): Error {
  return new Error(`${what} is not available in your own browser through the extension bridge`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BridgeTabDriverOptions {
  bridge: ExtensionBridgeService;
  accountId: string;
  deviceId: string;
  deviceName: string;
  site: string;
  log?: Logger;
}

/** Opens (or reuses) a tab of the user's browser for each launch. */
export class BridgeTabDriver implements BrowserDriver {
  readonly name = 'extension';
  readonly #o: BridgeTabDriverOptions;

  constructor(opts: BridgeTabDriverOptions) {
    this.#o = opts;
  }

  probe(): Promise<{ ok: boolean; detail: string }> {
    const ok = this.#o.bridge.connected(this.#o.accountId, this.#o.deviceId);
    return Promise.resolve({
      ok,
      detail: ok
        ? `your browser on ${this.#o.deviceName}`
        : `the extension is not connected on ${this.#o.deviceName}`,
    });
  }

  async launch(opts: DriverLaunchOptions): Promise<DriverSession> {
    const { bridge, accountId, deviceId, site } = this.#o;
    // The browser of the OS user connected now; a tab of anyone else's is never used.
    const user = bridge.user(accountId, deviceId);
    const shared = bridge.sharedTab(accountId, deviceId, site);
    let tabId: number;
    if (shared) {
      tabId = shared.tabId;
    } else {
      const r = (await bridge.call(
        accountId,
        deviceId,
        'tabs.open',
        { url: 'about:blank', group: 'Nova' },
        { site, user },
      )) as { tabId: number };
      tabId = r.tabId;
    }
    await bridge.call(accountId, deviceId, 'tab.attach', { tabId }, { user });
    const s = new BridgeTabSession({ ...this.#o, tabId, opts, user });
    try {
      await s.begin();
    } catch (err) {
      await s.close();
      throw err;
    }
    return s;
  }
}

interface SessionOptions extends BridgeTabDriverOptions {
  tabId: number;
  opts: DriverLaunchOptions;
  user: string | null;
}

class BridgeTabSession implements DriverSession {
  readonly #o: SessionOptions;
  #url = 'about:blank';
  /** The tab left the allowed and granted sites: only a navigation back is accepted. */
  #offLimits = false;
  #closed = false;
  #gone: string | null = null;

  constructor(o: SessionOptions) {
    this.#o = o;
  }

  /** Learn where the tab is now; it must be about:blank or an allowed, granted site. */
  async begin(): Promise<void> {
    const t = await this.#tab();
    // No host: about:blank (a new tab), or a page that is not a web site, which the extension
    // refuses to look at, so the launch fails.
    if (t.host === null) {
      this.#url = await this.#href(null);
      return;
    }
    if (!(await this.#usable(t.host)))
      throw new Error('the shared tab is no longer on a site the agent may use');
    this.#url = await this.#href(t.host);
  }

  // ---- the protocol through the bridge ---------------------------------------------------------

  /** The host the driver believes the tab is on (null: about:blank). */
  #host(): string | null {
    return this.#url === 'about:blank' ? null : hostOf(this.#url);
  }

  async #send(
    method: string,
    params: Record<string, unknown>,
    expectHost: string | null = this.#host(),
  ): Promise<Record<string, unknown>> {
    if (this.#closed) throw new Error('the tab is no longer controlled');
    try {
      const r = await this.#o.bridge.call(
        this.#o.accountId,
        this.#o.deviceId,
        'cdp.send',
        { tabId: this.#o.tabId, method, params, expectHost },
        { site: this.#o.site, user: this.#o.user },
      );
      return r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no tab with id|tab was closed|detached/i.test(msg)) this.#gone = 'the tab was closed';
      // The tab is no longer where the driver thought: stop until it is back on a usable site.
      if (/host_changed|no longer on the site/i.test(msg)) this.#offLimits = true;
      throw err;
    }
  }

  /** Run one of the extension's own page scripts on the expected host. */
  async #run<T>(
    script: BrowserBridgeScript,
    arg: Record<string, unknown> = {},
    expectHost: string | null = this.#host(),
  ): Promise<T> {
    if (!(BROWSER_BRIDGE_SCRIPTS as readonly string[]).includes(script))
      throw new Error(`${script} is not a page script`);
    const r = await this.#send('Runtime.evaluate', { script, arg, timeout: 15_000 }, expectHost);
    if (r.exceptionDetails) throw new Error('the page script failed');
    const value = (r.result as { value?: unknown } | undefined)?.value;
    if (value && typeof value === 'object' && WRONG_HOST in value) {
      this.#offLimits = true;
      throw new Error('the tab left the site; the agent stays out');
    }
    return value as T;
  }

  /** Where the tab is according to the browser (committed host, navigation under way). */
  async #tab(): Promise<{ host: string | null; loading: boolean; pendingHost: string | null }> {
    const t = await this.#o.bridge.tabInfo(
      this.#o.accountId,
      this.#o.deviceId,
      this.#o.tabId,
      this.#o.user,
    );
    if (!t) {
      this.#gone = 'the tab was closed';
      throw new Error(this.#gone);
    }
    return t;
  }

  /** The tab's address, read on `host` (the page cannot fake `location.href`). */
  async #href(host: string | null): Promise<string> {
    const href = await this.#run<string>('href', {}, host);
    if (typeof href !== 'string') throw new Error('the tab did not say where it is');
    if (href !== 'about:blank' && !hostOf(href)) {
      this.#offLimits = true;
      throw new Error('the tab shows a page that is not a web site; the agent stays out');
    }
    return href;
  }

  /** An allowed site (the session's guards) with an active grant. */
  async #usable(host: string): Promise<boolean> {
    return (
      this.#o.opts.allowNavigation(`https://${host}/`) &&
      (await this.#o.bridge.hostAllowed(this.#o.accountId, this.#o.deviceId, host)).ok
    );
  }

  /**
   * After an action: wait until the tab's navigation (if one started) committed and loaded, then
   * follow it onto an allowed and granted site, or stop acting. Only the host of a site the agent
   * may not use is reported, never its address.
   */
  async #settle(waitMs = 300, commitMs = COMMIT_WAIT_MS): Promise<void> {
    if (waitMs) await sleep(waitMs);
    const until = Date.now() + commitMs;
    let t = await this.#tab();
    while ((t.loading || t.pendingHost !== null) && Date.now() < until) {
      await sleep(POLL_MS);
      t = await this.#tab();
    }
    const before = this.#host();
    if (t.host === null) {
      // Still (or back) on about:blank.
      this.#url = 'about:blank';
      return;
    }
    if (t.host !== before && !(await this.#usable(t.host))) {
      this.#offLimits = true;
      this.#o.bridge.noteTabHost(this.#o.accountId, this.#o.deviceId, this.#o.tabId, t.host);
      this.#o.opts.onBlockedNavigation?.(`https://${t.host}/`);
      return;
    }
    const url = await this.#href(t.host);
    this.#o.bridge.noteTabHost(this.#o.accountId, this.#o.deviceId, this.#o.tabId, t.host);
    this.#offLimits = false;
    if (url !== this.#url) {
      this.#url = url;
      this.#o.opts.onNavigated?.(url);
    }
  }

  #guard(): void {
    if (this.#gone) throw new Error(this.#gone);
    if (this.#offLimits)
      throw new Error(
        'the tab left the sites the agent may use; navigate back to an allowed site first',
      );
  }

  async #point(ref: string): Promise<{ x: number; y: number }> {
    if (!REF.test(ref)) throw new Error(`"${ref}" is not an element ref from browser.read`);
    const p = await this.#run<{ x: number; y: number } | null>('point', { ref });
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number')
      throw new Error(`${ref} is no longer on the page`);
    return p;
  }

  async #mouse(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
    await this.#send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }

  // ---- DriverSession ---------------------------------------------------------------------------

  url(): string {
    return this.#url;
  }

  async goto(url: string, timeoutMs: number): Promise<{ status: number | null }> {
    if (this.#gone) throw new Error(this.#gone);
    const host = hostOf(url);
    if (!host || !this.#o.opts.allowNavigation(url)) {
      this.#o.opts.onBlockedNavigation?.(url);
      throw new Error('navigation refused');
    }
    // From where the tab is now (checked), to the target (its grant checked by the bridge).
    const from = await this.#tab();
    const r = await this.#send('Page.navigate', { url }, from.pendingHost ?? from.host);
    if (typeof r.errorText === 'string' && r.errorText)
      throw new Error(`the page did not open: ${r.errorText.slice(0, 200)}`);
    this.#url = url;
    this.#offLimits = false;
    await this.#settle(0, timeoutMs);
    const status = this.#offLimits
      ? null
      : await this.#run<number | null>('navStatus').catch(() => null);
    return { status: typeof status === 'number' ? status : null };
  }

  async back(): Promise<void> {
    this.#guard();
    await this.#run('back');
    await this.#settle();
  }

  async snapshot(maxChars: number): Promise<PageSnapshot> {
    this.#guard();
    const r = await this.#run<{ title: string; text: string; elements: PageElement[] }>('read', {
      maxChars,
      maxElements: 300,
    });
    const frames = await this.#run<string[]>('frames').catch(() => []);
    return {
      url: this.#url,
      title: typeof r.title === 'string' ? r.title : '',
      text: typeof r.text === 'string' ? r.text : '',
      tree: '',
      elements: Array.isArray(r.elements) ? r.elements : [],
      frames: Array.isArray(frames) ? frames.filter((f) => typeof f === 'string') : [],
    };
  }

  async describe(ref: string): Promise<PageElement | null> {
    if (!REF.test(ref)) return null;
    this.#guard();
    return await this.#run<PageElement | null>('describe', { ref });
  }

  async click(ref: string): Promise<void> {
    this.#guard();
    const { x, y } = await this.#point(ref);
    await this.#mouse('mouseMoved', x, y);
    await this.#mouse('mousePressed', x, y, { button: 'left', clickCount: 1 });
    await this.#mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
    await this.#settle();
  }

  async hover(ref: string): Promise<void> {
    this.#guard();
    const { x, y } = await this.#point(ref);
    await this.#mouse('mouseMoved', x, y);
  }

  async fill(ref: string, text: string): Promise<void> {
    this.#guard();
    if (!REF.test(ref)) throw new Error(`"${ref}" is not an element ref from browser.read`);
    if (!(await this.#run<boolean>('focus', { ref })))
      throw new Error(`${ref} is no longer on the page`);
    if (text) await this.#send('Input.insertText', { text });
    else await this.#key(NAMED_KEYS.backspace!, 0);
  }

  async select(ref: string, value: string): Promise<void> {
    this.#guard();
    if (!REF.test(ref)) throw new Error(`"${ref}" is not an element ref from browser.read`);
    if (!(await this.#run<boolean>('select', { ref, value })))
      throw new Error(`"${value}" is not an option of ${ref}`);
  }

  async #key(k: { key: string; code: string; vk: number; text?: string }, modifiers: number) {
    const base = {
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
      modifiers,
    };
    await this.#send('Input.dispatchKeyEvent', {
      type: k.text ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(k.text ? { text: k.text } : {}),
    });
    await this.#send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async press(key: string): Promise<void> {
    this.#guard();
    if (!KEY.test(key)) throw new Error(`"${key}" is not a key name`);
    const parts = key.split('+').map((p) => p.trim());
    const main = parts.pop() ?? '';
    let modifiers = 0;
    for (const m of parts) {
      const lower = m.toLowerCase();
      if (lower === 'shift') modifiers = SHIFT;
      else if (['control', 'ctrl', 'alt', 'meta', 'cmd', 'command'].includes(lower))
        throw unsupported(`Holding ${m}`);
      else throw new Error(`"${key}" is not a key name`);
    }
    const named = NAMED_KEYS[main.toLowerCase()];
    if (named) await this.#key(named, modifiers);
    else if (main.length === 1) {
      const upper = main.toUpperCase();
      const typed = modifiers === SHIFT ? upper : main;
      await this.#key(
        {
          key: typed,
          code: /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(main) ? `Digit${main}` : '',
          vk: upper.charCodeAt(0),
          text: typed,
        },
        modifiers,
      );
    } else throw new Error(`"${key}" is not a key name`);
    await this.#settle();
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    this.#guard();
    await this.#mouse('mouseWheel', 200, 200, {
      deltaX: 0,
      deltaY: direction === 'down' ? amount : -amount,
    });
  }

  async waitFor(
    kind: 'load' | 'idle' | 'text',
    text: string | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    this.#guard();
    const until = Date.now() + timeoutMs;
    for (;;) {
      const done =
        kind === 'text' && text
          ? await this.#run<boolean>('hasText', { text }).catch(() => false)
          : (await this.#run<string>('readyState').catch(() => '')) === 'complete';
      if (done) {
        if (kind === 'idle') await sleep(500);
        return true;
      }
      if (Date.now() > until) return false;
      await sleep(POLL_MS * 2);
    }
  }

  async screenshot(fullPage: boolean): Promise<Uint8Array> {
    this.#guard();
    const r = await this.#send('Page.captureScreenshot', {
      format: 'png',
      ...(fullPage ? { captureBeyondViewport: true } : {}),
    });
    if (typeof r.data !== 'string') throw new Error('no screenshot');
    return new Uint8Array(Buffer.from(r.data, 'base64'));
  }

  async screenshotElement(ref: string): Promise<Uint8Array> {
    this.#guard();
    if (!REF.test(ref)) throw new Error(`"${ref}" is not an element ref from browser.read`);
    const box = await this.#run<{ x: number; y: number; width: number; height: number } | null>(
      'box',
      { ref },
    );
    if (!box) throw new Error(`${ref} is no longer on the page`);
    const r = await this.#send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { ...box, scale: 1 },
    });
    if (typeof r.data !== 'string') throw new Error('no screenshot');
    return new Uint8Array(Buffer.from(r.data, 'base64'));
  }

  download(): Promise<{ suggestedName: string; data: Uint8Array }> {
    return Promise.reject(unsupported('Downloading'));
  }

  upload(): Promise<void> {
    return Promise.reject(unsupported('Uploading files'));
  }

  evaluate(): Promise<unknown> {
    return Promise.reject(unsupported('Developer-protocol mode'));
  }

  callPageTool(): Promise<unknown> {
    return Promise.reject(unsupported('Page tools'));
  }

  input(_event: BrowserTakeoverInput): Promise<void> {
    return Promise.reject(new Error('this is your own browser: use it directly'));
  }

  /** Never the user's cookies or storage (FR-096): nothing is carried or saved. */
  storageState(): Promise<StorageState> {
    return Promise.resolve({ cookies: [], origins: [] });
  }

  cookies(): Promise<Record<string, unknown>[]> {
    return Promise.resolve([]);
  }

  recover(): Promise<boolean> {
    return Promise.resolve(false);
  }

  crashState(): Promise<string | null> {
    return Promise.resolve(this.#closed ? null : this.#gone);
  }

  async focusedSecret(): Promise<boolean> {
    return await this.#run<boolean>('focusedSecret').catch(() => true);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // The tab stays the user's: the debugger detaches, the badge goes.
    await this.#o.bridge
      .call(
        this.#o.accountId,
        this.#o.deviceId,
        'tab.detach',
        { tabId: this.#o.tabId },
        { user: this.#o.user },
      )
      .catch((err: unknown) => this.#o.log?.debug('detaching a bridge tab failed', { err }));
  }
}
