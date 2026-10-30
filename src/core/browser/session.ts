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
import { launch, type Launched } from './chromium.ts';
import { allowed, hostOf } from './plan.ts';
import type { Cdp } from './cdp.ts';

export type Mode = 'starting' | 'working' | 'needs_person' | 'taken_over' | 'finishing' | 'closed';

// Who holds the browser: `key` is the console or `device:<id>`; `label` is what the person reads.
export interface Holder { key: string; label: string }

// `by`: who asked. A request refused at the proxy can't be told apart: Chromium's own calls home
// end there, and so does a page's WebSocket, so it is put down to the browser.
export interface Blocked { host: string; count: number; first_at: string; by: 'page' | 'person' | 'plan' | 'browser'; via: 'fetch' | 'proxy' | 'plan'; kind: string }

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
}

export class Session extends EventEmitter {
  readonly taskId: string;
  readonly hosts: string[];
  mode: Mode = 'starting';
  url = 'about:blank';
  step: SessionView['step'] = null;
  asked: string | null = null;
  holder: (Holder & { since: number }) | null = null;
  readonly blocked = new Map<string, Blocked>();
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
      blocked: [...this.blocked.values()].map((b) => ({ host: b.host, count: b.count })),
    };
  }

  // ---- starting and stopping ---------------------------------------------------------------

  async open(): Promise<void> {
    this.#refuser = await this.#startRefuser();
    const { port } = this.#refuser.address() as { port: number };
    const width = this.#o.width ?? 1280;
    const height = this.#o.height ?? 800;
    this.#meta = { width, height };
    this.#browser = await launch({ path: this.#o.chromium, bypass: this.hosts, refuser: `http://127.0.0.1:${port}`, sandbox: this.#o.sandbox, width, height });
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
    // A page's alert or confirm would stop it; nobody can answer it from a picture.
    cdp.on('Page.javascriptDialogOpening', (_p: unknown, sid?: string) => { void cdp.send('Page.handleJavaScriptDialog', { accept: false }, sid).catch(() => {}); });
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
  async #paused(p: { requestId: string; request: { url: string }; resourceType?: string }, sid?: string): Promise<void> {
    const cdp = this.#cdp;
    if (!cdp) return;
    const url = p.request.url;
    if (allowed(url, this.hosts) || /^(data|blob|about):/.test(url)) {
      await cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sid).catch(() => {});
      return;
    }
    this.#block(hostOf(url), this.mode === 'taken_over' ? 'person' : 'page', 'fetch', (p.resourceType ?? 'request').toLowerCase());
    await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
  }

  #block(host: string, by: Blocked['by'], via: Blocked['via'], kind: string): void {
    const seen = this.blocked.get(host);
    if (seen) { seen.count++; return; }
    if (this.blocked.size >= MAX_BLOCKED_HOSTS) return;
    const b: Blocked = { host, count: 1, first_at: this.#now().toISOString(), by, via, kind };
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
    while (this.mode === 'taken_over' || this.mode === 'needs_person') {
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

  takeOver(h: Holder): SessionView {
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
    const tree = await this.#send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    const world = await this.#send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'nova' });
    const r = await this.#send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'The page threw an error.');
    return r.result.value as T;
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
