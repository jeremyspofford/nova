// Settings → Extensions (FR-117; docs/14 §4-§5, docs/26 §3): installed extensions with their status,
// publisher, Verified or Unverified, permissions, hooks (trust again after an update) and secrets
// (never shown); on and off; uninstall with "also remove its data"; install from a .novax file with
// the preview (signature, permissions, the update's diff, hooks to trust) and the sideload
// confirmation for an unverified bundle; refusals in plain words; managed policy; the SDK switch;
// the developer note; a member's owner-only notice.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionsPage } from '../src/extensions/ExtensionsPage.tsx';
import {
  PUBLISHER_KEY,
  bundleFile,
  renderWithExtensions,
  wordCount,
  type FakeBundle,
} from './fakes-m8-extensions.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

const TRUSTED = { 'plugins.trustedPublishers': [{ name: 'Example Labs', key: PUBLISHER_KEY }] };

const card = (name: string) => screen.getByRole('listitem', { name: new RegExp(`^${name}`) });

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
    },
  ],
  hooks: [{ id: 'guard', event: 'tool.pre', matcher: 'fs.write' }],
  secrets: ['notes.token'],
};

async function upload(b: FakeBundle) {
  const input = screen.getByTestId<HTMLInputElement>('novax-input');
  await userEvent.upload(input, bundleFile(b));
}

describe('installed extensions', () => {
  it('lists each with status, publisher, verdict, permissions and hooks, and turns it off and on', async () => {
    const { ext } = await renderWithExtensions(<ExtensionsPage />, {
      settings: TRUSTED,
      bundles: [{ bundle: wordCount() }, { bundle: notes }],
    });
    const wc = await screen.findByRole('listitem', { name: /Word count/ });
    expect(within(wc).getByText('Verified')).toBeTruthy();
    expect(within(wc).getByText('Running')).toBeTruthy();
    expect(within(wc).getByText(/Example Labs · Signed by a publisher you trust/)).toBeTruthy();
    expect(within(wc).getByText('1 command, 1 shortcut, 1 menu, 1 status item')).toBeTruthy();
    expect(within(wc).getByText('Add the command “Count words”')).toBeTruthy();

    const n = card('Notes helper');
    expect(within(n).getByText('Unverified')).toBeTruthy();
    expect(within(n).getByText(/Not signed · Not signed by a publisher you trust/)).toBeTruthy();
    // A sensitive permission is marked in words, not by color.
    expect(within(n).getByText('(Sensitive)')).toBeTruthy();
    const hooks = within(n).getByRole('region', { name: 'Hooks: Notes helper' });
    expect(within(hooks).getByText('Needs trust')).toBeTruthy();

    await userEvent.click(within(wc).getByRole('switch', { name: 'Run Word count' }));
    expect(ext.setExtensionEnabled).toHaveBeenCalledWith('com.examplelabs.word-count', false);
    await waitFor(() => expect(within(card('Word count')).getByText('Off')).toBeTruthy());
    expect((await screen.findAllByText('Word count turned off.')).length).toBeGreaterThan(0);
    await userEvent.click(
      within(card('Word count')).getByRole('switch', { name: 'Run Word count' }),
    );
    await waitFor(() => expect(within(card('Word count')).getByText('Running')).toBeTruthy());
  });

  it('uninstalls after a confirmation, removing its data only when asked', async () => {
    const { ext, state } = await renderWithExtensions(<ExtensionsPage />, {
      bundles: [{ bundle: wordCount() }, { bundle: notes }],
    });
    await screen.findByRole('listitem', { name: /Word count/ });
    await userEvent.click(screen.getByRole('button', { name: 'Uninstall Word count' }));
    let dialog = screen.getByRole('dialog', { name: 'Uninstall Word count?' });
    expect(dialog.textContent).toContain('stored secrets are removed');
    expect(dialog.textContent).toContain('Its data stays on the Hub');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(ext.uninstallExtension).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Uninstall Word count' }));
    dialog = screen.getByRole('dialog', { name: 'Uninstall Word count?' });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Also remove its data/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: /Word count/ })).toBeNull());
    expect(state.uninstalls).toEqual([{ id: 'com.examplelabs.word-count', removeData: true }]);

    await userEvent.click(screen.getByRole('button', { name: 'Uninstall Notes helper' }));
    dialog = screen.getByRole('dialog', { name: 'Uninstall Notes helper?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    expect(
      await screen.findByRole('heading', { name: 'No extensions are installed.' }),
    ).toBeTruthy();
    expect(state.uninstalls.at(-1)).toEqual({ id: 'com.test.notes', removeData: false });
  });

  it('stores a declared secret without ever showing it, and clears it after a confirmation', async () => {
    const { ext } = await renderWithExtensions(<ExtensionsPage />, {
      bundles: [{ bundle: notes }],
    });
    const secrets = await screen.findByRole('region', { name: 'Secrets: Notes helper' });
    const row = within(secrets).getByRole('listitem', { name: 'Secret notes.token' });
    expect(within(row).getByText('Not set')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Set notes.token' }));
    const field = within(row).getByLabelText<HTMLInputElement>('Value of notes.token');
    expect(field.type).toBe('password');
    await userEvent.type(field, 's3cret-value');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(ext.setExtensionSecret).toHaveBeenCalledWith(
      'com.test.notes',
      'notes.token',
      's3cret-value',
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('listitem', { name: 'Secret notes.token' })).getByText('Stored'),
      ).toBeTruthy(),
    );
    expect(document.body.textContent).not.toContain('s3cret-value');

    await userEvent.click(screen.getByRole('button', { name: 'Clear notes.token' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear notes.token?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    expect(ext.clearExtensionSecret).toHaveBeenCalledWith('com.test.notes', 'notes.token');
    await waitFor(() =>
      expect(
        within(screen.getByRole('listitem', { name: 'Secret notes.token' })).getByText('Not set'),
      ).toBeTruthy(),
    );
  });

  it('a hook needs trust again after an update, and a hook that changed under review shows its new hash', async () => {
    const { ext, hub } = await renderWithExtensions(<ExtensionsPage />, {
      bundles: [{ bundle: notes, trust: true }],
    });
    const hooks = await screen.findByRole('region', { name: 'Hooks: Notes helper' });
    expect(within(hooks).getByText('Trusted')).toBeTruthy();

    // The update changes the bundle, so its hook's hash changes.
    await upload({ ...notes, version: '1.1.0', digest: '2'.repeat(64) });
    const dialog = await screen.findByRole('dialog', { name: 'Update Notes helper to 1.1.0?' });
    expect(dialog.textContent).toContain('Replaces version 1.0.0.');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /I trust its source/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    expect((await screen.findAllByText('Notes helper updated.')).length).toBeGreaterThan(0);
    const after = screen.getByRole('region', { name: 'Hooks: Notes helper' });
    await waitFor(() => expect(within(after).getByText('Needs trust')).toBeTruthy());

    // The hook changes again while the dialog is open: the Hub refuses the old hash.
    await userEvent.click(
      within(after).getByRole('button', { name: 'Trust hook:com.test.notes.guard' }),
    );
    let trust = screen.getByRole('dialog', { name: 'Trust this hook?' });
    const shown = within(trust).getByTestId('ext-trust-hash').textContent;
    expect(trust.textContent).toMatch(/the action it guards is blocked/i);
    const row = hub.state.m4.hooks.find((h) => h.id === 'hook:com.test.notes.guard')!;
    const installedNotes = (await ext.getExtension('com.test.notes')).hooks[0]!;
    expect(installedNotes.contentHash).toBe(shown);
    hub.state.m4.hooks = hub.state.m4.hooks.map((h) =>
      h === row ? { ...h, contentHash: `sha256:${'3'.repeat(64)}` } : h,
    );
    await userEvent.click(within(trust).getByRole('button', { name: 'Trust' }));
    expect(await within(trust).findByText(/changed since it was shown/)).toBeTruthy();
    expect(hub.api.trustHook).toHaveBeenCalledWith('hook:com.test.notes.guard', shown);
    // The fake's view recomputes the hash from the bundle; the dialog shows what the Hub lists.
    trust = screen.getByRole('dialog', { name: 'Trust this hook?' });
    await userEvent.click(within(trust).getByRole('button', { name: 'Keep disabled' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('install from a file', () => {
  it('installs a verified bundle after the preview, trusting a ticked hook', async () => {
    const { ext, hub } = await renderWithExtensions(<ExtensionsPage />, { settings: TRUSTED });
    expect(
      await screen.findByRole('heading', { name: 'No extensions are installed.' }),
    ).toBeTruthy();
    const b = wordCount({ hooks: [{ id: 'audit', event: 'tool.post' }] });
    await upload(b);
    const dialog = await screen.findByRole('dialog', { name: 'Install Word count 1.0.0?' });
    expect(ext.previewExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'upload',
        fileName: 'com.examplelabs.word-count-1.0.0.novax',
      }),
    );
    expect(within(dialog).getByText('Verified')).toBeTruthy();
    expect(dialog.textContent).toContain('Signed by a publisher you trust: Example Labs');
    expect(within(dialog).getByRole('list', { name: 'This extension can' }).textContent).toContain(
      'Offer the tool count, which reads data',
    );
    expect(within(dialog).queryByRole('checkbox', { name: /I trust its source/ })).toBeNull();
    await userEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'Trust hook:com.examplelabs.word-count.audit now',
      }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect(ext.installExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        enable: true,
        trustHooks: [expect.objectContaining({ id: 'hook:com.examplelabs.word-count.audit' })],
      }),
    );
    expect(ext.installExtension.mock.calls[0]![0]).not.toHaveProperty('confirmSideload');
    expect((await screen.findAllByText('Word count installed.')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('listitem', { name: /Word count/ })).toBeTruthy();
    expect(
      hub.state.m4.hooks.find((h) => h.id === 'hook:com.examplelabs.word-count.audit')?.status,
    ).toBe('trusted');
  });

  it('an unverified bundle installs only after the sideload confirmation', async () => {
    const { ext } = await renderWithExtensions(<ExtensionsPage />);
    await screen.findByRole('heading', { name: 'No extensions are installed.' });
    await upload(notes);
    const dialog = await screen.findByRole('dialog', { name: 'Install Notes helper 1.0.0?' });
    expect(within(dialog).getByText('Unverified')).toBeTruthy();
    expect(dialog.textContent).toContain('The bundle is not signed. It stays labelled Unverified');
    const install = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Install' });
    expect(install.disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /I trust its source/ }));
    expect(install.disabled).toBe(false);
    await userEvent.click(install);
    expect(ext.installExtension).toHaveBeenCalledWith(
      expect.objectContaining({ confirmSideload: true }),
    );
    expect(await screen.findByRole('listitem', { name: /Notes helper/ })).toBeTruthy();
  });

  it('shows the update’s permission diff', async () => {
    await renderWithExtensions(<ExtensionsPage />, { bundles: [{ bundle: notes }] });
    await screen.findByRole('listitem', { name: /Notes helper/ });
    await upload({
      ...notes,
      version: '2.0.0',
      permissions: [
        ...notes.permissions!,
        { key: 'fs:/srv/notes', kind: 'fs', text: 'Write files in /srv/notes', sensitive: true },
      ],
    });
    const dialog = await screen.findByRole('dialog', { name: 'Update Notes helper to 2.0.0?' });
    const diff = within(dialog).getByRole('heading', { name: 'Permission changes' }).parentElement!;
    expect(diff.textContent).toContain('New: Write files in /srv/notes');
  });

  it('says why a bundle is refused, in plain words, and keeps nothing', async () => {
    const { ext } = await renderWithExtensions(<ExtensionsPage />);
    await screen.findByRole('heading', { name: 'No extensions are installed.' });
    await upload({ ...notes, signature: 'invalid' });
    expect(await screen.findByText(/its files do not match its signature/)).toBeTruthy();
    await upload({ ...notes, notExtension: true });
    expect(await screen.findByText(/This is not an extension/)).toBeTruthy();
    await upload({ ...notes, fsRefused: true });
    expect(
      await screen.findByText(/inside the Hub’s own data, which is never allowed/),
    ).toBeTruthy();
    // Not a .novax file: refused before anything is sent.
    ext.previewExtension.mockClear();
    await userEvent.upload(
      screen.getByTestId<HTMLInputElement>('novax-input'),
      new File(['x'], 'notes.zip'),
      { applyAccept: false },
    );
    expect(await screen.findByText('Choose a .novax file.')).toBeTruthy();
    expect(ext.previewExtension).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('checks a bundle or folder on the Hub by its path', async () => {
    const { ext } = await renderWithExtensions(<ExtensionsPage />, {
      extensions: { bundlesOnHub: { '/srv/ext/notes': notes } },
    });
    await screen.findByRole('heading', { name: 'No extensions are installed.' });
    await userEvent.click(screen.getByText('From a file or folder on the Hub'));
    await userEvent.type(screen.getByLabelText('Path on the Hub'), '/srv/ext/missing');
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText(/not found on the Hub: \/srv\/ext\/missing/)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Path on the Hub'));
    await userEvent.type(screen.getByLabelText('Path on the Hub'), '/srv/ext/notes');
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByRole('dialog', { name: 'Install Notes helper 1.0.0?' })).toBeTruthy();
    expect(ext.previewExtension).toHaveBeenLastCalledWith({ kind: 'path', path: '/srv/ext/notes' });
  });
});

describe('managed policy, the SDK switch and members', () => {
  const RESTRICT = {
    'managed.restrict': { layers: [{ unverifiedInstalls: false }], failClosed: null },
  };

  it('forbids unverified installs plainly, and the Hub’s refusal reads as managed', async () => {
    const { ext, hub } = await renderWithExtensions(<ExtensionsPage />, { managed: RESTRICT });
    expect(
      await screen.findByText(
        /Your organization allows only items signed by a publisher you trust/,
      ),
    ).toBeTruthy();
    expect(screen.getAllByText(/Managed by your organization/).length).toBeGreaterThan(0);
    await upload(notes);
    const dialog = await screen.findByRole('dialog', { name: 'Install Notes helper 1.0.0?' });
    expect(dialog.textContent).toContain('Your organization allows only extensions signed');
    expect(within(dialog).queryByRole('checkbox', { name: /I trust its source/ })).toBeNull();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Install' }).disabled,
    ).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // The policy arrives after the preview: the Hub refuses, and the dialog says so.
    hub.state.managed = {};
    resetDom();
    const again = await renderWithExtensions(<ExtensionsPage />);
    await screen.findByRole('heading', { name: 'No extensions are installed.' });
    await upload(notes);
    const d2 = await screen.findByRole('dialog', { name: 'Install Notes helper 1.0.0?' });
    again.hub.state.managed = RESTRICT;
    await userEvent.click(within(d2).getByRole('checkbox', { name: /I trust its source/ }));
    await userEvent.click(within(d2).getByRole('button', { name: 'Install' }));
    expect(await within(d2).findByRole('alert')).toBeTruthy();
    expect(within(d2).getByRole('alert').textContent).toMatch(/^Managed by your organization: /);
    expect(ext.installExtension).not.toHaveBeenCalled();
  });

  it('turns extensions off with the SDK switch, which managed policy can lock', async () => {
    const { hub } = await renderWithExtensions(<ExtensionsPage />, {
      bundles: [{ bundle: wordCount() }],
    });
    await screen.findByRole('listitem', { name: /Word count/ });
    await userEvent.click(screen.getByRole('switch', { name: 'Run extensions' }));
    await waitFor(() => expect(hub.state.settings['sdk.enabled']).toBe(false));
    expect(await screen.findByText(/Extensions are turned off on this Hub/)).toBeTruthy();
    resetDom();

    await renderWithExtensions(<ExtensionsPage />, { managed: { 'sdk.enabled': false } });
    const sw = await screen.findByRole('switch', { name: 'Run extensions' });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Managed by your organization/)).toBeTruthy();
  });

  it('explains nova dev for developers', async () => {
    await renderWithExtensions(<ExtensionsPage />);
    await userEvent.click(await screen.findByText('For developers'));
    expect(screen.getByText(/run nova dev with the folder of your extension/)).toBeTruthy();
    expect(screen.getByLabelText('Commands').textContent).toContain('nova dev ./my-extension');
  });

  it('shows a member the owner-only notice instead of any control', async () => {
    await renderWithExtensions(<ExtensionsPage />, { member: true });
    expect(await screen.findByText('Only the owner of this Hub can change this.')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Run extensions' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Choose a .novax file/ })).toBeNull();
  });
});
