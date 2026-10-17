import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { PaneGroup, Splitter, Tree, moveBoundary, type TreeNode } from '../src/index.ts';

afterEach(cleanup);

describe('Splitter (FR-005)', () => {
  function Harness({
    onMove = vi.fn(),
    orientation = 'vertical',
  }: {
    onMove?: (d: number) => void;
    orientation?: 'vertical' | 'horizontal';
  }) {
    const [v, setV] = useState(50);
    return (
      <div>
        <Splitter
          label="Resize Chat and Editor"
          orientation={orientation}
          value={v}
          min={20}
          max={80}
          onMove={(d) => {
            onMove(d);
            setV((x) => x + d);
          }}
        />
      </div>
    );
  }

  it('is a focusable, labelled separator with its value and limits', () => {
    render(<Harness />);
    const s = screen.getByRole('separator', { name: 'Resize Chat and Editor' });
    expect(s.tabIndex).toBe(0);
    expect(s.getAttribute('aria-orientation')).toBe('vertical');
    expect(s.getAttribute('aria-valuenow')).toBe('50');
    expect(s.getAttribute('aria-valuemin')).toBe('20');
    expect(s.getAttribute('aria-valuemax')).toBe('80');
  });

  it('moves with the arrow keys, Shift for bigger steps, and Home and End to the limits', async () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    const s = screen.getByRole('separator');
    s.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(s.getAttribute('aria-valuenow')).toBe('55');
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(s.getAttribute('aria-valuenow')).toBe('45');
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(s.getAttribute('aria-valuenow')).toBe('65');
    await userEvent.keyboard('{End}');
    expect(s.getAttribute('aria-valuenow')).toBe('80');
    onMove.mockClear();
    await userEvent.keyboard('{ArrowRight}{End}');
    expect(onMove).not.toHaveBeenCalled();
    await userEvent.keyboard('{Home}');
    expect(s.getAttribute('aria-valuenow')).toBe('20');
    // Up and Down belong to horizontal splitters only.
    await userEvent.keyboard('{ArrowDown}');
    expect(s.getAttribute('aria-valuenow')).toBe('20');
  });

  it('uses Up and Down when horizontal', async () => {
    render(<Harness orientation="horizontal" />);
    const s = screen.getByRole('separator');
    s.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(s.getAttribute('aria-valuenow')).toBe('55');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(s.getAttribute('aria-valuenow')).toBe('45');
  });

  it('follows a pointer drag relative to its container, within the limits', () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    const s = screen.getByRole('separator');
    s.parentElement!.getBoundingClientRect = () =>
      ({ width: 1000, height: 500, top: 0, left: 0, right: 1000, bottom: 500 }) as DOMRect;
    fireEvent.pointerDown(s, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(s, { clientX: 600, pointerId: 1 });
    expect(s.getAttribute('aria-valuenow')).toBe('60');
    fireEvent.pointerMove(s, { clientX: 1000, pointerId: 1 });
    expect(s.getAttribute('aria-valuenow')).toBe('80');
    fireEvent.pointerUp(s, { pointerId: 1 });
    fireEvent.pointerMove(s, { clientX: 100, pointerId: 1 });
    expect(s.getAttribute('aria-valuenow')).toBe('80');
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it('ignores drags without a measurable container and other buttons', () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    const s = screen.getByRole('separator');
    fireEvent.pointerDown(s, { button: 0, clientX: 500 });
    fireEvent.pointerMove(s, { clientX: 700 });
    fireEvent.pointerDown(s, { button: 2, clientX: 500 });
    fireEvent.pointerMove(s, { clientX: 700 });
    fireEvent.pointerCancel(s);
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('PaneGroup (FR-005)', () => {
  it('moves one boundary and keeps both panes above the minimum', () => {
    expect(moveBoundary([0.5, 0.5], 0, 0.2, 0.1)).toEqual([0.7, 0.3]);
    const [a, b] = moveBoundary([0.5, 0.5], 0, 0.9, 0.1);
    expect(a).toBeCloseTo(0.9);
    expect(b).toBeCloseTo(0.1);
    expect(moveBoundary([0.5, 0.5], 3, 0.1, 0.1)).toEqual([0.5, 0.5]);
  });

  it('puts a splitter between each pair and resizes with the keyboard', async () => {
    const onSizes = vi.fn();
    function Harness() {
      const [sizes, setSizes] = useState([0.5, 0.25, 0.25]);
      return (
        <PaneGroup
          direction="row"
          sizes={sizes}
          onSizes={(s) => {
            onSizes(s);
            setSizes(s);
          }}
          splitterLabel={(i) => `Resize pane ${i + 1}`}
        >
          <section key="a" aria-label="A" />
          <section key="b" aria-label="B" />
          <section key="c" aria-label="C" />
        </PaneGroup>
      );
    }
    const { container } = render(<Harness />);
    const splitters = screen.getAllByRole('separator');
    expect(splitters.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Resize pane 1',
      'Resize pane 2',
    ]);
    expect(splitters[0]!.getAttribute('aria-valuenow')).toBe('50');
    expect(splitters[1]!.getAttribute('aria-valuenow')).toBe('75');
    expect(splitters[0]!.getAttribute('aria-valuemin')).toBe('10');
    expect(splitters[0]!.getAttribute('aria-valuemax')).toBe('65');
    splitters[0]!.focus();
    await userEvent.keyboard('{ArrowLeft}');
    const sizes = onSizes.mock.lastCall![0] as number[];
    expect(sizes[0]).toBeCloseTo(0.45);
    expect(sizes[1]).toBeCloseTo(0.3);
    const cells = container.querySelectorAll<HTMLElement>('.nv-pane-cell');
    expect(cells[0]!.style.flex).toMatch(/^0\.45/);
    expect(container.querySelector('.nv-panes')!.getAttribute('data-direction')).toBe('row');
  });

  it('stacks in a column with horizontal splitters and shares space evenly without sizes', () => {
    const { container } = render(
      <PaneGroup direction="column" sizes={[]} onSizes={() => undefined} splitterLabel={() => 'R'}>
        <div />
        <div />
      </PaneGroup>,
    );
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('horizontal');
    expect(container.querySelectorAll<HTMLElement>('.nv-pane-cell')[1]!.style.flex).toMatch(
      /^0\.5/,
    );
  });
});

describe('Tree with branches that load on demand (FR-039)', () => {
  const nodes: TreeNode[] = [
    { id: 'src', parentId: null, label: 'src', expandable: true },
    { id: 'readme', parentId: null, label: 'README.md' },
  ];

  it('shows closed branches, opens them with the arrow key, and reports it', async () => {
    const onExpandedChange = vi.fn();
    function Harness() {
      const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
      const [list, setList] = useState(nodes);
      return (
        <Tree
          label="Files"
          nodes={list}
          onActivate={() => undefined}
          expanded={open}
          onExpandedChange={(id, isOpen) => {
            onExpandedChange(id, isOpen);
            setOpen((s) => {
              const next = new Set(s);
              if (isOpen) next.add(id);
              else next.delete(id);
              return next;
            });
            if (isOpen && !list.some((n) => n.parentId === id))
              setList((l) => [...l, { id: 'main', parentId: 'src', label: 'main.ts' }]);
          }}
        />
      );
    }
    render(<Harness />);
    const src = screen.getByRole('treeitem', { name: 'src' });
    expect(src.getAttribute('aria-expanded')).toBe('false');
    src.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onExpandedChange).toHaveBeenLastCalledWith('src', true);
    expect(src.getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'main.ts' }));
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(onExpandedChange).toHaveBeenLastCalledWith('src', false);
    expect(screen.queryByRole('treeitem', { name: 'main.ts' })).toBeNull();
    // The toggle opens it with the pointer too.
    await userEvent.click(src.querySelector('.nv-tree-toggle')!);
    expect(onExpandedChange).toHaveBeenLastCalledWith('src', true);
  });

  it('reports changes without taking control when `expanded` is not given', async () => {
    const onExpandedChange = vi.fn();
    render(
      <Tree
        label="Files"
        nodes={[...nodes, { id: 'a', parentId: 'src', label: 'a.ts' }]}
        onActivate={() => undefined}
        onExpandedChange={onExpandedChange}
      />,
    );
    const src = screen.getByRole('treeitem', { name: 'src' });
    expect(src.getAttribute('aria-expanded')).toBe('true');
    src.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onExpandedChange).toHaveBeenLastCalledWith('src', false);
    expect(src.getAttribute('aria-expanded')).toBe('false');
  });
});
