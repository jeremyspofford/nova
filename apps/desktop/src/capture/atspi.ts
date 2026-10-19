// Window text on Linux through AT-SPI over D-Bus (FR-214), driven with the `gdbus` CLI so the shell
// needs no native module. The accessibility bus lists every application; the window in front is
// the frame whose state is ACTIVE. Its text is read from the accessible tree, including text
// scrolled off screen (Text.GetText reads the whole buffer). Password fields are never read.
import { execFile } from 'node:child_process';
import { parseGVariant, type GValue } from './gvariant.ts';

/** Runs `gdbus` with these arguments and returns its stdout. */
export type Gdbus = (args: string[]) => Promise<string>;

const ROOT = '/org/a11y/atspi/accessible/root';
const ACCESSIBLE = 'org.a11y.atspi.Accessible';
const TEXT = 'org.a11y.atspi.Text';
// AtspiRole (at-spi2-core atspi-constants.h).
const ROLE_PASSWORD_TEXT = 40;
// AtspiStateType ACTIVE is bit 1 of the first word.
const STATE_ACTIVE = 1;

export interface AtspiRef {
  bus: string;
  path: string;
}

export interface AtspiWindow {
  /** The accessibility bus address. */
  address: string;
  ref: AtspiRef;
  /** The name the application gives itself (self-reported). */
  app: string;
  title: string;
  /** The application's process, from the bus itself (not self-reported); null when unknown. */
  pid: number | null;
}

export interface WindowText {
  text: string;
  /** False when a limit cut the walk short. */
  complete: boolean;
  passwordFieldsSkipped: number;
}

export interface AtspiOptions {
  /** Most accessible objects read from one window. */
  maxNodes?: number;
  /** Most characters kept. */
  maxChars?: number;
  /** Time budget for one read (ms). */
  budgetMs?: number;
  now?: () => number;
}

/** The real runner: `gdbus` from PATH with a per-call timeout. */
export function gdbusCli(timeoutMs = 3000): Gdbus {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        'gdbus',
        args,
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) =>
          err ? reject(err instanceof Error ? err : new Error('gdbus failed')) : resolve(stdout),
      );
    });
}

function first(v: GValue): GValue {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function refOf(v: GValue): AtspiRef | null {
  if (!Array.isArray(v) || typeof v[0] !== 'string' || typeof v[1] !== 'string') return null;
  return { bus: v[0], path: v[1] };
}

const NULL_PATH = '/org/a11y/atspi/null';

interface CachedNode {
  ref: AtspiRef;
  parent: AtspiRef | null;
  index: number;
  interfaces: string[];
  name: string;
  role: number;
  states: number[];
}

const key = (r: AtspiRef) => `${r.bus}${r.path}`;

/** One item of `org.a11y.atspi.Cache.GetItems`, in the current or the older layout. */
function cacheItem(v: GValue): CachedNode | null {
  if (!Array.isArray(v)) return null;
  const ref = refOf(v[0] ?? null);
  const parent = refOf(v[2] ?? null);
  if (!ref) return null;
  // Current: (ref, app, parent, index, childCount, interfaces, name, role, description, states).
  // Older: (ref, app, parent, children, interfaces, name, role, description, states).
  const older = Array.isArray(v[3]);
  const at = (i: number) => v[older ? i - 1 : i] ?? null;
  const interfaces = at(5);
  const states = at(9);
  return {
    ref,
    parent: parent && parent.path !== NULL_PATH ? parent : null,
    index: older ? 0 : Number(v[3] ?? 0),
    interfaces: Array.isArray(interfaces) ? interfaces.map(String) : [],
    name: typeof at(6) === 'string' ? (at(6) as string) : '',
    role: Number(at(7) ?? 0),
    states: Array.isArray(states) ? states.map(Number) : [],
  };
}

const active = (states: number[]) => (((states[0] ?? 0) >>> STATE_ACTIVE) & 1) === 1;

export class AtspiReader {
  readonly #gdbus: Gdbus;
  readonly #maxNodes: number;
  readonly #maxChars: number;
  readonly #budgetMs: number;
  readonly #now: () => number;

  constructor(gdbus: Gdbus, opts: AtspiOptions = {}) {
    this.#gdbus = gdbus;
    this.#maxNodes = opts.maxNodes ?? 600;
    this.#maxChars = opts.maxChars ?? 200_000;
    this.#budgetMs = opts.budgetMs ?? 6000;
    this.#now = opts.now ?? Date.now;
  }

  async #call(address: string, ref: AtspiRef, method: string, args: string[] = []) {
    const out = await this.#gdbus([
      'call',
      '--address',
      address,
      '--dest',
      ref.bus,
      '--object-path',
      ref.path,
      '--method',
      method,
      ...args,
    ]);
    return parseGVariant(out);
  }

  async #prop(address: string, ref: AtspiRef, iface: string, name: string): Promise<GValue> {
    return first(
      await this.#call(address, ref, 'org.freedesktop.DBus.Properties.Get', [iface, name]),
    );
  }

  /** The accessibility bus address, or null when the desktop runs no AT-SPI bus. */
  async busAddress(): Promise<string | null> {
    try {
      const out = await this.#gdbus([
        'call',
        '--session',
        '--dest',
        'org.a11y.Bus',
        '--object-path',
        '/org/a11y/bus',
        '--method',
        'org.a11y.Bus.GetAddress',
      ]);
      const addr = first(parseGVariant(out));
      return typeof addr === 'string' && addr.length > 0 ? addr : null;
    } catch {
      return null;
    }
  }

  async #children(address: string, ref: AtspiRef): Promise<AtspiRef[]> {
    const v = first(await this.#call(address, ref, `${ACCESSIBLE}.GetChildren`));
    return Array.isArray(v) ? v.map(refOf).filter((r): r is AtspiRef => r !== null) : [];
  }

  async #name(address: string, ref: AtspiRef): Promise<string> {
    const v = await this.#prop(address, ref, ACCESSIBLE, 'Name');
    return typeof v === 'string' ? v : '';
  }

  /** The window in front: the ACTIVE frame, dialog or window of any application. */
  async activeWindow(): Promise<AtspiWindow | null> {
    const address = await this.busAddress();
    if (!address) return null;
    const apps = await this.#children(address, { bus: 'org.a11y.atspi.Registry', path: ROOT });
    for (const app of apps) {
      let frames: AtspiRef[];
      try {
        frames = await this.#children(address, app);
      } catch {
        continue; // an application that went away or does not answer
      }
      for (const frame of frames) {
        try {
          const states = first(await this.#call(address, frame, `${ACCESSIBLE}.GetState`));
          if (!Array.isArray(states) || !active(states.map(Number))) continue;
          const [appName, title, pid] = await Promise.all([
            this.#name(address, app),
            this.#name(address, frame),
            this.#pid(address, frame.bus),
          ]);
          return { address, ref: frame, app: appName, title, pid };
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  /** The process behind a bus name, as the bus daemon knows it (its peer credentials). */
  async #pid(address: string, bus: string): Promise<number | null> {
    // Bus names are `:1.42` or dotted names: nothing a quoted GVariant string cannot hold.
    if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(bus)) return null;
    try {
      const v = first(
        await this.#call(
          address,
          { bus: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus' },
          'org.freedesktop.DBus.GetConnectionUnixProcessID',
          [`'${bus}'`],
        ),
      );
      return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  }

  /** The cached tree of an application, or null when it offers no cache. */
  async #cache(address: string, bus: string): Promise<CachedNode[] | null> {
    try {
      const v = first(
        await this.#call(
          address,
          { bus, path: '/org/a11y/atspi/cache' },
          'org.a11y.atspi.Cache.GetItems',
        ),
      );
      if (!Array.isArray(v)) return null;
      return v.map(cacheItem).filter((n): n is CachedNode => n !== null);
    } catch {
      return null;
    }
  }

  /** The window's text, depth first in reading order, without password fields. */
  async windowText(win: AtspiWindow): Promise<WindowText> {
    const started = this.#now();
    const lines: string[] = [];
    let chars = 0;
    let complete = true;
    let skipped = 0;
    let visited = 0;
    const add = (s: string) => {
      const t = s.trim();
      if (!t || lines.at(-1) === t) return;
      if (chars + t.length > this.#maxChars) {
        complete = false;
        return;
      }
      lines.push(t);
      chars += t.length;
    };
    const textOf = async (ref: AtspiRef, interfaces: string[], name: string) => {
      if (!interfaces.includes(TEXT)) return add(name);
      const count = Number(first(await this.#prop(win.address, ref, TEXT, 'CharacterCount')));
      const n = Math.max(0, Math.min(Number.isFinite(count) ? count : 0, this.#maxChars));
      if (n === 0) return add(name);
      const v = first(await this.#call(win.address, ref, `${TEXT}.GetText`, ['0', String(n)]));
      add(typeof v === 'string' ? v : name);
    };
    const overBudget = () => {
      if (visited >= this.#maxNodes || this.#now() - started > this.#budgetMs) {
        complete = false;
        return true;
      }
      return false;
    };

    const cache = await this.#cache(win.address, win.ref.bus);
    if (cache && cache.some((n) => key(n.ref) === key(win.ref))) {
      const kids = new Map<string, CachedNode[]>();
      for (const n of cache) {
        if (!n.parent) continue;
        const list = kids.get(key(n.parent)) ?? [];
        list.push(n);
        kids.set(key(n.parent), list);
      }
      for (const list of kids.values()) list.sort((a, b) => a.index - b.index);
      const stack = [...(kids.get(key(win.ref)) ?? [])].reverse();
      while (stack.length > 0) {
        if (overBudget()) break;
        const n = stack.pop();
        if (!n) break;
        visited++;
        if (n.role === ROLE_PASSWORD_TEXT) {
          skipped++;
          continue;
        }
        try {
          await textOf(n.ref, n.interfaces, n.name);
        } catch {
          add(n.name);
        }
        stack.push(...[...(kids.get(key(n.ref)) ?? [])].reverse());
      }
      return { text: lines.join('\n'), complete, passwordFieldsSkipped: skipped };
    }

    // No cache: walk the tree object by object.
    const stack: AtspiRef[] = [...(await this.#children(win.address, win.ref))].reverse();
    while (stack.length > 0) {
      if (overBudget()) break;
      const ref = stack.pop();
      if (!ref) break;
      visited++;
      try {
        const role = Number(first(await this.#call(win.address, ref, `${ACCESSIBLE}.GetRole`)));
        if (role === ROLE_PASSWORD_TEXT) {
          skipped++;
          continue;
        }
        const ifaces = first(await this.#call(win.address, ref, `${ACCESSIBLE}.GetInterfaces`));
        const interfaces = Array.isArray(ifaces) ? ifaces.map(String) : [];
        const name = interfaces.includes(TEXT) ? '' : await this.#name(win.address, ref);
        await textOf(ref, interfaces, name);
        stack.push(...[...(await this.#children(win.address, ref))].reverse());
      } catch {
        // an object that went away while we read: skip it
      }
    }
    return { text: lines.join('\n'), complete, passwordFieldsSkipped: skipped };
  }
}
