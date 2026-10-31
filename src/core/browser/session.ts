// One browser task's browser (M5 plan §3): a fresh Chromium driven over CDP, its requests held to
// the task's declared hosts, a live picture for the person, and takeover. Era 1's session had the
// same three duties (pause/resume, frames, guards); this one speaks CDP directly.
//
// Takeover: the person may take the browser over at any time, and the worker asks for it at a step
// only a person may do. While someone holds it, every action of the worker waits at `gate()`: the
// worker does nothing. Handing back lets the worker carry on from the page as the person left it.
import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { CoreError } from '../errors.ts';
import { launch, type LaunchOptions, type Launched } from './chromium.ts';
import { lookup } from 'node:dns/promises';
import { BROWSER_TASK_HEADER } from '../mesh/access.ts';
import { HUB_REFUSAL, NO_HUB, allowed, hostOf, reachesHub, target, thisMachine, type Hub } from './plan.ts';
import type { Cdp } from './cdp.ts';
import type { Target } from './plan.ts';
import { ORDER_PATH, PAY_PATH } from './copilot.ts';

// `paused`: the person paused the worker (M10b); it waits at its next gate, with nobody driving.
export type Mode = 'starting' | 'working' | 'paused' | 'needs_person' | 'taken_over' | 'finishing' | 'closed';

// Who holds the browser: `key` is the console or `device:<id>`; `label` is what the person reads.
export interface Holder { key: string; label: string }

// `by`: who asked. A request refused at the proxy can't be told apart: Chromium's own calls home
// end there, and so does a page's WebSocket, so it is put down to the browser.
// `reason`: why, in plain words, when it isn't simply a host the task didn't declare.
export interface Blocked { host: string; count: number; first_at: string; by: 'page' | 'person' | 'plan' | 'browser'; via: 'fetch' | 'proxy' | 'plan'; kind: string; reason?: string }

export interface Frame { seq: number; jpeg: string; width: number; height: number }

export interface SessionView {
  task_id: string;
  live: boolean;
  mode: Mode;
  url: string;
  step: { n: number; of: number; what: string } | null;
  // What the worker asked the person to do, while it waits for them.
  asked: string | null;
  holder: { key: string; label: string; since: string } | null;
  blocked: { host: string; count: number }[];
}

export type Input =
  | { type: 'click'; x: number; y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string };

// Keys the person can press that aren't text: their CDP names and Windows key codes.
const KEYS: Record<string, [string, number, string?]> = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Backspace: ['Backspace', 8], Escape: ['Escape', 27], Delete: ['Delete', 46],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ' ': ['Space', 32, ' '],
};
export const INPUT_KEYS = Object.keys(KEYS);

// Frames go out at most this often; the newest one wins.
const FRAME_GAP_MS = 100;
const MAX_BLOCKED_HOSTS = 50;

export interface SessionOptions {
  taskId: string;
  chromium: string;
  hosts: string[];
  sandbox: boolean;
  now?: () => Date;
  width?: number;
  height?: number;
  // Where Nova itself listens (plan.ts): refused whatever the declared hosts say.
  hub?: () => Hub;
  // How the browser is started: Chromium, or a stand-in in tests.
  launch?: (o: LaunchOptions) => Promise<Launched>;
  // Nova's own persistent profile (profile.ts); without it, a throwaway one (M5c).
  profile?: string;
}

// Where an element is: a CSS selector (the DOM), or an accessibility target (role and name).
export interface Locator { selector?: string; target?: Target }
// A dialog a page opened with alert, confirm or prompt (dismissed at once, as in M5c).
export interface JsDialog { type: string; message: string; url: string }

export const PAY_GUARD = 'A request that would pay: Nova never pays. Paying is yours (tier 3).';
export const SENDS_UNASKED = 'The page tried to send something no step of the plan sends (a script, a beacon, a form sending itself): refused.';
export const SENDS_ELSEWHERE = 'The step sends only where the plan says it does; this went somewhere else: refused.';
export const SENDS_LOCKED = 'Nova stopped at the checkout: nothing more is sent from this page.';
// Where a request goes, for the send guard: origin and path.
export const sendKey = (url: string): string => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return ''; } };

export class Session extends EventEmitter {
  readonly taskId: string;
  readonly hosts: string[];
  mode: Mode = 'starting';
  url = 'about:blank';
  step: SessionView['step'] = null;
  asked: string | null = null;
  holder: (Holder & { since: number }) | null = null;
  readonly blocked = new Map<string, Blocked>();
  // Whether the task's plan marks the step where its outside effect happens (plan.ts, `commits`).
  commits = false;
  #o: SessionOptions;
  #now: () => Date;
  #browser: Launched | null = null;
  #refuser: Server | null = null;
  #sockets = new Set<Socket>();
  #cdp: Cdp | null = null;
  #page: string | null = null;
  #mainFrame: string | null = null;
  #loading = 0;
  #viewers = new Set<(f: Frame) => void>();
  #frame: Frame | null = null;
  #meta = { width: 1280, height: 800 };
  #seq = 0;
  #lastSent = 0;
  #pendingFrame: ReturnType<typeof setTimeout> | null = null;
  #casting = false;
  #handedBack: (() => void)[] = [];
  #closedWhy: string | null = null;
  #dialogs: JsDialog[] = [];
  #pausedBy: (Holder & { since: number }) | null = null;
  // Where a pay form sends (origin and path), found by the worker on the pages it reads: a request
  // there that isn't a GET is refused unless the person holds the browser.
  readonly payTargets = new Set<string>();
  // What may send (review of PR #238, 2). While Nova drives, every request that isn't a GET is a
  // potential commit: it goes out only while a declared step is acting, and only to where that step
  // accounts for (`allowSends`); after the checkout stop, none at all (`lockSends`). Pay addresses
  // are refused whatever the method. The person holding the browser may send anything.
  #sends: { step: number; to: Set<string> } | null = null;
  #locked = false;
  #refusals = 0;

  constructor(o: SessionOptions) {
    super();
    this.setMaxListeners(50);
    this.#o = o;
    this.taskId = o.taskId;
    this.hosts = o.hosts;
    this.#now = o.now ?? (() => new Date());
  }

  get live(): boolean { return this.mode !== 'closed'; }

  view(): SessionView {
    return {
      task_id: this.taskId, live: this.live, mode: this.mode, url: this.url, step: this.step, asked: this.asked,
      holder: this.holder ? { key: this.holder.key, label: this.holder.label, since: new Date(this.holder.since).toISOString() } : null,
      // What the pages and the person were refused. Chromium's own calls home, refused at the
      // proxy, are in the task's record but aren't news to the person watching.
      blocked: [...this.blocked.values()].filter((b) => b.via !== 'proxy').map((b) => ({ host: b.host, count: b.count })),
    };
  }

  // ---- starting and stopping ---------------------------------------------------------------

  async open(): Promise<void> {
    this.#refuser = await this.#startRefuser();
    const { port } = this.#refuser.address() as { port: number };
    const width = this.#o.width ?? 1280;
    const height = this.#o.height ?? 800;
    this.#meta = { width, height };
    this.#browser = await (this.#o.launch ?? launch)({ path: this.#o.chromium, bypass: this.hosts, refuser: `http://127.0.0.1:${port}`, sandbox: this.#o.sandbox, width, height, ...(this.#o.profile ? { profile: this.#o.profile } : {}) });
    const cdp = this.#browser.cdp;
    this.#cdp = cdp;
    cdp.on('close', (why: string) => { if (this.mode !== 'closed') this.#closeNow(`the browser stopped (${why})`); });
    // Every target the browser makes (the page, a popup, an iframe in another process, a worker)
    // is attached before it runs, so its requests are held to the declared hosts from the start.
    cdp.on('Target.attachedToTarget', (p: { sessionId: string; targetInfo: { targetId: string; type: string }; waitingForDebugger: boolean }) => { void this.#attached(p); });
    cdp.on('Fetch.requestPaused', (p: { requestId: string; request: { url: string }; resourceType?: string }, sid?: string) => { void this.#paused(p, sid); });
    cdp.on('Page.screencastFrame', (p: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }, sid?: string) => { void this.#screencast(p, sid); });
    cdp.on('Page.frameNavigated', (p: { frame: { id: string; url: string; parentId?: string } }, sid?: string) => {
      if (sid !== this.#page || p.frame.parentId) return;
      this.#mainFrame = p.frame.id;
      this.url = p.frame.url;
      this.emit('change');
    });
    cdp.on('Page.frameStartedLoading', (p: { frameId: string }, sid?: string) => { if (sid === this.#page && (!this.#mainFrame || p.frameId === this.#mainFrame)) this.#loading++; });
    cdp.on('Page.frameStoppedLoading', (p: { frameId: string }, sid?: string) => { if (sid === this.#page && (!this.#mainFrame || p.frameId === this.#mainFrame)) this.#loading = Math.max(0, this.#loading - 1); this.emit('loaded'); });
    // A page's alert or confirm would stop it; nobody can answer it from a picture. What it said is
    // kept for the worker, which screens it (M10b: a dialog may be an injection), and never followed.
    cdp.on('Page.javascriptDialogOpening', (p: { type?: string; message?: string; url?: string }, sid?: string) => {
      if (this.#dialogs.length < 20) this.#dialogs.push({ type: String(p?.type ?? 'alert'), message: String(p?.message ?? '').slice(0, 4000), url: String(p?.url ?? this.url) });
      this.emit('dialog');
      void cdp.send('Page.handleJavaScriptDialog', { accept: false }, sid).catch(() => {});
    });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    // The first page may already exist; attach to it if auto-attach didn't.
    for (let i = 0; i < 40 && !this.#page; i++) await new Promise((r) => setTimeout(r, 25));
    if (!this.#page) {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
      const page = targetInfos.find((t) => t.type === 'page');
      if (!page) throw new Error('Chromium opened no page.');
      await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      for (let i = 0; i < 80 && !this.#page; i++) await new Promise((r) => setTimeout(r, 25));
      if (!this.#page) throw new Error('Nova couldn’t attach to the browser’s page.');
    }
    this.mode = 'working';
    this.emit('change');
  }

  async #attached(p: { sessionId: string; targetInfo: { targetId: string; type: string }; waitingForDebugger: boolean }): Promise<void> {
    const cdp = this.#cdp!;
    const sid = p.sessionId;
    const type = p.targetInfo.type;
    try {
      if (['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].includes(type)) {
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid).catch(() => {});
      }
      if (type === 'page' || type === 'iframe') await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
      if (type === 'page' && !this.#page) {
        this.#page = sid;
        await cdp.send('Page.enable', {}, sid);
        await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sid).catch(() => {});
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: this.#meta.width, height: this.#meta.height, deviceScaleFactor: 1, mobile: false }, sid);
      } else if (type === 'page') {
        // A second window (a popup): the task has one page, so it is closed. Its requests were
        // already held to the declared hosts.
        this.emit('popup');
        await cdp.send('Target.closeTarget', { targetId: p.targetInfo.targetId }).catch(() => {});
        return;
      }
    } finally {
      if (p.waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
    }
  }

  // Every request of every target: inside the declared hosts it goes on, anything else is refused
  // and recorded (host and port only: a path or query can carry what a page tried to send).
  //
  // Nova's own listeners are refused even inside the declared hosts. Whatever goes on carries the
  // task's mark (BROWSER_TASK_HEADER), set here, beneath the page: a page can't remove it, and
  // Nova treats anything carrying it as nobody in particular (mesh/access.ts), so a page that
  // got to Nova anyway would get no more than a stranger would.
  async #paused(p: { requestId: string; request: { url: string; method?: string; headers?: Record<string, string> }; resourceType?: string }, sid?: string): Promise<void> {
    const cdp = this.#cdp;
    if (!cdp) return;
    const url = p.request.url;
    if (/^(data|blob|about):/.test(url)) {
      await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sid).catch(() => {});
      return;
    }
    const by = this.mode === 'taken_over' ? 'person' : 'page';
    const kind = (p.resourceType ?? 'request').toLowerCase();
    // Stopped: nothing lands afterwards.
    if (this.mode === 'closed') {
      await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' }, sid).catch(() => {});
      return;
    }
    const nova = await this.#reachesHub(url);
    const why = !nova && this.mode !== 'taken_over' ? this.#sendRefusal(url, (p.request.method ?? 'GET').toUpperCase()) : null;
    if (why) {
      this.#block(hostOf(url), by, 'fetch', kind, why.why);
      if (this.#refusals++ < 50) this.emit(why.pay ? 'pay_refused' : 'send_refused', { host: hostOf(url), method: (p.request.method ?? 'GET').toUpperCase(), kind, why: why.why });
      await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
      return;
    }
    if (!nova && allowed(url, this.hosts)) {
      const headers = Object.entries(p.request.headers ?? {}).filter(([k]) => k.toLowerCase() !== BROWSER_TASK_HEADER).map(([name, value]) => ({ name, value }));
      headers.push({ name: BROWSER_TASK_HEADER, value: this.taskId });
      await cdp.send('Fetch.continueRequest', { requestId: p.requestId, headers }, sid).catch(() => {});
      return;
    }
    this.#block(hostOf(url), by, 'fetch', kind, nova ? HUB_REFUSAL : undefined);
    await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
  }

  // Why a request may not go out while Nova drives, or null.
  #sendRefusal(url: string, method: string): { why: string; pay: boolean } | null {
    if (this.#paysAt(url)) return { why: PAY_GUARD, pay: true };
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
    try { if (ORDER_PATH.test(new URL(url).pathname)) return { why: PAY_GUARD, pay: true }; } catch { /* not an address */ }
    if (this.#locked) return { why: SENDS_LOCKED, pay: true };
    if (!this.#sends) return { why: SENDS_UNASKED, pay: false };
    if (!this.#sends.to.has(sendKey(url))) return { why: SENDS_ELSEWHERE, pay: false };
    return null;
  }

  // The step now acting, and where it may send (absolute addresses; the query doesn't count), or
  // null once it is done.
  allowSends(step: number | null, to: string[] = []): void {
    this.#sends = step === null ? null : { step, to: new Set(to.map(sendKey).filter(Boolean)) };
  }

  // The checkout stop: from now on nothing that isn't a GET leaves this browser while Nova drives.
  lockSends(): void { this.#locked = true; this.#sends = null; }

  #paysAt(url: string): boolean {
    try {
      const u = new URL(url);
      return this.payTargets.has(`${u.origin}${u.pathname}`) || PAY_PATH.test(u.pathname);
    } catch { return false; }
  }

  addPayTarget(url: string): void {
    try { const u = new URL(url); if (this.payTargets.size < 50) this.payTargets.add(`${u.origin}${u.pathname}`); } catch { /* not an address */ }
  }

  // Whether a URL would reach Nova itself: by its address or this machine's names, or by a name
  // that resolves to this machine now (asked once per name, and only at Nova's own ports).
  #resolved = new Map<string, Promise<boolean>>();
  async #reachesHub(url: string): Promise<boolean> {
    const hub = (() => { try { return this.#o.hub?.() ?? NO_HUB; } catch { return NO_HUB; } })();
    if (reachesHub(url, hub)) return true;
    const t = target(url);
    if (!t || !hub.ports.includes(t.port) || /^[\d.]+$|^\[/.test(t.host)) return false;
    let r = this.#resolved.get(t.host);
    if (!r) {
      r = lookup(t.host, { all: true }).then((xs) => xs.some((x) => thisMachine(x.address, hub)), () => false);
      this.#resolved.set(t.host, r);
    }
    return r;
  }

  #block(host: string, by: Blocked['by'], via: Blocked['via'], kind: string, reason?: string): void {
    const seen = this.blocked.get(host);
    if (seen) { seen.count++; return; }
    if (this.blocked.size >= MAX_BLOCKED_HOSTS) return;
    const b: Blocked = { host, count: 1, first_at: this.#now().toISOString(), by, via, kind, ...(reason ? { reason } : {}) };
    this.blocked.set(host, b);
    this.emit('blocked', b);
    this.emit('change');
  }

  // The plan itself asked for a host it may not reach.
  refusedByPlan(url: string): void {
    this.#block(hostOf(url), 'plan', 'plan', 'navigation');
  }

  // The second wall: what Fetch can't hold (a WebSocket, say) is sent here by Chromium's proxy
  // setting, unless its host was declared. It is refused, and recorded.
  #startRefuser(): Promise<Server> {
    const server = createServer((sock) => {
      this.#sockets.add(sock);
      sock.on('close', () => this.#sockets.delete(sock));
      sock.on('error', () => {});
      let head = '';
      sock.on('data', (d) => {
        head += String(d);
        if (!head.includes('\r\n') && head.length < 8192) return;
        const [, target = ''] = /^[A-Z]+ (\S+)/.exec(head) ?? [];
        const host = /^[a-z]+:\/\//i.test(target) ? hostOf(target) : target.toLowerCase() || 'unknown';
        this.#block(host, 'browser', 'proxy', 'connection');
        sock.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      });
    });
    return new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => ok(server));
    });
  }

  close(why = 'finished'): Promise<void> {
    return this.#closeNow(why);
  }

  async #closeNow(why: string): Promise<void> {
    if (this.mode === 'closed') return;
    const held = this.holder;
    this.mode = 'closed';
    this.#closedWhy = why;
    if (held) {
      this.holder = null;
      this.emit('takeover_ended', { holder: held, duration_ms: Date.now() - held.since, how: 'the task ended' });
    }
    if (this.#pendingFrame) clearTimeout(this.#pendingFrame);
    for (const fn of this.#handedBack.splice(0)) fn();
    this.emit('change');
    this.emit('closed', why);
    await this.#browser?.close().catch(() => {});
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((r) => (this.#refuser ? this.#refuser.close(() => r()) : r()));
  }

  // ---- what the worker waits on ------------------------------------------------------------

  // Resolves once nobody holds the browser and nobody is being waited for; rejects once the
  // session is closed. Returns how long it waited, so a step's own time limit can leave out the
  // time the person had it.
  async gate(): Promise<number> {
    const started = Date.now();
    while (this.mode === 'taken_over' || this.mode === 'needs_person' || this.mode === 'paused') {
      await new Promise<void>((r) => this.#handedBack.push(r));
    }
    if (this.mode === 'closed') throw new Error(`The browser closed: ${this.#closedWhy ?? 'stopped'}.`);
    return Date.now() - started;
  }

  // The worker asks for the person and waits for them to hand back.
  async needPerson(why: string): Promise<void> {
    if (this.mode === 'closed') throw new Error(`The browser closed: ${this.#closedWhy ?? 'stopped'}.`);
    this.asked = why;
    if (this.mode !== 'taken_over') this.mode = 'needs_person';
    this.emit('change');
    try {
      await this.gate();
    } finally {
      this.asked = null;
    }
  }

  // ---- takeover ---------------------------------------------------------------------------

  // ---- pause (M10b) -------------------------------------------------------------------------

  // The person pauses the worker: it stops at its next gate and waits, with nobody driving.
  pause(h: Holder): SessionView {
    if (this.mode === 'closed' || this.mode === 'finishing' || this.mode === 'starting') throw new CoreError('conflict', this.mode === 'starting' ? 'The browser is still starting. Try again in a moment.' : 'This task’s browser work is over; there’s nothing to pause.');
    if (this.mode === 'paused' || this.mode === 'taken_over' || this.mode === 'needs_person') return this.view();
    this.#pausedBy = { ...h, since: Date.now() };
    this.mode = 'paused';
    this.emit('paused', { holder: h });
    this.emit('change');
    return this.view();
  }

  resume(h: Holder): SessionView {
    if (this.mode !== 'paused') throw new CoreError('conflict', 'This task isn’t paused.');
    const by = this.#pausedBy;
    this.#pausedBy = null;
    this.mode = 'working';
    this.emit('resumed', { holder: h, duration_ms: by ? Date.now() - by.since : 0 });
    this.emit('change');
    for (const fn of this.#handedBack.splice(0)) fn();
    return this.view();
  }

  takeOver(h: Holder): SessionView {
    if (this.mode === 'paused' && !this.holder) this.#pausedBy = null;
    if (this.mode === 'closed' || this.mode === 'finishing' || this.mode === 'starting') throw new CoreError('conflict', this.mode === 'starting' ? 'The browser is still starting. Try again in a moment.' : 'This task’s browser work is over; there’s nothing to take over.');
    if (this.holder && this.holder.key !== h.key) throw new CoreError('conflict', `${this.holder.label} has already taken over.`);
    if (this.holder) return this.view();
    const requested = this.mode === 'needs_person';
    this.holder = { ...h, since: Date.now() };
    this.mode = 'taken_over';
    this.emit('takeover_started', { holder: h, requested, asked: this.asked });
    this.emit('change');
    return this.view();
  }

  handBack(h: Holder): { duration_ms: number } {
    if (!this.holder) throw new CoreError('conflict', 'Nobody has taken over this task.');
    // The hub's own screen can always end a takeover, say one left open on another device.
    if (this.holder.key !== h.key && h.key !== 'console') throw new CoreError('forbidden', `${this.holder.label} has control; only they, or the hub’s own screen, can hand back.`);
    const held = this.holder;
    const duration_ms = Date.now() - held.since;
    this.holder = null;
    this.mode = 'working';
    this.emit('takeover_ended', { holder: held, duration_ms, how: held.key === h.key ? 'handed back' : `ended by ${h.label}` });
    this.emit('change');
    for (const fn of this.#handedBack.splice(0)) fn();
    return { duration_ms };
  }

  // Nova ends a takeover itself: the one holding the browser may no longer (their device was
  // removed, or may no longer approve). A step that waits for a person waits for someone else;
  // otherwise the worker carries on from the page as it was left.
  release(how: string): void {
    const held = this.holder;
    if (!held || this.mode !== 'taken_over') return;
    this.holder = null;
    this.mode = this.asked ? 'needs_person' : 'working';
    this.emit('takeover_ended', { holder: held, duration_ms: Date.now() - held.since, how });
    this.emit('change');
    for (const fn of this.#handedBack.splice(0)) fn();
  }

  // The dialogs pages opened since the last call, for the worker to screen.
  takeDialogs(): JsDialog[] { return this.#dialogs.splice(0); }

  // The person's pointer and keys, only from whoever holds the browser.
  async input(h: Holder, e: Input): Promise<void> {
    if (!this.holder) throw new CoreError('conflict', 'Take over first: Nova is working in this browser.');
    if (this.holder.key !== h.key) throw new CoreError('forbidden', `${this.holder.label} has control of this browser.`);
    const cdp = this.#cdp;
    const sid = this.#page;
    if (!cdp || !sid) throw new CoreError('conflict', 'The browser isn’t open.');
    const at = (x: number, y: number) => ({ x: Math.round(clamp(x) * this.#meta.width), y: Math.round(clamp(y) * this.#meta.height) });
    switch (e.type) {
      case 'click': {
        const p = at(e.x, e.y);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p }, sid);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 }, sid);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 }, sid);
        break;
      }
      case 'move':
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(e.x, e.y) }, sid);
        break;
      case 'scroll':
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...at(e.x, e.y), deltaX: Math.round(e.dx), deltaY: Math.round(e.dy) }, sid);
        break;
      case 'text':
        await cdp.send('Input.insertText', { text: e.text }, sid);
        break;
      case 'key': {
        const k = KEYS[e.key];
        if (!k) throw new CoreError('validation', `Nova can’t send the key ${e.key}.`);
        const [code, vk, text] = k;
        await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: e.key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) }, sid);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: e.key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid);
        break;
      }
    }
  }

  // ---- the live picture --------------------------------------------------------------------

  // A viewer gets the newest frame at once, then each new one. The browser draws frames only
  // while someone watches.
  watch(fn: (f: Frame) => void): () => void {
    this.#viewers.add(fn);
    if (this.#frame) fn(this.#frame);
    if (!this.#casting) void this.#cast(true);
    return () => {
      this.#viewers.delete(fn);
      if (!this.#viewers.size) void this.#cast(false);
    };
  }

  async #cast(on: boolean): Promise<void> {
    const cdp = this.#cdp;
    if (!cdp || !this.#page || this.mode === 'closed' || on === this.#casting) return;
    this.#casting = on;
    if (on) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: this.#meta.width, maxHeight: this.#meta.height, everyNthFrame: 1 }, this.#page).catch(() => { this.#casting = false; });
    else await cdp.send('Page.stopScreencast', {}, this.#page).catch(() => {});
  }

  async #screencast(p: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }, sid?: string): Promise<void> {
    if (sid !== this.#page) return;
    await this.#cdp?.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => {});
    this.#frame = { seq: ++this.#seq, jpeg: p.data, width: Math.round(p.metadata.deviceWidth ?? this.#meta.width), height: Math.round(p.metadata.deviceHeight ?? this.#meta.height) };
    const send = () => {
      this.#pendingFrame = null;
      this.#lastSent = Date.now();
      for (const v of this.#viewers) v(this.#frame!);
    };
    const wait = FRAME_GAP_MS - (Date.now() - this.#lastSent);
    if (wait <= 0) send();
    else this.#pendingFrame ??= setTimeout(send, wait);
  }

  // ---- what the worker does ----------------------------------------------------------------

  #send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.#cdp || !this.#page) return Promise.reject(new Error('The browser isn’t open.'));
    return this.#cdp.send<T>(method, params, this.#page);
  }

  // Runs in a world of Nova's own beside the page's: the page shares the DOM but can't replace
  // the functions Nova calls, so it can't mislead the worker about what is there.
  async evaluate<T>(expression: string): Promise<T> {
    return this.#run<T>(await this.#world(), expression);
  }

  // What the worker does to the page (types, chooses, clicks), never while someone holds it. The
  // hold is checked after the last wait and before the call that acts goes out, with nothing
  // awaited in between: a takeover that starts after that starts after the action, never during
  // it; one that started before it makes the worker wait, and look again.
  async act<T>(expression: string): Promise<T> {
    for (;;) {
      await this.gate();
      const world = await this.#world();
      if (this.#mustWait()) continue;
      return this.#run<T>(world, expression);
    }
  }

  // The one check every action makes after its last wait and right before the call that acts goes
  // out, with nothing awaited in between (review of PR #238, 1): someone holds the browser, the
  // worker is waiting for them, or it is paused, so it waits and looks again; or it was stopped.
  #mustWait(): boolean {
    if (this.mode === 'closed') throw new Error(`The browser closed: ${this.#closedWhy ?? 'stopped'}.`);
    return this.mode === 'taken_over' || this.mode === 'needs_person' || this.mode === 'paused';
  }

  // Gives the page a moment and returns what is pending; for tests and the worker's own waits.
  get dialogsPending(): number { return this.#dialogs.length; }

  async #world(): Promise<number> {
    const tree = await this.#send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    const world = await this.#send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'nova' });
    return world.executionContextId;
  }

  async #run<T>(contextId: number, expression: string): Promise<T> {
    const r = await this.#send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression, contextId, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'The page threw an error.');
    return r.result.value as T;
  }

  // ---- elements, by the DOM or the accessibility tree (M10b) ----------------------------------

  // The element in Nova's world, or null. A selector is asked of the DOM; a target of the
  // accessibility tree (CDP Accessibility.queryAXTree, by role and accessible name), first match
  // that isn't ignored.
  async #resolve(world: number, loc: Locator): Promise<string | null> {
    if (loc.selector) {
      const r = await this.#send<{ result: { objectId?: string; subtype?: string } ; exceptionDetails?: { exception?: { description?: string }; text?: string } }>('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(loc.selector)})`, contextId: world, returnByValue: false });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'The selector failed.');
      return r.result.subtype === 'null' ? null : r.result.objectId ?? null;
    }
    if (loc.target) {
      const doc = await this.#send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: 'document', contextId: world, returnByValue: false });
      if (!doc.result.objectId) return null;
      const q = await this.#send<{ nodes: { backendDOMNodeId?: number; ignored?: boolean; role?: { value?: string }; name?: { value?: string } }[] }>('Accessibility.queryAXTree', { objectId: doc.result.objectId, accessibleName: loc.target.name, role: loc.target.role });
      const node = q.nodes.find((n) => !n.ignored && typeof n.backendDOMNodeId === 'number');
      if (!node) return null;
      const o = await this.#send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId, executionContextId: world });
      return o.object.objectId ?? null;
    }
    return null;
  }

  async #callOn<T>(objectId: string, fn: string, args: unknown[] = []): Promise<T> {
    const r = await this.#send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.callFunctionOn', {
      objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'The page threw an error.');
    return r.result.value as T;
  }

  // Whether the element is on the page now.
  async exists(loc: Locator): Promise<boolean> {
    const world = await this.#world();
    return (await this.#resolve(world, loc)) !== null;
  }

  // Runs `fn` (a function's source; `this` is the element) on the element, read-only.
  async inspect<T>(loc: Locator, fn: string, args: unknown[] = []): Promise<T | null> {
    const world = await this.#world();
    const id = await this.#resolve(world, loc);
    return id ? this.#callOn<T>(id, fn, args) : null;
  }

  // Runs `fn` on the element to act on it, never while someone holds the browser: as act(), the
  // hold is checked after the last wait and before the call that acts goes out. `args` reach the
  // function as values, never as source (a sign-in's value goes this way).
  async actOn<T>(loc: Locator, fn: string, args: unknown[] = []): Promise<T | 'missing'> {
    for (;;) {
      await this.gate();
      const world = await this.#world();
      const id = await this.#resolve(world, loc);
      if (this.#mustWait()) continue;
      if (!id) return 'missing';
      return this.#callOn<T>(id, fn, args);
    }
  }

  async navigate(url: string, timeoutMs = 30_000): Promise<void> {
    const r = await this.#send<{ errorText?: string }>('Page.navigate', { url });
    if (r.errorText) throw new Error(r.errorText === 'net::ERR_BLOCKED_BY_CLIENT' ? `${hostOf(url)} is outside the hosts this task may reach.` : `The page didn’t open (${r.errorText}).`);
    await this.settle(timeoutMs);
  }

  // Waits for the page to finish loading after something that may have started a navigation.
  async settle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await new Promise((r) => setTimeout(r, 120));
    while (this.#loading > 0 && Date.now() < deadline && this.mode !== 'closed') {
      await new Promise<void>((r) => {
        const done = () => { clearTimeout(t); this.off('loaded', done); r(); };
        const t = setTimeout(done, 250);
        this.on('loaded', done);
      });
    }
    for (; Date.now() < deadline && this.mode !== 'closed';) {
      const state = await this.evaluate<string>('document.readyState').catch(() => 'loading');
      if (state === 'complete') return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // A click at a point of the page (the vision fallback), never while someone holds the browser.
  async clickAt(x: number, y: number): Promise<void> {
    for (;;) {
      await this.gate();
      if (this.#mustWait()) continue;
      const p = { x: Math.round(x), y: Math.round(y) };
      void this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
      void this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
      await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
      return;
    }
  }

  // Forget a site in this profile (M10b): its cookies (the host name's, and its parent domains'),
  // and every kind of storage for its origins. Returns how many cookies went.
  async clearSite(host: string): Promise<number> {
    const cdp = this.#cdp;
    if (!cdp) throw new Error('The browser isn’t open.');
    const name = host.replace(/:\d{1,5}$/, '');
    const { cookies } = await cdp.send<{ cookies: { name: string; domain: string; path: string }[] }>('Storage.getCookies', {});
    const mine = cookies.filter((c) => { const d = c.domain.replace(/^\./, ''); return d === name || name.endsWith(`.${d}`); });
    for (const c of mine) await this.#send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
    for (const origin of new Set([`http://${host}`, `https://${host}`, `http://${name}`, `https://${name}`])) {
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(() => {});
    }
    return mine.length;
  }

  // Where the page hosts shadow roots of its own, closed ones included (CDP sees through them), in
  // viewport pixels: what they show can't be read from the page, so it is covered in a picture
  // taken after a sign-in (review of PR #238, 4).
  async shadowRects(): Promise<{ x: number; y: number; w: number; h: number }[]> {
    type N = { backendNodeId: number; children?: N[]; shadowRoots?: (N & { shadowRootType?: string })[] };
    const { root } = await this.#send<{ root: N }>('DOM.getDocument', { depth: -1, pierce: true });
    const hosts: number[] = [];
    const walk = (n: N, depth = 0) => {
      if (depth > 200 || hosts.length >= 200) return;
      if ((n.shadowRoots ?? []).some((r) => r.shadowRootType !== 'user-agent')) hosts.push(n.backendNodeId);
      for (const c of n.children ?? []) walk(c, depth + 1);
      for (const r of n.shadowRoots ?? []) if (r.shadowRootType !== 'user-agent') walk(r, depth + 1);
    };
    walk(root);
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (const id of hosts) {
      const m = await this.#send<{ model: { border: number[] } }>('DOM.getBoxModel', { backendNodeId: id }).catch(() => null);
      if (!m) continue;
      const xs = [m.model.border[0]!, m.model.border[2]!, m.model.border[4]!, m.model.border[6]!];
      const ys = [m.model.border[1]!, m.model.border[3]!, m.model.border[5]!, m.model.border[7]!];
      out.push({ x: Math.min(...xs) - 2, y: Math.min(...ys) - 2, w: Math.max(...xs) - Math.min(...xs) + 4, h: Math.max(...ys) - Math.min(...ys) + 4 });
    }
    return out;
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.#send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(r.data, 'base64');
  }

  // The page's text as it is now, read afresh.
  text(): Promise<string> {
    return this.evaluate<string>('document.body ? document.body.innerText : ""');
  }
}

const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
