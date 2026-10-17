// The computer-use panel (FR-093, FR-207, FR-087, FR-098, FR-075; docs/04 §2.8): enabling asks
// first; while Nova controls apps the indicator shows with a big Stop, and the kill key stops it
// anywhere in the app (once, even with the global indicator listening too); Resume brings control
// back. Grants show the grant prompt, refuse apps Nova never controls, renew and revoke; the
// recorded actions show before/after screenshots and typed text only as a length; takeover opens
// the live view with input and returns control; appshots are captured and opened.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlIndicator } from '../src/screen/ControlIndicator.tsx';
import { ScreenPanel } from '../src/screen/ScreenPanel.tsx';
import {
  PNG_1X1,
  appshotView,
  computerView,
  emitHub,
  fakeScreen,
  grantView,
  renderWithBrowser,
  screenActionView,
  windowView,
} from './fakes-m6-browser.ts';
import { FakeSocket } from './fakes.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const SEEN = { ignore: 'script, style, .nv-vh' };

const controlling = () =>
  fakeScreen({ enabled: true, grants: [grantView({ id: 'g1', app: 'Spreadsheet' })] });

describe('control state and the kill key', () => {
  it('turns computer use on only after a confirmation, and off directly', async () => {
    const { fake, state } = await renderWithBrowser(<ScreenPanel computerId="pc1" />);
    expect(await screen.findByText('Computer use off')).toBeTruthy();
    expect(screen.getByText(/Nobody: computer use is off/)).toBeTruthy();
    const sw = screen.getByRole('switch', { name: 'Allow computer use on this computer' });
    await userEvent.click(sw);
    const dialog = screen.getByRole('dialog', { name: 'Turn on computer use?' });
    expect(dialog.textContent).toContain('never controls system settings');
    expect(fake.api.setScreenControl).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(fake.api.setScreenControl).toHaveBeenCalledWith('pc1', true));
    expect(await screen.findByText('On, no apps allowed')).toBeTruthy();
    expect(state.screens.pc1!.enabled).toBe(true);
    await userEvent.click(sw);
    await waitFor(() => expect(fake.api.setScreenControl).toHaveBeenLastCalledWith('pc1', false));
    expect(await screen.findByText('Computer use off')).toBeTruthy();
  });

  it('shows the indicator while Nova controls apps; Stop stops it and Resume brings it back', async () => {
    const { fake } = await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: controlling() } },
    });
    const banner = await screen.findByRole('group', { name: 'Control indicator' });
    expect(banner.textContent).toContain('Nova is controlling Spreadsheet · Escape to stop');
    await userEvent.click(within(banner).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(fake.api.killScreen).toHaveBeenCalledWith('pc1'));
    const stopped = await screen.findByRole('group', { name: 'Control stopped' });
    expect(screen.queryByRole('group', { name: 'Control indicator' })).toBeNull();
    await userEvent.click(within(stopped).getByRole('button', { name: 'Resume control' }));
    await waitFor(() => expect(fake.api.resumeScreen).toHaveBeenCalledWith('pc1'));
    expect(await screen.findByRole('group', { name: 'Control indicator' })).toBeTruthy();
  });

  it('stops on the kill key anywhere in the app, once, even with the global indicator mounted', async () => {
    const { fake } = await renderWithBrowser(
      <>
        <ControlIndicator />
        <input aria-label="Elsewhere" />
        <ScreenPanel computerId="pc1" />
      </>,
      { browser: { screens: { pc1: controlling() } } },
    );
    await screen.findByRole('group', { name: 'Control indicator' });
    await screen.findByRole('region', { name: 'Computer control' });
    screen.getByLabelText('Elsewhere').focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(fake.api.killScreen).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('group', { name: 'Control stopped' })).toBeTruthy();
    // No longer controlling: the key does nothing more.
    await userEvent.keyboard('{Escape}');
    expect(fake.api.killScreen).toHaveBeenCalledTimes(1);
  });

  it('uses a remapped kill key', async () => {
    const { fake } = await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: controlling() } },
      settings: { 'screen.killKey': 'ctrl+alt+k' },
    });
    const banner = await screen.findByRole('group', { name: 'Control indicator' });
    expect(
      within(banner).getByRole('button', { name: 'Stop' }).getAttribute('aria-keyshortcuts'),
    ).toBe('Control+Alt+K');
    await userEvent.keyboard('{Escape}');
    expect(fake.api.killScreen).not.toHaveBeenCalled();
    await userEvent.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');
    await waitFor(() => expect(fake.api.killScreen).toHaveBeenCalledTimes(1));
  });

  it('says when Stop failed so the user presses it again', async () => {
    await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: controlling() } },
      fail: { killScreen: new Error('the device did not answer') },
    });
    const banner = await screen.findByRole('group', { name: 'Control indicator' });
    await userEvent.click(within(banner).getByRole('button', { name: 'Stop' }));
    expect(
      await screen.findByText(
        /Could not stop computer use: the device did not answer Press Stop again\./,
        SEEN,
      ),
    ).toBeTruthy();
  });

  it('follows control events for this computer', async () => {
    const { state } = await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: fakeScreen({ enabled: true }) } },
    });
    await screen.findByText('On, no apps allowed');
    state.screens.pc1!.grants = [grantView({ app: 'Notes' })];
    emitHub('screen.grant.changed', {
      computerId: 'pc1',
      grantId: 'x',
      app: 'Notes',
      status: 'active',
    });
    expect(await screen.findByRole('group', { name: 'Control indicator' })).toBeTruthy();
  });

  it('says when the computer does not exist', async () => {
    await renderWithBrowser(<ScreenPanel computerId="gone" />);
    expect(await screen.findByText('This computer does not exist or was removed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('grants', () => {
  it('lists allowed apps with time left; renews and revokes after a confirmation', async () => {
    const { fake, state } = await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: controlling() } },
    });
    const list = await screen.findByRole('list', { name: 'Allowed apps' });
    const row = within(list).getByRole('listitem', { name: 'Spreadsheet' });
    expect(row.textContent).toContain('Full control');
    expect(row.textContent).toMatch(/(29|30) min left/);
    await userEvent.click(within(row).getByRole('button', { name: 'Renew Spreadsheet' }));
    await waitFor(() => expect(fake.api.renewScreenGrant).toHaveBeenCalledWith('pc1', 'g1'));
    await userEvent.click(within(row).getByRole('button', { name: 'Revoke Spreadsheet' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke Spreadsheet?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(fake.api.revokeScreenGrant).toHaveBeenCalledWith('pc1', 'g1'));
    expect(await screen.findByText('No apps allowed right now.')).toBeTruthy();
    expect(state.screens.pc1!.grants[0]!.revokedAt).not.toBeNull();
    // Past grants show on request.
    await userEvent.click(screen.getByRole('button', { name: 'Show past grants' }));
    expect((await screen.findByRole('list', { name: 'Past grants' })).textContent).toContain(
      'Spreadsheet: revoked',
    );
  });

  it('asks with the grant prompt before allowing an app', async () => {
    const { fake } = await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: fakeScreen({ enabled: true }) } },
      settings: { 'screen.grantMinutes': 20 },
    });
    await userEvent.type(await screen.findByLabelText('App to allow'), 'Spreadsheet');
    expect(screen.getByLabelText<HTMLInputElement>('Minutes').value).toBe('20');
    await userEvent.click(screen.getByRole('button', { name: 'Allow…' }));
    const dialog = screen.getByRole('dialog', { name: 'Allow Nova to control “Spreadsheet”?' });
    expect(dialog.textContent).toContain('20 minutes after you allow');
    expect(dialog.textContent).toContain('Stop at any time');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow for 20 min' }));
    await waitFor(() =>
      expect(fake.api.grantScreenApp).toHaveBeenCalledWith('pc1', {
        app: 'Spreadsheet',
        minutes: 20,
      }),
    );
    expect(await screen.findByRole('group', { name: 'Control indicator' })).toBeTruthy();
  });

  it('refuses apps Nova never controls, with the reason', async () => {
    const { fake } = await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: fakeScreen({ enabled: true }) } },
    });
    await userEvent.type(await screen.findByLabelText('App to allow'), 'Banking');
    await userEvent.click(screen.getByRole('button', { name: 'Allow…' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Allow for/ }),
    );
    await waitFor(() => expect(fake.api.grantScreenApp).toHaveBeenCalled());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Banking is never controlled by Nova; do this step yourself.',
    );
  });

  it('shows the apps on screen with their level; an app handled by the user cannot be allowed', async () => {
    const { fake } = await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: {
        screens: {
          pc1: fakeScreen({
            enabled: true,
            windows: [
              windowView({ id: 'w1', app: 'Spreadsheet', title: 'Q3 <script>', focused: true }),
              windowView({ id: 'w2', app: 'Terminal', title: 'zsh' }),
              windowView({ id: 'w3', app: 'Password Manager', title: 'Vault' }),
            ],
          }),
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'See apps on screen' }));
    const list = await screen.findByRole('list', { name: 'Apps on screen' });
    expect(within(list).getByText('Q3 <script>')).toBeTruthy();
    const term = within(list).getByRole('listitem', { name: 'Terminal' });
    expect(term.textContent).toContain('Click only');
    const vault = within(list).getByRole('listitem', { name: 'Password Manager' });
    expect(vault.textContent).toContain('No control (you do it)');
    expect(within(vault).queryByRole('button')).toBeNull();
    // Typing a never-controlled app from the list is refused before asking the Hub.
    await userEvent.type(screen.getByLabelText('App to allow'), 'Password Manager');
    await userEvent.click(screen.getByRole('button', { name: 'Allow…' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Password Manager is never controlled by Nova',
    );
    expect(fake.api.grantScreenApp).not.toHaveBeenCalled();
    await userEvent.click(within(term).getByRole('button', { name: 'Allow Terminal…' }));
    expect(screen.getByRole('dialog').textContent).toContain('Click only');
  });

  it('says when the computer has no controlled desktop', async () => {
    await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: fakeScreen({ desktop: false }) } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'See apps on screen' }));
    expect(
      await screen.findByText(/This computer has no controlled desktop, so there is no screen/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'See apps on screen' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('recorded actions', () => {
  it('lists actions newest first, never typed text, with before/after screenshots', async () => {
    await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: {
        screens: {
          pc1: fakeScreen({
            actions: [
              screenActionView({ id: 'sa01' }),
              screenActionView({
                id: 'sa02',
                kind: 'type',
                args: { kind: 'type', chars: 5 },
                hasAfter: false,
              }),
              screenActionView({
                id: 'sa03',
                kind: 'key',
                args: { kind: 'key', keys: 'ctrl+s' },
                status: 'refused',
                error: { code: 'screen_tier', message: 'terminal is click only for computer use' },
                hasBefore: false,
                hasAfter: false,
                actor: 'user',
                origin: 'takeover',
              }),
            ],
          }),
        },
      },
    });
    const list = await screen.findByRole('list', { name: 'Screen actions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.activity-title')!.textContent)).toEqual([
      'Press Ctrl+S in Spreadsheet',
      'Type 5 characters in Spreadsheet',
      'Click at (120, 40) in Spreadsheet',
    ]);
    expect(rows[0]!.textContent).toContain('Refused');
    expect(rows[0]!.textContent).toContain('You (takeover)');
    await userEvent.click(within(rows[0]!).getByRole('button'));
    expect(within(rows[0]!).getByText('Terminal is click only for computer use.')).toBeTruthy();
    expect(within(rows[0]!).getByText(/Nothing was sent/)).toBeTruthy();
    await userEvent.click(within(rows[1]!).getByRole('button'));
    expect(
      within(rows[1]!).getByRole('img', { name: 'Before: Type 5 characters' }).getAttribute('src'),
    ).toBe('/api/v1/computers/pc1/screen/actions/sa02/before');
    expect(within(rows[1]!).queryByRole('img', { name: /After/ })).toBeNull();
  });

  it('pages back with Show older and follows new actions', async () => {
    const actions = Array.from({ length: 55 }, (_, i) =>
      screenActionView({ id: `sa${String(i).padStart(3, '0')}` }),
    );
    const { state } = await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: fakeScreen({ actions }) } },
    });
    const list = await screen.findByRole('list', { name: 'Screen actions' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(55));
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
    state.screens.pc1!.actions.push(
      screenActionView({ id: 'sa999', kind: 'scroll', args: { dy: -3 } }),
    );
    emitHub('screen.action', { computerId: 'pc1', actionId: 'sa999' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(56));
    expect(within(list).getAllByRole('listitem')[0]!.textContent).toContain('Scroll up');
  });

  it('explains an empty list', async () => {
    await renderWithBrowser(<ScreenPanel computerId="pc1" />);
    expect(await screen.findByText(/No screen actions yet/)).toBeTruthy();
  });
});

describe('takeover', () => {
  it('takes over with a live view that sends input, then returns control', async () => {
    const { fake, state } = await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: controlling() } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(fake.api.startTakeover).toHaveBeenCalledWith('pc1', 'desktop'));
    const takeover = await screen.findByRole('group', { name: 'Takeover' });
    expect(takeover.textContent).toContain('You have control.');
    expect(screen.queryByRole('group', { name: 'Control indicator' })).toBeNull();
    const ws = FakeSocket.for('/api/v1/computers/pc1/screen/live?surface=desktop');
    ws.open();
    ws.frame({
      type: 'state',
      status: await fake.api.screenStatus('pc1'),
    });
    ws.frame({
      type: 'frame',
      surface: 'desktop',
      width: 1280,
      height: 800,
      image: PNG_1X1,
      takenAt: '2026-10-01T12:00:00.000Z',
    });
    const img = await screen.findByRole('img', { name: "Live view of the computer's screen" });
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 10,
      width: 640,
      height: 400,
      right: 650,
      bottom: 410,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    });
    fireEvent.click(img, { clientX: 330, clientY: 210 });
    expect(ws.sent).toContainEqual({ type: 'input', action: { kind: 'click', x: 640, y: 400 } });
    fireEvent.contextMenu(img, { clientX: 10, clientY: 10 });
    expect(ws.sent).toContainEqual({
      type: 'input',
      action: { kind: 'click', x: 0, y: 0, button: 'right' },
    });
    // Typing while the frame has focus goes to the computer, batched; keys are pressed.
    const frame = screen.getByLabelText(/Typing here goes to the computer/);
    frame.focus();
    await userEvent.keyboard('hi');
    await userEvent.keyboard('{Control>}s{/Control}');
    expect(ws.sent).toContainEqual({ type: 'input', action: { kind: 'type', text: 'hi' } });
    expect(ws.sent).toContainEqual({ type: 'input', action: { kind: 'key', keys: 'ctrl+s' } });
    await userEvent.click(screen.getByRole('button', { name: 'Esc' }));
    expect(ws.sent).toContainEqual({ type: 'input', action: { kind: 'key', keys: 'Escape' } });
    await userEvent.click(screen.getByRole('button', { name: 'Scroll down' }));
    expect(ws.sent).toContainEqual({
      type: 'input',
      action: { kind: 'scroll', x: 640, y: 400, dy: 300 },
    });
    // A refused input says why.
    ws.frame({ type: 'input.ack', ok: false, error: 'the window closed' });
    expect(await screen.findByText('The input did not work: The window closed.')).toBeTruthy();
    // Return control.
    await userEvent.click(within(takeover).getByRole('button', { name: 'Return control' }));
    await waitFor(() => expect(fake.api.endTakeover).toHaveBeenCalledWith('pc1'));
    expect(state.screens.pc1!.takeover).toBeNull();
    expect(await screen.findByRole('group', { name: 'Control indicator' })).toBeTruthy();
    expect(ws.closed).toBe(true);
  });

  it('watches live without taking over, and says when the view disconnects', async () => {
    await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: controlling() } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Watch live' }));
    const ws = FakeSocket.for('/screen/live?surface=desktop');
    ws.open();
    ws.frame({
      type: 'frame',
      surface: 'desktop',
      width: 10,
      height: 10,
      image: PNG_1X1,
      takenAt: '2026-10-01T12:00:00.000Z',
    });
    const img = await screen.findByRole('img', { name: "Live view of the computer's screen" });
    fireEvent.click(img, { clientX: 1, clientY: 1 });
    expect(ws.sent).toEqual([]);
    expect(screen.queryByLabelText('Type text')).toBeNull();
    ws.frame({
      type: 'error',
      error: { code: 'conflict', message: 'the screen could not be read' },
    });
    expect(await screen.findByText('The screen could not be read.')).toBeTruthy();
    ws.drop();
    expect(await screen.findByText('The live view is disconnected.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(FakeSocket.all.filter((s) => s.url.includes('/screen/live'))).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Close live view' }));
    expect(screen.queryByRole('img', { name: "Live view of the computer's screen" })).toBeNull();
  });

  it('says why a takeover was refused', async () => {
    await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: fakeScreen({ desktop: false }) } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    expect(
      await screen.findByText(
        'Could not take over: This computer has no controlled desktop.',
        SEEN,
      ),
    ).toBeTruthy();
  });

  it('shows a takeover of the browser with Return control', async () => {
    await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: {
        screens: {
          pc1: fakeScreen({
            takeover: {
              id: 't1',
              computerId: 'pc1',
              surface: 'browser',
              startedBy: 'user',
              startedAt: '2026-10-01T12:00:00.000Z',
              endedAt: null,
              endReason: null,
              inputCount: 0,
            },
          }),
        },
      },
    });
    const group = await screen.findByRole('group', { name: 'Takeover' });
    expect(group.textContent).toContain('You have the agent browser.');
    // The banner says who has control; the line under it does not repeat it.
    expect(document.querySelector('.scr-who')).toBeNull();
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe('appshots', () => {
  it('captures a window and opens it', async () => {
    const { fake } = await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: {
        screens: {
          pc1: fakeScreen({ windows: [windowView({ app: 'Spreadsheet', focused: true })] }),
        },
        appshots: [
          appshotView({ id: 'old', app: 'Notes', windowTitle: 'todo', capturedBy: 'agent:ag1' }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: 'Appshots' });
    expect(within(list).getByRole('listitem', { name: 'Notes – todo' }).textContent).toContain(
      'By Nova',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Take appshot' }));
    await waitFor(() =>
      expect(fake.api.captureAppshot).toHaveBeenCalledWith('pc1', { source: 'window' }),
    );
    const row = await within(list).findByRole('listitem', { name: 'Spreadsheet – Expenses.xlsx' });
    const img = within(row).getByRole('img', { name: 'Appshot: Spreadsheet – Expenses.xlsx' });
    expect(img.getAttribute('src')).toMatch(/^\/api\/v1\/artifacts\/.+\/content$/);
    const open = within(row).getByRole('link', { name: 'Open image' });
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    await userEvent.click(within(row).getByRole('button', { name: 'Hide' }));
    expect(within(row).queryByRole('img')).toBeNull();
  });

  it('says why an appshot could not be taken', async () => {
    await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: { screens: { pc1: fakeScreen({ browser: false }) } },
    });
    await userEvent.selectOptions(await screen.findByLabelText('Capture'), 'browser');
    expect(screen.queryByLabelText('App')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Take appshot' }));
    expect(await screen.findByText('This computer has no browser.')).toBeTruthy();
    expect(await screen.findByText('No appshots of this computer yet.')).toBeTruthy();
  });
});

describe('the fake follows the Hub', () => {
  it('refuses what the Hub refuses', async () => {
    const { fake } = await renderWithBrowser(<div />, {
      browser: { computers: [computerView({ id: 'pc1' })], screens: { pc1: controlling() } },
    });
    const api = fake.api;
    await expect(api.screenStatus('nope')).rejects.toMatchObject({ status: 404 });
    await expect(api.grantScreenApp('pc1', { app: 'System Settings' })).rejects.toMatchObject({
      status: 403,
      body: { code: 'policy_denied' },
    });
    // Granting an app again renews its grant.
    const again = await api.grantScreenApp('pc1', { app: 'spreadsheet' });
    expect(again.id).toBe('g1');
    await api.revokeScreenGrant('pc1', 'g1');
    await expect(api.renewScreenGrant('pc1', 'g1')).rejects.toMatchObject({ status: 409 });
    await expect(api.endTakeover('pc1')).rejects.toMatchObject({ status: 409 });
    await expect(
      api.takeoverInput('pc1', { action: { kind: 'type', text: 'x' } }),
    ).rejects.toMatchObject({
      status: 409,
    });
    await api.startTakeover('pc1', 'desktop');
    await expect(api.startTakeover('pc1', 'browser')).rejects.toMatchObject({ status: 409 });
    await expect(
      api.takeoverInput('pc1', { browser: { kind: 'type', text: 'x' } }),
    ).rejects.toMatchObject({ status: 400 });
    await act(async () => {
      expect((await api.screenStatus('pc1')).state).toBe('taken_over');
    });
  });
});
