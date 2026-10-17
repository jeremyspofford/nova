import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { Button, IconButton, Kbd, Switch, TextField } from '../src/index.ts';

afterEach(cleanup);

describe('Button', () => {
  it('is a real button, keyboard-activatable, defaulting to type=button', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.getAttribute('type')).toBe('button');
    btn.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('does not fire when disabled and exposes its variant', async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" disabled onClick={onClick} className="extra">
        Go
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Go' });
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    expect(btn.dataset.variant).toBe('primary');
    expect(btn.className).toBe('nv-btn extra');
  });
});

describe('IconButton', () => {
  it('has an accessible name and hides the icon from assistive tech', () => {
    render(<IconButton label="Open settings" icon="⚙" />);
    const btn = screen.getByRole('button', { name: 'Open settings' });
    expect(btn.getAttribute('title')).toBe('Open settings');
    expect(btn.querySelector('[aria-hidden="true"]')?.textContent).toBe('⚙');
  });
});

describe('TextField', () => {
  it('labels the input and links hint and error text', () => {
    render(<TextField label="API key" hint="Stored in the keychain" error="Required" />);
    const input = screen.getByLabelText('API key');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = input.getAttribute('aria-describedby')!.split(' ');
    expect(described).toHaveLength(2);
    expect(screen.getByRole('alert').textContent).toBe('Required');
  });

  it('works without hint or error and accepts typing', async () => {
    render(<TextField label="Name" id="name" className="wide" />);
    const input = screen.getByLabelText<HTMLInputElement>('Name');
    expect(input.getAttribute('aria-describedby')).toBeNull();
    expect(input.className).toBe('nv-input wide');
    await userEvent.type(input, 'Nova');
    expect(input.value).toBe('Nova');
  });
});

describe('Kbd', () => {
  it('reads as a spoken key combination', () => {
    render(<Kbd keys={['Ctrl', 'K']} />);
    expect(screen.getByLabelText('Ctrl plus K')).toBeTruthy();
  });
});

describe('Switch', () => {
  function Harness() {
    const [on, setOn] = useState(false);
    return <Switch checked={on} onChange={setOn} label="Reduced motion" />;
  }

  it('toggles with click and keyboard and reports aria-checked', async () => {
    render(<Harness />);
    const sw = screen.getByRole('switch', { name: 'Reduced motion' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.focus();
    await userEvent.keyboard(' ');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });
});
