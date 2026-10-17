// The Playwright driver (docs/11 §4: Playwright preferred). `playwright-core` (Apache-2.0) is
// loaded lazily, so the Hub runs without it and the browser then reports unavailable. Chromium
// starts headless with a fresh, temporary user data directory: nothing is imported from the
// user's browsers (ADR-080); cookies come only from the computer's own saved state (FR-096).
// Every request passes the navigation/request guards before it leaves (blocked sites, private
// addresses, sites not allowed yet), and all traffic goes through the egress proxy the service
// opened (docs/12 §8). Element refs are `data-nova-ref` attributes set by each read; the scripts
// that read the page are sent whole with every call, so the page cannot replace them.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type {
  BrowserDriver,
  DriverLaunchOptions,
  DriverSession,
  PageElement,
  PageSnapshot,
  StorageState,
  BrowserTakeoverInput,
} from './types.ts';

import type * as Playwright from 'playwright-core';

type PlaywrightModule = typeof Playwright;
type PwRequest = Playwright.Request;
type PwBrowser = Awaited<ReturnType<PlaywrightModule['chromium']['launch']>>;
type PwContext = Awaited<ReturnType<PwBrowser['newContext']>>;
type PwPage = Awaited<ReturnType<PwContext['newPage']>>;
type PwContextOptions = NonNullable<Parameters<PwBrowser['newContext']>[0]>;
type PwStorageState = Exclude<PwContextOptions['storageState'], string | undefined>;

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const REF = /^e\d{1,5}$/;
const KEY = /^[A-Za-z0-9+_ -]{1,40}$/;

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return await import('playwright-core');
  } catch {
    return null;
  }
}

// Runs in the page: reads the top frame (mode `read`) or describes one element (mode `describe`).
// Plain JavaScript in a string, so core needs no DOM types; the result is untrusted.
const PAGE_SCRIPT = String.raw`(function (arg) {
  var MAX_NAME = 120;
  function clip(s, n) { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function visible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  }
  function textOf(id) { var n = document.getElementById(id); return n ? n.innerText || n.textContent || '' : ''; }
  function roleOf(el) {
    var r = el.getAttribute('role'); if (r) return r.split(/\s+/)[0].toLowerCase();
    var tag = el.tagName.toLowerCase(), t = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'iframe') return 'iframe';
    if (tag === 'input') {
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image' || t === 'file') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }
  function nameOf(el) {
    var a = el.getAttribute('aria-label'); if (a) return clip(a, MAX_NAME);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) return clip(lb.split(/\s+/).map(textOf).join(' '), MAX_NAME);
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return clip(l.innerText, MAX_NAME); }
      var p = el.closest('label'); if (p) return clip(p.innerText, MAX_NAME);
      var t = (el.getAttribute('type') || '').toLowerCase();
      if ((t === 'submit' || t === 'button' || t === 'reset') && el.value) return clip(el.value, MAX_NAME);
      if (el.getAttribute('placeholder')) return clip(el.getAttribute('placeholder'), MAX_NAME);
    }
    if (tag === 'iframe') return clip(el.getAttribute('title') || el.src || '', MAX_NAME);
    if (el.getAttribute('title')) return clip(el.getAttribute('title'), MAX_NAME);
    var img = el.querySelector && el.querySelector('img[alt]');
    var txt = clip(el.innerText || el.textContent || '', MAX_NAME);
    if (!txt && img) return clip(img.getAttribute('alt'), MAX_NAME);
    return txt;
  }
  function info(el, ref) {
    var tag = el.tagName.toLowerCase();
    var o = { ref: ref, role: roleOf(el), name: nameOf(el), tag: tag };
    var t = el.getAttribute('type'); if (t) o.inputType = t.toLowerCase();
    if (tag === 'a' && el.href) o.href = el.href;
    if (tag === 'iframe' && el.src) o.href = el.src;
    var f = el.form || el.closest('form');
    o.form = f ? { action: f.action || location.href, method: (f.getAttribute('method') || 'get').toLowerCase() } : null;
    var ac = el.getAttribute('autocomplete'); if (ac) o.autocomplete = ac;
    var nm = el.getAttribute('name'); if (nm) o.fieldName = nm;
    var ph = el.getAttribute('placeholder'); if (ph) o.placeholder = clip(ph, MAX_NAME);
    if (el.disabled) o.disabled = true;
    if (tag === 'select') o.options = Array.prototype.slice.call(el.options, 0, 20).map(function (x) { return clip(x.text, 60); });
    if (o.role === 'checkbox' || o.role === 'radio') o.checked = !!el.checked;
    return o;
  }
  var SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,iframe,[role],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]';
  if (arg.mode === 'describe') {
    var one = document.querySelector('[data-nova-ref="' + arg.ref + '"]');
    return one ? info(one, arg.ref) : null;
  }
  var old = document.querySelectorAll('[data-nova-ref]');
  for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-nova-ref');
  var out = [], n = 0, all = document.querySelectorAll(SEL);
  var INTERACTIVE = /^(link|button|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem|menuitemcheckbox|menuitemradio|tab|switch|slider|spinbutton|iframe|treeitem|gridcell)$/;
  for (var j = 0; j < all.length && out.length < arg.maxElements; j++) {
    var el = all[j];
    if (!visible(el)) continue;
    var role = roleOf(el);
    if (!INTERACTIVE.test(role) && !el.hasAttribute('onclick') && !(el.getAttribute('tabindex') && el.getAttribute('tabindex') !== '-1')) continue;
    var ref = 'e' + (++n);
    el.setAttribute('data-nova-ref', ref);
    out.push(info(el, ref));
  }
  var text = (document.body && document.body.innerText) || '';
  return { title: document.title || '', text: text.slice(0, arg.maxChars), elements: out };
})`;

// Runs in every new document. Only the top frame gets the page-tools API (FR-208); the binding
// re-checks the frame on the Hub side, so an iframe calling it directly is ignored too.
const PAGE_TOOLS_SCRIPT = String.raw`(function () {
  if (window.top !== window) return;
  var fns = new Map();
  var api = {
    registerTool: function (tool) {
      if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function')
        throw new TypeError('a tool needs a name and an execute function');
      fns.set(tool.name, tool.execute);
      return window.__novaPageTool(JSON.stringify({ op: 'register', name: tool.name,
        description: String(tool.description || ''), inputSchema: tool.inputSchema || { type: 'object' } }));
    },
    unregisterTool: function (name) {
      fns.delete(String(name));
      return window.__novaPageTool(JSON.stringify({ op: 'unregister', name: String(name) }));
    }
  };
  Object.defineProperty(window, '__novaCallPageTool', { configurable: false, value: function (name, args) {
    var f = fns.get(name); if (!f) return Promise.reject(new Error('the page no longer offers ' + name));
    return Promise.resolve(f(args));
  } });
  try { Object.defineProperty(navigator, 'modelContext', { configurable: false, value: api }); } catch (e) {}
})();`;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

/** Race a promise against a timeout (the page can stall a call forever). */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class PlaywrightSession implements DriverSession {
  readonly #browser: PwBrowser;
  readonly #context: PwContext;
  #page: PwPage;
  /** Main-frame navigations in flight (a click or a key may start one). */
  readonly #navigations = new Set<PwRequest>();
  #navigationsDone: (() => void)[] = [];

  constructor(browser: PwBrowser, context: PwContext, page: PwPage) {
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    const main = (r: PwRequest) => {
      try {
        return r.isNavigationRequest() && r.frame().parentFrame() === null;
      } catch {
        return false;
      }
    };
    const done = (r: PwRequest) => {
      if (!this.#navigations.delete(r) || this.#navigations.size) return;
      for (const fn of this.#navigationsDone.splice(0)) fn();
    };
    page.on('request', (r) => {
      if (main(r)) this.#navigations.add(r);
    });
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  #at(ref: string) {
    if (!REF.test(ref)) throw new Error(`"${ref}" is not an element ref from browser.read`);
    return this.#page.locator(`[data-nova-ref="${ref}"]`).first();
  }

  /**
   * After a click or a key: give a navigation it started a moment to begin, wait until it is
   * committed, failed or refused by the guard (bounded), then for the new document.
   */
  async #settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 100));
    if (this.#navigations.size)
      await within(
        new Promise<void>((r) => this.#navigationsDone.push(r)),
        10_000,
        'the navigation',
      ).catch(() => undefined);
    await this.#page
      .waitForLoadState('domcontentloaded', { timeout: 5_000 })
      .catch(() => undefined);
  }

  url(): string {
    return this.#page.url();
  }

  async goto(url: string, timeoutMs: number): Promise<{ status: number | null }> {
    const res = await this.#page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return { status: res?.status() ?? null };
  }

  async back(timeoutMs: number): Promise<void> {
    await this.#page.goBack({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  async snapshot(maxChars: number): Promise<PageSnapshot> {
    const r = await within(
      this.#page.evaluate<{ title: string; text: string; elements: PageElement[] }>(
        `${PAGE_SCRIPT}(${JSON.stringify({ mode: 'read', maxChars, maxElements: 300 })})`,
      ),
      15_000,
      'reading the page',
    );
    const tree = await this.#page
      .locator('body')
      .ariaSnapshot({ timeout: 5_000 })
      .catch(() => '');
    return {
      url: this.#page.url(),
      title: r.title,
      text: r.text,
      tree: tree.slice(0, maxChars),
      elements: r.elements,
      frames: this.#page
        .frames()
        .filter((f) => f !== this.#page.mainFrame())
        .map((f) => f.url())
        .filter((u) => u && u !== 'about:blank')
        .slice(0, 20),
    };
  }

  async describe(ref: string): Promise<PageElement | null> {
    if (!REF.test(ref)) return null;
    return await within(
      this.#page.evaluate<PageElement | null>(
        `${PAGE_SCRIPT}(${JSON.stringify({ mode: 'describe', ref })})`,
      ),
      10_000,
      'checking the element',
    );
  }

  async click(ref: string, timeoutMs: number): Promise<void> {
    await this.#at(ref).click({ timeout: timeoutMs });
    await this.#settle();
  }

  async fill(ref: string, text: string, timeoutMs: number): Promise<void> {
    await this.#at(ref).fill(text, { timeout: timeoutMs });
  }

  async select(ref: string, value: string, timeoutMs: number): Promise<void> {
    const loc = this.#at(ref);
    try {
      await loc.selectOption({ label: value }, { timeout: timeoutMs });
    } catch {
      await loc.selectOption(value, { timeout: timeoutMs });
    }
  }

  async press(key: string, timeoutMs: number): Promise<void> {
    if (!KEY.test(key)) throw new Error(`"${key}" is not a key name`);
    await within(this.#page.keyboard.press(key), timeoutMs, 'the key press');
    await this.#settle();
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    await this.#page.mouse.wheel(0, direction === 'down' ? amount : -amount);
  }

  async waitFor(
    kind: 'load' | 'idle' | 'text',
    text: string | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      if (kind === 'text' && text)
        await this.#page.getByText(text).first().waitFor({ timeout: timeoutMs });
      else
        await this.#page.waitForLoadState(kind === 'idle' ? 'networkidle' : 'load', {
          timeout: timeoutMs,
        });
      return true;
    } catch {
      return false;
    }
  }

  async screenshot(fullPage: boolean): Promise<Uint8Array> {
    return await this.#page.screenshot({ fullPage, type: 'png', timeout: 10_000 });
  }

  async download(
    ref: string,
    timeoutMs: number,
  ): Promise<{ suggestedName: string; data: Uint8Array }> {
    const [dl] = await Promise.all([
      this.#page.waitForEvent('download', { timeout: timeoutMs }),
      this.#at(ref).click({ timeout: timeoutMs }),
    ]);
    const path = await dl.path();
    const data = await readFile(path);
    if (data.length > MAX_DOWNLOAD_BYTES) throw new Error('the download is larger than 50 MiB');
    return { suggestedName: dl.suggestedFilename(), data };
  }

  async upload(
    ref: string,
    files: { name: string; mime: string; data: Uint8Array }[],
  ): Promise<void> {
    await this.#at(ref).setInputFiles(
      files.map((f) => ({ name: f.name, mimeType: f.mime, buffer: Buffer.from(f.data) })),
    );
  }

  async evaluate(expression: string, timeoutMs: number): Promise<unknown> {
    return await within(this.#page.evaluate(expression), timeoutMs, 'the script');
  }

  async callPageTool(name: string, args: unknown, timeoutMs: number): Promise<unknown> {
    const call = `window.__novaCallPageTool(${JSON.stringify(name)}, ${JSON.stringify(args ?? {})})`;
    return await within(this.#page.evaluate(call), timeoutMs, 'the page tool');
  }

  async input(event: BrowserTakeoverInput): Promise<void> {
    switch (event.kind) {
      case 'click':
        await this.#page.mouse.click(event.x, event.y);
        return;
      case 'type':
        await this.#page.keyboard.type(event.text);
        return;
      case 'key':
        if (!KEY.test(event.key)) throw new Error(`"${event.key}" is not a key name`);
        await this.#page.keyboard.press(event.key);
        return;
      case 'scroll':
        await this.#page.mouse.wheel(0, event.dy);
        return;
    }
  }

  async storageState(): Promise<StorageState> {
    return await this.#context.storageState();
  }

  async close(): Promise<void> {
    await this.#browser.close().catch(() => undefined);
  }
}

export interface PlaywrightDriverOptions {
  /** Replace the module loader (tests). */
  load?: () => Promise<PlaywrightModule | null>;
}

export class PlaywrightDriver implements BrowserDriver {
  readonly name = 'playwright';
  readonly #load: () => Promise<PlaywrightModule | null>;
  readonly #probes = new Map<string, Promise<{ ok: boolean; detail: string }>>();

  constructor(opts: PlaywrightDriverOptions = {}) {
    this.#load = opts.load ?? loadPlaywright;
  }

  probe(executablePath: string | null): Promise<{ ok: boolean; detail: string }> {
    const key = executablePath ?? '';
    let p = this.#probes.get(key);
    if (!p) {
      p = this.#probe(executablePath);
      this.#probes.set(key, p);
    }
    return p;
  }

  async #probe(executablePath: string | null): Promise<{ ok: boolean; detail: string }> {
    const pw = await this.#load();
    if (!pw) return { ok: false, detail: 'playwright-core is not installed on this Hub' };
    let exe: string;
    try {
      exe = executablePath ?? pw.chromium.executablePath();
    } catch {
      exe = '';
    }
    if (!exe || !existsSync(exe))
      return {
        ok: false,
        detail:
          'No Chromium is installed for the agent browser. Run `npx playwright install chromium` ' +
          'on the Hub, or set browser.executablePath.',
      };
    try {
      const b = await within(
        pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }),
        20_000,
        'starting Chromium',
      );
      await b.close();
      return { ok: true, detail: `Chromium ${b.version()}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lib = /error while loading shared libraries: ([^\s:]+)/.exec(msg)?.[1];
      return {
        ok: false,
        detail: lib
          ? `Chromium cannot start on this Hub: the system library ${lib} is missing (install the browser's dependencies).`
          : `Chromium cannot start on this Hub: ${msg.split('\n')[0] ?? 'unknown error'}`,
      };
    }
  }

  async launch(opts: DriverLaunchOptions): Promise<DriverSession> {
    const pw = await this.#load();
    if (!pw) throw new Error('playwright-core is not installed on this Hub');
    const args: string[] = [];
    if (opts.proxy?.caSpki) args.push(`--ignore-certificate-errors-spki-list=${opts.proxy.caSpki}`);
    const browser = await pw.chromium.launch({
      headless: true,
      args,
      ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
      // Playwright also routes loopback through the proxy (it adds `<-loopback>` itself).
      ...(opts.proxy ? { proxy: { server: opts.proxy.server } } : {}),
    });
    try {
      const contextOptions: PwContextOptions = {
        viewport: opts.viewport,
        acceptDownloads: true,
        // Service workers would fetch outside the request guard.
        serviceWorkers: 'block',
      };
      if (opts.storageState)
        contextOptions.storageState = opts.storageState as unknown as PwStorageState;
      const context = await browser.newContext(contextOptions);
      await context.exposeBinding('__novaPageTool', (source, payload: unknown) => {
        // Only the top frame may register (FR-208).
        if (source.frame !== source.page.mainFrame() || typeof payload !== 'string') return false;
        let msg: { op?: unknown; name?: unknown; description?: unknown; inputSchema?: unknown };
        try {
          msg = JSON.parse(payload) as typeof msg;
        } catch {
          return false;
        }
        if ((msg.op !== 'register' && msg.op !== 'unregister') || typeof msg.name !== 'string')
          return false;
        opts.onPageTool?.(msg.op, {
          origin: originOf(source.frame.url()),
          name: msg.name,
          description: typeof msg.description === 'string' ? msg.description : '',
          inputSchema:
            msg.inputSchema && typeof msg.inputSchema === 'object'
              ? (msg.inputSchema as Record<string, unknown>)
              : {},
        });
        return true;
      });
      await context.addInitScript(PAGE_TOOLS_SCRIPT);
      const page = await context.newPage();
      await context.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if (!/^https?:/i.test(url)) return route.continue();
        let main: boolean;
        try {
          main = req.isNavigationRequest() && req.frame().parentFrame() === null;
        } catch {
          main = false;
        }
        if (main ? opts.allowNavigation(url) : opts.allowRequest(url)) return route.continue();
        if (!main) return route.abort('blockedbyclient');
        opts.onBlockedNavigation?.(url);
        // `aborted` cancels the navigation and leaves the current page in place (other errors
        // show an error page; a 204 leaves Playwright waiting for the navigation).
        return route.abort('aborted');
      });
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) opts.onNavigated?.(frame.url());
      });
      page.on('popup', (popup) => {
        const u = popup.url();
        void popup.close().catch(() => undefined);
        opts.onPopup?.(u);
      });
      return new PlaywrightSession(browser, context, page);
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw err;
    }
  }
}
