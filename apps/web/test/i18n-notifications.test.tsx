// The notification bell in the pseudo-locale (FR-016): the bell's own words come from messages;
// notification titles and bodies are the Hub's text (fixture data here; an M9 gap).
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { BELL_TEXT, KIND_TEXT, NotificationsBell } from '../src/notifications/Bell.tsx';
import { FakeEventSource, createHub } from './fakes.ts';
import { m3State } from './fakes-m3.ts';
import { renderWithPush } from './fakes-m7-push.ts';
import { notification } from './fakes-settings.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';

afterEach(() => {
  cleanup();
  FakeEventSource.reset();
  resetTestLocale();
});

const TITLES = ['Approval needed: write plan.md', 'Reply finished', 'Server files crashed'];
const BODY = 'In “Trip planning”';

const hubWith = (empty = false) =>
  createHub({
    m3: m3State({
      notifications: empty
        ? []
        : [
            notification({ id: 'n1', kind: 'approval', title: TITLES[0], body: BODY }),
            notification({ id: 'n2', title: TITLES[1], read: true }),
            notification({ id: 'n3', kind: 'error', title: TITLES[2] }),
          ],
    }),
  });

async function openBell(empty = false) {
  await activateTestLocale('en-XA');
  const { container } = await renderWithPush(<NotificationsBell />, { hub: hubWith(empty) });
  const bell = screen.getByRole('button', { name: /./ });
  if (!empty)
    await waitFor(() => expect(bell.getAttribute('aria-label')).toBe(BELL_TEXT.button({ n: 2 })));
  await userEvent.click(bell);
  const panel = screen.getByRole('dialog', { name: BELL_TEXT.notifications });
  return { container, panel };
}

describe('the bell in a pseudo-locale', () => {
  it('shows the bell and its panel localized in en-XA', async () => {
    const { container, panel } = await openBell();
    expect(BELL_TEXT.notifications).toMatch(/^\[/);
    expect(within(panel).getByText(KIND_TEXT.error, { exact: false })).toBeTruthy();
    expectFullyLocalized(container, { data: [...TITLES, BODY] });
  });

  it('shows the empty panel localized in en-XA', async () => {
    const { panel } = await openBell(true);
    await within(panel).findByText(BELL_TEXT.empty);
    expectFullyLocalized(panel);
  });
});
