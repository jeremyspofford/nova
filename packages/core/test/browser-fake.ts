// A scripted browser for the browser area's unit tests: pages by URL with their elements, the
// driver guards honoured like the real driver (a refused main-frame navigation throws), and every
// call logged. Typed values are kept apart (`fills`) so tests can check that a password reached
// the browser and nothing else. M7: console and network events on demand (`emitConsole`,
// `emitNetwork`), and crashes (`crash`: the page, or the whole browser; `crashOn`: during a call).
import type {
  BrowserDriver,
  BrowserTakeoverInput,
  DriverLaunchOptions,
  DriverSession,
  PageElement,
  PageSnapshot,
  StorageState,
} from '../src/browser/index.ts';

/** A 1x1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** What an element screenshot gives (told apart from a page screenshot by its bytes). */
export const ELEMENT_PNG = Buffer.concat([PNG, Buffer.from('element')]);

export type FakeElement = Omit<PageElement, 'ref'> & {
  /** Clicking navigates here (links do by their href). */
  navigates?: string;
  /** Clicking starts this download. */
  download?: { name: string; data: string };
};

export interface FakePage {
  title: string;
  text: string;
  elements: FakeElement[];
  frames?: string[];
  status?: number;
}

export class FakeDriver implements BrowserDriver {
  readonly name = 'fake';
  available = true;
  readonly pages = new Map<string, FakePage>();
  readonly log: string[] = [];
  readonly fills: { ref: string; text: string }[] = [];
  readonly launches: DriverLaunchOptions[] = [];
  readonly sessions: FakeSession[] = [];
  pageToolResult: unknown = { ok: true };
  evaluateResult: unknown = 42;
  /** Fail launches with this error (a browser that cannot start again). */
  launchError: string | null = null;

  probe(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve(
      this.available
        ? { ok: true, detail: 'fake browser' }
        : { ok: false, detail: 'No Chromium is installed for the agent browser.' },
    );
  }

  launch(opts: DriverLaunchOptions): Promise<DriverSession> {
    if (this.launchError) return Promise.reject(new Error(this.launchError));
    this.launches.push(opts);
    const s = new FakeSession(this, opts);
    this.sessions.push(s);
    return Promise.resolve(s);
  }

  get current(): FakeSession {
    const s = this.sessions.at(-1);
    if (!s) throw new Error('no session');
    return s;
  }
}

export class FakeSession implements DriverSession {
  readonly #d: FakeDriver;
  readonly opts: DriverLaunchOptions;
  #url = 'about:blank';
  /** ref -> index of the element on the page when it was read. */
  #refs = new Map<string, number>();
  closed = false;
  storage: StorageState = { cookies: [], origins: [] };
  /** `page`: the page crashed (recover gives a new page); `browser`: the browser is gone. */
  crashed: 'page' | 'browser' | null = null;
  /** Crash during the next call of this name (`click`, `snapshot`, `goto`, …). */
  crashOn: { call: string; kind: 'page' | 'browser'; event?: boolean } | null = null;
  recovers = 0;
  #requests = 0;

  constructor(d: FakeDriver, opts: DriverLaunchOptions) {
    this.#d = d;
    this.opts = opts;
    if (opts.storageState) this.storage = opts.storageState;
  }

  /** The page or the browser crashes now, as Playwright reports it. */
  crash(kind: 'page' | 'browser' = 'page', event = true): void {
    this.crashed = kind;
    if (event)
      this.opts.onCrash?.(kind === 'page' ? 'the page crashed' : 'the browser process exited');
  }

  /** The error a crashed Playwright page gives, or null; `name` may crash it first (crashOn). */
  #dead(name: string): Error | null {
    if (this.failOn?.call === name) {
      const f = this.failOn;
      this.failOn = null;
      return new Error(f.message);
    }
    if (this.crashOn?.call === name) {
      const c = this.crashOn;
      this.crashOn = null;
      this.crash(c.kind, c.event !== false);
    }
    if (!this.crashed) return null;
    return new Error(
      this.crashed === 'page'
        ? `${name}: Target crashed`
        : `${name}: Target page, context or browser has been closed`,
    );
  }

  emitConsole(text: string, level = 'log', source: 'console' | 'pageerror' = 'console'): void {
    this.opts.onConsole?.({ level, text, source, url: this.#url, line: 3 });
  }

  /** One request with its response and body (as the real driver reports them). */
  emitNetwork(r: {
    url: string;
    method?: string;
    resourceType?: string;
    requestHeaders?: Record<string, string>;
    status?: number;
    responseHeaders?: Record<string, string>;
    body?: string | Uint8Array | null;
    failure?: string | null;
  }): string {
    const id = `f${++this.#requests}`;
    const on = this.opts.onNetwork;
    on?.({
      phase: 'request',
      id,
      method: r.method ?? 'GET',
      url: r.url,
      resourceType: r.resourceType ?? 'fetch',
      navigation: false,
      headers: r.requestHeaders ?? {},
    });
    if (r.failure) {
      on?.({ phase: 'done', id, failure: r.failure });
      return id;
    }
    on?.({
      phase: 'response',
      id,
      status: r.status ?? 200,
      statusText: (r.status ?? 200) === 200 ? 'OK' : '',
      headers: r.responseHeaders ?? {},
    });
    if (r.body !== undefined)
      on?.({
        phase: 'body',
        id,
        body:
          r.body === null
            ? null
            : typeof r.body === 'string'
              ? new Uint8Array(Buffer.from(r.body))
              : r.body,
      });
    on?.({ phase: 'done', id, failure: null });
    return id;
  }

  #page(): FakePage | null {
    return this.#d.pages.get(this.#url) ?? null;
  }

  #nav(url: string, method = 'GET'): void {
    if (!this.opts.allowNavigation(url)) {
      this.opts.onBlockedNavigation?.(url);
      throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${url}`);
    }
    // The main-frame request, as the real driver reports it (the session tracks its method).
    const id = `n${++this.#requests}`;
    this.opts.onNetwork?.({
      phase: 'request',
      id,
      method,
      url,
      resourceType: 'document',
      navigation: true,
      headers: {},
    });
    this.opts.onNetwork?.({
      phase: 'response',
      id,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html' },
    });
    this.opts.onNetwork?.({ phase: 'done', id, failure: null });
    this.#url = url;
    this.#refs.clear();
    this.opts.onNavigated?.(url);
  }

  /** Simulate a page script registering a tool from its top frame (FR-208). */
  register(name: string, description = 'a page tool', origin?: string): void {
    this.opts.onPageTool?.('register', {
      origin: origin ?? new URL(this.#url).origin,
      name,
      description,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    });
  }

  url(): string {
    return this.#url;
  }

  goto(url: string): Promise<{ status: number | null }> {
    this.#d.log.push(`goto ${url}`);
    const dead = this.#dead('goto');
    if (dead) return Promise.reject(dead);
    this.#nav(url);
    return Promise.resolve({ status: this.#page()?.status ?? 200 });
  }

  back(): Promise<void> {
    this.#d.log.push('back');
    return Promise.resolve();
  }

  snapshot(maxChars: number): Promise<PageSnapshot> {
    const dead = this.#dead('snapshot');
    if (dead) return Promise.reject(dead);
    const p = this.#page();
    this.#refs.clear();
    const elements = (p?.elements ?? []).map((e, i) => {
      const ref = `e${i + 1}`;
      this.#refs.set(ref, i);
      const { navigates: _n, download: _d, ...rest } = e;
      return { ...rest, ref };
    });
    return Promise.resolve({
      url: this.#url,
      title: p?.title ?? '',
      text: (p?.text ?? '').slice(0, maxChars),
      tree: p ? `- document "${p.title}"` : '',
      elements,
      frames: p?.frames ?? [],
    });
  }

  #at(ref: string): FakeElement | undefined {
    const i = this.#refs.get(ref);
    return i === undefined ? undefined : this.#page()?.elements[i];
  }

  describe(ref: string): Promise<PageElement | null> {
    const e = this.#at(ref);
    if (!e) return Promise.resolve(null);
    const { navigates: _n, download: _d, ...rest } = e;
    return Promise.resolve({ ...rest, ref });
  }

  click(ref: string): Promise<void> {
    this.#d.log.push(`click ${ref}`);
    const dead = this.#dead('click');
    if (dead) return Promise.reject(dead);
    const e = this.#at(ref);
    if (!e) return Promise.reject(new Error(`no element ${ref}`));
    const to = e.navigates ?? (e.role === 'link' ? e.href : undefined);
    if (to) this.#nav(to, e.form?.method === 'post' ? 'POST' : 'GET');
    return Promise.resolve();
  }

  fill(ref: string, text: string): Promise<void> {
    this.#d.log.push(`fill ${ref}`);
    this.#d.fills.push({ ref, text });
    return Promise.resolve();
  }

  select(ref: string, value: string): Promise<void> {
    this.#d.log.push(`select ${ref} ${value}`);
    return Promise.resolve();
  }

  press(key: string): Promise<void> {
    this.#d.log.push(`press ${key}`);
    return Promise.resolve();
  }

  scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    this.#d.log.push(`scroll ${direction} ${amount}`);
    const dead = this.#dead('scroll');
    if (dead) return Promise.reject(dead);
    return Promise.resolve();
  }

  hover(ref: string): Promise<void> {
    this.#d.log.push(`hover ${ref}`);
    const dead = this.#dead('hover');
    if (dead) return Promise.reject(dead);
    if (!this.#at(ref)) return Promise.reject(new Error(`no element ${ref}`));
    return Promise.resolve();
  }

  waitFor(kind: 'load' | 'idle' | 'text', text: string | undefined): Promise<boolean> {
    this.#d.log.push(`wait ${kind}`);
    if (kind === 'text') return Promise.resolve((this.#page()?.text ?? '').includes(text ?? ''));
    return Promise.resolve(true);
  }

  screenshot(): Promise<Uint8Array> {
    const dead = this.#dead('screenshot');
    if (dead) return Promise.reject(dead);
    return Promise.resolve(new Uint8Array(PNG));
  }

  screenshotElement(ref: string): Promise<Uint8Array> {
    this.#d.log.push(`shot ${ref}`);
    const dead = this.#dead('screenshotElement');
    if (dead) return Promise.reject(dead);
    if (!this.#at(ref)) return Promise.reject(new Error(`no element ${ref}`));
    return Promise.resolve(new Uint8Array(ELEMENT_PNG));
  }

  download(ref: string): Promise<{ suggestedName: string; data: Uint8Array }> {
    this.#d.log.push(`download ${ref}`);
    const e = this.#at(ref);
    if (!e?.download) return Promise.reject(new Error('nothing was downloaded'));
    return Promise.resolve({
      suggestedName: e.download.name,
      data: new Uint8Array(Buffer.from(e.download.data)),
    });
  }

  upload(ref: string, files: { name: string; data: Uint8Array }[]): Promise<void> {
    this.#d.log.push(`upload ${ref} ${files.map((f) => `${f.name}:${f.data.length}`).join(',')}`);
    return Promise.resolve();
  }

  evaluate(expression: string): Promise<unknown> {
    this.#d.log.push(`evaluate ${expression}`);
    return Promise.resolve(this.#d.evaluateResult);
  }

  callPageTool(name: string, args: unknown): Promise<unknown> {
    this.#d.log.push(`pagetool ${name} ${JSON.stringify(args)}`);
    return Promise.resolve(this.#d.pageToolResult);
  }

  input(event: BrowserTakeoverInput): Promise<void> {
    this.#d.log.push(`input ${event.kind}`);
    return Promise.resolve();
  }

  /** The focused field takes a secret (set by tests for takeover typing). */
  secretFocused = false;

  focusedSecret(): Promise<boolean> {
    return Promise.resolve(this.secretFocused);
  }

  /** The driver's own crash signal: what `crash()` set, never an error's text. */
  crashState(): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.crashed === 'page') return Promise.resolve('the page crashed');
    if (this.crashed === 'browser') return Promise.resolve('the browser process exited');
    return Promise.resolve(null);
  }

  /** The next call of this name fails with this message, the page and browser still up. */
  failOn: { call: string; message: string } | null = null;

  storageState(): Promise<StorageState> {
    if (this.crashed === 'browser') return Promise.reject(new Error('Browser has been closed'));
    return Promise.resolve(this.storage);
  }

  cookies(): Promise<Record<string, unknown>[]> {
    if (this.crashed === 'browser') return Promise.reject(new Error('Browser has been closed'));
    return Promise.resolve(this.storage.cookies);
  }

  recover(): Promise<boolean> {
    if (this.crashed === 'browser' || this.closed) return Promise.resolve(false);
    this.recovers++;
    this.#d.log.push('recover');
    this.crashed = null;
    this.#url = 'about:blank';
    this.#refs.clear();
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    this.closed = true;
    this.#d.log.push('close');
    return Promise.resolve();
  }
}
