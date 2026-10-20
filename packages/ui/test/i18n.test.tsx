// The design system in the pseudo-locales (FR-016): every word a component writes itself comes
// from messages; the caller's labels are fixture data here.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { setLocale } from '@nova/i18n';
import { findUnlocalized } from '@nova/i18n/testing';
import {
  ColorField,
  KEY_TEXT,
  Kbd,
  MANAGED_TEXT,
  PresetScale,
  RadioGroup,
  SelectField,
  StatusChip,
  ToastProvider,
  UI_TEXT,
  spokenKeys,
  useToast,
} from '../src/index.ts';

afterEach(() => {
  cleanup();
  setLocale('en');
});

const DATA = ['Accent', 'Theme', 'Model', 'Fast', 'Smart', 'Saved', 'waiting on Pat', 'Mode'];

function ShowToast() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show('Saved', { tone: 'error' })}>
      {UI_TEXT.notifications}
    </button>
  );
}

function Gallery() {
  return (
    <ToastProvider>
      <Kbd keys={['Ctrl', 'Shift', 'P']} />
      <Kbd keys={['⌘', 'Esc']} />
      <StatusChip status="needs_input" reason="waiting on Pat" />
      <StatusChip status="blocked" compact />
      <StatusChip status="running" />
      <StatusChip status="ready" />
      <ColorField
        label="Accent"
        value="#12345"
        fallback="#000000"
        onChange={() => undefined}
        onReset={() => undefined}
        locked
      />
      <SelectField label="Theme" value="a" onChange={() => undefined} options={[]} locked />
      <RadioGroup legend="Mode" name="m" value="" options={[]} onChange={() => undefined} locked />
      <PresetScale
        label="Model"
        options={[
          { value: 'f', label: 'Fast' },
          { value: 's', label: 'Smart' },
        ]}
        value="f"
        onChange={() => undefined}
      />
      <ShowToast />
    </ToastProvider>
  );
}

describe('packages/ui in a pseudo-locale', () => {
  it('writes no English of its own in en-XA', async () => {
    setLocale('en-XA');
    const { container } = render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: UI_TEXT.notifications }));
    expect(findUnlocalized(container, { data: DATA })).toEqual([]);
    // The toast region and its dismiss button live in the same container.
    expect(screen.getByRole('button', { name: UI_TEXT.dismissNotification })).toBeTruthy();
    expect(screen.getAllByText(UI_TEXT.managed)).toHaveLength(3);
  });

  it('writes no English of its own in ar-XB', () => {
    setLocale('ar-XB');
    const { container } = render(<Gallery />);
    expect(findUnlocalized(container, { data: DATA })).toEqual([]);
  });

  it('names key combinations in the locale, keeping English unchanged', () => {
    expect(spokenKeys(['Ctrl', 'Alt', 'N'])).toBe('Ctrl plus Alt plus N');
    expect(spokenKeys(['⌃', '⌥', 'N'])).toBe('⌃ plus ⌥ plus N');
    expect(spokenKeys([])).toBe('');
    setLocale('en-XA');
    const spoken = spokenKeys(['Ctrl', 'K']);
    expect(spoken).toContain(KEY_TEXT.ctrl);
    expect(spoken.replace(/K/g, '')).not.toMatch(/[A-Za-z]/);
  });

  it('keeps MANAGED_TEXT following the locale', () => {
    expect(MANAGED_TEXT).toBe('Managed by your organization');
    act(() => setLocale('en-XA'));
    expect(MANAGED_TEXT).toBe(UI_TEXT.managed);
    expect(MANAGED_TEXT).not.toMatch(/[A-Za-z]/);
  });
});
