// The browser fallback and the extension bridge in the pseudo-locale (FR-016): a device's bridge
// section (connected, with shared tabs, a site waiting, the activity and the setup steps) and its
// dialogs, the fallback offer card in a chat, the two Settings → Browser sections, and the note
// and mark in a computer's browser panel. Sites, names, versions and the Hub's question and
// choices are fixture data.
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it } from 'vitest';
import { BRIDGE_TEXT } from '../src/browserdevice/BridgeSection.tsx';
import { FallbackOffers, OFFER_TEXT } from '../src/browserdevice/FallbackOffer.tsx';
import {
  BrowserDeviceSettings,
  FALLBACK_SETTINGS_TEXT,
} from '../src/browserdevice/FallbackSettings.tsx';
import { FallbackMark, FallbackSessionNote } from '../src/browserdevice/FallbackTrace.tsx';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { deviceView } from './fakes-m6-devices.ts';
import {
  auditEntry,
  bridgeGrantView,
  bridgeTab,
  connectedBridge,
  consentView,
  fallbackOffer,
  fallbackSessionView,
  renderM75Browser,
} from './fakes-m75-browser.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

/** Names, sites, tab titles, browser and user names: the fakes' data. */
const DATA = [
  'Desk PC',
  'Shopper',
  'Pull requests',
  'Mail',
  'Chromium 140',
  'sam',
  'alex',
  'github.com',
  'docs.example',
  'mail.example',
  'example.com',
  'shop.example',
  'news.example',
];

describe('the browser fallback and bridge in en-XA', () => {
  it('shows a device’s bridge section and its dialogs localized', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/devices/d1');
    await renderM75Browser(<DevicesView deviceId="d1" />, {
      devices: { devices: [deviceView({ id: 'd1', name: 'Desk PC' })] },
      m75: {
        bridges: {
          d1: connectedBridge({
            tabs: [
              bridgeTab({ tabId: 7, host: 'github.com', title: 'Pull requests' }),
              bridgeTab({ tabId: 8, host: 'docs.example', title: '', origin: 'agent' }),
              bridgeTab({ tabId: 9, host: 'mail.example', title: 'Mail', user: 'alex' }),
            ],
          }),
        },
        grants: [
          bridgeGrantView({ id: 'g1', host: 'github.com', state: 'pending' }),
          bridgeGrantView({ id: 'g2', host: 'docs.example', state: 'active' }),
        ],
      },
      audit: [
        auditEntry({ id: 'a1', action: 'browser.bridge.history.search', resource: 'd1' }),
        auditEntry({ id: 'a2', action: 'browser.bridge.connected', resource: 'd1' }),
      ],
    });
    const heading = await screen.findByRole('heading', { name: BRIDGE_TEXT.title, level: 2 });
    const section = heading.closest('section')!;
    await within(section).findByRole('list', { name: BRIDGE_TEXT.sitesWaiting });
    await within(section).findByRole('list', { name: BRIDGE_TEXT.activity.list });
    await userEvent.click(
      within(section).getByRole('button', { name: BRIDGE_TEXT.setupOn({ name: 'Desk PC' }) }),
    );
    expectFullyLocalized(section, { data: DATA });

    await userEvent.click(
      within(section).getByRole('button', {
        name: BRIDGE_TEXT.confirmLabel({ label: 'github.com' }),
      }),
    );
    expectFullyLocalized(screen.getByRole('dialog'), { data: DATA });
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(section).getByRole('button', { name: BRIDGE_TEXT.grantAll }));
    expectFullyLocalized(screen.getByRole('dialog'), { data: DATA });
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(section).getByRole('button', { name: BRIDGE_TEXT.grant }));
    expectFullyLocalized(section, { data: DATA });
  });

  it('shows the fallback offer in a chat localized', async () => {
    await activateTestLocale('en-XA');
    const offer = fallbackOffer({ id: 'rq1' });
    await renderM75Browser(<FallbackOffers threadId="t1" />, { requests: [offer] });
    const card = await screen.findByRole('article', {
      name: OFFER_TEXT.title({ site: 'example.com', device: 'Desk PC' }),
    });
    // The Hub's question and its choices are shown as the Hub wrote them (English in M8, D9).
    const hub = [String(offer.payload.question), ...(offer.payload.choices as string[])];
    expectFullyLocalized(card, { data: [...DATA, ...hub] });
  });

  it('shows the Settings → Browser sections localized', async () => {
    await activateTestLocale('en-XA');
    await renderM75Browser(<BrowserDeviceSettings />, {
      agents: [{ id: 'ag1', name: 'Shopper' }],
      m75: {
        consents: [
          consentView({ id: 'c1', site: 'shop.example' }),
          consentView({
            id: 'c2',
            site: 'news.example',
            profile: 'extension',
            scopeKind: 'thread',
            scopeRef: 't9',
            deviceName: null,
          }),
        ],
      },
    });
    const fallback = (
      await screen.findByRole('heading', { name: FALLBACK_SETTINGS_TEXT.fallbackTitle })
    ).closest('section')!;
    await within(fallback).findByRole('list', { name: FALLBACK_SETTINGS_TEXT.sites });
    expectFullyLocalized(fallback, { data: DATA });
    const bridge = screen
      .getByRole('heading', { name: FALLBACK_SETTINGS_TEXT.bridgeTitle })
      .closest('section')!;
    expectFullyLocalized(bridge, { data: DATA });

    await userEvent.click(
      within(fallback).getByRole('button', {
        name: FALLBACK_SETTINGS_TEXT.revokeSite({ site: 'shop.example', device: 'Desk PC' }),
      }),
    );
    expectFullyLocalized(screen.getByRole('dialog'), { data: DATA });
  });

  it('shows the fallback note and mark of a computer’s browser localized', async () => {
    await activateTestLocale('en-XA');
    await renderM75Browser(
      <>
        <FallbackSessionNote computerId="pc1" />
        <FallbackMark
          mark={{ sessionId: 's1', deviceId: 'd1', profile: 'clean' }}
          deviceName="Desk PC"
        />
      </>,
      {
        m75: {
          consents: [consentView({ id: 'c1', deviceName: 'Desk PC' })],
          sessions: [
            fallbackSessionView({
              id: 's1',
              computerId: 'pc1',
              site: 'shop.example',
              consentId: 'c1',
            }),
          ],
        },
      },
    );
    const note = await screen.findByRole('status');
    await within(note).findAllByText(/shop\.example/);
    expectFullyLocalized(document.body, { data: DATA });
  });
});
