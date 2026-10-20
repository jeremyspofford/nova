// Generate image in the pseudo-locale (FR-016): the composer's button and the dialog, before and
// after an image is made, come from messages. The description and chat title are fixture data.
import { afterEach, describe, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { IMAGE_TEXT } from '../src/images/GenerateImage.tsx';
import { SIDEBAR_TEXT } from '../src/shell/strings.ts';
import { DONE_ONBOARDING, createHub, thread } from './fakes.ts';
import { createWorkHub } from './fakes-m7-work.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

describe('Generate image in a pseudo-locale', () => {
  it('shows the dialog localized, with a missing description and a made image', async () => {
    const hub = createHub({ threads: [thread({ id: 't1', title: 'Ideas' })] });
    hub.state.settings = { 'onboarding.state': DONE_ONBOARDING };
    hub.state.messages.set('t1', []);
    const work = createWorkHub(hub, { imageTool: true });
    Object.assign(hub.api, work.api);
    await activateTestLocale('en-XA');
    await renderApp({ hub, path: '/chat/t1', ready: false });
    await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });

    await userEvent.click(await screen.findByRole('button', { name: IMAGE_TEXT.generate }));
    const dialog = screen.getByRole('dialog', { name: IMAGE_TEXT.generate });
    await userEvent.click(within(dialog).getByRole('button', { name: IMAGE_TEXT.go }));
    await within(dialog).findByText(IMAGE_TEXT.describe);
    expectFullyLocalized(dialog);

    await userEvent.type(
      within(dialog).getByLabelText(IMAGE_TEXT.description),
      'A lighthouse at dusk',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: IMAGE_TEXT.go }));
    await within(dialog).findByRole('img', { name: 'A lighthouse at dusk' });
    expectFullyLocalized(dialog, { data: ['A lighthouse at dusk'] });
  });
});
