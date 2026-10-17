import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { Menu, PresetScale, SelectField, Tree, type TreeNode } from '../src/index.ts';

afterEach(cleanup);

describe('PresetScale (FR-221)', () => {
  function Harness({ initial = null as string | null, onChange = vi.fn() }) {
    const [v, setV] = useState<string | null>(initial);
    return (
      <PresetScale
        label="Model preset"
        value={v}
        onChange={(next) => {
          onChange(next);
          setV(next);
        }}
        options={[
          { value: 'faster', label: 'Faster' },
          { value: 'balanced', label: 'Balanced', description: 'Mock fast' },
          { value: 'smarter', label: 'Smarter' },
        ]}
      >
        <a href="/settings/models">Advanced…</a>
      </PresetScale>
    );
  }

  it('is a named group of labelled radios with the trailing content', () => {
    render(<Harness initial="balanced" />);
    const group = screen.getByRole('group', { name: 'Model preset' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('value'))).toEqual(['faster', 'balanced', 'smarter']);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Balanced' }).checked).toBe(true);
    const balanced = screen.getByRole('radio', { name: 'Balanced' });
    const desc = document.getElementById(balanced.getAttribute('aria-describedby')!);
    expect(desc?.textContent).toBe('Mock fast');
    expect(
      screen.getByRole('radio', { name: 'Faster' }).getAttribute('aria-describedby'),
    ).toBeNull();
    expect(within(group).getByRole('link', { name: 'Advanced…' })).toBeTruthy();
  });

  it('selects by click and by arrow keys, and can show no selection', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getAllByRole<HTMLInputElement>('radio').every((r) => !r.checked)).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'Faster' }));
    expect(onChange).toHaveBeenLastCalledWith('faster');
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('balanced');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Balanced' }).checked).toBe(true);
  });

  it('can be disabled', () => {
    render(
      <PresetScale
        label="Model preset"
        value={null}
        onChange={() => undefined}
        options={[{ value: 'a', label: 'A' }]}
        disabled
      />,
    );
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'A' }).disabled).toBe(true);
  });
});

describe('Tree (FR-033)', () => {
  const nodes: TreeNode[] = [
    { id: 'root', parentId: null, label: 'Trip', detail: '4 messages' },
    { id: 'b1', parentId: 'root', label: 'Branch: Trip' },
    { id: 'b2', parentId: 'b1', label: 'Deeper' },
    { id: 's1', parentId: 'root', label: 'Side question' },
  ];

  it('exposes levels, expansion, the current node and names without child text', () => {
    render(<Tree label="Branches" nodes={nodes} onActivate={() => undefined} currentId="b1" />);
    const tree = screen.getByRole('tree', { name: 'Branches' });
    const root = within(tree).getByRole('treeitem', { name: 'Trip' });
    expect(root.getAttribute('aria-level')).toBe('1');
    expect(root.getAttribute('aria-expanded')).toBe('true');
    const b1 = screen.getByRole('treeitem', { name: 'Branch: Trip' });
    expect(b1.getAttribute('aria-level')).toBe('2');
    expect(b1.getAttribute('aria-current')).toBe('page');
    expect(b1.tabIndex).toBe(0);
    expect(root.tabIndex).toBe(-1);
    expect(
      screen.getByRole('treeitem', { name: 'Side question' }).getAttribute('aria-expanded'),
    ).toBeNull();
    expect(screen.getByText('4 messages')).toBeTruthy();
    expect(tree.getAttribute('aria-multiselectable')).toBeNull();
  });

  it('moves with arrows, Home and End, collapses and expands, and activates', async () => {
    const onActivate = vi.fn();
    render(<Tree label="Branches" nodes={nodes} onActivate={onActivate} />);
    const item = (name: string) => screen.getByRole('treeitem', { name });
    item('Trip').focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(item('Branch: Trip'));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(item('Deeper'));
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(item('Branch: Trip'));
    await userEvent.keyboard('{ArrowLeft}');
    expect(item('Branch: Trip').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: 'Deeper' })).toBeNull();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(item('Side question'));
    await userEvent.keyboard('{ArrowUp}{ArrowRight}');
    expect(item('Branch: Trip').getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(item('Deeper'));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(item('Trip'));
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(item('Side question'));
    await userEvent.keyboard('{Enter}');
    expect(onActivate).toHaveBeenLastCalledWith('s1');
    await userEvent.click(screen.getByText('Deeper'));
    expect(onActivate).toHaveBeenLastCalledWith('b2');
    await userEvent.keyboard('x');
  });

  it('toggles selection with Space and the check box when multiselectable', async () => {
    function Harness() {
      const [sel, setSel] = useState<string[]>([]);
      return (
        <Tree
          label="Branches"
          nodes={nodes}
          onActivate={() => undefined}
          selected={sel}
          onToggleSelect={(id) =>
            setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
          }
        />
      );
    }
    const { container } = render(<Harness />);
    const tree = screen.getByRole('tree');
    expect(tree.getAttribute('aria-multiselectable')).toBe('true');
    const root = screen.getByRole('treeitem', { name: 'Trip' });
    expect(root.getAttribute('aria-selected')).toBe('false');
    root.focus();
    await userEvent.keyboard(' ');
    expect(root.getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard(' ');
    expect(root.getAttribute('aria-selected')).toBe('false');
    const checks = container.querySelectorAll<HTMLElement>('.nv-tree-check');
    await userEvent.click(checks[3]!);
    expect(
      screen.getByRole('treeitem', { name: 'Side question' }).getAttribute('aria-selected'),
    ).toBe('true');
    // The expand toggle is a mouse affordance; it collapses without activating.
    await userEvent.click(container.querySelector<HTMLElement>('.nv-tree-toggle[data-open]')!);
    expect(root.getAttribute('aria-expanded')).toBe('false');
  });

  it('treats a node whose parent is missing as a root and survives an empty list', () => {
    const { unmount } = render(
      <Tree
        label="Orphans"
        nodes={[{ id: 'x', parentId: 'gone', label: 'Orphan' }]}
        onActivate={() => undefined}
      />,
    );
    expect(screen.getByRole('treeitem', { name: 'Orphan' }).getAttribute('aria-level')).toBe('1');
    unmount();
    render(<Tree label="Empty" nodes={[]} onActivate={() => undefined} />);
    expect(screen.getByRole('tree', { name: 'Empty' }).children).toHaveLength(0);
  });
});

describe('Menu checkbox items and option tooltips', () => {
  it('renders checked state as menuitemcheckbox with a description', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        label="Chat options"
        items={[
          { id: 'mem', label: "Don't use for memory", checked: true, onSelect },
          { id: 'plain', label: 'Rename', onSelect: () => undefined, description: 'F2' },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    const item = screen.getByRole('menuitemcheckbox', { name: /Don't use for memory/ });
    expect(item.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Rename' }).getAttribute('title')).toBe('F2');
    await userEvent.click(item);
    expect(onSelect).toHaveBeenCalled();
  });

  it('puts option titles on native options', () => {
    render(
      <SelectField
        label="Model"
        value="a"
        onChange={() => undefined}
        groups={[
          {
            label: 'Presets',
            options: [{ value: 'p', label: 'Smarter', disabled: true, title: 'No model' }],
          },
          { label: 'Mock', options: [{ value: 'a', label: 'A' }] },
          { label: 'Mock', options: [{ value: 'b', label: 'B' }] },
        ]}
      />,
    );
    const opt = screen.getByRole<HTMLOptionElement>('option', { name: 'Smarter' });
    expect(opt.disabled).toBe(true);
    expect(opt.title).toBe('No model');
    expect(screen.getAllByRole('group')).toHaveLength(3);
  });
});
