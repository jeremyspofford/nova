// "Notifications on this device" in the pseudo-locale (FR-016): the device's state, its actions,
// the devices that get notifications, the Hub-wide switches, the removal confirmation and why a
// browser cannot get pushes all come from messages. Device labels and the push service's error
// are data.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { SUPPORT_TEXT, rememberMine } from '../src/push/browser.ts';
import { PushSection } from '../src/push/PushSection.tsx';
import { PUSH_TEXT } from '../src/push/strings.ts';
import { VAPID_KEY, fakePushEnv, renderWithPush, subscriptionView } from './fakes-m7-push.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetTestLocale();
});

/** Device labels, the push service's host and its error text (the Hub's, English in M8). */
const DATA = ['Phone', 'Chrome on Android', 'fcm.googleapis.com', '410 Gone'];

describe('Notifications on this device in a pseudo-locale', () => {
  it('shows the section, a test result and the removal confirmation localized', async () => {
    const env = fakePushEnv({ permission: 'granted' });
    const sub = env.manager.existing('https://fcm.googleapis.com/fcm/send/mine', VAPID_KEY);
    const mine = subscriptionView({
      endpoint: sub.endpoint,
      label: 'Phone',
      lastSuccessAt: '2026-10-01T11:00:00.000Z',
    });
    const other = subscriptionView({ status: 'failing', lastError: '410 Gone' });
    await rememberMine(env, mine.id, sub.endpoint);
    await activateTestLocale('en-XA');
    await renderWithPush(<PushSection env={env} />, {
      push: { subscriptions: [mine, other] },
      settings: { 'push.enabled': false },
    });
    const section = screen.getByRole('region', { name: PUSH_TEXT.heading });
    expect(await within(section).findByText(PUSH_TEXT.stateOn)).toBeTruthy();
    expect(within(section).getByText(PUSH_TEXT.hubOff)).toBeTruthy();
    expect(
      within(section).getByText(PUSH_TEXT.statusError({ status: 'failing', error: '410 Gone' })),
    ).toBeTruthy();
    expectFullyLocalized(section, { data: DATA });

    await userEvent.click(within(section).getByRole('button', { name: PUSH_TEXT.sendTest }));
    expect(await within(section).findByText(PUSH_TEXT.test.sent)).toBeTruthy();
    expectFullyLocalized(section, { data: DATA });

    await userEvent.click(
      within(section).getByRole('button', {
        name: PUSH_TEXT.removeNamed({ name: 'Chrome on Android' }),
      }),
    );
    const dialog = screen.getByRole('dialog', {
      name: PUSH_TEXT.stopTitle({ name: 'Chrome on Android' }),
    });
    expectFullyLocalized(dialog, { data: DATA });
  });

  it('says why this browser cannot get pushes, localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithPush(<PushSection env={fakePushEnv({ secure: false })} />);
    const section = screen.getByRole('region', { name: PUSH_TEXT.heading });
    expect(await within(section).findByText(SUPPORT_TEXT.insecure)).toBeTruthy();
    expectFullyLocalized(section, { data: DATA });
  });
});
