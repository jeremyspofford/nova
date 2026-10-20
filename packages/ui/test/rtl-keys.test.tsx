// Right-to-left (FR-016): the Left and Right arrow keys and pointer drags follow what the user
// sees, so in a right-to-left layout their meaning swaps along the inline axis.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { readingDirection, rovingIndex, Splitter, Tree, type TreeNode } from '../src/index.ts';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('dir');
});

describe('readingDirection', () => {
  it('reads the nearest ltr or rtl around an element, else the document', () => {
    const { container } = render(
      <div dir="rtl">
        <p id="a" dir="auto">
          <span id="in-rtl" />
        </p>
        <pre dir="ltr">
          <code id="island" />
        </pre>
      </div>,
    );
    expect(readingDirection(container.querySelector('#in-rtl'))).toBe('rtl');
    expect(readingDirection(container.querySelector('#island'))).toBe('ltr');
    expect(readingDirection(container)).toBe('ltr');
    document.documentElement.dir = 'rtl';
    expect(readingDirection(container)).toBe('rtl');
    expect(readingDirection()).toBe('rtl');
  });
});

describe('rovingIndex', () => {
  it('swaps Left and Right for horizontal lists in right-to-left', () => {
    expect(rovingIndex('ArrowRight', 1, 3, 'horizontal', 'ltr')).toBe(2);
    expect(rovingIndex('ArrowRight', 1, 3, 'horizontal', 'rtl')).toBe(0);
    expect(rovingIndex('ArrowLeft', 1, 3, 'horizontal', 'rtl')).toBe(2);
    expect(rovingIndex('ArrowDown', 1, 3, 'vertical', 'rtl')).toBe(2);
  });

  it('follows the document direction by default', () => {
    expect(rovingIndex('ArrowLeft', 0, 3, 'horizontal')).toBe(2);
    document.documentElement.dir = 'rtl';
    expect(rovingIndex('ArrowLeft', 0, 3, 'horizontal')).toBe(1);
  });
});

describe('Splitter in right-to-left', () => {
  function Harness({ onMove = vi.fn() }: { onMove?: (d: number) => void }) {
    const [v, setV] = useState(50);
    return (
      <div dir="rtl">
        <Splitter
          label="Resize"
          orientation="vertical"
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

  it('moves toward the arrow pressed: Left grows the first (right-hand) pane', async () => {
    render(<Harness />);
    const s = screen.getByRole('separator');
    s.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(s.getAttribute('aria-valuenow')).toBe('55');
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(s.getAttribute('aria-valuenow')).toBe('45');
  });

  it('follows a pointer drag: moving left grows the first pane', () => {
    render(<Harness />);
    const s = screen.getByRole('separator');
    s.parentElement!.getBoundingClientRect = () =>
      ({ width: 1000, height: 500, top: 0, left: 0, right: 1000, bottom: 500 }) as DOMRect;
    fireEvent.pointerDown(s, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(s, { clientX: 400, pointerId: 1 });
    expect(s.getAttribute('aria-valuenow')).toBe('60');
    fireEvent.pointerUp(s, { pointerId: 1 });
  });
});

describe('Tree in right-to-left', () => {
  const nodes: TreeNode[] = [
    { id: 'src', parentId: null, label: 'src' },
    { id: 'main', parentId: 'src', label: 'main.ts' },
  ];

  it('opens a branch with Left and closes it with Right', async () => {
    function Harness() {
      const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
      return (
        <div dir="rtl">
          <Tree
            label="Files"
            nodes={nodes}
            onActivate={() => undefined}
            expanded={open}
            onExpandedChange={(id, isOpen) =>
              setOpen((s) => {
                const next = new Set(s);
                if (isOpen) next.add(id);
                else next.delete(id);
                return next;
              })
            }
          />
        </div>
      );
    }
    render(<Harness />);
    const branch = screen.getByRole('treeitem', { name: 'src' });
    branch.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(branch.getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    expect(branch.getAttribute('aria-expanded')).toBe('false');
  });
});
