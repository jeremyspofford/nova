// The mock desktop and its PNG frames (FR-093, docs/18 J8 step 6): deterministic input handling
// (clicks raise windows and focus or press widgets, typing fills fields, keys submit, tab and
// delete), an accessibility tree with masked password fields, frames that change with the state,
// and controller handles that latch after the kill key.
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  MOCK_TITLE_BAR,
  MockDesktop,
  MockDesktops,
  Raster,
  cropPng,
  decodePng,
  encodePng,
  pngSize,
  windowBounds,
} from '../src/screen/index.ts';

const signal = () => new AbortController().signal;
/** The absolute center of a widget in the default desktop. */
function center(d: MockDesktop, windowId: string, name: string): [number, number] {
  const line = d
    .observe()
    .tree.split('\n')
    .find((l) => l.includes(`"${name}"`) && !l.startsWith('window'));
  const w = d.windows().find((x) => x.id === windowId)!;
  const m = /bounds=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(line!)!;
  const [x, y, width, height] = m.slice(1).map(Number) as [number, number, number, number];
  expect(x).toBeGreaterThanOrEqual(w.bounds.x);
  return [x + Math.floor(width / 2), y + Math.floor(height / 2)];
}

describe('PNG', () => {
  it('round-trips RGB and RGBA pixels and reads the size', () => {
    const r = new Raster(5, 3, [10, 20, 30]);
    r.fillRect({ x: 1, y: 1, width: 2, height: 1 }, [200, 100, 50]);
    r.strokeRect({ x: 0, y: 0, width: 5, height: 3 }, [1, 2, 3]);
    const png = r.toPng();
    expect(pngSize(png)).toEqual({ width: 5, height: 3 });
    const back = decodePng(png)!;
    expect(back.channels).toBe(3);
    expect([...back.pixels]).toEqual([...r.data]);
    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...decodePng(encodePng(2, 1, rgba, 4))!.pixels]).toEqual([...rgba]);
    expect(() => encodePng(2, 2, rgba, 4)).toThrow(RangeError);
    expect(() => new Raster(0, 1)).toThrow(RangeError);
  });

  it('decodes every filter type', () => {
    // Two rows of 2 RGB pixels, each filtered differently; expected pixels are known.
    const px = [
      [10, 20, 30, 40, 50, 60],
      [15, 25, 35, 45, 55, 65],
      [5, 5, 5, 200, 210, 220],
      [1, 2, 3, 4, 5, 6],
      [100, 90, 80, 70, 60, 50],
    ];
    const rows: number[][] = [];
    const filters = [0, 1, 2, 3, 4];
    const prev = (y: number, i: number) => (y > 0 ? px[y - 1]![i]! : 0);
    px.forEach((row, y) => {
      const f = filters[y]!;
      const out = [f];
      row.forEach((v, i) => {
        const left = i >= 3 ? row[i - 3]! : 0;
        const up = prev(y, i);
        const ul = i >= 3 ? prev(y, i - 3) : 0;
        let pred = 0;
        if (f === 1) pred = left;
        if (f === 2) pred = up;
        if (f === 3) pred = (left + up) >> 1;
        if (f === 4) {
          const p = left + up - ul;
          const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - ul)];
          pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
        }
        out.push((v - pred) & 0xff);
      });
      rows.push(out);
    });
    // Reuse the encoder's chunk layout with our own IDAT.
    const base = Buffer.from(encodePng(2, 5, new Uint8Array(30), 3));
    const ihdrEnd = 8 + 25;
    const idat = deflateSync(Buffer.from(rows.flat()));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(idat.length);
    const chunk = Buffer.concat([len, Buffer.from('IDAT'), idat, Buffer.alloc(4)]);
    const png = Buffer.concat([base.subarray(0, ihdrEnd), chunk, base.subarray(base.length - 12)]);
    expect([...decodePng(png)!.pixels]).toEqual(px.flat());
  });

  it('crops a region and refuses what it cannot read', () => {
    const r = new Raster(10, 10, [0, 0, 0]);
    r.fillRect({ x: 2, y: 3, width: 4, height: 2 }, [255, 0, 0]);
    const cut = cropPng(r.toPng(), { x: 2, y: 3, width: 4, height: 2 })!;
    expect(pngSize(cut)).toEqual({ width: 4, height: 2 });
    expect(new Set(decodePng(cut)!.pixels)).toEqual(new Set([255, 0]));
    // Clipped to the image; an empty region or a non-PNG gives null.
    expect(pngSize(cropPng(r.toPng(), { x: 8, y: 8, width: 10, height: 10 })!)).toEqual({
      width: 2,
      height: 2,
    });
    expect(cropPng(r.toPng(), { x: 20, y: 20, width: 2, height: 2 })).toBeNull();
    expect(cropPng(new Uint8Array([1, 2, 3]), { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
    expect(pngSize(new Uint8Array(30))).toBeNull();
    expect(decodePng(Buffer.from('not a png at all, really not at all'))).toBeNull();
  });
});

describe('mock desktop', () => {
  it('reports windows front first with class tiers, geometry and a tree', () => {
    const d = new MockDesktop();
    const obs = d.observe();
    expect(pngSize(obs.image)).toEqual({ width: 960, height: 600 });
    expect(obs.windows.map((w) => [w.app, w.tier, w.focused])).toEqual([
      ['Expense Form', 'full', true],
      ['Code Editor', 'click', false],
      ['Terminal', 'click', false],
      ['Web Browser', 'view', false],
    ]);
    expect(windowBounds(obs.windows[0]!)).toEqual({ x: 560, y: 20, width: 380, height: 290 });
    expect(obs.tree).toContain('window "Expense Form" id=w-form');
    expect(obs.tree).toContain('textbox "Name"');
    // The same state gives the same frame; a change gives a new one.
    expect(d.observe().image).toBe(obs.image);
  });

  it('focuses fields on click, fills them by typing and submits with Enter', async () => {
    const d = new MockDesktop();
    const h = d.controller();
    const [nx, ny] = center(d, 'w-form', 'Name');
    expect(await h.act({ kind: 'click', x: nx, y: ny }, signal())).toEqual({ ok: true });
    await h.act({ kind: 'type', text: 'Ada' }, signal());
    await h.act({ kind: 'key', keys: 'Tab' }, signal());
    await h.act({ kind: 'type', text: '42x' }, signal());
    await h.act({ kind: 'key', keys: 'Backspace' }, signal());
    const [cx, cy] = center(d, 'w-form', 'Reimbursable');
    await h.act({ kind: 'click', x: cx, y: cy }, signal());
    const before = d.observe().image;
    await h.act({ kind: 'key', keys: 'Enter' }, signal());
    expect(d.widget('w-form', 'Name')!.value).toBe('Ada');
    expect(d.widget('w-form', 'Amount')!.value).toBe('42');
    expect(d.widget('w-form', 'Status')!.value).toBe('Submitted: Ada, 42 (reimbursable)');
    expect(d.observe().image).not.toBe(before);
    expect(d.delivered.map((e) => e.action.kind)).toEqual([
      'click',
      'type',
      'key',
      'type',
      'key',
      'click',
      'key',
    ]);
    expect(d.delivered[0]).toMatchObject({ windowId: 'w-form', widgetId: 'name' });
  });

  it('raises clicked windows, presses buttons and follows links', async () => {
    const d = new MockDesktop();
    const h = d.controller();
    const [sx, sy] = center(d, 'w-editor', 'Save');
    await h.act({ kind: 'click', x: sx, y: sy }, signal());
    expect(d.windows()[0]).toMatchObject({
      id: 'w-editor',
      focused: true,
      title: 'notes.md (saved) - Code Editor',
    });
    expect(d.widget('w-editor', 'Save')!.presses).toBe(1);
    // A right click raises the window but presses nothing.
    const [bx, by] = center(d, 'w-editor', 'Run');
    await h.act({ kind: 'click', x: bx, y: by, button: 'right' }, signal());
    expect(d.widget('w-editor', 'Run')!.presses).toBe(0);
    // Enter in a multi-line buffer adds a line.
    const [ex, ey] = center(d, 'w-editor', 'Buffer');
    await h.act({ kind: 'click', x: ex, y: ey }, signal());
    await h.act({ kind: 'key', keys: 'Enter' }, signal());
    expect(d.widget('w-editor', 'Buffer')!.value).toBe('# Notes\n');
    // The link in the browser navigates.
    const [lx, ly] = center(d, 'w-browser', 'More information');
    await h.act({ kind: 'click', x: lx, y: ly }, signal());
    expect(d.windows()[0]).toMatchObject({
      id: 'w-browser',
      title: 'More information - Web Browser',
    });
    expect(d.widget('w-browser', 'Address')!.value).toBe('https://example.test/more');
    // Typing into the terminal goes to its output; Enter starts a new prompt.
    // (The browser now covers the terminal's top edge, so click lower, on its output.)
    const [tx, ty] = center(d, 'w-terminal', 'Output');
    await h.act({ kind: 'click', x: tx, y: ty }, signal());
    await h.act({ kind: 'type', text: 'ls' }, signal());
    await h.act({ kind: 'key', keys: 'Enter' }, signal());
    expect(d.widget('w-terminal', 'Output')!.value).toBe('$ ls\n$ ');
    // Clicking the desktop background reaches no window.
    await h.act({ kind: 'click', x: 5, y: 595 }, signal());
    expect(d.delivered.at(-1)).toMatchObject({ windowId: null });
  });

  it('scrolls and drags windows by the title bar', async () => {
    const d = new MockDesktop();
    const h = d.controller();
    await h.act({ kind: 'scroll', x: 600, y: 100, dy: 50 }, signal());
    await h.act({ kind: 'scroll', x: 600, y: 100, dy: -500 }, signal());
    expect(d.windows().find((w) => w.id === 'w-form')!.scrollY).toBe(0);
    await h.act({ kind: 'scroll', x: 600, y: 100, dy: 30 }, signal());
    expect(d.windows().find((w) => w.id === 'w-form')!.scrollY).toBe(30);
    await h.act({ kind: 'drag', from: [600, 20 + MOCK_TITLE_BAR / 2], to: [500, 60] }, signal());
    expect(d.windows()[0]!.bounds).toMatchObject({ x: 460, y: 49 });
    // A drag that does not start on a title bar moves nothing.
    await h.act({ kind: 'drag', from: [700, 200], to: [100, 100] }, signal());
    expect(d.windows()[0]!.bounds).toMatchObject({ x: 460, y: 49 });
    await h.act({ kind: 'drag', from: [5, 595], to: [10, 10] }, signal());
    await h.act({ kind: 'scroll', x: 5, y: 595, dy: 5 }, signal());
  });

  it('masks password fields in the tree and the frame', async () => {
    const d = new MockDesktop({
      windows: [
        {
          id: 'w-login',
          app: 'Sign in',
          appClass: 'app',
          title: 'Sign in',
          bounds: { x: 0, y: 0, width: 300, height: 200 },
          widgets: [
            { id: 'pw', role: 'password', name: 'Password', x: 10, y: 10, width: 200, height: 24 },
          ],
        },
        {
          id: 'w-vault',
          app: 'Password Vault',
          appClass: 'sensitive',
          title: 'Vault',
          bounds: { x: 400, y: 0, width: 200, height: 200 },
          widgets: [],
        },
      ],
    });
    const h = d.controller();
    await h.act({ kind: 'click', x: 50, y: 40 }, signal());
    await h.act({ kind: 'type', text: 'hunter2' }, signal());
    await h.act({ kind: 'key', keys: 'Tab' }, signal());
    expect(d.widget('w-login', 'Password')!.value).toBe('hunter2');
    expect(d.observe().tree).toContain('password "Password" value=(masked)');
    expect(d.observe().tree).not.toContain('hunter2');
    // The seam has no `none` tier: a sensitive app reports `view` (the Hub lowers it by name).
    expect(d.observe().windows.find((w) => w.app === 'Password Vault')!.tier).toBe('view');
    expect(d.tierOf('w-vault')).toBe('none');
    expect(d.tierOf('missing')).toBeNull();
  });

  it('latches a handle after the kill key and drops input waiting to be delivered', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hold = true;
    const d = new MockDesktop({ beforeInput: () => (hold ? held : Promise.resolve()) });
    const h = d.controller();
    const pending = h.act({ kind: 'click', x: 600, y: 100 }, signal());
    await h.kill();
    release();
    expect(await pending).toEqual({ ok: false, error: 'control was stopped with the kill key' });
    hold = false;
    expect(await h.act({ kind: 'click', x: 600, y: 100 }, signal())).toMatchObject({ ok: false });
    expect(d.delivered).toEqual([]);
    // A new handle (after the user resumes control) delivers again; observing still works.
    expect((await h.observe()).windows).toHaveLength(4);
    expect(await d.controller().act({ kind: 'click', x: 600, y: 100 }, signal())).toEqual({
      ok: true,
    });
    expect(d.delivered).toHaveLength(1);
  });

  it('cancels input on abort, before or while it waits', async () => {
    const never = new Promise<void>(() => undefined);
    const d = new MockDesktop({ beforeInput: () => never });
    const h = d.controller();
    const aborted = new AbortController();
    aborted.abort();
    expect(await h.act({ kind: 'type', text: 'x' }, aborted.signal)).toEqual({
      ok: false,
      error: 'cancelled',
    });
    const ac = new AbortController();
    const pending = h.act({ kind: 'type', text: 'x' }, ac.signal);
    ac.abort();
    expect(await pending).toEqual({ ok: false, error: 'cancelled' });
    const failing = new MockDesktop({ beforeInput: () => Promise.reject(new Error('boom')) });
    expect(await failing.controller().act({ kind: 'type', text: 'x' }, signal())).toEqual({
      ok: false,
      error: 'cancelled',
    });
    expect(d.delivered).toEqual([]);
  });

  it('keeps one desktop per computer in the registry', async () => {
    const reg = new MockDesktops((id) => ({ width: id === 'small' ? 320 : 640, height: 240 }));
    expect(reg.desktop('small').width).toBe(320);
    expect(reg.desktop('big').width).toBe(640);
    expect(reg.desktop('small')).toBe(reg.desktop('small'));
    const a = reg.screen('small');
    const b = reg.screen('small');
    expect(a).not.toBe(b);
    expect((await a.observe()).windows).toHaveLength(4);
    reg.delete('small');
    expect(reg.desktop('small')).not.toBe(reg.desktop('big'));
    expect(new MockDesktops().desktop('x').width).toBe(960);
  });
});
