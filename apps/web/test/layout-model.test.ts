import { describe, expect, it } from 'vitest';
import {
  MAX_PANES,
  closePane,
  defaultLayout,
  findPane,
  leaves,
  movePane,
  normalize,
  openInPane,
  parseLayout,
  RESIZE_STEP,
  resizePane,
  setActive,
  setBottom,
  setSizes,
  splitPane,
  swapPanes,
  toggleMaximize,
  updatePane,
  type ModeLayout,
  type PaneSplit,
} from '../src/layout/model.ts';
import { layoutsFrom } from '../src/layout/useLayouts.ts';

const ids = (l: ModeLayout) => leaves(l.root).map((p) => `${p.id}:${p.kind}`);

describe('pane layout model (FR-005)', () => {
  it('starts with the main pane alone and the bottom panel closed', () => {
    const l = defaultLayout();
    expect(ids(l)).toEqual(['main:main']);
    expect(l.bottom).toEqual({ open: false, size: 0.3 });
    expect(l.active).toBe('main');
  });

  it('splits right and down, sharing space within one direction', () => {
    const a = splitPane(defaultLayout(), 'main', 'row', 'editor');
    expect(a.paneId).toBe('p1');
    expect(ids(a.layout)).toEqual(['main:main', 'p1:editor']);
    expect(a.layout.active).toBe('p1');
    const root = a.layout.root as PaneSplit;
    expect(root.direction).toBe('row');
    expect(root.sizes).toEqual([0.5, 0.5]);

    // Same direction: the target's share is halved for the new sibling.
    const b = splitPane(a.layout, 'p1', 'row');
    expect(ids(b.layout)).toEqual(['main:main', 'p1:editor', 'p2:empty']);
    expect((b.layout.root as PaneSplit).sizes).toEqual([0.5, 0.25, 0.25]);

    // Other direction: the target becomes a column split in place.
    const c = splitPane(b.layout, 'main', 'column', 'terminal');
    const top = c.layout.root as PaneSplit;
    expect(top.children[0]).toMatchObject({ type: 'split', direction: 'column' });
    expect(ids(c.layout)).toEqual(['main:main', 'p3:terminal', 'p1:editor', 'p2:empty']);
  });

  it('refuses a second main pane, unknown targets and too many panes', () => {
    const l = defaultLayout();
    expect(splitPane(l, 'main', 'row', 'main').paneId).toBeNull();
    expect(splitPane(l, 'nope', 'row').layout).toBe(l);
    let many = l;
    for (let i = 0; i < MAX_PANES + 2; i++) many = splitPane(many, 'main', 'row').layout;
    expect(leaves(many.root)).toHaveLength(MAX_PANES);
    expect(splitPane(many, 'main', 'row').paneId).toBeNull();
  });

  it('closes panes, collapses single-child splits and never closes the main pane', () => {
    let l = splitPane(defaultLayout(), 'main', 'row', 'editor').layout;
    l = splitPane(l, 'p1', 'column', 'preview').layout;
    l = toggleMaximize(l, 'p2');
    const closed = closePane(l, 'p2');
    expect(ids(closed)).toEqual(['main:main', 'p1:editor']);
    expect(closed.maximized).toBeNull();
    expect(closed.active).toBe('p1');
    expect((closed.root as PaneSplit).children.every((c) => c.type === 'pane')).toBe(true);
    const alone = closePane(closed, 'p1');
    expect(alone.root).toEqual({ type: 'pane', id: 'main', kind: 'main' });
    expect(alone.active).toBe('main');
    expect(closePane(alone, 'main')).toBe(alone);
    expect(closePane(alone, 'zzz')).toBe(alone);
    // Closing a pane that is not active keeps the active one.
    const two = splitPane(defaultLayout(), 'main', 'row', 'editor').layout;
    expect(closePane(setActive(two, 'main'), 'p1').active).toBe('main');
  });

  it('resizes a split, keeping a minimum share and normalizing', () => {
    const l = splitPane(defaultLayout(), 'main', 'row', 'editor').layout;
    const split = l.root as PaneSplit;
    const r = setSizes(l, split.id, [3, 1]);
    expect((r.root as PaneSplit).sizes).toEqual([0.75, 0.25]);
    const tiny = (setSizes(l, split.id, [1, 0]).root as PaneSplit).sizes;
    expect(tiny[1]).toBeGreaterThan(0);
    expect(setSizes(l, split.id, [1])).toBe(l);
    expect(setSizes(l, 'missing', [1, 1])).toBe(l);
    expect(normalize([0, 0])).toEqual([0.5, 0.5]);
    expect(normalize([Number.NaN, 1])).toEqual([0, 1]);
  });

  it('makes a pane larger or smaller without dragging (WCAG 2.5.7)', () => {
    const two = splitPane(defaultLayout(), 'main', 'row', 'editor').layout;
    const three = splitPane(two, 'p1', 'row', 'preview').layout;
    const shares = (l: ModeLayout) => (l.root as PaneSplit).sizes.map((s) => Math.round(s * 100));
    expect(shares(three)).toEqual([50, 25, 25]);
    // Larger takes from the siblings by what each can spare; smaller gives back by size.
    const larger = resizePane(three, 'main', RESIZE_STEP)!;
    expect(shares(larger)).toEqual([60, 20, 20]);
    expect(shares(resizePane(larger, 'main', -RESIZE_STEP)!)).toEqual([50, 25, 25]);
    // Never below the minimum share; null when nothing can change.
    let l = three;
    for (let i = 0; i < 10; i++) l = resizePane(l, 'main', RESIZE_STEP) ?? l;
    expect(shares(l)).toEqual([80, 10, 10]);
    expect(resizePane(l, 'main', RESIZE_STEP)).toBeNull();
    expect(resizePane(l, 'p1', -RESIZE_STEP)).toBeNull();
    expect(resizePane(defaultLayout(), 'main', RESIZE_STEP)).toBeNull();
  });

  it('moves panes among siblings and swaps any two', () => {
    let l = splitPane(defaultLayout(), 'main', 'row', 'editor').layout;
    l = setSizes(l, l.root.id, [0.7, 0.3]);
    const moved = movePane(l, 'p1', -1);
    expect(ids(moved)).toEqual(['p1:editor', 'main:main']);
    expect((moved.root as PaneSplit).sizes).toEqual([0.3, 0.7]);
    expect(movePane(moved, 'p1', -1)).toBe(moved);
    expect(movePane(defaultLayout(), 'main', 1).root).toEqual(defaultLayout().root);

    const deep = splitPane(l, 'p1', 'column', 'terminal').layout;
    const swapped = swapPanes(deep, 'main', 'p2');
    expect(ids(swapped)).toEqual(['p2:terminal', 'p1:editor', 'main:main']);
    expect(swapPanes(deep, 'main', 'main')).toBe(deep);
    expect(swapPanes(deep, 'main', 'nope')).toBe(deep);
  });

  it('maximizes and restores, and tracks the active pane', () => {
    const l = splitPane(defaultLayout(), 'main', 'row', 'editor').layout;
    const max = toggleMaximize(l, 'main');
    expect(max.maximized).toBe('main');
    expect(max.active).toBe('main');
    expect(toggleMaximize(max, 'main').maximized).toBeNull();
    expect(toggleMaximize(l, 'nope')).toBe(l);
    expect(setActive(l, 'p1')).toBe(l);
    expect(setActive(l, 'nope')).toBe(l);
  });

  it('changes a pane kind and file, but never into or out of main', () => {
    const l = splitPane(defaultLayout(), 'main', 'row').layout;
    const ed = updatePane(l, 'p1', { kind: 'editor', file: { root: '/w', path: 'a.ts' } });
    expect(findPane(ed, 'p1')).toMatchObject({ kind: 'editor', file: { path: 'a.ts' } });
    expect(findPane(updatePane(ed, 'p1', { file: null }), 'p1')?.file).toBeUndefined();
    expect(updatePane(l, 'main', { kind: 'editor' })).toBe(l);
    expect(updatePane(l, 'p1', { kind: 'main' })).toBe(l);
  });

  it('opens a file in the active pane of the kind, then any of the kind, an empty one, or a new one', () => {
    const f = { root: '/w', path: 'a.md' };
    const g = { root: '/w', path: 'b.md' };
    const fresh = openInPane(defaultLayout(), 'editor', f);
    expect(fresh.paneId).toBe('p1');
    expect(findPane(fresh.layout, 'p1')).toMatchObject({ kind: 'editor', file: f });

    const again = openInPane(setActive(fresh.layout, 'main'), 'editor', g);
    expect(again.paneId).toBe('p1');
    expect(findPane(again.layout, 'p1')?.file).toEqual(g);
    expect(again.layout.active).toBe('p1');

    const withEmpty = splitPane(defaultLayout(), 'main', 'column').layout;
    const reused = openInPane(toggleMaximize(withEmpty, 'main'), 'preview', f);
    expect(reused.paneId).toBe('p1');
    expect(reused.layout.maximized).toBeNull();
  });

  it('keeps the bottom panel within its limits', () => {
    const l = defaultLayout();
    expect(setBottom(l, { open: true }).bottom).toEqual({ open: true, size: 0.3 });
    expect(setBottom(l, { size: 5 }).bottom.size).toBe(0.8);
    expect(setBottom(l, { size: 0 }).bottom.size).toBe(0.15);
    expect(setBottom(l, {})).toBe(l);
  });

  it('round-trips through JSON and rejects malformed saved layouts', () => {
    let l = splitPane(defaultLayout(), 'main', 'row', 'editor', {
      root: '/w',
      path: 'x.ts',
    }).layout;
    l = setBottom(toggleMaximize(l, 'p1'), { open: true, size: 0.4 });
    const back = parseLayout(JSON.parse(JSON.stringify(l)));
    expect(back).toEqual(l);

    expect(parseLayout(null)).toBeNull();
    expect(parseLayout({ root: { type: 'pane', id: 'x', kind: 'editor' } })).toBeNull();
    expect(parseLayout({ root: { type: 'pane', id: 'main', kind: 'weird' } })).toBeNull();
    const dup = {
      root: {
        type: 'split',
        id: 's1',
        direction: 'row',
        children: [
          { type: 'pane', id: 'main', kind: 'main' },
          { type: 'pane', id: 'main', kind: 'editor' },
        ],
        sizes: [0.5, 0.5],
      },
    };
    expect(parseLayout(dup)).toBeNull();
    const badDirection = { root: { ...dup.root, direction: 'diagonal' } };
    expect(parseLayout(badDirection)).toBeNull();
    const oneChild = { root: { ...dup.root, children: [dup.root.children[0]] } };
    expect(parseLayout(oneChild)).toBeNull();

    // Missing or broken fields fall back to safe values.
    const loose = parseLayout({
      root: {
        type: 'split',
        id: 's1',
        direction: 'column',
        children: [
          { type: 'pane', id: 'main', kind: 'main' },
          { type: 'pane', id: 'p9', kind: 'preview', file: { root: 7 } },
        ],
        sizes: ['a', 1],
      },
      maximized: 'gone',
      active: 42,
      bottom: { open: 'yes', size: 99 },
    });
    expect(loose).toMatchObject({
      maximized: null,
      active: 'main',
      bottom: { open: false, size: 0.8 },
    });
    expect((loose!.root as PaneSplit).sizes).toEqual([0.5, 0.5]);
    expect(findPane(loose!, 'p9')?.file).toBeUndefined();
  });

  it('reads every mode from the setting, with defaults for missing or broken ones', () => {
    const chat = splitPane(defaultLayout(), 'main', 'row', 'terminal').layout;
    const all = layoutsFrom({ chat, code: 'broken' });
    expect(ids(all.chat)).toEqual(['main:main', 'p1:terminal']);
    expect(all.code).toEqual(defaultLayout());
    expect(all.work).toEqual(defaultLayout());
    expect(all.agents).toEqual(defaultLayout());
  });
});
