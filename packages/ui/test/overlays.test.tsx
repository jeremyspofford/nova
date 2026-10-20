import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { Button, Dialog, Menu, Tabs, Tooltip, type MenuItem } from '../src/index.ts';

afterEach(cleanup);

function DialogHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Delete chat</Button>
      <Dialog
        open={open}
        title="Delete this chat?"
        description="This removes it from every device."
        initialFocusRef={cancel}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        footer={
          <>
            <Button ref={cancel} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger">Delete</Button>
          </>
        }
      >
        <input aria-label="Reason" />
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('is a labelled modal that focuses the initial element and traps Tab', async () => {
    render(<DialogHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this chat?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Reason' }));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Delete chat' });
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(opener);
  });

  it('closes on a backdrop click but not on a click inside', async () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
    await userEvent.click(screen.getByRole('textbox', { name: 'Reason' }));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(document.querySelector('.nv-dialog-backdrop')!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('returns focus to an opener that was disabled while it worked (WCAG 2.4.3)', async () => {
    // A "Check" button disables itself while a check runs (focus falls to the page), then the
    // result opens in a dialog; closing the dialog puts focus back on the button.
    function Busy() {
      const [busy, setBusy] = useState(false);
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button
            disabled={busy}
            onClick={(e) => {
              setBusy(true);
              // Browsers move focus off a control that becomes disabled; jsdom does not.
              e.currentTarget.blur();
              setTimeout(() => {
                setBusy(false);
                setOpen(true);
              }, 0);
            }}
          >
            Check
          </Button>
          <Dialog open={open} title="Result" onClose={() => setOpen(false)}>
            <Button>Install</Button>
          </Dialog>
        </>
      );
    }
    render(<Busy />);
    const opener = screen.getByRole('button', { name: 'Check' });
    await userEvent.click(opener);
    await screen.findByRole('dialog', { name: 'Result' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Install' }));
    await userEvent.keyboard('{Escape}');
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(opener);
  });

  it('closes from the backdrop only for a press that starts and ends there (WCAG 2.5.2)', async () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
    const backdrop = document.querySelector<HTMLElement>('.nv-dialog-backdrop')!;
    const field = screen.getByRole('textbox', { name: 'Reason' });
    // Selecting text in the field and releasing outside it: the click lands on the backdrop.
    fireEvent.mouseDown(field);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    // Pressing on the backdrop and moving into the dialog before release.
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(field);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    // A press down and up on the backdrop closes it.
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('uses the fallback when the opener is gone and focuses itself when empty', async () => {
    const target = document.createElement('button');
    document.body.append(target);
    function Gone() {
      const [shown, setShown] = useState(true);
      const [open, setOpen] = useState(false);
      return (
        <>
          {shown ? <Button onClick={() => setOpen(true)}>Open</Button> : null}
          <Dialog
            open={open}
            title="Empty"
            fallbackFocus={() => target}
            onClose={() => {
              setShown(false);
              setOpen(false);
            }}
          />
        </>
      );
    }
    render(<Gone />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    await userEvent.keyboard('{Escape}');
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(target);
    target.remove();
  });
});

describe('Menu', () => {
  const make = (log: string[]): MenuItem[] => [
    { id: 'rename', label: 'Rename', onSelect: () => log.push('rename') },
    { id: 'pin', label: 'Pin', onSelect: () => log.push('pin') },
    { id: 'off', label: 'Unavailable', onSelect: () => log.push('off'), disabled: true },
    { id: 'delete', label: 'Delete', onSelect: () => log.push('delete'), danger: true },
  ];

  it('opens from the button, moves with arrows, and selects with Enter', async () => {
    const log: string[] = [];
    render(<Menu label="More actions" items={make(log)} />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    await userEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard('{ArrowDown}');
    // The disabled item is skipped.
    expect(document.activeElement).toBe(items[3]);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('{End}{Enter}');
    expect(log).toEqual(['delete']);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('supports Home, type-ahead, ArrowUp to open at the end, and Esc to close', async () => {
    const log: string[] = [];
    render(<Menu label="More actions" items={make(log)} />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    trigger.focus();
    await userEvent.keyboard('{ArrowUp}');
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[3]);
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('p');
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard(' ');
    expect(log).toEqual(['pin']);
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click and on Tab; clicks select; disabled items do nothing', async () => {
    const log: string[] = [];
    render(
      <>
        <Menu label="More actions" items={make(log)} />
        <button>outside</button>
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Unavailable' }));
    expect(log).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(trigger);
    await userEvent.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(log).toEqual(['rename']);
  });

  it('can be controlled and placed at a point (context menu)', async () => {
    const onOpenChange = vi.fn();
    render(
      <Menu
        label="Chat actions"
        items={make([])}
        open
        at={{ x: 40, y: 50 }}
        onOpenChange={onOpenChange}
      />,
    );
    const menu = screen.getByRole('menu', { name: 'Chat actions' });
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.left).toBe('40px');
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('Tabs', () => {
  function Harness() {
    const [v, setV] = useState('a');
    return (
      <Tabs
        label="Inspector"
        value={v}
        onChange={setV}
        items={[
          { id: 'a', label: 'Artifacts', panel: <p>No artifacts</p> },
          { id: 'f', label: 'Files', panel: <p>No files</p> },
          { id: 's', label: 'Sources', panel: <p>No sources</p> },
        ]}
      />
    );
  }

  it('has one tab stop and moves selection with arrows, Home and End', async () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getByRole('tabpanel', { name: 'Artifacts' }).textContent).toBe('No artifacts');
    tabs[0]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Files' }));
    expect(screen.getByRole('tabpanel').textContent).toBe('No files');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Sources' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tabpanel').textContent).toBe('No artifacts');
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tabpanel').textContent).toBe('No sources');
    await userEvent.keyboard('{Home}x');
    expect(screen.getByRole('tabpanel').textContent).toBe('No artifacts');
    await userEvent.click(screen.getByRole('tab', { name: 'Files' }));
    expect(screen.getByRole('tabpanel').textContent).toBe('No files');
  });
});

describe('Tooltip', () => {
  it('shows on hover and focus, links aria-describedby, and hides on Escape', async () => {
    render(
      <Tooltip content="Ctrl+B">
        <button>Toggle sidebar</button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button', { name: 'Toggle sidebar' });
    const tip = document.getElementById(btn.getAttribute('aria-describedby')!)!;
    expect(tip.hidden).toBe(true);
    await userEvent.hover(btn);
    expect(tip.hidden).toBe(false);
    await userEvent.unhover(btn);
    expect(tip.hidden).toBe(true);
    act(() => btn.focus());
    expect(screen.getByRole('tooltip').textContent).toBe('Ctrl+B');
    await userEvent.keyboard('{Escape}');
    expect(tip.hidden).toBe(true);
    act(() => btn.blur());
  });

  it('stays while the pointer is on it and Esc dismisses it from anywhere (WCAG 1.4.13)', async () => {
    render(
      <>
        <Tooltip content="Ctrl+B">
          <button>Toggle sidebar</button>
        </Tooltip>
        <input aria-label="Elsewhere" />
      </>,
    );
    const btn = screen.getByRole('button', { name: 'Toggle sidebar' });
    const tip = document.getElementById(btn.getAttribute('aria-describedby')!)!;
    await userEvent.hover(btn);
    // Moving onto the tooltip keeps it (it is inside the anchor and takes the pointer).
    await userEvent.hover(tip);
    expect(tip.hidden).toBe(false);
    // Focus is elsewhere; Esc still closes what the pointer opened.
    act(() => screen.getByRole('textbox', { name: 'Elsewhere' }).focus());
    await userEvent.keyboard('{Escape}');
    expect(tip.hidden).toBe(true);
  });
});
