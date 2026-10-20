// Computer use in the pseudo-locale (FR-016): the screen panel (control state, apps on screen,
// grants, recorded actions, appshots, the live view and the turn-on dialog), the control
// indicator and Settings → Computer use. App names, window titles, the Hub's refusals and the key
// caps (always allowed in <kbd>) are fixture data.
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, vi } from 'vitest';
import { APPSHOTS_TEXT } from '../src/screen/Appshots.tsx';
import { COMPUTER_USE_TEXT, ComputerUseSettings } from '../src/screen/ComputerUseSettings.tsx';
import { ControlIndicator, INDICATOR_TEXT } from '../src/screen/ControlIndicator.tsx';
import { GRANTS_TEXT } from '../src/screen/ScreenGrants.tsx';
import { PANEL_TEXT, ScreenPanel } from '../src/screen/ScreenPanel.tsx';
import {
  appshotView,
  computerView,
  fakeScreen,
  grantView,
  renderWithBrowser,
  screenActionView,
  windowView,
} from './fakes-m6-browser.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  vi.restoreAllMocks();
});

/** App names, window titles and what the Hub said: the fakes' data. */
const DATA = [
  'Spreadsheet',
  'Expenses.xlsx',
  'Terminal',
  'zsh',
  'Notes',
  'terminal is click only for computer use',
];

describe('computer use in en-XA', () => {
  it('shows the screen panel with grants, apps, actions and appshots localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithBrowser(<ScreenPanel computerId="pc1" />, {
      browser: {
        screens: {
          pc1: fakeScreen({
            enabled: true,
            grants: [grantView({ id: 'g1', app: 'Spreadsheet' })],
            windows: [
              windowView({ id: 'w1', app: 'Spreadsheet', focused: true }),
              windowView({ id: 'w2', app: 'Terminal', title: 'zsh', tier: 'click' }),
            ],
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
        appshots: [appshotView({ id: 'as1' })],
      },
    });
    await screen.findByRole('heading', { name: APPSHOTS_TEXT.title });
    const panel = document.querySelector<HTMLElement>('section.scr-panel[data-state]')!;
    await userEvent.click(within(panel).getByRole('button', { name: GRANTS_TEXT.seeApps }));
    await within(panel).findByRole('list', { name: GRANTS_TEXT.onScreen });
    expectFullyLocalized(panel, {
      data: [
        ...DATA,
        // The banner shows the Hub's indicator sentence (English in M8, D9).
        'Nova is controlling Spreadsheet · Escape to stop',
        // A pressed combination is named by its keys, as on the keyboard.
        'Ctrl+S',
      ],
    });
  });

  it('shows the panel while off, and the turn-on dialog, localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithBrowser(<ScreenPanel computerId="pc1" />);
    const sw = await screen.findByRole('switch', { name: PANEL_TEXT.allow });
    expectFullyLocalized(sw.closest('section.scr-panel')!, { data: DATA });
    await userEvent.click(sw);
    expectFullyLocalized(screen.getByRole('dialog', { name: PANEL_TEXT.confirmTitle }), {
      data: DATA,
    });
  });

  it('shows the control indicator localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithBrowser(<ControlIndicator onOpenComputer={() => undefined} />, {
      browser: {
        computers: [computerView({ id: 'pc1' }), computerView({ id: 'pc2', kind: 'local_host' })],
        screens: {
          pc1: fakeScreen({ enabled: true, grants: [grantView({ id: 'g1', app: 'Spreadsheet' })] }),
          pc2: fakeScreen({ enabled: true, grants: [grantView({ id: 'g2', app: 'Notes' })] }),
        },
      },
    });
    const region = await screen.findByRole('region', { name: INDICATOR_TEXT.region });
    expectFullyLocalized(region, { data: DATA });
  });

  it('shows Settings → Computer use localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithBrowser(<ComputerUseSettings />, {
      browser: {
        screens: {
          pc1: fakeScreen({ enabled: true, grants: [grantView({ id: 'g1', app: 'Spreadsheet' })] }),
        },
      },
      settings: { 'screen.tierOverrides': { Terminal: 'view' } },
    });
    await screen.findByRole('list', { name: COMPUTER_USE_TEXT.grants.list });
    const page = document.querySelector('.scr-settings')!;
    expectFullyLocalized(page, { data: DATA });

    const mins = screen.getByLabelText(COMPUTER_USE_TEXT.grantMinutes);
    await userEvent.clear(mins);
    await userEvent.type(mins, '2000');
    await userEvent.click(screen.getByRole('button', { name: COMPUTER_USE_TEXT.change }));
    expectFullyLocalized(page, { data: DATA });

    await userEvent.click(
      screen.getByRole('button', {
        name: COMPUTER_USE_TEXT.grants.revokeApp({ app: 'Spreadsheet' }),
      }),
    );
    expectFullyLocalized(screen.getByRole('dialog'), { data: DATA });
  });
});
