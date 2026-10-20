// The shell in the pseudo-locale (FR-016): every word the shell owns comes from messages. Regions
// other areas own (the chat list, the agents list, the bell, the pages in #main) are skipped
// until those areas are extracted.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/App.tsx';
import { CATEGORY } from '../src/commands.ts';
import { COMMAND_TEXT, SHELL_TEXT, SIDEBAR_TEXT } from '../src/shell/strings.ts';
import {
  createHub,
  fakeEventSource,
  fakeTerminalScreen,
  fakeWebSocket,
  testRegistry,
  thread,
} from './fakes.ts';
import { resetDom } from './render.tsx';
import { expectFullyLocalized, renderInLocale, resetTestLocale } from './i18n.ts';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

/**
 * Commands other areas register (their titles are theirs to extract), and the "Open … settings"
 * commands, whose section names are Settings' words.
 */
const OTHER_AREAS = [
  '[id^="cmd-settings."]:not([id="cmd-settings.open"])',
  ...['work.', 'ext', 'marketplace.', 'window.', 'shell.', 'agents.', 'code.'].map(
    (p) => `[id^="cmd-${p}"]`,
  ),
];

async function renderShell(locale: string) {
  const hub = createHub({ threads: [thread({ id: 't1', title: 'Plan the trip' })] });
  const registry = testRegistry();
  window.history.replaceState(null, '', '/chat');
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
  const nav = await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });
  await waitFor(() => {
    if (!registry.get('view.toggleTheme')) throw new Error('shell commands not registered yet');
  });
  return { ...utils, hub, registry, nav };
}

describe('the shell in a pseudo-locale', () => {
  it('shows every shell word localized in en-XA', async () => {
    const { nav, registry } = await renderShell('en-XA');
    expect(SIDEBAR_TEXT.sidebar).toMatch(/^\[Šîðéƀåŕ/);
    expectFullyLocalized(nav, { skip: ['.thread-list', '.sidebar-agents'] });

    const header = document.querySelector('header.topbar');
    expect(header).toBeTruthy();
    // The account button carries the user's name and initial: fixture data.
    expectFullyLocalized(header!, { skip: ['.bell', '.account-initial'], data: ['Sam'] });

    const inspector = screen.getByRole('complementary', { name: SHELL_TEXT.inspector });
    expectFullyLocalized(within(inspector).getByRole('tablist'));

    // The layout menu and the account menu (its first item is the connection, the relay area's).
    await userEvent.click(screen.getByRole('button', { name: SHELL_TEXT.layout }));
    expectFullyLocalized(screen.getByRole('menu'));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(
      screen.getByRole('button', { name: SHELL_TEXT.accountOf({ name: 'Sam' }) }),
    );
    expectFullyLocalized(screen.getByRole('menu'), {
      skip: ['[role="menuitem"]:first-child'],
      data: ['Sam'],
    });
    await userEvent.keyboard('{Escape}');

    // The palette: its own words and the shell's commands, with their categories.
    await userEvent.click(screen.getByRole('button', { name: SHELL_TEXT.commands }));
    const palette = screen.getByRole('dialog', { name: /Çöɱɱåñð/ });
    expectFullyLocalized(palette, { skip: OTHER_AREAS });
    expect(registry.get('chat.new')).toMatchObject({
      title: COMMAND_TEXT.newChat,
      category: CATEGORY.chat,
    });
  });

  it('runs right to left in ar-XB', async () => {
    const { nav } = await renderShell('ar-XB');
    expect(document.documentElement.dir).toBe('rtl');
    expectFullyLocalized(nav, { skip: ['.thread-list', '.sidebar-agents'] });
  });
});
