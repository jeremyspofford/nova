import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ToastProvider } from '@nova/ui';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { CodePage } from '../src/settings/CodePage.tsx';
import { ModelsProvider } from '../src/stores.tsx';
import { createHub, fakeEventSource, testRegistry } from './fakes.ts';

afterEach(cleanup);

async function renderPage(
  init: { settings?: Record<string, unknown>; managed?: Record<string, unknown> } = {},
) {
  const hub = createHub();
  hub.state.settings = { ...hub.state.settings, ...init.settings };
  hub.state.managed = { ...init.managed };
  const { settings } = await hub.api.settings();
  render(
    <ServicesProvider api={hub.api} eventSource={fakeEventSource} registry={testRegistry()}>
      <SettingsProvider api={hub.api} initial={settings}>
        <ToastProvider>
          <AnnouncerProvider>
            <ModelsProvider api={hub.api}>
              <CodePage />
            </ModelsProvider>
          </AnnouncerProvider>
        </ToastProvider>
      </SettingsProvider>
    </ServicesProvider>,
  );
  await screen.findByRole('heading', { name: 'Code' });
  return hub;
}

const select = (name: string) => screen.getByRole<HTMLSelectElement>('combobox', { name });
const option = (s: HTMLSelectElement, value: string) =>
  [...s.options].find((o) => o.value === value)!;

describe('Settings → Code (FR-063, FR-085, FR-195)', () => {
  it('sets the default mode, the reviewer model and Allow Bypass', async () => {
    const hub = await renderPage();
    const mode = select('Permission mode for new sessions');
    expect(mode.value).toBe('manual');
    expect([...mode.options].map((o) => o.value)).toEqual([
      'manual',
      'accept_edits',
      'auto',
      'bypass',
    ]);
    expect(option(mode, 'auto').disabled).toBe(true);
    expect(option(mode, 'auto').textContent).toBe('Auto (needs a reviewer model, chosen below)');
    expect(option(mode, 'bypass').textContent).toBe('Bypass (needs Allow Bypass, below)');
    await userEvent.selectOptions(mode, 'accept_edits');
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('code.permissionMode', 'accept_edits'),
    );

    // The reviewer model comes from the model list; with one, Auto can be the default.
    const reviewer = select('Reviewer model');
    expect(reviewer.value).toBe('');
    await waitFor(() => expect(option(reviewer, 'pa1/mock-smart')).toBeTruthy());
    await userEvent.selectOptions(reviewer, 'pa1/mock-smart');
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('review.model', 'pa1/mock-smart'),
    );
    await waitFor(() => expect(option(mode, 'auto').disabled).toBe(false));
    await userEvent.selectOptions(reviewer, '');
    await waitFor(() => expect(hub.api.setSetting).toHaveBeenLastCalledWith('review.model', null));

    // Allow Bypass, with its warning.
    expect(screen.queryByText(/without asking you first/)).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Allow Bypass mode' }));
    await waitFor(() => expect(hub.api.setSetting).toHaveBeenCalledWith('code.allowBypass', true));
    expect(await screen.findByText(/without asking you first/)).toBeTruthy();
    await waitFor(() => expect(option(mode, 'bypass').disabled).toBe(false));
  });

  it('warns when the default mode cannot be used, and shows managed values locked', async () => {
    await renderPage({
      settings: { 'code.permissionMode': 'auto' },
      managed: { 'code.allowBypass': false },
    });
    expect(
      screen.getByText(
        /Auto needs a reviewer model, chosen below\. Until then new sessions start in Manual/,
      ),
    ).toBeTruthy();
    // The current value stays selectable even while it is unavailable.
    expect(option(select('Permission mode for new sessions'), 'auto').disabled).toBe(false);
    expect(screen.getByRole('switch', { name: 'Allow Bypass mode' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
  });

  it('reports a refused save', async () => {
    const hub = await renderPage();
    hub.state.failNext.setSetting = new Error('Hub offline');
    await userEvent.click(screen.getByRole('switch', { name: 'Allow Bypass mode' }));
    expect(await screen.findByText(/Could not save: Hub offline/)).toBeTruthy();
  });
});
