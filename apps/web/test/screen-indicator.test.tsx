// The global control indicator and Settings → Computer use (FR-207; docs/04 §2.8, §5): the pill
// shows only while Nova controls a computer, names the apps and the kill key, stops on Stop or the
// kill key, renews the grants, follows control events and grant expiry, and says when it appears
// and goes. Settings remap the kill key (never unbound), the grant length, the screenshot
// retention and app levels (lower only), and list active grants with Renew and Revoke.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerUseSettings, killKeyFromEvent } from '../src/screen/ComputerUseSettings.tsx';
import { ControlIndicator } from '../src/screen/ControlIndicator.tsx';
import { keyInput, liveFrame } from '../src/screen/LiveView.tsx';
import { keyCaps, remainingText, screenActionText } from '../src/screen/format.ts';
import { claimKill, killBinding } from '../src/screen/killkey.ts';
import {
  computerView,
  emitHub,
  fakeScreen,
  grantView,
  renderWithBrowser,
  screenActionView,
} from './fakes-m6-browser.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const two = () => ({
  computers: [computerView({ id: 'pc1' }), computerView({ id: 'pc2', kind: 'local_host' })],
  screens: {
    pc1: fakeScreen({ enabled: true, grants: [grantView({ id: 'g1', app: 'Spreadsheet' })] }),
    pc2: fakeScreen({ enabled: true }),
  },
});

describe('the control indicator', () => {
  it('shows nothing while nothing is controlled', async () => {
    const { fake } = await renderWithBrowser(<ControlIndicator />);
    await waitFor(() => expect(fake.api.screenStatus).toHaveBeenCalledWith('pc1'));
    expect(screen.queryByRole('region', { name: 'Computer control' })).toBeNull();
  });

  it('names the apps and the kill key, and stops with Stop', async () => {
    const open = vi.fn();
    const { fake } = await renderWithBrowser(<ControlIndicator onOpenComputer={open} />, {
      browser: two(),
    });
    const region = await screen.findByRole('region', { name: 'Computer control' });
    const pills = region.querySelectorAll('.scr-indicator');
    expect(pills).toHaveLength(1);
    expect(region.textContent).toContain('Nova is controlling Spreadsheet');
    expect(within(region).getByLabelText('Esc')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('announcer').textContent).toContain(
        'Nova is controlling Spreadsheet · Escape to stop.',
      ),
    );
    await userEvent.click(within(region).getByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenCalledWith('pc1');
    await userEvent.click(within(region).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(fake.api.killScreen).toHaveBeenCalledWith('pc1'));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Computer control' })).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByTestId('announcer').textContent).toContain(
        'Nova stopped controlling the screen.',
      ),
    );
  });

  it('stops every controlled computer on the kill key while it shows', async () => {
    const init = two();
    init.screens.pc2 = fakeScreen({
      enabled: true,
      grants: [grantView({ id: 'g2', computerId: 'pc2', app: 'Notes' })],
    });
    const { fake } = await renderWithBrowser(<ControlIndicator />, { browser: init });
    await screen.findByRole('region', { name: 'Computer control' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(fake.api.killScreen).toHaveBeenCalledTimes(2));
    expect(fake.api.killScreen.mock.calls.map((c) => c[0]).sort()).toEqual(['pc1', 'pc2']);
  });

  it('renews the grants of a computer', async () => {
    const { fake } = await renderWithBrowser(<ControlIndicator />, { browser: two() });
    const region = await screen.findByRole('region', { name: 'Computer control' });
    await userEvent.click(within(region).getByRole('button', { name: 'Renew' }));
    await waitFor(() => expect(fake.api.renewScreenGrant).toHaveBeenCalledWith('pc1', 'g1'));
  });

  it('appears when a control event says a computer is now controlled', async () => {
    const { state } = await renderWithBrowser(<ControlIndicator />, {
      browser: { screens: { pc1: fakeScreen({ enabled: true }) } },
    });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Computer control' })).toBeNull(),
    );
    state.screens.pc1!.grants = [grantView({ app: 'Mail' })];
    // Wait until the stream is open before the event.
    await waitFor(() =>
      expect(
        emitHub('screen.control.changed', {
          computerId: 'pc1',
          from: 'idle',
          state: 'controlling',
        }),
      ).toBeGreaterThan(0),
    );
    expect((await screen.findByRole('region', { name: 'Computer control' })).textContent).toContain(
      'Nova is controlling Mail',
    );
  });

  it('goes when the last grant runs out, without an event', async () => {
    const soon = new Date(Date.now() + 1_500).toISOString();
    await renderWithBrowser(<ControlIndicator />, {
      browser: {
        screens: {
          pc1: fakeScreen({ enabled: true, grants: [grantView({ app: 'Mail', expiresAt: soon })] }),
        },
      },
    });
    await screen.findByRole('region', { name: 'Computer control' });
    await waitFor(
      () => expect(screen.queryByRole('region', { name: 'Computer control' })).toBeNull(),
      { timeout: 6_000 },
    );
  });

  it('says when Stop failed and keeps showing', async () => {
    await renderWithBrowser(<ControlIndicator />, {
      browser: two(),
      fail: { killScreen: new Error('the device did not answer') },
    });
    const region = await screen.findByRole('region', { name: 'Computer control' });
    await userEvent.click(within(region).getByRole('button', { name: 'Stop' }));
    expect(
      await screen.findByText(/Could not stop computer use: the device did not answer/, {
        ignore: 'script, style, .nv-vh',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Computer control' })).toBeTruthy();
  });

  it('retries a failed load', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fake } = await renderWithBrowser(<ControlIndicator />, {
      browser: two(),
      fail: { listScreenComputers: new Error('offline') },
    });
    await waitFor(() => expect(fake.api.listScreenComputers).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(await screen.findByRole('region', { name: 'Computer control' })).toBeTruthy();
  });
});

describe('Settings → Computer use', () => {
  it('remaps the kill key by pressing it, and goes back to Esc', async () => {
    const { hub } = await renderWithBrowser(<ComputerUseSettings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Change the kill key' }));
    const rec = screen.getByRole('group', { name: 'Press the new kill key' });
    await waitFor(() => expect(document.activeElement).toBe(rec));
    await userEvent.keyboard('/');
    expect(screen.getByRole('alert').textContent).toContain('Use a letter, a digit or a named key');
    await userEvent.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    await waitFor(() => expect(hub.state.settings['screen.killKey']).toBe('ctrl+alt+k'));
    expect(screen.getByLabelText('Ctrl plus Alt plus K')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Use Esc' }));
    await waitFor(() => expect(hub.state.settings['screen.killKey']).toBe('Escape'));
  });

  it('saves the grant length and retention, and lowers app levels', async () => {
    const { hub } = await renderWithBrowser(<ComputerUseSettings />);
    const mins = await screen.findByLabelText('An app grant lasts (minutes)');
    await userEvent.clear(mins);
    await userEvent.type(mins, '2000');
    expect(screen.getByText('From 1 to 1440 minutes')).toBeTruthy();
    await userEvent.clear(mins);
    await userEvent.type(mins, '45');
    const forms = screen.getAllByRole('button', { name: 'Save' });
    await userEvent.click(forms[0]!);
    await waitFor(() => expect(hub.state.settings['screen.grantMinutes']).toBe(45));
    const days = screen.getByLabelText('Keep action screenshots for (days)');
    await userEvent.clear(days);
    await userEvent.type(days, '10');
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]!);
    await waitFor(() => expect(hub.state.settings['screen.screenshotRetentionDays']).toBe(10));
    expect(screen.getByText('No apps lowered.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('App'), 'Mail');
    await userEvent.selectOptions(screen.getByLabelText('Level'), 'view');
    await userEvent.click(screen.getByRole('button', { name: 'Lower' }));
    await waitFor(() =>
      expect(hub.state.settings['screen.tierOverrides']).toEqual({ Mail: 'view' }),
    );
    await userEvent.selectOptions(screen.getByLabelText('Level for Mail'), 'none');
    await waitFor(() =>
      expect(hub.state.settings['screen.tierOverrides']).toEqual({ Mail: 'none' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove Mail' }));
    await waitFor(() => expect(hub.state.settings['screen.tierOverrides']).toEqual({}));
  });

  it('shows managed locks', async () => {
    await renderWithBrowser(<ComputerUseSettings />, {
      managed: { 'screen.killKey': 'F12', 'screen.grantMinutes': 10 },
    });
    expect(await screen.findByLabelText('F12')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change the kill key' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('An app grant lasts (minutes)')).toHaveProperty('disabled', true);
  });

  it('lists active grants on every computer with Renew and Revoke', async () => {
    const { fake } = await renderWithBrowser(<ComputerUseSettings />, { browser: two() });
    const list = await screen.findByRole('list', { name: 'Active grants' });
    const row = within(list).getByRole('listitem', { name: 'Spreadsheet' });
    expect(row.textContent).toContain('Cloud computer');
    await userEvent.click(within(row).getByRole('button', { name: 'Renew Spreadsheet' }));
    await waitFor(() => expect(fake.api.renewScreenGrant).toHaveBeenCalledWith('pc1', 'g1'));
    await userEvent.click(within(row).getByRole('button', { name: 'Revoke Spreadsheet' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }),
    );
    await waitFor(() => expect(fake.api.revokeScreenGrant).toHaveBeenCalledWith('pc1', 'g1'));
    expect(await screen.findByText('None. Nova asks before it controls an app.')).toBeTruthy();
  });
});

describe('helpers', () => {
  it('maps key presses to live input', () => {
    const k = (
      key: string,
      mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>> = {},
    ) => ({
      key,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      ...mods,
    });
    expect(keyInput(k('a'), 'desktop')).toEqual({ kind: 'type', text: 'a' });
    expect(keyInput(k('A', { shiftKey: true }), 'desktop')).toEqual({ kind: 'type', text: 'A' });
    expect(keyInput(k('Enter'), 'desktop')).toEqual({ kind: 'key', keys: 'Enter' });
    expect(keyInput(k('s', { ctrlKey: true }), 'desktop')).toEqual({ kind: 'key', keys: 'ctrl+s' });
    expect(keyInput(k('s', { ctrlKey: true }), 'browser')).toEqual({
      kind: 'key',
      keys: 'Control+s',
    });
    expect(keyInput(k('Tab'), 'desktop')).toBeNull();
    expect(keyInput(k('Escape'), 'desktop')).toBeNull();
    expect(keyInput(k('Shift', { shiftKey: true }), 'desktop')).toBeNull();
    expect(keyInput(k('/', { ctrlKey: true }), 'desktop')).toBeNull();
    expect(liveFrame({ kind: 'key', keys: 'Enter' }, 'browser')).toEqual({
      type: 'input',
      browser: { kind: 'key', key: 'Enter' },
    });
    expect(liveFrame({ kind: 'scroll', x: 1, y: 2, dy: 3 }, 'browser')).toEqual({
      type: 'input',
      browser: { kind: 'scroll', dy: 3 },
    });
  });

  it('formats keys, times and actions, and claims a kill once per computer', () => {
    expect(keyCaps('Escape')).toEqual(['Esc']);
    expect(keyCaps('ctrl alt k')).toEqual(['Ctrl', 'Alt', 'K']);
    expect(killBinding('ctrl alt k', false)).toBe('mod+alt+k');
    expect(killBinding('Escape', true)).toBe('escape');
    expect(remainingText(0)).toBe('Expired');
    expect(remainingText(45)).toBe('45 s left');
    expect(remainingText(7200)).toBe('2 h left');
    expect(screenActionText(screenActionView({ kind: 'drag', args: {} }))).toBe('Drag');
    expect(screenActionText(screenActionView({ kind: 'type', args: { chars: 1 } }))).toBe(
      'Type 1 character',
    );
    expect(
      screenActionText(screenActionView({ kind: 'click', args: { x: 1, y: 2, button: 'right' } })),
    ).toBe('Right-click at (1, 2)');
    const e = new Event('keydown');
    expect(claimKill(e, 'pc1')).toBe(true);
    expect(claimKill(e, 'pc1')).toBe(false);
    expect(claimKill(e, 'pc2')).toBe(true);
    expect(
      killKeyFromEvent({
        key: 'F12',
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBe('F12');
    expect(
      killKeyFromEvent({
        key: 'Control',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toBeNull();
  });
});
