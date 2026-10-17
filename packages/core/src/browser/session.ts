// One computer's agent browser (docs/11 §4): a clean profile per computer (ADR-080), traffic
// through an egress proxy session (docs/12 §8), the page guards, the last read (element refs),
// page-registered tools of the current origin (FR-208) and the takeover hooks the screen area
// uses (FR-087): pause/resume, user input while paused and a rate-capped live frame stream.
// Policy (site lists, approvals, the classifier) lives in BrowserService; this class only runs
// the browser and keeps its state.
import { X509Certificate, createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserSessionState, BrowserSessionView } from '@nova/shared';
import { readSealedFile, writeSealedFile } from '../attachments.ts';
import type { Logger } from '@nova/telemetry';
import type { EgressPolicy, EgressProxy, EgressSession } from '../computers/types.ts';
import type {
  BrowserDriver,
  DriverSession,
  PageElement,
  PageSnapshot,
  PageToolRegistration,
  StorageState,
  BrowserTakeoverInput,
} from './types.ts';
import { navigationAllowed, normalizeHost, requestAllowed, type SitePermissions } from './sites.ts';

/** The screenshot rate cap of the live stream (docs/11 §8: 1 per 2 s). */
export const BROWSER_FRAME_INTERVAL_MS = 2_000;
const MAX_PAGE_TOOLS = 20;

export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return normalizeHost(u.hostname);
  } catch {
    return null;
  }
}

/** The SPKI SHA-256 (base64) of the proxy's CA, which Chromium is told to accept. */
export function caSpki(pem: string | null): string | null {
  if (!pem) return null;
  try {
    const der = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('base64');
  } catch {
    return null;
  }
}

export interface SessionTimers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface BrowserSessionOptions {
  accountId: string;
  computerId: string;
  driver: BrowserDriver;
  profileDir: string;
  /** The data directory whose key seals the cookie state (docs/12 §5). */
  dataDir: string;
  executablePath: string | null;
  persistCookies: boolean;
  /** The egress proxy; null means direct network (only where the service allows it). */
  egress: EgressProxy | null;
  allowLocalBinding: boolean;
  /** Patterns the proxy lets this browser reach, and the ones it never does. */
  networkLists: () => Promise<{ allow: string[]; deny: string[] }>;
  timers: SessionTimers;
  log: Logger;
  now: () => Date;
}

/** Hosts the proxy session allows: each exact host also covers its subdomains. */
function proxyAllow(patterns: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    out.add(p);
    if (!p.startsWith('*.')) out.add(`*.${p}`);
  }
  return [...out].sort();
}

export class BrowserSession {
  readonly accountId: string;
  readonly computerId: string;
  readonly startedAt: string;
  state: BrowserSessionState = 'starting';
  pausedBy: string | null = null;
  lastActionAt: string | null = null;
  /** The last read: refs the actions take. Cleared when the page navigates. */
  snapshot: PageSnapshot | null = null;
  /** The field typed into last (what Enter submits). */
  lastTyped: PageElement | null = null;
  /** The current page was signed by an external agent (FR-194). */
  externalAgent: { id: string; reason: string } | null = null;
  /** A host the user allowed once: allowed while the browser stays on it. */
  visitHost: string | null = null;
  /** Main-frame navigations refused since the last report, and popups closed. */
  readonly blocked: string[] = [];
  readonly popups: string[] = [];
  /** Subresource hosts refused on the current page (reported by browser.read). */
  readonly blockedResources = new Set<string>();
  /** True while an action runs (the session is not idle). */
  busy = 0;
  /** What the guards allow; the service refreshes it before every action. */
  permissions: SitePermissions = { allow: [], deny: [], allowLocal: false };
  readonly #o: BrowserSessionOptions;
  #driver: DriverSession | null = null;
  #egress: EgressSession | null = null;
  #proxyAllow: string[] = [];
  #url = 'about:blank';
  readonly #pageTools = new Map<string, PageToolRegistration>();
  #resume: { promise: Promise<void>; release: () => void } | null = null;
  readonly #frames = new Set<(png: Uint8Array) => void>();
  #frameTimer: unknown = null;

  constructor(opts: BrowserSessionOptions) {
    this.#o = opts;
    this.accountId = opts.accountId;
    this.computerId = opts.computerId;
    this.startedAt = opts.now().toISOString();
  }

  get url(): string {
    return this.#url;
  }

  get host(): string | null {
    return hostOf(this.#url);
  }

  get open(): boolean {
    return this.#driver !== null && this.state !== 'closed';
  }

  get paused(): boolean {
    return this.pausedBy !== null;
  }

  // ---- launch -----------------------------------------------------------------------------

  #statePath(): string {
    return join(this.#o.profileDir, 'state.json');
  }

  #stateLabel(): string {
    return `browser-state:${this.#o.accountId}:${this.#o.computerId}`;
  }

  #loadState(): StorageState | null {
    if (!this.#o.persistCookies) {
      // Cookies are kept only while the setting is on (FR-096).
      rmSync(this.#statePath(), { force: true });
      return null;
    }
    try {
      const raw = readSealedFile(this.#o.dataDir, this.#statePath(), this.#stateLabel());
      return JSON.parse(raw.toString('utf8')) as StorageState;
    } catch {
      return null;
    }
  }

  async #saveState(): Promise<void> {
    if (!this.#driver || !this.#o.persistCookies) return;
    try {
      const state = await this.#driver.storageState();
      // Cookies are credentials: sealed with the data key like every blob.
      writeSealedFile(
        this.#o.dataDir,
        this.#statePath(),
        this.#stateLabel(),
        Buffer.from(JSON.stringify(state)),
      );
    } catch (err) {
      this.#o.log.warn('could not save the browser profile', { err });
    }
  }

  async #openEgress(): Promise<{ server: string; caSpki: string | null } | null> {
    if (!this.#o.egress) return null;
    const lists = await this.#o.networkLists();
    const allow = proxyAllow([...lists.allow, ...(this.visitHost ? [this.visitHost] : [])]);
    const policy: EgressPolicy = {
      mode: 'allowlist',
      allow,
      deny: [...lists.deny],
      credentials: [],
      allowLocalBinding: this.#o.allowLocalBinding,
    };
    const session = await this.#o.egress.open({
      accountId: this.accountId,
      scope: { kind: 'sandbox', id: `browser:${this.computerId}` },
      policy,
    });
    this.#egress = session;
    this.#proxyAllow = allow;
    return { server: session.proxyUrl, caSpki: caSpki(session.caCertPem) };
  }

  /** Start the browser (or start it again with the same cookies). */
  async launch(carry: StorageState | null = null): Promise<void> {
    mkdirSync(this.#o.profileDir, { recursive: true, mode: 0o700 });
    const proxy = await this.#openEgress();
    try {
      this.#driver = await this.#o.driver.launch({
        profileDir: this.#o.profileDir,
        proxy,
        storageState: carry ?? this.#loadState(),
        viewport: { width: 1280, height: 800 },
        executablePath: this.#o.executablePath,
        allowNavigation: (url) => this.allowsNavigation(url),
        allowRequest: (url) => {
          const ok = this.allowsRequest(url);
          if (!ok) {
            const h = hostOf(url);
            if (h && this.blockedResources.size < 50) this.blockedResources.add(h);
          }
          return ok;
        },
        onNavigated: (url) => this.#navigated(url),
        onPageTool: (op, reg) => this.#pageTool(op, reg),
        onBlockedNavigation: (url) => {
          if (this.blocked.length < 10) this.blocked.push(url);
        },
        onPopup: (url) => {
          if (this.popups.length < 10) this.popups.push(url);
        },
      });
    } catch (err) {
      await this.#egress?.close().catch(() => undefined);
      this.#egress = null;
      this.state = 'error';
      throw err;
    }
    this.#url = this.#driver.url();
    this.state = this.paused ? 'paused' : 'running';
  }

  /** The navigation guard (docs/11 §4): blocked and unknown sites never load. */
  allowsNavigation(url: string): boolean {
    const h = hostOf(url);
    return h !== null && navigationAllowed(this.permissions, this.visitHost, h);
  }

  allowsRequest(url: string): boolean {
    const h = hostOf(url);
    return h !== null && requestAllowed(this.permissions, this.visitHost, h);
  }

  /**
   * Whether the proxy session already reaches `host`; when not, reopen it with the current lists
   * and restart the browser with the same cookies (the proxy's allowlist is fixed per session).
   */
  async ensureReachable(host: string): Promise<void> {
    if (!this.#o.egress || !this.#driver) return;
    const covered = this.#proxyAllow.some(
      (p) => p === host || (p.startsWith('*.') && host.endsWith(p.slice(1))),
    );
    if (covered) return;
    const carry = await this.#driver.storageState().catch(() => null);
    const url = this.#url;
    await this.#driver.close().catch(() => undefined);
    await this.#egress?.close().catch(() => undefined);
    this.#driver = null;
    this.#egress = null;
    await this.launch(carry);
    this.#url = url === 'about:blank' ? this.#url : url;
  }

  #navigated(url: string): void {
    const before = hostOf(this.#url);
    const after = hostOf(url);
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return 'null';
      }
    })();
    this.#url = url;
    this.snapshot = null;
    this.lastTyped = null;
    // What a page said about itself, and what it could not load, belong to that page.
    this.externalAgent = null;
    this.blockedResources.clear();
    if (before !== after && this.visitHost && after !== this.visitHost) this.visitHost = null;
    // Page tools belong to the origin that registered them (FR-208).
    for (const [name, reg] of this.#pageTools)
      if (reg.origin !== origin) this.#pageTools.delete(name);
  }

  #pageTool(op: 'register' | 'unregister', reg: PageToolRegistration): void {
    if (op === 'unregister') {
      this.#pageTools.delete(reg.name);
      return;
    }
    if (!/^[A-Za-z0-9_]{1,64}$/.test(reg.name)) return;
    try {
      if (reg.origin !== new URL(this.#url).origin) return;
    } catch {
      return;
    }
    if (!this.#pageTools.has(reg.name) && this.#pageTools.size >= MAX_PAGE_TOOLS) return;
    let schema = reg.inputSchema;
    if (JSON.stringify(schema).length > 10_000 || schema.type !== 'object')
      schema = { type: 'object' };
    this.#pageTools.set(reg.name, {
      origin: reg.origin,
      name: reg.name,
      description: reg.description.slice(0, 1_000),
      inputSchema: schema,
    });
  }

  /** Page tools of the current origin. */
  pageTools(): PageToolRegistration[] {
    return [...this.#pageTools.values()];
  }

  // ---- the driver, guarded ------------------------------------------------------------------

  get driver(): DriverSession {
    if (!this.#driver) throw new Error('the browser is not running');
    return this.#driver;
  }

  /** Track the URL after an action (the driver's page may have navigated). */
  sync(): void {
    if (this.#driver) {
      const u = this.#driver.url();
      if (u !== this.#url) this.#navigated(u);
    }
  }

  touch(): void {
    this.lastActionAt = this.#o.now().toISOString();
  }

  element(ref: string): PageElement | null {
    return this.snapshot?.elements.find((e) => e.ref === ref) ?? null;
  }

  // ---- takeover (FR-087) --------------------------------------------------------------------

  /** The user takes control: agent writes wait until `resume`. */
  pause(by: string): void {
    if (this.pausedBy) return;
    this.pausedBy = by;
    let release = () => {};
    const promise = new Promise<void>((r) => (release = r));
    this.#resume = { promise, release };
    if (this.state === 'running') this.state = 'paused';
  }

  resume(): void {
    if (!this.pausedBy) return;
    this.pausedBy = null;
    const r = this.#resume;
    this.#resume = null;
    if (this.state === 'paused') this.state = 'running';
    // The user may have navigated: refs from before are stale.
    this.sync();
    this.snapshot = null;
    r?.release();
  }

  /** Wait while the user has control; rejects when the call is cancelled. */
  async untilResumed(signal: AbortSignal): Promise<void> {
    while (this.#resume) {
      const r = this.#resume;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new Error('cancelled while the user had control'));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        void r.promise.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
  }

  /** The user's own input while they have control; refused otherwise. */
  async input(event: BrowserTakeoverInput): Promise<void> {
    if (!this.pausedBy) throw new Error('input is accepted only while the user has control');
    await this.driver.input(event);
    this.sync();
  }

  /**
   * A live screenshot stream at most once per 2 s (docs/11 §8). Returns an unsubscribe.
   * Frames are not stored.
   */
  onFrame(listener: (png: Uint8Array) => void, intervalMs = BROWSER_FRAME_INTERVAL_MS): () => void {
    this.#frames.add(listener);
    if (this.#frameTimer === null) {
      this.#frameTimer = this.#o.timers.setInterval(
        () => void this.#frame(),
        Math.max(intervalMs, BROWSER_FRAME_INTERVAL_MS),
      );
    }
    return () => {
      this.#frames.delete(listener);
      if (this.#frames.size === 0 && this.#frameTimer !== null) {
        this.#o.timers.clearInterval(this.#frameTimer);
        this.#frameTimer = null;
      }
    };
  }

  async #frame(): Promise<void> {
    if (!this.#driver || this.#frames.size === 0) return;
    try {
      const png = await this.#driver.screenshot(false);
      for (const fn of this.#frames) fn(png);
    } catch (err) {
      this.#o.log.debug('live frame failed', { err });
    }
  }

  // ---- end ----------------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.resume();
    if (this.#frameTimer !== null) this.#o.timers.clearInterval(this.#frameTimer);
    this.#frameTimer = null;
    this.#frames.clear();
    await this.#saveState();
    await this.#driver?.close().catch(() => undefined);
    await this.#egress?.close().catch(() => undefined);
    this.#driver = null;
    this.#egress = null;
    this.state = 'closed';
  }

  /** Forget this computer's saved cookies (a deleted computer, or the user cleared them). */
  clearProfile(): void {
    if (existsSync(this.#o.profileDir)) rmSync(this.#statePath(), { force: true });
  }

  view(): BrowserSessionView {
    const host = this.host;
    return {
      computerId: this.computerId,
      state: this.state,
      url: this.#url === 'about:blank' ? null : this.#url,
      title: this.snapshot?.title ?? null,
      host,
      pausedBy: this.pausedBy,
      pageTools: host ? this.pageTools().map((t) => `page:${host}.${t.name}`) : [],
      startedAt: this.startedAt,
      lastActionAt: this.lastActionAt,
      persistCookies: this.#o.persistCookies,
    };
  }
}
