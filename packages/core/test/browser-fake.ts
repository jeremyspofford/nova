// A scripted browser for the browser area's unit tests: pages by URL with their elements, the
// driver guards honoured like the real driver (a refused main-frame navigation throws), and every
// call logged. Typed values are kept apart (`fills`) so tests can check that a password reached
// the browser and nothing else.
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

  probe(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve(
      this.available
        ? { ok: true, detail: 'fake browser' }
        : { ok: false, detail: 'No Chromium is installed for the agent browser.' },
    );
  }

  launch(opts: DriverLaunchOptions): Promise<DriverSession> {
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

  constructor(d: FakeDriver, opts: DriverLaunchOptions) {
    this.#d = d;
    this.opts = opts;
    if (opts.storageState) this.storage = opts.storageState;
  }

  #page(): FakePage | null {
    return this.#d.pages.get(this.#url) ?? null;
  }

  #nav(url: string): void {
    if (!this.opts.allowNavigation(url)) {
      this.opts.onBlockedNavigation?.(url);
      throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${url}`);
    }
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
    this.#nav(url);
    return Promise.resolve({ status: this.#page()?.status ?? 200 });
  }

  back(): Promise<void> {
    this.#d.log.push('back');
    return Promise.resolve();
  }

  snapshot(maxChars: number): Promise<PageSnapshot> {
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
    const e = this.#at(ref);
    if (!e) return Promise.reject(new Error(`no element ${ref}`));
    const to = e.navigates ?? (e.role === 'link' ? e.href : undefined);
    if (to) this.#nav(to);
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
    return Promise.resolve();
  }

  waitFor(kind: 'load' | 'idle' | 'text', text: string | undefined): Promise<boolean> {
    this.#d.log.push(`wait ${kind}`);
    if (kind === 'text') return Promise.resolve((this.#page()?.text ?? '').includes(text ?? ''));
    return Promise.resolve(true);
  }

  screenshot(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(PNG));
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

  storageState(): Promise<StorageState> {
    return Promise.resolve(this.storage);
  }

  close(): Promise<void> {
    this.closed = true;
    this.#d.log.push('close');
    return Promise.resolve();
  }
}
