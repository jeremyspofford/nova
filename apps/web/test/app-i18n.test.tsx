// The app's own screens in the pseudo-locale (FR-016): connecting, offline and first-run setup
// before sign-in, onboarding's steps, and the pane layout. Parts other areas own (the sign-in
// options, the provider form, the MCP server form, the chat view, terminals) are skipped.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/App.tsx';
import { ApiError } from '../src/api.ts';
import { LAYOUT_TEXT } from '../src/layout/strings.ts';
import { ONBOARDING_TEXT as T } from '../src/onboarding/strings.ts';
import { MODE_TEXT, SIDEBAR_TEXT } from '../src/shell/strings.ts';
import {
  createHub,
  fakeEventSource,
  fakeTerminalScreen,
  fakeWebSocket,
  testRegistry,
} from './fakes.ts';
import { resetDom } from './render.tsx';
import { expectFullyLocalized, renderInLocale, resetTestLocale } from './i18n.ts';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

const unauthorized = new ApiError(401, {
  code: 'token_required',
  message: 'sign in',
  retryable: false,
});

async function renderAt(locale: string, hub: ReturnType<typeof createHub>, path = '/chat') {
  window.history.replaceState(null, '', path);
  const registry = testRegistry();
  const utils = await renderInLocale(
    locale,
    <App
      api={hub.api}
      registry={registry}
      eventSource={fakeEventSource}
      takeSetupCode={() => null}
      announceEveryMs={0}
      webSocket={fakeWebSocket}
      terminalScreen={fakeTerminalScreen}
    />,
  );
  return { ...utils, registry };
}

const main = () => document.getElementById('main')!;

describe('before sign-in', () => {
  it('connects, then offers setup, all localized', async () => {
    const hub = createHub();
    let release: () => void = () => undefined;
    hub.api.hello.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ name: 'Nova', version: '0', setup: true });
        }),
    );
    hub.api.session.mockRejectedValue(unauthorized);
    await renderAt('en-XA', hub);
    expectFullyLocalized(main());
    release();
    await screen.findByRole('heading', { name: /Šéţ ûþ/ });
    // The command to run is code, not words.
    expectFullyLocalized(main(), { skip: ['.joinm-signin'], data: ['nova-hub code'] });
  });

  it('says when the Hub cannot be reached', async () => {
    const hub = createHub();
    hub.api.hello.mockRejectedValue('down');
    await renderAt('ar-XB', hub);
    await screen.findByRole('button', { name: /Retry/ });
    expect(document.documentElement.dir).toBe('rtl');
    expectFullyLocalized(main());
  });
});

describe('onboarding', () => {
  const fresh = (step: string) =>
    createHub({
      settings: { 'onboarding.state': { step, completed: false, skipped: false } },
    });

  it('shows each step localized in en-XA', async () => {
    const hub = fresh('provider');
    await renderAt('en-XA', hub, '/onboarding');
    await screen.findByRole('heading', { level: 1, name: T.steps.provider });
    const page = () => document.querySelector('.onboarding')!;
    expectFullyLocalized(page(), { skip: ['.provider-setup', '.provider-failed'] });

    await userEvent.click(screen.getByRole('button', { name: T.skipStep }));
    await screen.findByRole('heading', { level: 1, name: T.steps.model });
    expectFullyLocalized(page(), { data: ['Mock fast', 'Mock smart', 'Mock'] });

    await userEvent.click(screen.getByRole('button', { name: T.skipStep }));
    await screen.findByRole('heading', { level: 1, name: T.steps.profile });
    expectFullyLocalized(page());

    await userEvent.click(screen.getByRole('button', { name: T.skipStep }));
    await screen.findByRole('heading', { level: 1, name: T.steps.tool });
    expectFullyLocalized(page());

    await userEvent.click(screen.getByRole('button', { name: T.skipStep }));
    await screen.findByRole('heading', { level: 1, name: T.steps.sample });
    expectFullyLocalized(page());
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: T.sample.message }).value).toBe(
      T.sample.prompt,
    );
  });
});

describe('the pane layout', () => {
  it('names panes, splitters and the bottom panel in the locale', async () => {
    const hub = createHub();
    const { registry } = await renderAt('en-XA', hub);
    await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });
    await waitFor(() => {
      if (!registry.get('pane.splitRight')) throw new Error('shell commands not registered yet');
    });
    registry.run('pane.splitRight');
    await screen.findByText(LAYOUT_TEXT.choose);
    registry.run('panel.toggle');
    await screen.findByRole('region', { name: LAYOUT_TEXT.bottomPanel });
    const workspace = screen.getByRole('region', { name: MODE_TEXT.chat.workspace });
    expectFullyLocalized(workspace, {
      skip: ['[data-kind="main"] .pane-body', '.bottom-panel-body'],
    });
    expect(
      screen.getByRole('separator', {
        name: LAYOUT_TEXT.resizeBetween({
          first: MODE_TEXT.chat.label,
          second: LAYOUT_TEXT.newPane,
        }),
      }),
    ).toBeTruthy();
  });
});
