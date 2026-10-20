// An extension update in Settings → Extensions (FR-117; docs/14 §5; the SDK review): changed
// permissions worded from their detail (a tool's `action:default`, an MCP server's JSON), the
// looser parts marked, never raw JSON; and an update by another publisher (here unsigned) said
// first and installed only after its explicit acceptance, which clears the extension's secrets.
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionsPage } from '../src/extensions/ExtensionsPage.tsx';
import { extensionErrorMessage } from '../src/extensions/format.ts';
import { ApiError } from '../src/api.ts';
import {
  PUBLISHER_KEY,
  bundleFile,
  fakeFingerprint,
  renderWithExtensions,
  type FakeBundle,
} from './fakes-m8-extensions.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

const TRUSTED = { 'plugins.trustedPublishers': [{ name: 'Example Labs', key: PUBLISHER_KEY }] };

const server = (over: Record<string, unknown>) =>
  JSON.stringify({
    transport: 'stdio',
    command: 'node',
    url: null,
    args: ['srv.js'],
    defaultApproval: 'ask',
    policy: null,
    enabledTools: null,
    disabledTools: [],
    ...over,
  });

const v1: FakeBundle = {
  id: 'com.examplelabs.helper',
  name: 'Helper',
  version: '1.0.0',
  signature: 'verified',
  publisher: { key: PUBLISHER_KEY, name: 'Example Labs' },
  digest: '1'.repeat(64),
  permissions: [
    {
      key: 'tool:lookup',
      kind: 'tool',
      text: 'Offer the tool lookup to models',
      sensitive: false,
      detail: 'read:ask',
    },
    {
      key: 'plugin.server:docs',
      kind: 'mcp_server',
      text: 'Start the MCP server docs on this Hub (node srv.js); its tools: ask you first',
      sensitive: true,
      detail: server({}),
    },
  ],
  secrets: ['helper.token'],
};

async function upload(b: FakeBundle) {
  const input = screen.getByTestId<HTMLInputElement>('novax-input');
  await userEvent.upload(input, bundleFile(b));
}

describe('an extension update (FR-117)', () => {
  it('words what changed and marks the looser parts, never raw', async () => {
    await renderWithExtensions(<ExtensionsPage />, {
      settings: TRUSTED,
      bundles: [{ bundle: v1 }],
    });
    await screen.findByRole('listitem', { name: /Helper/ });
    await upload({
      ...v1,
      version: '2.0.0',
      permissions: [
        { ...v1.permissions![0]!, detail: 'read:allow' },
        { ...v1.permissions![1]!, detail: server({ defaultApproval: 'allow' }) },
      ],
    });
    const dialog = await screen.findByRole('dialog', { name: 'Update Helper to 2.0.0?' });
    const diff = within(dialog).getByRole('heading', { name: 'Permission changes' }).parentElement!;
    expect(diff.textContent).not.toContain('Permissions are unchanged.');
    const tool = within(diff)
      .getByText('Offer the tool lookup to models', { exact: false })
      .closest('li')!;
    expect(tool.getAttribute('data-sensitive')).toBe('true');
    expect(
      within(tool).getByText('By default it: asks you first → runs without asking').tagName,
    ).toBe('STRONG');
    const srv = within(diff)
      .getByText(/Start the MCP server docs/)
      .closest('li')!;
    expect(within(srv).getByText('Its tools: ask you first → run without asking')).toBeTruthy();
    expect(diff.textContent).not.toMatch(/[{}"]|defaultApproval/);
  });

  it('says a change of publisher first and installs only once it is accepted', async () => {
    const { ext, state } = await renderWithExtensions(<ExtensionsPage />, {
      settings: TRUSTED,
      bundles: [{ bundle: v1 }],
    });
    await screen.findByRole('listitem', { name: /Helper/ });
    state.installed[0]!.secretValues.set('helper.token', 'tok');
    // The same id, now unsigned.
    await upload({ ...v1, version: '2.0.0', signature: 'unverified', publisher: null });
    const dialog = await screen.findByRole('dialog', { name: 'Update Helper to 2.0.0?' });
    const notice = within(dialog).getByText('Another publisher').closest('[role="note"]')!;
    expect(notice.textContent).toContain('The installed version: Signed by Example Labs.');
    expect(notice.textContent).toContain('This version: Not signed.');
    expect(notice.textContent).toContain('the secrets you stored for it and its data are deleted');
    expect(dialog.textContent).toContain(
      'Not signed by the publisher of the installed version (Example Labs).',
    );
    const update = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Update' });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /I trust its source/ }));
    expect(update.disabled).toBe(true);
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: /I accept the new publisher/ }),
    );
    expect(update.disabled).toBe(false);
    await userEvent.click(update);
    expect(ext.installExtension).toHaveBeenCalledWith(
      expect.objectContaining({ acceptPublisherChange: true, confirmSideload: true }),
    );
    expect(await screen.findByRole('listitem', { name: /Helper/ })).toBeTruthy();
    // It starts over: the secret stored for the old publisher's version is gone.
    expect(state.installed[0]!.secretValues.size).toBe(0);
  });

  it('shows another signer by name only when trusted, and the refusal in words', async () => {
    const other = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
    await renderWithExtensions(<ExtensionsPage />, {
      settings: TRUSTED,
      bundles: [{ bundle: v1 }],
    });
    await screen.findByRole('listitem', { name: /Helper/ });
    await upload({ ...v1, version: '2.0.0', publisher: { key: other, name: 'Example Labs' } });
    const dialog = await screen.findByRole('dialog', { name: 'Update Helper to 2.0.0?' });
    const notice = within(dialog).getByText('Another publisher').closest('[role="note"]')!;
    // The bundle claims "Example Labs" for a key nobody trusts: its fingerprint, not that name.
    expect(notice.textContent).toContain(
      `This version: Signed with the key ${fakeFingerprint(other)}, not trusted.`,
    );
    expect(
      extensionErrorMessage(
        new ApiError(400, {
          code: 'validation',
          message: 'confirm the change of publisher',
          retryable: false,
          details: { reason: 'publisher_change_confirmation_required' },
        }),
      ),
    ).toBe(
      'This version comes from another publisher than the installed one. Tick that you accept the new publisher to install it.',
    );
  });
});
