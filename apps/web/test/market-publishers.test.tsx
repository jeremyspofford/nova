// Who signed and what an update changes (FR-049, FR-117; docs/14 §5, docs/08 §7; the marketplace
// review): a publisher is named only with the owner's own name for a key they trust, otherwise by
// its fingerprint and "not trusted" (cards, details, the install dialog), never the name a catalog
// claims; an untrusted bundle signer's warning; an update's changed MCP server worded part by part
// with the looser approval standing out (never raw JSON); an extension update by another
// publisher said first and installed only after its explicit acceptance.
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { MarketInstallView, MarketPermissionLine } from '@nova/shared';
import { PublisherChangeNotice } from '../src/market/Changes.tsx';
import {
  describeChange,
  marketErrorMessage,
  marketPublisherText,
  publisherSideText,
  shortKey,
} from '../src/market/format.ts';
import { MarketplacePage } from '../src/market/MarketplacePage.tsx';
import { ApiError } from '../src/api.ts';
import { fakeFingerprint } from './fakes-m8-extensions.ts';
import {
  EXAMPLE_LABS_KEY,
  SAMPLE_KEY,
  item,
  publisherOf,
  renderWithMarket,
  sampleItems,
  type FakeItem,
} from './fakes-m8-market.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const OTHER_KEY = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
const card = (name: string) => screen.getByRole('listitem', { name });
const TRUST_LABS = {
  'plugins.trustedPublishers': [{ name: 'Example Labs', key: EXAMPLE_LABS_KEY }],
};

function installedView(over: Partial<MarketInstallView>): MarketInstallView {
  return {
    kind: 'plugin',
    itemId: 'com.examplelabs.release-notes',
    name: 'Release notes',
    version: '1.0.0',
    catalogId: 'nova-sample',
    origin: 'nova-sample/com.examplelabs.release-notes@1.0.0',
    verified: true,
    publisherKey: SAMPLE_KEY,
    sha256: null,
    commit: null,
    permissions: [],
    installedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

const server = (over: Record<string, unknown>) =>
  JSON.stringify({
    transport: 'stdio',
    command: 'node',
    url: null,
    args: ['server.js'],
    defaultApproval: 'ask',
    policy: { network: ['api.a.example'] },
    enabledTools: ['lookup'],
    disabledTools: ['erase'],
    ...over,
  });

describe('who signed (FR-049)', () => {
  it('names a publisher only for a key the owner trusts, else its fingerprint and not trusted', async () => {
    window.history.replaceState(null, '', '/marketplace');
    await renderWithMarket(<MarketplacePage tab={null} />);
    const fp = fakeFingerprint(EXAMPLE_LABS_KEY);
    const words = await screen.findByRole('listitem', { name: 'Word count' });
    expect(words.textContent).toContain(`Signed with the key ${fp}, not trusted`);
    // The catalog calls the key "Example Labs": never shown as the publisher.
    expect(words.textContent).not.toContain('Signed by Example Labs');
    expect(card('Release notes').textContent).toContain(
      `Signed with a key you trust (${fakeFingerprint(SAMPLE_KEY)})`,
    );

    await userEvent.click(within(words).getByRole('button', { name: 'Details of Word count' }));
    const details = await screen.findByRole('dialog');
    expect(within(details).getByText('Signature').nextElementSibling!.textContent).toBe(
      `Signed with the key ${fp}, not trusted`,
    );
    await userEvent.click(within(details).getByRole('button', { name: /Close/ }));

    // The bundle's signer is not trusted: Unverified, with the Hub's warning.
    await userEvent.click(within(words).getByRole('button', { name: 'Install Word count' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Word count 1.0.0?' });
    expect(within(dialog).getByText('Unverified')).toBeTruthy();
    expect(dialog.textContent).toContain(`Signed with the key ${fp}, not trusted`);
    expect(within(dialog).getByRole('list', { name: 'Why it is Unverified' }).textContent).toBe(
      'Its bundle is signed by a key you do not trust.',
    );
    expect(within(dialog).getByRole('list', { name: 'Warnings' }).textContent).toContain(
      `Signed by a publisher you have not trusted (key ${fp}); the name the catalog gives it is not checked.`,
    );
  });

  it('uses the owner’s own name once they trust the key, and the item is Verified', async () => {
    window.history.replaceState(null, '', '/marketplace');
    await renderWithMarket(<MarketplacePage tab={null} />, { settings: TRUST_LABS });
    const words = await screen.findByRole('listitem', { name: 'Word count' });
    expect(words.textContent).toContain('Signed by Example Labs');
    await userEvent.click(within(words).getByRole('button', { name: 'Install Word count' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Word count 1.0.0?' });
    expect(within(dialog).getByText('Verified')).toBeTruthy();
    // What vouches, by name: the catalog (its pinned key) and the bundle's trusted publisher.
    expect(dialog.textContent).toContain(
      `Verified: listed in Sample catalog, signed with the key this catalog pins (${fakeFingerprint(SAMPLE_KEY)}).`,
    );
    expect(dialog.textContent).toContain(
      'Its bundle is signed by Example Labs, a publisher you trust.',
    );
    expect(within(dialog).queryByRole('list', { name: 'Warnings' })).toBeNull();
  });

  it('shows no author for an item that names none of its own, only who signed it', async () => {
    // The Hub no longer falls back to the catalog's name for the signing key: `author` is null.
    window.history.replaceState(null, '', '/marketplace');
    const quiet: FakeItem = {
      detail: item({
        kind: 'plugin',
        id: 'com.examplelabs.quiet',
        name: 'Quiet tool',
        author: null,
        publisher: publisherOf(EXAMPLE_LABS_KEY),
      }),
      details: { hooks: [], mcpServers: [], skills: [], roles: [], uiEntryPoints: [] },
    };
    const market = { items: [...sampleItems(), quiet] };
    const r = await renderWithMarket(<MarketplacePage tab={null} />, { market });
    const untrusted = await screen.findByRole('listitem', { name: 'Quiet tool' });
    expect(untrusted.textContent).not.toMatch(/\bBy /);
    expect(untrusted.textContent).not.toContain('Example Labs');
    expect(untrusted.textContent).toContain(
      `Signed with the key ${fakeFingerprint(EXAMPLE_LABS_KEY)}, not trusted`,
    );
    r.unmount();
    await renderWithMarket(<MarketplacePage tab={null} />, { market, settings: TRUST_LABS });
    const trusted = await screen.findByRole('listitem', { name: 'Quiet tool' });
    expect(trusted.textContent).not.toMatch(/\bBy /);
    expect(trusted.textContent).toContain('Signed by Example Labs');
  });

  it('words publishers and their changes', () => {
    const p = publisherOf(OTHER_KEY);
    expect(marketPublisherText(p)).toBe(
      `Signed with the key ${fakeFingerprint(OTHER_KEY)}, not trusted`,
    );
    // A name the Hub sends for a key nobody trusts is still not shown.
    expect(marketPublisherText({ ...p, name: 'Claimed Corp' })).not.toContain('Claimed Corp');
    expect(marketPublisherText({ ...p, name: 'Example Labs', trusted: true })).toBe(
      'Signed by Example Labs',
    );
    expect(marketPublisherText({ ...p, fingerprint: '', trusted: true })).toBe(
      `Signed with a key you trust (${shortKey(OTHER_KEY)})`,
    );
    expect(publisherSideText({ key: null, name: null, fingerprint: null, trusted: false })).toBe(
      'Not signed',
    );
  });
});

describe('what an update changes (FR-049)', () => {
  it('words a changed MCP server part by part, the looser parts standing out, never raw', async () => {
    window.history.replaceState(null, '', '/marketplace');
    const before: MarketPermissionLine = {
      key: 'mcp_server:notes',
      kind: 'mcp_server',
      text: 'Add the MCP server notes, which runs node server.js; its tools ask you first',
      detail: server({}),
    };
    const after: MarketPermissionLine = {
      ...before,
      text: 'Add the MCP server notes, which runs node server2.js --fast; its tools run without asking',
      detail: server({
        args: ['server2.js', '--fast'],
        defaultApproval: 'allow',
        policy: { network: ['api.a.example', 'api.b.example'] },
        enabledTools: null,
        disabledTools: [],
      }),
    };
    const v2: FakeItem = {
      detail: item({
        kind: 'plugin',
        id: 'com.examplelabs.release-notes',
        name: 'Release notes',
        version: '2.0.0',
      }),
      own: [after],
      details: {},
    };
    await renderWithMarket(<MarketplacePage tab={null} />, {
      market: {
        items: [...sampleItems(), v2],
        installed: [installedView({ permissions: [before] })],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Update Release notes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update Release notes to 2.0.0?' });
    const diff = within(dialog).getByRole('heading', { name: 'Permission changes' }).parentElement!;
    const line = within(diff).getByText(after.text, { exact: false }).closest('li')!;
    expect(line.getAttribute('data-sensitive')).toBe('true');
    const parts = within(line)
      .getAllByRole('listitem')
      .map((li) => [li.textContent, li.hasAttribute('data-sensitive')]);
    expect(parts).toEqual([
      ['What it runs: runs node server.js → runs node server2.js --fast', true],
      ['Sites it may reach: api.a.example → api.a.example, api.b.example', true],
      ['Its tools: ask you first → run without asking', true],
      ['Tools it offers: lookup → all its tools', true],
      ['Tools turned off: erase → none', true],
    ]);
    expect(within(line).getByText('Its tools: ask you first → run without asking').tagName).toBe(
      'STRONG',
    );
    expect(diff.textContent).not.toMatch(/[{}"]|defaultApproval/);
  });

  it('describes every kind of change in words, and flags what it cannot word', () => {
    const c = (key: string, before: string | null, after: string | null) => ({
      key,
      text: 'x',
      before,
      after,
    });
    // Tightening is not sensitive.
    const tighter = describeChange(
      c('mcp_server:a', server({ defaultApproval: 'allow' }), server({ defaultApproval: 'ask' })),
    );
    expect(tighter.sensitive).toBe(false);
    expect(tighter.fields).toEqual([
      {
        label: 'Its tools',
        before: 'run without asking',
        after: 'ask you first',
        sensitive: false,
      },
    ]);
    // An extension's MCP server line (`plugin.server:`), its kind given by the preview's lines.
    expect(
      describeChange(
        c(
          'plugin.server:a',
          server({}),
          server({ policy: { network: ['api.a.example'], fs: 'project' } }),
        ),
        'mcp_server',
      ).fields,
    ).toEqual([
      {
        label: 'Files it may use',
        before: 'not set',
        after: 'the project’s files',
        sensitive: true,
      },
    ]);
    // An extension's tool (`action:default`) and a plugin's (`action, default`).
    expect(describeChange(c('tool:count', 'read:ask', 'write:allow')).fields).toEqual([
      { label: 'What it does', before: 'read', after: 'write', sensitive: true },
      {
        label: 'By default it',
        before: 'asks you first',
        after: 'runs without asking',
        sensitive: true,
      },
    ]);
    expect(describeChange(c('tool:x', 'read, allow', 'read, ask')).sensitive).toBe(false);
    // File access of an extension.
    expect(describeChange(c('fs:/srv', 'r', 'rw'), 'fs').fields[0]).toEqual({
      label: 'Access',
      before: 'read',
      after: 'read and write',
      sensitive: true,
    });
    // Hooks, roles and panels: canonical JSON, worded.
    const hook = describeChange(
      c(
        'plugin.hook:guard',
        JSON.stringify({
          event: 'tool.pre',
          handler: { type: 'command', command: ['node', 'a.mjs'] },
          failClosed: true,
        }),
        JSON.stringify({
          event: 'tool.pre',
          handler: { type: 'command', command: ['node', 'b.mjs'] },
          failClosed: false,
        }),
      ),
      'hook',
    );
    expect(hook.fields.map((f) => [f.label, f.before, f.after, f.sensitive])).toEqual([
      ['What it runs', 'runs node a.mjs', 'runs node b.mjs', true],
      ['Blocks the action when it fails', 'yes', 'no', true],
    ]);
    expect(
      describeChange(
        c(
          'plugin.role:r',
          JSON.stringify({ tools: ['read'] }),
          JSON.stringify({ tools: ['read', 'send'], modelHint: 'fast' }),
        ),
        'role',
      ).fields,
    ).toEqual([
      { label: 'Tools it may use', before: 'read', after: 'read, send', sensitive: true },
      { label: 'Model it suggests', before: 'not set', after: 'fast', sensitive: false },
    ]);
    expect(
      describeChange(
        c(
          'panel:p',
          JSON.stringify({ entryPoint: 'thread', connectDomains: ['a.example'] }),
          JSON.stringify({ entryPoint: 'global', connectDomains: ['a.example'] }),
        ),
        'panel',
      ).fields,
    ).toEqual([{ label: 'Where it shows', before: 'thread', after: 'global', sensitive: false }]);
    // Parts Nova cannot word, or JSON it cannot read: flagged, never shown, counted sensitive.
    const odd = describeChange(
      c('plugin.hook:h', JSON.stringify({ secretSauce: 1 }), JSON.stringify({ secretSauce: 2 })),
    );
    expect(odd).toMatchObject({ unreadable: true, sensitive: true, fields: [] });
    expect(describeChange(c('mcp_server:a', '{broken', server({})))).toMatchObject({
      unreadable: true,
      sensitive: true,
    });
    // A plain detail reads as it is.
    expect(describeChange(c('hook:h', 'tool.pre node a.mjs', 'tool.pre node b.mjs')).plain).toBe(
      true,
    );
  });
});

describe('an extension update by another publisher (FR-117)', () => {
  const change = {
    from: {
      key: EXAMPLE_LABS_KEY,
      name: 'Example Labs',
      fingerprint: fakeFingerprint(EXAMPLE_LABS_KEY),
      trusted: true,
    },
    to: {
      key: OTHER_KEY,
      name: null,
      fingerprint: fakeFingerprint(OTHER_KEY),
      trusted: false,
    },
  };

  it('is said first and installs only after the new publisher is accepted', async () => {
    window.history.replaceState(null, '', '/marketplace');
    const v2: FakeItem = {
      detail: item({
        kind: 'plugin',
        id: 'com.examplelabs.word-count',
        name: 'Word count',
        version: '2.0.0',
        publisher: publisherOf(OTHER_KEY),
      }),
      bundle: true,
      publisherChange: change,
      details: {},
    };
    const { market } = await renderWithMarket(<MarketplacePage tab={null} />, {
      settings: TRUST_LABS,
      market: {
        items: [...sampleItems().filter((i) => i.detail.name !== 'Word count'), v2],
        installed: [
          installedView({
            itemId: 'com.examplelabs.word-count',
            name: 'Word count',
            publisherKey: EXAMPLE_LABS_KEY,
          }),
        ],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Update Word count' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update Word count to 2.0.0?' });
    const notice = within(dialog).getByText('Another publisher').closest('[role="note"]')!;
    expect(notice.textContent).toContain('The installed version: Signed by Example Labs.');
    expect(notice.textContent).toContain(
      `This version: Signed with the key ${fakeFingerprint(OTHER_KEY)}, not trusted.`,
    );
    expect(notice.textContent).toContain('the secrets you stored for it and its data are deleted');
    expect(
      within(dialog).getByRole('list', { name: 'Warnings' }).firstElementChild!.textContent,
    ).toMatch(/^Another publisher: the installed version is signed by Example Labs/);
    const update = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Update' });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /I trust its source/ }));
    expect(update.disabled).toBe(true);
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: /I accept the new publisher/ }),
    );
    expect(update.disabled).toBe(false);
    // The Hub refuses once (say the preview it answered changed): the words, and the form stays.
    market.installMarketItem.mockRejectedValueOnce(
      new ApiError(400, {
        code: 'validation',
        message: 'accept the change to install it',
        retryable: false,
        details: {
          field: 'acceptPublisherChange',
          reason: 'publisher_change_confirmation_required',
          from: EXAMPLE_LABS_KEY,
          to: OTHER_KEY,
        },
      }),
    );
    await userEvent.click(update);
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This version comes from another publisher than the installed one. Tick that you accept the new publisher to install it.',
    );
    expect(
      within(dialog).getByRole<HTMLInputElement>('checkbox', { name: /I accept the new publisher/ })
        .checked,
    ).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Update Word count to 2.0.0?' })).toBe(dialog);
    await userEvent.click(update);
    expect(market.installMarketItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ acceptPublisherChange: true, confirmSideload: true }),
    );
    expect((await screen.findAllByText('Word count updated.')).length).toBeGreaterThan(0);
  });

  it('the notice’s checkbox reports its state, and the Hub’s refusal reads plainly', async () => {
    const seen: boolean[] = [];
    render(
      <PublisherChangeNotice change={change} accepted={false} onAccept={(v) => seen.push(v)} />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /I accept the new publisher/ }));
    expect(seen).toEqual([true]);
    expect(
      marketErrorMessage(
        new ApiError(400, {
          code: 'validation',
          message: 'accept the change',
          retryable: false,
          details: { reason: 'publisher_change_confirmation_required' },
        }),
      ),
    ).toBe(
      'This version comes from another publisher than the installed one. Tick that you accept the new publisher to install it.',
    );
  });
});
