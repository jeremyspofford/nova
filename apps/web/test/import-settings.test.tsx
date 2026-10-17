import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { CommandRegistry } from '../src/commands.ts';
import {
  defaultSelection,
  groupItems,
  parsePaths,
  selectable,
} from '../src/settings/ImportPage.tsx';
import { registerWorkspaceCommands } from '../src/workspace-commands.ts';
import { createHub } from './fakes.ts';
import { m4State } from './fakes-m4.ts';
import { importItem } from './fakes-m4-settings.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const fail = (message: string, status = 500, code = 'x') =>
  new ApiError(status, { code, message, retryable: false });

const ITEMS = [
  importItem({ id: 'i1', name: 'review-pr', target: 'skill review-pr' }),
  importItem({ id: 'i2', name: 'standup', target: 'skill standup', status: 'duplicate' }),
  importItem({
    id: 'i3',
    kind: 'mcp_servers',
    name: 'github',
    target: 'MCP server github (disabled)',
    sourcePath: '/home/me/.config/assistant/mcp.json',
    maskedSecrets: ['GITHUB_TOKEN=ghp_••••••a1b2'],
  }),
  importItem({
    id: 'i4',
    kind: 'commands',
    name: 'deploy',
    target: 'skill deploy',
    status: 'conflict',
    note: 'A skill named deploy exists.',
  }),
  importItem({
    id: 'i5',
    kind: 'chats',
    name: 'export.zip',
    target: '312 chats',
    status: 'unsupported',
    note: 'Unknown export format.',
  }),
  importItem({
    id: 'i6',
    kind: 'memories',
    name: 'memories.json',
    target: '148 memory suggestions',
  }),
];

describe('import helpers (FR-200)', () => {
  it('parses folder lines, groups items by kind and picks new items', () => {
    expect(parsePaths('  /a \n\n/b\n/a')).toEqual({ paths: ['/a', '/b'] });
    expect(parsePaths(' \n ')).toEqual({ error: 'Enter at least one folder or file on the Hub.' });
    expect(parsePaths('relative/dir')).toEqual({ error: 'Use a full path: relative/dir' });
    expect(parsePaths(Array.from({ length: 21 }, (_, i) => `/p${i}`).join('\n'))).toHaveProperty(
      'error',
    );
    expect(groupItems(ITEMS).map((g) => [g.kind, g.items.map((i) => i.id)])).toEqual([
      ['skills', ['i1', 'i2']],
      ['commands', ['i4']],
      ['mcp_servers', ['i3']],
      ['memories', ['i6']],
      ['chats', ['i5']],
    ]);
    expect([...defaultSelection(ITEMS)].sort()).toEqual(['i1', 'i3', 'i6']);
    expect(ITEMS.map(selectable)).toEqual([true, false, true, true, false, true]);
  });

  it('is in the command palette', () => {
    const registry = new CommandRegistry({ mac: false, browserTab: false });
    const go = vi.fn();
    const off = registerWorkspaceCommands(registry, { navigate: go });
    registry.run('import.open');
    registry.run('plugins.browse');
    expect(go.mock.calls.map((c) => c[0])).toEqual(['/settings/import', '/settings/plugins']);
    off();
  });
});

describe('Settings → Import (FR-200, docs/04 §2.11)', () => {
  it('walks source → choose → review → import, then shows the records', async () => {
    const hub = createHub({
      m4: m4State({
        importPreview: { previewId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70', items: ITEMS },
      }),
    });
    await renderApp({ hub, path: '/settings/import' });
    expect(await screen.findByRole('heading', { name: 'Step 1 of 4: Where to look' })).toBeTruthy();
    expect(await screen.findByText('Nothing imported yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
    expect(screen.getByText('Enter at least one folder or file on the Hub.')).toBeTruthy();
    const paths = screen.getByRole('textbox', { name: 'Folders or files on the Hub' });
    await userEvent.type(paths, '/home/me/.config/assistant{Enter}/home/me/chat-export.zip');
    await userEvent.click(screen.getByRole('checkbox', { name: /Plugins/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
    await waitFor(() =>
      expect(hub.api.importPreview).toHaveBeenCalledWith({
        paths: ['/home/me/.config/assistant', '/home/me/chat-export.zip'],
        kinds: [
          'instructions',
          'skills',
          'commands',
          'mcp_servers',
          'projects',
          'memories',
          'chats',
        ],
      }),
    );

    const step2 = await screen.findByRole('heading', {
      name: 'Step 2 of 4: Choose what to import',
    });
    await waitFor(() => expect(document.activeElement).toBe(step2));
    const skills = screen.getByRole('group', { name: 'Skills: 2, 1 already imported' });
    const review = within(skills).getByRole<HTMLInputElement>('checkbox', { name: /^review-pr/ });
    expect(review.checked).toBe(true);
    const dupe = within(skills).getByRole<HTMLInputElement>('checkbox', { name: /^standup/ });
    expect(dupe.checked).toBe(false);
    expect(dupe.disabled).toBe(true);
    expect(within(skills).getByText('Already imported')).toBeTruthy();
    const conflict = screen.getByRole<HTMLInputElement>('checkbox', { name: /^deploy/ });
    expect(conflict.checked).toBe(false);
    expect(conflict.disabled).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /^export\.zip/ }).disabled).toBe(
      true,
    );
    expect(screen.getByText('1 secret found; moved to the vault')).toBeTruthy();
    await userEvent.click(conflict);
    await userEvent.click(screen.getByRole('checkbox', { name: /^memories\.json/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Review 3 items' }));

    expect(
      await screen.findByRole('heading', { name: 'Step 3 of 4: Review before importing' }),
    ).toBeTruthy();
    expect(
      screen.getByText('3 items will be imported: Skills (1), Commands (1), MCP servers (1).'),
    ).toBeTruthy();
    expect(screen.getByText('GITHUB_TOKEN=ghp_••••••a1b2')).toBeTruthy();
    expect(
      screen.getByText('deploy becomes skill deploy: A skill named deploy exists.'),
    ).toBeTruthy();
    expect(screen.getByText('MCP server github (disabled)')).toBeTruthy();
    // Back keeps the selection.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /^deploy/ }).checked).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Review 3 items' }));

    hub.state.failNext.importApply = fail('The Hub ran out of space');
    await userEvent.click(screen.getByRole('button', { name: 'Import 3 items' }));
    expect(await screen.findByText('The Hub ran out of space')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Step 3 of 4: Review before importing' }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Import 3 items' }));
    await waitFor(() =>
      expect(hub.api.importApply).toHaveBeenLastCalledWith('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70', [
        'i1',
        'i3',
        'i4',
      ]),
    );
    expect(await screen.findByRole('heading', { name: 'Step 4 of 4: Done' })).toBeTruthy();
    const done = screen.getByRole('status');
    expect(within(done).getByText('Imported').nextElementSibling?.textContent).toBe('3 items');
    expect(
      within(done).getByText('Left off until you confirm them').nextElementSibling?.textContent,
    ).toBe('1 item');
    expect(
      within(done).getByText('Secrets moved to the vault').nextElementSibling?.textContent,
    ).toBe('1 secret');
    const records = await screen.findByRole('table', { name: 'Import records' });
    expect(within(records).getAllByRole('row')).toHaveLength(4);
    expect(
      within(records).getByRole('rowheader', { name: 'MCP server github (disabled)' }),
    ).toBeTruthy();
    await userEvent.click(within(done).getByRole('link', { name: 'import records' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Import records' }));

    await userEvent.click(screen.getByRole('button', { name: 'Import something else' }));
    expect(await screen.findByRole('heading', { name: 'Step 1 of 4: Where to look' })).toBeTruthy();
  });

  it('reports a failed scan and an empty result, and needs a kind', async () => {
    const hub = createHub({
      m4: m4State({
        importPreview: { previewId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a71', items: [] },
      }),
    });
    hub.state.failNext.importRecords = fail('Ledger unavailable');
    await renderApp({ hub, path: '/settings/import' });
    expect(await screen.findByText('Ledger unavailable')).toBeTruthy();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Folders or files on the Hub' }),
      '/nowhere',
    );
    for (const box of screen.getAllByRole<HTMLInputElement>('checkbox'))
      if (box.checked) await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
    expect(screen.getByText('Choose at least one kind of item.')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Skills' }));
    hub.state.failNext.importPreview = fail('/nowhere does not exist', 400, 'validation');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
    expect(await screen.findByText('/nowhere does not exist')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
    expect(await screen.findByText('Nothing to import was found there.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Review 0 items' }).disabled).toBe(
      true,
    );
  });

  it('is linked from onboarding', async () => {
    const hub = createHub({
      settings: { 'onboarding.state': { step: 'tool', completed: false, skipped: false } },
    });
    await renderApp({ hub, path: '/onboarding' });
    await userEvent.click(await screen.findByRole('link', { name: /Import its skills, servers/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/settings/import'));
    expect(await screen.findByRole('heading', { name: 'Import', level: 2 })).toBeTruthy();
  });
});
