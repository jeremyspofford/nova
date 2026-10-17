// The mock desktop (FR-093, FR-207; docs/18 J8 step 6): an in-process simulated desktop behind
// the `ScreenController` seam, so computer use, takeover and appshots run offline and
// deterministically. Windows belong to app classes (a browser, a terminal, an editor, a form
// app), each with a small accessibility tree and a rendered PNG frame; clicks raise windows and
// focus or press widgets, typing fills the focused field, keys submit, tab and delete. It is the
// `screen()` of the mock cloud computer: the computers area binds `MockDesktops.screen(id)`.
//
// The desktop does not enforce control tiers: for a cloud desktop the Hub's ScreenService is the
// enforcement point (novad enforces again on a real device). A controller handle latches after
// `kill()`: nothing it holds or receives later is delivered, and the Hub asks the computer for a
// new handle once the user resumes control.
import type {
  ScreenAction,
  ScreenController,
  ScreenObservation,
  ScreenWindow,
} from '../computers/types.ts';
import { Raster, type ScreenRect } from './png.ts';
import type { ControlTier } from './tiers.ts';

export type MockAppClass = 'browser' | 'terminal' | 'editor' | 'app' | 'sensitive';
export type MockWidgetRole = 'button' | 'textbox' | 'password' | 'link' | 'checkbox' | 'label';

export interface MockWidgetSpec {
  id: string;
  role: MockWidgetRole;
  name: string;
  /** Relative to the window's content area (below the title bar). */
  x: number;
  y: number;
  width: number;
  height: number;
  value?: string;
  checked?: boolean;
}

export interface MockWindowSpec {
  id: string;
  app: string;
  appClass: MockAppClass;
  title: string;
  bounds: ScreenRect;
  widgets: MockWidgetSpec[];
}

export interface MockWidget {
  readonly id: string;
  readonly role: MockWidgetRole;
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly presses: number;
}

export interface MockWindow {
  readonly id: string;
  readonly app: string;
  readonly appClass: MockAppClass;
  readonly title: string;
  readonly bounds: ScreenRect;
  readonly focused: boolean;
  readonly scrollY: number;
  readonly widgets: readonly MockWidget[];
}

/** One input event the desktop received (tests check that none arrive after the kill key). */
export interface MockInputEvent {
  seq: number;
  handle: number;
  action: ScreenAction;
  windowId: string | null;
  widgetId: string | null;
}

export interface MockDesktopOptions {
  width?: number;
  height?: number;
  windows?: MockWindowSpec[];
  /** Awaited before every input event is delivered; tests use it to hold an event in flight. */
  beforeInput?: (action: ScreenAction) => Promise<void>;
  now?: () => Date;
}

/** A window with its geometry: the extra field the mock (and novad) report on `ScreenWindow`. */
export type ScreenWindowWithBounds = ScreenWindow & { bounds: ScreenRect };

export const MOCK_TITLE_BAR = 22;
const MAX_VALUE = 10_000;
const CHAR_W = 6;

const CLASS_TIER: Record<MockAppClass, ControlTier> = {
  browser: 'view',
  terminal: 'click',
  editor: 'click',
  app: 'full',
  sensitive: 'none',
};

type RGB = [number, number, number];
const BODY: Record<MockAppClass, RGB> = {
  browser: [225, 232, 245],
  terminal: [20, 20, 24],
  editor: [245, 245, 240],
  app: [250, 250, 252],
  sensitive: [250, 235, 235],
};
const INK: Record<MockAppClass, RGB> = {
  browser: [50, 50, 60],
  terminal: [190, 225, 190],
  editor: [40, 40, 40],
  app: [50, 50, 60],
  sensitive: [90, 40, 40],
};

/** The default desktop: a browser, a terminal, a code editor and a form app (front last). */
export function defaultMockWindows(): MockWindowSpec[] {
  return [
    {
      id: 'w-browser',
      app: 'Web Browser',
      appClass: 'browser',
      title: 'Example page - Web Browser',
      bounds: { x: 20, y: 20, width: 520, height: 340 },
      widgets: [
        {
          id: 'address',
          role: 'textbox',
          name: 'Address',
          x: 10,
          y: 10,
          width: 500,
          height: 24,
          value: 'https://example.test/',
        },
        {
          id: 'more',
          role: 'link',
          name: 'More information',
          x: 10,
          y: 50,
          width: 160,
          height: 20,
        },
        {
          id: 'page',
          role: 'label',
          name: 'Page',
          x: 10,
          y: 80,
          width: 500,
          height: 200,
          value: 'Example page. This domain is for use in examples.',
        },
      ],
    },
    {
      id: 'w-terminal',
      app: 'Terminal',
      appClass: 'terminal',
      title: 'Terminal - bash',
      bounds: { x: 40, y: 300, width: 440, height: 260 },
      widgets: [
        { id: 'new-tab', role: 'button', name: 'New tab', x: 10, y: 8, width: 80, height: 22 },
        {
          id: 'output',
          role: 'label',
          name: 'Output',
          x: 10,
          y: 40,
          width: 420,
          height: 190,
          value: '$ ',
        },
      ],
    },
    {
      id: 'w-editor',
      app: 'Code Editor',
      appClass: 'editor',
      title: 'notes.md - Code Editor',
      bounds: { x: 500, y: 330, width: 440, height: 250 },
      widgets: [
        { id: 'save', role: 'button', name: 'Save', x: 10, y: 8, width: 60, height: 22 },
        { id: 'run', role: 'button', name: 'Run', x: 80, y: 8, width: 60, height: 22 },
        {
          id: 'buffer',
          role: 'textbox',
          name: 'Buffer',
          x: 10,
          y: 40,
          width: 420,
          height: 180,
          value: '# Notes',
        },
      ],
    },
    {
      id: 'w-form',
      app: 'Expense Form',
      appClass: 'app',
      title: 'New expense - Expense Form',
      bounds: { x: 560, y: 20, width: 380, height: 290 },
      widgets: [
        { id: 'name', role: 'textbox', name: 'Name', x: 20, y: 20, width: 220, height: 24 },
        { id: 'amount', role: 'textbox', name: 'Amount', x: 20, y: 60, width: 120, height: 24 },
        {
          id: 'reimbursable',
          role: 'checkbox',
          name: 'Reimbursable',
          x: 20,
          y: 100,
          width: 20,
          height: 20,
        },
        { id: 'submit', role: 'button', name: 'Submit', x: 20, y: 140, width: 100, height: 28 },
        { id: 'status', role: 'label', name: 'Status', x: 20, y: 190, width: 340, height: 24 },
      ],
    },
  ];
}

interface WidgetState {
  id: string;
  role: MockWidgetRole;
  name: string;
  rect: ScreenRect;
  value: string;
  checked: boolean;
  presses: number;
}

interface WindowState {
  id: string;
  app: string;
  appClass: MockAppClass;
  title: string;
  bounds: ScreenRect;
  widgets: WidgetState[];
  focusedWidget: string | null;
  scrollY: number;
}

const inside = (r: ScreenRect, x: number, y: number) =>
  x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;

const intersect = (a: ScreenRect, b: ScreenRect): ScreenRect => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
};

export class MockDesktop {
  readonly width: number;
  readonly height: number;
  /** Every input event delivered, oldest first. */
  readonly delivered: MockInputEvent[] = [];
  readonly #beforeInput: MockDesktopOptions['beforeInput'];
  readonly #now: () => Date;
  /** Back to front: the last window is the focused one. */
  #windows: WindowState[];
  #version = 0;
  #frame: { version: number; png: Uint8Array } | null = null;
  #handles = 0;

  constructor(opts: MockDesktopOptions = {}) {
    this.width = opts.width ?? 960;
    this.height = opts.height ?? 600;
    this.#beforeInput = opts.beforeInput;
    this.#now = opts.now ?? (() => new Date());
    this.#windows = (opts.windows ?? defaultMockWindows()).map((w) => ({
      id: w.id,
      app: w.app,
      appClass: w.appClass,
      title: w.title,
      bounds: { ...w.bounds },
      scrollY: 0,
      focusedWidget: null,
      widgets: w.widgets.map((s) => ({
        id: s.id,
        role: s.role,
        name: s.name,
        rect: { x: s.x, y: s.y, width: s.width, height: s.height },
        value: s.value ?? '',
        checked: s.checked ?? false,
        presses: 0,
      })),
    }));
  }

  /** A new controller handle over this desktop (each `Computer.screen()` call gets one). */
  controller(): ScreenController {
    return new MockScreenHandle(this, ++this.#handles);
  }

  /** The windows, front first (tests and the tree). */
  windows(): MockWindow[] {
    const front = this.#windows.at(-1)?.id;
    return [...this.#windows].reverse().map((w) => ({
      id: w.id,
      app: w.app,
      appClass: w.appClass,
      title: w.title,
      bounds: { ...w.bounds },
      focused: w.id === front,
      scrollY: w.scrollY,
      widgets: w.widgets.map((d) => ({
        id: d.id,
        role: d.role,
        name: d.name,
        value: d.value,
        checked: d.checked,
        presses: d.presses,
      })),
    }));
  }

  /** A widget by window id and widget name (tests). */
  widget(windowId: string, name: string): MockWidget | undefined {
    return this.windows()
      .find((w) => w.id === windowId)
      ?.widgets.find((d) => d.name === name);
  }

  /** The class tier of a window's app, as novad would classify it. */
  tierOf(windowId: string): ControlTier | null {
    const w = this.#windows.find((x) => x.id === windowId);
    return w ? CLASS_TIER[w.appClass] : null;
  }

  observe(): ScreenObservation {
    if (this.#frame?.version !== this.#version)
      this.#frame = { version: this.#version, png: this.#render() };
    const front = this.#windows.at(-1)?.id;
    const windows: ScreenWindowWithBounds[] = [...this.#windows].reverse().map((w) => {
      const tier = CLASS_TIER[w.appClass];
      return {
        id: w.id,
        app: w.app,
        // The seam has no `none` tier: a sensitive app reports `view` and the Hub's name check
        // lowers it to none.
        tier: tier === 'none' ? 'view' : tier,
        title: w.title,
        focused: w.id === front,
        bounds: { ...w.bounds },
      };
    });
    return {
      image: this.#frame.png,
      windows,
      tree: this.#tree(),
      takenAt: this.#now().toISOString(),
    };
  }

  /** Wait for the test hook (or the abort) before an event is delivered. */
  async waitBeforeInput(action: ScreenAction, signal: AbortSignal): Promise<void> {
    if (!this.#beforeInput) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      this.#beforeInput!(action).then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** Deliver one input event to the desktop. */
  deliver(handle: number, action: ScreenAction): { ok: boolean; error?: string } {
    const event: MockInputEvent = {
      seq: this.delivered.length + 1,
      handle,
      action: structuredClone(action),
      windowId: null,
      widgetId: null,
    };
    this.delivered.push(event);
    this.#version++;
    switch (action.kind) {
      case 'click': {
        const w = this.#windowAt(action.x, action.y);
        if (!w) return { ok: true };
        this.#raise(w);
        event.windowId = w.id;
        const d = this.#widgetAt(w, action.x, action.y);
        if (!d) return { ok: true };
        event.widgetId = d.id;
        if ((action.button ?? 'left') === 'left') this.#press(w, d);
        return { ok: true };
      }
      case 'scroll': {
        const w = this.#windowAt(action.x, action.y);
        if (w) {
          event.windowId = w.id;
          w.scrollY = Math.min(2_000, Math.max(0, w.scrollY + action.dy));
        }
        return { ok: true };
      }
      case 'type': {
        const w = this.#windows.at(-1);
        if (!w) return { ok: true };
        event.windowId = w.id;
        const d = w.widgets.find((x) => x.id === w.focusedWidget);
        if (d && (d.role === 'textbox' || d.role === 'password')) {
          event.widgetId = d.id;
          d.value = (d.value + action.text).slice(0, MAX_VALUE);
        } else if (w.appClass === 'terminal') {
          const out = w.widgets.find((x) => x.name === 'Output');
          if (out) out.value = (out.value + action.text).slice(-MAX_VALUE);
        }
        return { ok: true };
      }
      case 'key': {
        const w = this.#windows.at(-1);
        if (w) {
          event.windowId = w.id;
          this.#key(w, action.keys.trim().toLowerCase());
        }
        return { ok: true };
      }
      case 'drag': {
        const [fx, fy] = action.from;
        const [tx, ty] = action.to;
        const w = this.#windowAt(fx, fy);
        if (!w) return { ok: true };
        event.windowId = w.id;
        this.#raise(w);
        const bar: ScreenRect = { ...w.bounds, height: MOCK_TITLE_BAR };
        if (inside(bar, fx, fy)) {
          w.bounds = {
            ...w.bounds,
            x: Math.min(this.width - 40, Math.max(-w.bounds.width + 40, w.bounds.x + tx - fx)),
            y: Math.min(this.height - MOCK_TITLE_BAR, Math.max(0, w.bounds.y + ty - fy)),
          };
        }
        return { ok: true };
      }
    }
  }

  #windowAt(x: number, y: number): WindowState | null {
    for (let i = this.#windows.length - 1; i >= 0; i--) {
      const w = this.#windows[i]!;
      if (inside(w.bounds, x, y)) return w;
    }
    return null;
  }

  #abs(w: WindowState, d: WidgetState): ScreenRect {
    return {
      x: w.bounds.x + d.rect.x,
      y: w.bounds.y + MOCK_TITLE_BAR + d.rect.y,
      width: d.rect.width,
      height: d.rect.height,
    };
  }

  #widgetAt(w: WindowState, x: number, y: number): WidgetState | null {
    return w.widgets.find((d) => inside(this.#abs(w, d), x, y)) ?? null;
  }

  #raise(w: WindowState): void {
    this.#windows = [...this.#windows.filter((x) => x !== w), w];
  }

  #press(w: WindowState, d: WidgetState): void {
    switch (d.role) {
      case 'textbox':
      case 'password':
        w.focusedWidget = d.id;
        return;
      case 'checkbox':
        d.checked = !d.checked;
        w.focusedWidget = d.id;
        return;
      case 'button':
        d.presses++;
        this.#activate(w, d);
        return;
      case 'link':
        d.presses++;
        if (w.appClass === 'browser') {
          const addr = w.widgets.find((x) => x.name === 'Address');
          const page = w.widgets.find((x) => x.name === 'Page');
          if (addr) addr.value = 'https://example.test/more';
          if (page) page.value = 'More information about the example domain.';
          w.title = 'More information - Web Browser';
        }
        return;
      case 'label':
        return;
    }
  }

  #activate(w: WindowState, d: WidgetState): void {
    const field = (name: string) => w.widgets.find((x) => x.name === name);
    if (d.name === 'Submit') {
      const status = field('Status');
      if (status) {
        const parts = [field('Name')?.value ?? '', field('Amount')?.value ?? ''].filter(Boolean);
        const flag = field('Reimbursable')?.checked ? ' (reimbursable)' : '';
        status.value = `Submitted: ${parts.join(', ') || '(empty)'}${flag}`;
      }
    } else if (d.name === 'Save' && w.appClass === 'editor') {
      w.title = w.title.replace(/^([^ ]+?)( \(saved\))? - /, '$1 (saved) - ');
    }
  }

  #key(w: WindowState, keys: string): void {
    const d = w.widgets.find((x) => x.id === w.focusedWidget);
    switch (keys) {
      case 'enter':
      case 'return': {
        if (w.appClass === 'terminal') {
          const out = w.widgets.find((x) => x.name === 'Output');
          if (out) out.value = `${out.value}\n$ `.slice(-MAX_VALUE);
          return;
        }
        if (d?.role === 'textbox' && d.rect.height > 40) {
          d.value = `${d.value}\n`.slice(0, MAX_VALUE);
          return;
        }
        const submit = w.widgets.find((x) => x.role === 'button' && x.name === 'Submit');
        if (submit) {
          submit.presses++;
          this.#activate(w, submit);
        }
        return;
      }
      case 'tab': {
        const fields = w.widgets.filter(
          (x) => x.role === 'textbox' || x.role === 'password' || x.role === 'checkbox',
        );
        if (!fields.length) return;
        const at = fields.findIndex((x) => x.id === w.focusedWidget);
        w.focusedWidget = fields[(at + 1) % fields.length]!.id;
        return;
      }
      case 'backspace':
        if (d && (d.role === 'textbox' || d.role === 'password')) d.value = d.value.slice(0, -1);
        return;
      default:
        return;
    }
  }

  #tree(): string {
    const front = this.#windows.at(-1)?.id;
    const lines = [`screen ${this.width}x${this.height}`];
    for (const w of [...this.#windows].reverse()) {
      const b = w.bounds;
      const tier = CLASS_TIER[w.appClass];
      lines.push(
        `window ${JSON.stringify(w.app)} id=${w.id} title=${JSON.stringify(w.title)} tier=${
          tier === 'none' ? 'view' : tier
        }${w.id === front ? ' focused' : ''} bounds=${b.x},${b.y},${b.width},${b.height}`,
      );
      for (const d of w.widgets) {
        const r = this.#abs(w, d);
        // Password fields are masked before anything leaves the desktop (docs/11 §5.2).
        const value =
          d.role === 'password'
            ? ' value=(masked)'
            : d.role === 'checkbox'
              ? ` checked=${d.checked}`
              : d.value
                ? ` value=${JSON.stringify(d.value.slice(0, 500))}`
                : '';
        lines.push(
          `  ${d.role} ${JSON.stringify(d.name)}${value} bounds=${r.x},${r.y},${r.width},${r.height}${
            d.id === w.focusedWidget ? ' focused' : ''
          }`,
        );
      }
    }
    return lines.join('\n');
  }

  #render(): Uint8Array {
    const img = new Raster(this.width, this.height, [40, 60, 90]);
    const front = this.#windows.at(-1)?.id;
    for (const w of this.#windows) {
      const b = w.bounds;
      img.fillRect(b, BODY[w.appClass]);
      img.fillRect(
        { ...b, height: MOCK_TITLE_BAR },
        w.id === front ? [70, 110, 200] : [140, 150, 165],
      );
      // The title's length as a light bar, so title changes show in the frame.
      img.fillRect(
        { x: b.x + 8, y: b.y + 8, width: Math.min(b.width - 16, w.title.length * 4), height: 6 },
        [235, 240, 250],
      );
      img.strokeRect(b, [25, 25, 30]);
      for (const d of w.widgets) this.#renderWidget(img, w, d);
    }
    return img.toPng();
  }

  #renderWidget(img: Raster, w: WindowState, d: WidgetState): void {
    const r = intersect(this.#abs(w, d), {
      ...w.bounds,
      y: w.bounds.y + MOCK_TITLE_BAR,
      height: w.bounds.height - MOCK_TITLE_BAR,
    });
    if (!r.width || !r.height) return;
    const ink = INK[w.appClass];
    const bars = (text: string, color: RGB) => {
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        const y = r.y + 4 + i * 12 - w.scrollY;
        const bar = intersect(
          { x: r.x + 4, y, width: Math.min(r.width - 8, line.length * CHAR_W), height: 7 },
          r,
        );
        if (bar.width && bar.height) img.fillRect(bar, color);
      });
    };
    switch (d.role) {
      case 'textbox':
        img.fillRect(r, w.appClass === 'terminal' ? [35, 35, 40] : [255, 255, 255]);
        img.strokeRect(r, [130, 130, 140]);
        bars(d.value, ink);
        break;
      case 'password': {
        img.fillRect(r, [255, 255, 255]);
        img.strokeRect(r, [130, 130, 140]);
        // Masked: one dot per character, never the characters themselves.
        for (let i = 0; i < Math.min(d.value.length, Math.floor((r.width - 8) / 8)); i++)
          img.fillRect(
            { x: r.x + 4 + i * 8, y: r.y + r.height / 2 - 2, width: 5, height: 5 },
            [20, 20, 20],
          );
        break;
      }
      case 'button':
        img.fillRect(r, d.presses % 2 ? [175, 190, 215] : [200, 205, 215]);
        img.strokeRect(r, [110, 115, 130]);
        bars(d.name, [40, 40, 50]);
        break;
      case 'link':
        bars(d.name, [40, 90, 200]);
        img.fillRect(
          { x: r.x + 4, y: r.y + r.height - 3, width: d.name.length * CHAR_W, height: 1 },
          [40, 90, 200],
        );
        break;
      case 'checkbox':
        img.fillRect(r, [255, 255, 255]);
        img.strokeRect(r, [90, 90, 100]);
        if (d.checked)
          img.fillRect(
            { x: r.x + 4, y: r.y + 4, width: r.width - 8, height: r.height - 8 },
            [40, 120, 60],
          );
        break;
      case 'label':
        bars(d.value, ink);
        break;
    }
    if (w.focusedWidget === d.id) img.strokeRect(r, [250, 170, 30]);
  }
}

class MockScreenHandle implements ScreenController {
  readonly #desktop: MockDesktop;
  readonly #id: number;
  #killed = false;

  constructor(desktop: MockDesktop, id: number) {
    this.#desktop = desktop;
    this.#id = id;
  }

  observe(): Promise<ScreenObservation> {
    return Promise.resolve(this.#desktop.observe());
  }

  async act(action: ScreenAction, signal: AbortSignal): Promise<{ ok: boolean; error?: string }> {
    if (this.#killed) return { ok: false, error: 'control was stopped with the kill key' };
    if (signal.aborted) return { ok: false, error: 'cancelled' };
    try {
      await this.#desktop.waitBeforeInput(action, signal);
    } catch {
      return { ok: false, error: 'cancelled' };
    }
    // Queued input is dropped when the kill key lands while it waits (docs/11 §5.2).
    if (this.#killed) return { ok: false, error: 'control was stopped with the kill key' };
    if (signal.aborted) return { ok: false, error: 'cancelled' };
    return this.#desktop.deliver(this.#id, action);
  }

  kill(): Promise<void> {
    this.#killed = true;
    return Promise.resolve();
  }
}

/**
 * One mock desktop per computer id. The computers area binds it as the mock cloud computer's
 * `screen()`: `screen: () => Promise.resolve(desktops.screen(computerId))`.
 */
export class MockDesktops {
  readonly #desktops = new Map<string, MockDesktop>();
  readonly #options: (computerId: string) => MockDesktopOptions;

  constructor(options: MockDesktopOptions | ((computerId: string) => MockDesktopOptions) = {}) {
    this.#options = typeof options === 'function' ? options : () => options;
  }

  desktop(computerId: string): MockDesktop {
    let d = this.#desktops.get(computerId);
    if (!d) {
      d = new MockDesktop(this.#options(computerId));
      this.#desktops.set(computerId, d);
    }
    return d;
  }

  /** A fresh controller handle over the computer's desktop. */
  screen(computerId: string): ScreenController {
    return this.desktop(computerId).controller();
  }

  delete(computerId: string): void {
    this.#desktops.delete(computerId);
  }
}
