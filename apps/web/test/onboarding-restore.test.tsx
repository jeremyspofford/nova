// Restoring an export instead of setting up (FR-014, J10): after "Delete all data" the Hub starts
// empty and lands on onboarding; its first screen leads to Settings → Data's import without
// marking setup done or skipped, and the onboarding redirect leaves the import alone.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { act } from 'react';
import { getLocale } from '@nova/i18n';
import { pinLocale } from '../src/i18n/I18nProvider.tsx';
import { createHub } from './fakes.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  pinLocale(null);
});

const INCOMPLETE = { step: 'provider', completed: false, skipped: false };

describe('restoring an export from onboarding', () => {
  it('opens Settings → Data at the import, leaving the setup state alone', async () => {
    const hub = createHub({ settings: { 'onboarding.state': INCOMPLETE } });
    await renderApp({ hub, path: '/chat' });
    await waitFor(() => expect(window.location.pathname).toBe('/onboarding'));
    const restore = await screen.findByRole('button', { name: 'Restore from an export file' });
    expect(restore.getAttribute('aria-describedby')).toBeTruthy();
    await userEvent.click(restore);
    expect(window.location.pathname).toBe('/settings/data');
    expect(window.location.hash).toBe('#import');
    const heading = await screen.findByRole('heading', { name: 'Import', level: 3 });
    expect(heading.closest('section')?.id).toBe('import');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    // Nothing about setup changed: the imported settings decide it after the restart.
    expect(hub.state.settings['onboarding.state']).toEqual(INCOMPLETE);
    expect(hub.api.setSetting).not.toHaveBeenCalledWith('onboarding.state', expect.anything());
  });

  it('does not bounce a load of the import page back to onboarding, even when the shell remounts', async () => {
    const hub = createHub({ settings: { 'onboarding.state': INCOMPLETE } });
    await renderApp({ hub, path: '/settings/data#import' });
    await screen.findByRole('heading', { name: 'Import', level: 3 });
    // A language change remounts the shell (and its once-per-load redirect check).
    act(() => pinLocale('en-XA'));
    await waitFor(() => expect(getLocale()).toBe('en-XA'));
    act(() => pinLocale(null));
    await waitFor(() => expect(getLocale()).toBe('en'));
    await screen.findByRole('heading', { name: 'Import', level: 3 });
    expect(window.location.pathname).toBe('/settings/data');
  });

  it('after the restart, the imported setup state decides', async () => {
    // The import finished and the Hub restarted: the page reloads with the imported settings.
    const imported = createHub({
      settings: { 'onboarding.state': { step: 'done', completed: true, skipped: false } },
    });
    await renderApp({ hub: imported, path: '/settings/data' });
    await screen.findByRole('heading', { name: 'Import', level: 3 });
    expect(window.location.pathname).toBe('/settings/data');
    resetDom();
    // An export taken before setup finished still leads to onboarding from anywhere else.
    const unfinished = createHub({ settings: { 'onboarding.state': INCOMPLETE } });
    await renderApp({ hub: unfinished, path: '/chat' });
    await waitFor(() => expect(window.location.pathname).toBe('/onboarding'));
  });
});
