// The extensions area in the pseudo-locale (FR-016): every word of Settings → Extensions (installed
// extensions with their status, publisher, permissions, hooks, secrets and apps; install from a
// file or a path; the SDK switch and managed policy; the developer note; a member's notice), the
// install and update preview, the uninstall, clear-secret and hook-trust dialogs, the shell's
// contributions (commands, status bar, sidebar menu, the composer's + menu) and the themes and
// shortcuts extensions offer comes from messages. Extension names, titles, descriptions,
// permission lines and the Hub's warnings are data. One test renders the page in Arabic.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { pseudoLocalize } from '@nova/i18n';
import type { UiEntryPointView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { CATEGORY } from '../src/commands.ts';
import { ComposerPlusMenu, PLUS_TEXT } from '../src/extensions/ComposerPlus.tsx';
import { ExtensionsPage } from '../src/extensions/ExtensionsPage.tsx';
import {
  EXT_TEXT,
  HOOK_TRUST_TEXT,
  PREVIEW_TEXT,
  commandErrorText,
  extensionErrorMessage,
  readBundleFile,
  registeredText,
} from '../src/extensions/format.ts';
import { ExtensionKeyOffers, ExtensionThemeOffers, OFFER_TEXT } from '../src/extensions/Offers.tsx';
import {
  ExtensionStatusBar,
  SHELL_TEXT,
  SidebarExtensionMenu,
  useExtensionShell,
} from '../src/extensions/shell.tsx';
import {
  PUBLISHER_KEY,
  bundleFile,
  renderWithExtensions,
  wordCount,
  type FakeBundle,
} from './fakes-m8-extensions.ts';
import {
  activateTestLocale,
  expectFullyLocalized,
  resetTestLocale,
  unlocalizedResidue,
} from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

const TRUSTED = { 'plugins.trustedPublishers': [{ name: 'Example Labs', key: PUBLISHER_KEY }] };

const notes: FakeBundle = {
  id: 'com.test.notes',
  name: 'Notes helper',
  version: '1.0.0',
  description: 'Keeps notes.',
  signature: 'unverified',
  publisher: null,
  digest: '1'.repeat(64),
  permissions: [
    {
      key: 'net:api.notes.example',
      kind: 'network',
      text: 'Reach api.notes.example on the network',
      sensitive: true,
      detail: null,
    },
  ],
  hooks: [{ id: 'guard', event: 'tool.pre', matcher: 'fs.write' }],
  secrets: ['notes.token'],
};

function entry(over: Partial<UiEntryPointView> = {}): UiEntryPointView {
  return {
    id: 'ep-chart',
    kind: 'thread',
    title: 'Chart',
    serverId: 's1',
    pluginId: null,
    resource: 'ui://chart',
    extensions: [],
    ...over,
  };
}

/** Fixture text: extension names and descriptions, the Hub's permission lines, app titles. */
const DATA = [
  'Word count',
  'Notes helper',
  'Example Labs',
  'Counts the words, sentences and reading time of a text.',
  'Keeps notes.',
  'Add the command “Count words”',
  'Offer the tool count, which reads data',
  'Reach api.notes.example on the network',
  'notes.token',
  'Counter',
  'Chart',
];

/** Fails on any word in `text` that is not pseudo-localized. */
function expectLocalizedText(text: string, data: readonly string[] = []) {
  expect(unlocalizedResidue(text, data), text).not.toMatch(/[A-Za-z]/);
}

async function upload(b: FakeBundle) {
  await userEvent.upload(screen.getByTestId<HTMLInputElement>('novax-input'), bundleFile(b));
}

describe('Settings → Extensions in en-XA', () => {
  it('shows installed extensions with their status, publisher, hooks, secrets and apps', async () => {
    await activateTestLocale('en-XA');
    await renderWithExtensions(<ExtensionsPage />, {
      settings: TRUSTED,
      bundles: [{ bundle: wordCount() }, { bundle: notes }],
      prepare: (hub) => {
        hub.state.m4.entryPoints = [
          entry({
            id: 'ep-counter',
            kind: 'global',
            title: 'Counter',
            pluginId: 'com.examplelabs.word-count',
          }),
          entry({ pluginId: 'com.examplelabs.word-count' }),
        ];
      },
    });
    const wc = await screen.findByRole('listitem', { name: /Word count/ });
    expect(screen.getByRole('heading', { name: EXT_TEXT.title, level: 2 })).toBeTruthy();
    await within(wc).findByRole('link', { name: EXT_TEXT.openAppOf({ title: 'Counter' }) });
    expect(
      within(wc).getByRole('switch', { name: EXT_TEXT.runSwitch({ name: 'Word count' }) }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('listitem', { name: /Notes helper/ })).getByRole('region', {
        name: EXT_TEXT.secretsOf({ name: 'Notes helper' }),
      }),
    ).toBeTruthy();
    expectFullyLocalized(document.body, { data: DATA });
  });

  it('shows the empty list, the SDK switch off, managed policy and the install section', async () => {
    await activateTestLocale('en-XA');
    await renderWithExtensions(<ExtensionsPage />, {
      managed: {
        'sdk.enabled': false,
        'managed.restrict': { layers: [{ unverifiedInstalls: false }], failClosed: null },
      },
    });
    await screen.findByRole('heading', { name: EXT_TEXT.none });
    expect(screen.getByText(EXT_TEXT.sdkOff)).toBeTruthy();
    // A refusal before anything is sent, in words.
    await userEvent.upload(
      screen.getByTestId<HTMLInputElement>('novax-input'),
      new File(['x'], 'notes.zip'),
      { applyAccept: false },
    );
    expect(await screen.findByText(EXT_TEXT.notNovax)).toBeTruthy();
    expectFullyLocalized(document.body);
  });

  it('shows a member the owner-only notice', async () => {
    await activateTestLocale('en-XA');
    await renderWithExtensions(<ExtensionsPage />, { member: true });
    await waitFor(() => expect(screen.queryByRole('switch')).toBeNull());
    await screen.findByText(pseudoLocalize('Only the owner of this Hub can change this.', 'en-XA'));
    expectFullyLocalized(document.body);
  });
});

describe('the extension dialogs in en-XA', () => {
  it('shows an unverified update’s preview: signature, permission diff, hooks to trust', async () => {
    await activateTestLocale('en-XA');
    await renderWithExtensions(<ExtensionsPage />, { bundles: [{ bundle: notes }] });
    await screen.findByRole('listitem', { name: /Notes helper/ });
    await upload({
      ...notes,
      version: '2.0.0',
      digest: '2'.repeat(64),
      permissions: [
        {
          key: 'fs:/srv/notes',
          kind: 'fs',
          text: 'Write files in /srv/notes',
          sensitive: true,
          detail: 'rw',
        },
      ],
    });
    const dialog = await screen.findByRole('dialog', {
      name: PREVIEW_TEXT.update({ name: 'Notes helper', version: '2.0.0' }),
    });
    expect(within(dialog).getByRole('heading', { name: PREVIEW_TEXT.diff })).toBeTruthy();
    expect(
      within(dialog).getByRole('listitem', {
        name: PREVIEW_TEXT.hookRow({ id: 'hook:com.test.notes.guard' }),
      }),
    ).toBeTruthy();
    expectFullyLocalized(dialog, {
      data: [
        ...DATA,
        'Write files in /srv/notes',
        // The Hub's reason it is unverified and its warning about the update.
        'The bundle is not signed',
        'This update asks for more: Write files in /srv/notes.',
      ],
    });
  });

  it('shows a refusal of the install in the dialog', async () => {
    await activateTestLocale('en-XA');
    const { hub } = await renderWithExtensions(<ExtensionsPage />);
    await screen.findByRole('heading', { name: EXT_TEXT.none });
    await upload(notes);
    const dialog = await screen.findByRole('dialog', {
      name: PREVIEW_TEXT.install({ name: 'Notes helper', version: '1.0.0' }),
    });
    hub.state.managed = {
      'managed.restrict': { layers: [{ unverifiedInstalls: false }], failClosed: null },
    };
    await userEvent.click(within(dialog).getByRole('checkbox', { name: PREVIEW_TEXT.sideload }));
    await userEvent.click(within(dialog).getByRole('button', { name: PREVIEW_TEXT.installButton }));
    const alert = await within(dialog).findByRole('alert');
    expectFullyLocalized(dialog, {
      data: [
        ...DATA,
        'The bundle is not signed',
        // The Hub's own words after "Managed by your organization:".
        'Installing an unverified extension is not allowed by your organization: only signed ones from trusted publishers install',
      ],
    });
    expect(alert.textContent).not.toBe('');
  });

  it('shows the secret form, the clear, uninstall and hook trust dialogs', async () => {
    await activateTestLocale('en-XA');
    await renderWithExtensions(<ExtensionsPage />, { bundles: [{ bundle: notes }] });
    const row = await screen.findByRole('listitem', {
      name: EXT_TEXT.secretRow({ name: 'notes.token' }),
    });
    await userEvent.click(
      within(row).getByRole('button', { name: EXT_TEXT.setSecretOf({ name: 'notes.token' }) }),
    );
    expectFullyLocalized(row, { data: DATA });
    await userEvent.type(
      within(row).getByLabelText(EXT_TEXT.secretValue({ name: 'notes.token' })),
      'value',
    );
    await userEvent.click(within(row).getByRole('button', { name: EXT_TEXT.saveSecret }));
    await userEvent.click(
      await screen.findByRole('button', { name: EXT_TEXT.clearSecretOf({ name: 'notes.token' }) }),
    );
    let dialog = screen.getByRole('dialog', { name: EXT_TEXT.clearTitle({ name: 'notes.token' }) });
    expectFullyLocalized(dialog, { data: DATA });
    await userEvent.click(within(dialog).getByRole('button', { name: EXT_TEXT.cancel }));

    await userEvent.click(
      screen.getByRole('button', { name: EXT_TEXT.uninstallOf({ name: 'Notes helper' }) }),
    );
    dialog = screen.getByRole('dialog', {
      name: EXT_TEXT.uninstallTitle({ name: 'Notes helper' }),
    });
    expectFullyLocalized(dialog, { data: DATA });
    await userEvent.click(within(dialog).getByRole('button', { name: EXT_TEXT.cancel }));

    await userEvent.click(
      screen.getByRole('button', { name: EXT_TEXT.trustHook({ id: 'hook:com.test.notes.guard' }) }),
    );
    dialog = screen.getByRole('dialog', { name: HOOK_TRUST_TEXT.title });
    expect(within(dialog).getByText(HOOK_TRUST_TEXT.failClosedYes)).toBeTruthy();
    expectFullyLocalized(dialog, { data: DATA });
  });
});

function Shell() {
  useExtensionShell();
  return <ExtensionStatusBar />;
}

describe('extension contributions in en-XA', () => {
  it('registers its commands, and shows the status bar, the sidebar menu and the + menu', async () => {
    await activateTestLocale('en-XA');
    const b = wordCount();
    b.contributes!.menus = [
      {
        extensionId: '',
        where: 'sidebar',
        items: [{ id: 's', title: 'Word count of today', command: 'count' }],
      },
      {
        extensionId: '',
        where: 'composer',
        items: [{ id: 'c', title: 'Count my draft', command: 'count' }],
      },
    ];
    const { registry } = await renderWithExtensions(
      <>
        <Shell />
        <SidebarExtensionMenu />
        <ComposerPlusMenu threadId="t1" />
      </>,
      {
        bundles: [{ bundle: b }],
        prepare: (hub) => {
          hub.state.m4.entryPoints = [entry()];
        },
      },
    );
    const data = [...DATA, '120 words', 'Word count of today', 'Count my draft', 'Count words'];
    const bar = await screen.findByRole('group', { name: SHELL_TEXT.statusBar });
    await waitFor(() => expect(registry.get('marketplace.open')).toBeTruthy());
    expect(registry.get('marketplace.open')).toMatchObject({
      title: SHELL_TEXT.openMarket,
      category: CATEGORY.navigation,
    });
    expect(registry.get('extensions.manage')).toMatchObject({
      title: SHELL_TEXT.manage,
      category: CATEGORY.settings,
    });
    await userEvent.click(
      within(bar).getByRole('button', {
        name: SHELL_TEXT.statusFrom({ text: '120 words', name: 'Word count' }),
      }),
    );
    expect(
      (await screen.findAllByText(SHELL_TEXT.done({ title: '120 words' }))).length,
    ).toBeGreaterThan(0);
    expectFullyLocalized(document.body, { data });

    await userEvent.click(screen.getByRole('button', { name: SHELL_TEXT.sidebarMenu }));
    const item = screen.getByRole('menuitem', { name: 'Word count of today' });
    expect(item.getAttribute('title')).toBe(SHELL_TEXT.from({ name: 'Word count' }));
    expectFullyLocalized(document.body, { data });
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: PLUS_TEXT.label }));
    await screen.findByRole('menuitem', { name: PLUS_TEXT.openApp({ title: 'Chart' }) });
    expect(screen.getByRole('menuitem', { name: 'Count my draft' })).toBeTruthy();
    expectFullyLocalized(document.body, { data });
  });

  it('offers themes and shortcuts in words of the locale', async () => {
    await activateTestLocale('en-XA');
    const b = wordCount();
    b.contributes!.themes = [
      {
        schemaVersion: 1,
        id: 'com.examplelabs.paper',
        name: 'Paper',
        variant: 'light',
        tokens: { '--u-bg': '#fbf7ee', '--u-text': '#1f1b14', '--u-accent': '#a14a1c' },
      },
      { schemaVersion: 1, id: 'Bad Id', name: 'Broken', variant: 'dark', tokens: {} },
    ];
    await renderWithExtensions(
      <>
        <Shell />
        <ExtensionThemeOffers saved={[]} disabled={false} onKeep={() => undefined} />
        <ExtensionKeyOffers />
      </>,
      { bundles: [{ bundle: b }] },
    );
    const themes = await screen.findByRole('list', { name: OFFER_TEXT.themes });
    expect(
      within(themes).getByRole('button', { name: OFFER_TEXT.saveThemeOf({ name: 'Paper' }) }),
    ).toBeTruthy();
    expect(within(themes).getByText(OFFER_TEXT.variant.light)).toBeTruthy();
    const row = await screen.findByRole('listitem', {
      name: OFFER_TEXT.row({ extension: 'Word count', command: 'Count words' }),
    });
    await userEvent.click(within(row).getByRole('button'));
    expect(
      (await screen.findAllByText(OFFER_TEXT.bound({ keys: 'Ctrl+Alt+W', title: 'Count words' })))
        .length,
    ).toBeGreaterThan(0);
    expectFullyLocalized(document.body, {
      // Key names ("Ctrl", "Alt") are written by keys.ts as they are on the key caps.
      data: [...DATA, 'Paper', 'Count words', '120 words', 'Ctrl+Alt+W'],
    });
  });
});

describe('the extension words in en-XA', () => {
  it('says counts, refusals and command failures in the locale', async () => {
    await activateTestLocale('en-XA');
    expectLocalizedText(
      registeredText({
        commands: 2,
        panels: 1,
        tools: 0,
        hooks: 0,
        themes: 0,
        keybindings: 1,
        menus: 0,
        statusItems: 0,
        events: 3,
      }),
    );
    expectLocalizedText(
      registeredText({
        commands: 0,
        panels: 0,
        tools: 0,
        hooks: 0,
        themes: 0,
        keybindings: 0,
        menus: 0,
        statusItems: 0,
        events: 0,
      }),
    );
    const refusal = (code: string, message: string, reason?: string) =>
      new ApiError(400, {
        code,
        message,
        retryable: false,
        ...(reason ? { details: { reason } } : {}),
      });
    for (const reason of [
      'owner_only',
      'signature_invalid',
      'not_an_extension',
      'fs_scope_refused',
      'sideload_confirmation_required',
      'publisher_change_confirmation_required',
    ])
      expectLocalizedText(extensionErrorMessage(refusal('validation', 'x', reason)), ['x']);
    expectLocalizedText(extensionErrorMessage(refusal('request_expired', 'x')), ['x']);
    expectLocalizedText(extensionErrorMessage(refusal('policy_denied', 'nope')), ['nope']);
    expectLocalizedText(extensionErrorMessage(refusal('validation', 'bad json')), ['bad json']);
    expectLocalizedText(extensionErrorMessage(new Error('boom')), ['boom']);
    for (const code of [
      'timeout',
      'extension_unavailable',
      'extension_busy',
      'cancelled',
      'invalid_arguments',
      'policy_denied',
      'extension_error',
    ])
      expectLocalizedText(commandErrorText('Count', { code, message: 'no text' }), [
        'Count',
        'no text',
      ]);
    expectLocalizedText(commandErrorText('Count', null), ['Count']);
    const big = new File(['x'], 'big.novax');
    Object.defineProperty(big, 'size', { value: 33 * 1024 * 1024 });
    const read = await readBundleFile(big);
    expect(read.ok).toBe(false);
    if (!read.ok) expectLocalizedText(read.error);
  });
});

describe('Settings → Extensions in Arabic', () => {
  it('shows the page in Arabic, right to left', async () => {
    await activateTestLocale('ar');
    await renderWithExtensions(<ExtensionsPage />, {
      settings: TRUSTED,
      bundles: [{ bundle: wordCount() }],
    });
    expect(document.documentElement.dir).toBe('rtl');
    expect(await screen.findByRole('heading', { name: 'الإضافات', level: 2 })).toBeTruthy();
    expect(EXT_TEXT.title).toBe('الإضافات');
    const wc = await screen.findByRole('listitem', { name: /Word count/ });
    expect(within(wc).getByText('قيد التشغيل')).toBeTruthy();
    expect(within(wc).getByRole('switch', { name: 'تشغيل Word count' })).toBeTruthy();
    const facts = within(wc).getByText(/أمر واحد/);
    expect(facts.textContent).toContain('عنصر حالة واحد');
    expect(within(wc).getByRole('button', { name: 'إزالة تثبيت Word count' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'التثبيت من ملف' })).toBeTruthy();
  });
});
