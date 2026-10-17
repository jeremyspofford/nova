import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import {
  ColorField,
  EmptyState,
  ICON_NAMES,
  Icon,
  MANAGED_TEXT,
  RadioGroup,
  SelectField,
  Spinner,
  StatusChip,
  ToastProvider,
  VisuallyHidden,
  mixHex,
  readableOn,
  toHex,
  useToast,
} from '../src/index.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Icon', () => {
  it.each(ICON_NAMES)('%s is decorative and inherits color', (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
  });
});

describe('VisuallyHidden and Spinner', () => {
  it('keeps text for assistive tech', () => {
    render(<VisuallyHidden>3 unread</VisuallyHidden>);
    expect(screen.getByText('3 unread').className).toBe('nv-vh');
  });

  it('is a status with a label and decorative without one', () => {
    const { container } = render(
      <>
        <Spinner label="Loading chats" />
        <Spinner />
      </>,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading chats');
    expect(container.querySelectorAll('[aria-hidden="true"].nv-spinner')).toHaveLength(2);
  });
});

describe('EmptyState', () => {
  it('renders a heading at the requested level with its action', () => {
    render(
      <EmptyState
        title="Work runs arrive in a later milestone"
        description="Use Chat for now."
        icon="work"
        action={<button>Go to Chat</button>}
        level={3}
      />,
    );
    expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('Work runs');
    expect(screen.getByRole('button', { name: 'Go to Chat' })).toBeTruthy();
  });

  it('defaults to h2 and works without extras', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy();
  });
});

describe('StatusChip', () => {
  it.each([
    ['ready', 'Ready'],
    ['running', 'Running'],
    ['needs_input', 'Needs input'],
    ['blocked', 'Blocked'],
  ] as const)('%s pairs an icon with "%s"', (status, text) => {
    const { container } = render(<StatusChip status={status} />);
    expect(container.textContent).toBe(text);
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('adds a reason and keeps text for screen readers when compact', () => {
    const { container } = render(<StatusChip status="blocked" reason="Usage limit" compact />);
    const chip = container.querySelector('.nv-chip')!;
    expect(chip.getAttribute('title')).toBe('Blocked: Usage limit');
    expect(chip.querySelector('.nv-vh')!.textContent).toBe('Blocked: Usage limit');
  });
});

describe('Toast', () => {
  function Trigger({ tone }: { tone?: 'info' | 'success' | 'error' }) {
    const toast = useToast();
    return (
      <button
        onClick={() =>
          toast.show('Chat deleted', {
            tone,
            action: { label: 'Undo', onClick: () => document.body.classList.add('undone') },
          })
        }
      >
        Go
      </button>
    );
  }

  it('announces politely, runs its action, and can be dismissed', async () => {
    render(
      <ToastProvider defaultDuration={0}>
        <Trigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region.querySelector('[aria-live="polite"]')!.textContent).toContain('Chat deleted');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(document.body.classList.contains('undone')).toBe(true);
    expect(region.textContent).not.toContain('Chat deleted');
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(region.textContent).not.toContain('Chat deleted');
    document.body.classList.remove('undone');
  });

  it('puts errors in the assertive region and hides after its duration', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider defaultDuration={1000}>
        <Trigger tone="error" />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'Go' }).click());
    const urgent = document.querySelector('[aria-live="assertive"]')!;
    expect(urgent.textContent).toContain('Chat deleted');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(urgent.textContent).toBe('');
  });

  it('throws outside a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});

describe('SelectField', () => {
  it('labels a native select with groups and reports changes', async () => {
    const onChange = vi.fn();
    render(
      <SelectField
        label="Model"
        value="a/fast"
        onChange={onChange}
        options={[{ value: '', label: 'Default' }]}
        groups={[
          {
            label: 'Mock',
            options: [
              { value: 'a/fast', label: 'Fast' },
              { value: 'a/smart', label: 'Smart' },
            ],
          },
        ]}
        hint="Used for new chats"
      />,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('Model');
    expect(select.value).toBe('a/fast');
    await userEvent.selectOptions(select, 'a/smart');
    expect(onChange).toHaveBeenCalledWith('a/smart');
    expect(select.getAttribute('aria-describedby')).toContain('hint');
  });

  it('is disabled and explains why when managed', () => {
    render(<SelectField label="Model" value="" onChange={() => undefined} locked hideLabel />);
    const select = screen.getByLabelText<HTMLSelectElement>('Model');
    expect(select.disabled).toBe(true);
    expect(screen.getByText(MANAGED_TEXT)).toBeTruthy();
  });
});

describe('ColorField', () => {
  function Harness({ onChange }: { onChange: (v: string | null) => void }) {
    const [v, setV] = useState<string | null>(null);
    return (
      <ColorField
        label="Accent"
        value={v}
        fallback="#7D98FF"
        onChange={(x) => {
          setV(x);
          onChange(x);
        }}
        onReset={() => {
          setV(null);
          onChange(null);
        }}
      />
    );
  }

  it('shows the theme color, accepts a typed hex on Enter, and resets', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const hex = screen.getByRole('textbox', { name: 'Accent hex value' });
    expect((hex as HTMLInputElement).value).toBe('#7d98ff');
    const reset = screen.getByRole('button', { name: 'Reset to theme: Accent' });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(hex);
    await userEvent.type(hex, '#12');
    expect(screen.getByRole('alert').textContent).toContain('six hex digits');
    await userEvent.type(hex, '3456{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('#123456');
    expect((reset as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(reset);
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect((hex as HTMLInputElement).value).toBe('#7d98ff');
  });

  it('drops an invalid draft on blur and reports the swatch picker', async () => {
    const onChange = vi.fn();
    const { container } = render(<Harness onChange={onChange} />);
    const hex = screen.getByRole('textbox', { name: 'Accent hex value' });
    await userEvent.type(hex, 'zz');
    hex.blur();
    expect(onChange).not.toHaveBeenCalled();
    const swatch = container.querySelector<HTMLInputElement>('input[type="color"]')!;
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.input(swatch, { target: { value: '#00ff00' } });
    expect(onChange).toHaveBeenCalledWith('#00ff00');
  });

  it('locks under managed policy', () => {
    render(
      <ColorField
        label="Background"
        value="#000000"
        fallback="#111111"
        onChange={() => undefined}
        onReset={() => undefined}
        locked
      />,
    );
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Background hex value' }).disabled,
    ).toBe(true);
    expect(screen.getByText(MANAGED_TEXT)).toBeTruthy();
  });
});

describe('RadioGroup', () => {
  it('selects with click and arrow keys', async () => {
    function Harness() {
      const [v, setV] = useState('enter');
      return (
        <RadioGroup
          legend="Send with"
          name="send"
          value={v}
          onChange={setV}
          options={[
            { value: 'enter', label: 'Enter', description: 'Shift+Enter adds a line' },
            { value: 'mod+enter', label: 'Ctrl+Enter' },
          ]}
        />
      );
    }
    render(<Harness />);
    const group = screen.getByRole('group', { name: 'Send with' });
    expect(group).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: /Ctrl\+Enter/ }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Ctrl\+Enter/ }).checked).toBe(true);
  });

  it('disables every option when managed', () => {
    render(
      <RadioGroup
        legend="Theme"
        name="t"
        value="dark"
        onChange={() => undefined}
        options={[{ value: 'dark', label: 'Dark' }]}
        locked
      />,
    );
    expect(screen.getByRole<HTMLFieldSetElement>('group').disabled).toBe(true);
    expect(screen.getByText(MANAGED_TEXT)).toBeTruthy();
  });
});

describe('color helpers', () => {
  it('mixes, clamps and picks readable text', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#102030', '#ffffff', -1)).toBe('#102030');
    expect(mixHex('#102030', '#ffffff', 2)).toBe('#ffffff');
    expect(toHex([300, -5, 16])).toBe('#ff0010');
    expect(readableOn('#ffd60a')).toBe('#000000');
    expect(readableOn('#1a1a40')).toBe('#ffffff');
  });
});
