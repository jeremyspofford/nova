// Terminal sessions (FR-006): a shell the Hub runs inside its sandbox, reached over a WebSocket at
// /api/v1/terminals/:id/ws. Client frames are {type:'input',data} and {type:'resize',cols,rows};
// the Hub sends {type:'output',data} and {type:'exit',code}. The screen is xterm.js with its fit
// addon, loaded only when a terminal opens. A session owns its screen's element, so the bottom
// panel and a terminal pane can each show it without restarting the shell; the view that showed
// it last owns it. Terminal output is untrusted data (FR-189): it is only ever drawn as text.
import type { TerminalView } from '@nova/shared';
import { ApiError, errorMessage, type Api } from '../api.ts';

/** The subset of an xterm.js terminal that sessions use, so tests can draw into a fake. */
export interface TerminalScreen {
  readonly cols: number;
  readonly rows: number;
  open(parent: HTMLElement): void;
  write(data: string): void;
  onData(fn: (data: string) => void): void;
  /** Resize to the parent element. */
  fit(): void;
  focus(): void;
  clear(): void;
  /** `fn` returns false for keys the app handles instead of the shell. */
  setKeyFilter(fn: (e: KeyboardEvent) => boolean): void;
  dispose(): void;
}

export type TerminalScreenFactory = () => Promise<TerminalScreen>;

/** The subset of WebSocket that sessions use. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Opens a socket for an API path such as /api/v1/terminals/<id>/ws. */
export type WebSocketFactory = (path: string) => SocketLike;

export function socketUrl(path: string, loc: Pick<Location, 'protocol' | 'host'>): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${path}`;
}

/** The browser's WebSocket; the session cookie goes with the same-origin handshake. */
export const browserWebSocket: WebSocketFactory = (path) =>
  new WebSocket(socketUrl(path, window.location));

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** xterm.js with the fit addon, colored from the theme tokens. Loaded on first use. */
export const xtermScreen: TerminalScreenFactory = async () => {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  const term = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: token('--u-font-code', 'monospace'),
    fontSize: 13,
    scrollback: 5000,
    screenReaderMode: false,
    theme: {
      background: token('--u-surface', 'black'),
      foreground: token('--u-text', 'white'),
      cursor: token('--u-accent', 'white'),
      selectionBackground: token('--u-surface-2', 'gray'),
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    open: (el) => term.open(el),
    write: (data) => term.write(data),
    onData: (fn) => {
      term.onData(fn);
    },
    fit: () => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet (hidden); the next fit catches up.
      }
    },
    focus: () => term.focus(),
    clear: () => term.clear(),
    setKeyFilter: (fn) => term.attachCustomKeyEventHandler(fn),
    dispose: () => term.dispose(),
  };
};

export type SessionState = 'starting' | 'connecting' | 'open' | 'disconnected' | 'exited';

export interface SessionSnapshot {
  state: SessionState;
  exitCode: number | null;
  owner: string | null;
  error: string | null;
}

export interface SessionDeps {
  socket: WebSocketFactory;
  screen: TerminalScreenFactory;
  /** Returns false for keys that go to the app (e.g. the bottom panel toggle). */
  keyFilter: (e: KeyboardEvent) => boolean;
  onExit: (code: number | null) => void;
  onChange: () => void;
}

const OPEN = 1;

export class TerminalSession {
  readonly id: string;
  readonly url: string;
  /** The element the screen draws into; moved between views. */
  readonly host: HTMLDivElement;
  #deps: SessionDeps;
  #screen: TerminalScreen | null = null;
  #socket: SocketLike | null = null;
  #snap: SessionSnapshot = { state: 'starting', exitCode: null, owner: null, error: null };
  #size = { cols: 0, rows: 0 };
  #disposed = false;
  /** Focus was asked for before the screen existed. */
  #focusOnStart = false;

  constructor(id: string, url: string, deps: SessionDeps) {
    this.id = id;
    this.url = url;
    this.#deps = deps;
    this.host = document.createElement('div');
    this.host.className = 'terminal-host';
  }

  snapshot(): SessionSnapshot {
    return this.#snap;
  }

  #set(patch: Partial<SessionSnapshot>) {
    this.#snap = { ...this.#snap, ...patch };
    this.#deps.onChange();
  }

  async start(): Promise<void> {
    try {
      const screen = await this.#deps.screen();
      if (this.#disposed) {
        screen.dispose();
        return;
      }
      this.#screen = screen;
      screen.open(this.host);
      screen.setKeyFilter(this.#deps.keyFilter);
      screen.onData((data) => this.#send({ type: 'input', data }));
      this.fit();
      if (this.#focusOnStart) screen.focus();
      this.connect();
    } catch (err) {
      this.#set({
        state: 'disconnected',
        error: errorMessage(err, 'The terminal could not start.'),
      });
    }
  }

  connect(): void {
    if (this.#disposed || this.#snap.state === 'exited' || !this.#screen) return;
    this.#socket?.close();
    const socket = this.#deps.socket(this.url);
    this.#socket = socket;
    this.#set({ state: 'connecting', error: null });
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#set({ state: 'open' });
      this.#size = { cols: 0, rows: 0 };
      this.fit();
    };
    socket.onmessage = (ev) => {
      if (this.#socket !== socket) return;
      this.#receive(ev.data);
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (this.#snap.state !== 'exited' && !this.#disposed) this.#set({ state: 'disconnected' });
    };
    socket.onerror = () => undefined; // a close event follows
  }

  #receive(data: unknown) {
    if (typeof data !== 'string') return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return; // a malformed frame is dropped, never fatal
    }
    if (typeof frame !== 'object' || frame === null) return;
    const f = frame as { type?: unknown; data?: unknown; code?: unknown };
    if (f.type === 'output' && typeof f.data === 'string') this.#screen?.write(f.data);
    else if (f.type === 'exit') {
      const code = typeof f.code === 'number' ? f.code : null;
      this.#screen?.write(`\r\n[Process exited${code === null ? '' : ` with code ${code}`}]\r\n`);
      this.#set({ state: 'exited', exitCode: code });
      this.#deps.onExit(code);
      this.#socket?.close();
      this.#socket = null;
    }
  }

  #send(frame: { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }) {
    const s = this.#socket;
    if (s && s.readyState === OPEN && this.#snap.state === 'open') s.send(JSON.stringify(frame));
  }

  /** Show the screen in `container`; the previous view loses it. */
  attach(container: HTMLElement, owner: string): void {
    if (this.host.parentElement !== container) container.appendChild(this.host);
    if (this.#snap.owner !== owner) this.#set({ owner });
    this.fit();
  }

  release(owner: string): void {
    if (this.#snap.owner === owner) this.#set({ owner: null });
  }

  fit(): void {
    const screen = this.#screen;
    if (!screen) return;
    screen.fit();
    const { cols, rows } = screen;
    if (cols === this.#size.cols && rows === this.#size.rows) return;
    this.#size = { cols, rows };
    this.#send({ type: 'resize', cols, rows });
  }

  focus(): void {
    if (this.#screen) this.#screen.focus();
    else this.#focusOnStart = true;
  }

  clear(): void {
    this.#screen?.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#socket?.close();
    this.#socket = null;
    this.#screen?.dispose();
    this.#screen = null;
    this.host.remove();
  }
}

export interface TerminalsSnapshot {
  items: TerminalView[];
  loaded: boolean;
  /** Terminals being started. */
  creating: number;
  /** Set when the Hub has no sandbox (409 sandbox_unavailable). */
  unavailable: string | null;
  error: string | null;
  sessions: Record<string, SessionSnapshot>;
}

export interface TerminalHubDeps {
  socket: WebSocketFactory;
  screen: TerminalScreenFactory;
  keyFilter: (e: KeyboardEvent) => boolean;
}

export const SANDBOX_UNAVAILABLE =
  'Terminals run inside the Hub’s sandbox, and this Hub has none. Set up a sandbox on the Hub to use the terminal.';

/** Every terminal the UI knows about, with their sessions. One per signed-in workspace. */
export class TerminalHub {
  #api: Api;
  #deps: TerminalHubDeps;
  #sessions = new Map<string, TerminalSession>();
  #listeners = new Set<() => void>();
  #exits = new Set<(terminal: TerminalView) => void>();
  #snap: TerminalsSnapshot = {
    items: [],
    loaded: false,
    creating: 0,
    unavailable: null,
    error: null,
    sessions: {},
  };
  #loading = false;

  constructor(api: Api, deps: TerminalHubDeps) {
    this.#api = api;
    this.#deps = deps;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  snapshot = (): TerminalsSnapshot => this.#snap;

  /** Called when a shell exits; returns a function that stops listening. */
  onExit(fn: (terminal: TerminalView) => void): () => void {
    this.#exits.add(fn);
    return () => this.#exits.delete(fn);
  }

  #set(patch: Partial<TerminalsSnapshot>) {
    this.#snap = { ...this.#snap, ...patch };
    for (const fn of [...this.#listeners]) fn();
  }

  #syncSessions() {
    const sessions: Record<string, SessionSnapshot> = {};
    for (const [id, s] of this.#sessions) sessions[id] = s.snapshot();
    this.#set({ sessions });
  }

  /** Lists the Hub's terminals once, so a reload can show the ones still running. */
  load(): void {
    if (this.#snap.loaded || this.#loading) return;
    this.#loading = true;
    this.#api.listTerminals().then(
      ({ items }) => {
        const known = new Set(this.#snap.items.map((t) => t.id));
        this.#set({
          items: [...items.filter((t) => !known.has(t.id)), ...this.#snap.items],
          loaded: true,
        });
      },
      (err: unknown) => this.#set({ loaded: true, error: errorMessage(err) }),
    );
  }

  /** Starts a shell; null when the Hub has no sandbox. Other failures throw. */
  async create(opts: { threadId?: string | null; root?: string } = {}): Promise<string | null> {
    this.#set({ creating: this.#snap.creating + 1 });
    try {
      const view = await this.#api.createTerminal({
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
        ...(opts.root ? { root: opts.root } : {}),
        cols: 100,
        rows: 30,
      });
      this.#set({ items: [...this.#snap.items, view], unavailable: null, error: null });
      return view.id;
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'sandbox_unavailable') {
        this.#set({ unavailable: SANDBOX_UNAVAILABLE });
        return null;
      }
      throw err;
    } finally {
      this.#set({ creating: this.#snap.creating - 1 });
    }
  }

  async close(id: string): Promise<void> {
    try {
      await this.#api.closeTerminal(id);
    } catch (err) {
      // Already gone on the Hub is the result we wanted.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    this.#sessions.get(id)?.dispose();
    this.#sessions.delete(id);
    const sessions = { ...this.#snap.sessions };
    delete sessions[id];
    this.#set({ items: this.#snap.items.filter((t) => t.id !== id), sessions });
  }

  /** The session for a terminal, started on first use. */
  session(id: string): TerminalSession {
    let s = this.#sessions.get(id);
    if (s) return s;
    s = new TerminalSession(id, this.#api.terminalSocketUrl(id), {
      socket: this.#deps.socket,
      screen: this.#deps.screen,
      keyFilter: this.#deps.keyFilter,
      onChange: () => this.#syncSessions(),
      onExit: (code) => {
        const items = this.#snap.items.map((t) =>
          t.id === id ? { ...t, status: 'exited' as const, exitCode: code } : t,
        );
        this.#set({ items });
        const view = items.find((t) => t.id === id);
        if (view) for (const fn of [...this.#exits]) fn(view);
      },
    });
    this.#sessions.set(id, s);
    this.#syncSessions();
    void s.start();
    return s;
  }

  dispose(): void {
    for (const s of this.#sessions.values()) s.dispose();
    this.#sessions.clear();
    this.#listeners.clear();
    this.#exits.clear();
  }
}
