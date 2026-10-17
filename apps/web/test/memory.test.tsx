import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { checkMemoryJson, groupMemories } from '../src/settings/MemoryPage.tsx';
import { createHub, thread } from './fakes.ts';
import { memoryItem, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const fail = (message: string) => new ApiError(500, { code: 'x', message, retryable: true });
const item = (name: string | RegExp) => screen.getByRole('listitem', { name });

describe('groupMemories', () => {
  it('sorts named categories A to Z and puts uncategorized last, keeping item order', () => {
    const a = memoryItem({ category: 'work', content: 'a' });
    const b = memoryItem({ category: null, content: 'b' });
    const c = memoryItem({ category: 'Travel', content: 'c' });
    const d = memoryItem({ category: 'Work', content: 'd' });
    const e = memoryItem({ category: '  ', content: 'e' });
    const groups = groupMemories([a, b, c, d, e]);
    expect(groups.map((g) => g.category)).toEqual(['Travel', 'work', 'Work', null]);
    expect(groups.at(-1)!.items.map((m) => m.content)).toEqual(['b', 'e']);
  });

  it('checks a JSON export before sending it', () => {
    expect(checkMemoryJson('["a", {"content": "b", "category": "x"}]')).toBeNull();
    expect(checkMemoryJson('[1]')).toMatch(/Each entry/);
    expect(checkMemoryJson('{"content": "a"}')).toMatch(/JSON array/);
    expect(checkMemoryJson('not json')).toMatch(/not valid JSON/);
  });
});

describe('Settings → Memory (FR-032)', () => {
  it('turns memory off and on, groups items, and links to the source chat', async () => {
    const t = thread({ title: 'Trip planning' });
    const hub = createHub({
      threads: [t],
      workspace: workspaceState({
        memory: [
          memoryItem({
            content: 'Trip to Lisbon in September',
            category: 'Travel',
            sourceThreadId: t.id,
            sourceMessageId: 'm9',
          }),
          memoryItem({ content: 'Leads the billing team', category: 'Work', pinned: true }),
          memoryItem({ content: 'Likes tea', category: null, sourceKind: 'manual' }),
        ],
      }),
    });
    await renderApp({ hub, path: '/settings/memory' });
    const toggle = screen.getByRole('switch', { name: 'Use saved memories' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-describedby')).toBeTruthy();
    await userEvent.click(toggle);
    await waitFor(() => expect(hub.state.settings['memory.enabled']).toBe(false));
    expect(screen.getByText(/Memory is off/)).toBeTruthy();
    await userEvent.click(toggle);
    await waitFor(() => expect(hub.state.settings['memory.enabled']).toBe(true));

    const groups = await screen.findAllByRole('region');
    const names = groups.map((g) => g.getAttribute('aria-label')).filter(Boolean);
    expect(names).toEqual(expect.arrayContaining(['Travel', 'Work', 'Other']));
    expect(names.indexOf('Other')).toBeGreaterThan(names.indexOf('Work'));
    expect(within(item('Leads the billing team')).getByText('Pinned')).toBeTruthy();
    expect(within(item('Likes tea')).getByText('Added by you')).toBeTruthy();
    const link = within(item(/Lisbon/)).getByRole('link', { name: 'From “Trip planning”' });
    await userEvent.click(link);
    expect(window.location.pathname + window.location.search).toBe(`/chat/${t.id}?m=m9`);
  });

  it('pins, corrects, dismisses with undo, restores and deletes', async () => {
    const hub = createHub({
      workspace: workspaceState({
        memory: [memoryItem({ content: 'Lives in Porto', category: 'Home' })],
      }),
    });
    await renderApp({ hub, path: '/settings/memory' });
    const row = () => item('Lives in Porto');
    await screen.findByRole('listitem', { name: 'Lives in Porto' });

    await userEvent.click(within(row()).getByRole('button', { name: 'Pin' }));
    expect(await within(row()).findByText('Pinned')).toBeTruthy();
    expect(hub.state.workspace.memory[0]!.pinned).toBe(true);
    await userEvent.click(within(row()).getByRole('button', { name: 'Unpin' }));
    await waitFor(() => expect(within(row()).queryByText('Pinned')).toBeNull());

    // Correct: Escape cancels and refocuses; Save sends only what changed.
    await userEvent.click(within(row()).getByRole('button', { name: 'Correct' }));
    const form = screen.getByRole('form', { name: 'Correct this memory' });
    expect(document.activeElement).toBe(within(form).getByRole('textbox', { name: 'Memory' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(row()).getByRole('button', { name: 'Correct' })),
    );
    await userEvent.click(within(row()).getByRole('button', { name: 'Correct' }));
    const box = screen.getByRole('textbox', { name: 'Memory' });
    await userEvent.clear(box);
    await userEvent.type(box, 'Lives in Lisbon');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(hub.api.updateMemory).toHaveBeenLastCalledWith(expect.any(String), {
        content: 'Lives in Lisbon',
      }),
    );
    const moved = await screen.findByRole('listitem', { name: 'Lives in Lisbon' });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(moved).getByRole('button', { name: 'Correct' })),
    );

    await userEvent.click(within(moved).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Lives in Lisbon' })).toBeNull(),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('listitem', { name: 'Lives in Lisbon' })).toBeTruthy();
    await userEvent.click(within(item('Lives in Lisbon')).getByRole('button', { name: 'Dismiss' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'dismissed');
    const dismissed = await screen.findByRole('listitem', { name: 'Lives in Lisbon' });
    await userEvent.click(within(dismissed).getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Lives in Lisbon' })).toBeNull(),
    );
    expect(hub.state.workspace.memory[0]!.status).toBe('active');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'active');

    await userEvent.click(
      within(await screen.findByRole('listitem', { name: 'Lives in Lisbon' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete this memory?' });
    expect(within(dialog).getByText('Lives in Lisbon')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Memory deleted.')).toBeTruthy();
    expect(hub.state.workspace.memory).toEqual([]);
    expect(screen.getByRole('heading', { name: 'No memories yet' })).toBeTruthy();
  });

  it('adds by hand, imports text and JSON, and filters', async () => {
    const hub = createHub({
      workspace: workspaceState({ memory: [memoryItem({ content: 'Likes tea' })] }),
    });
    await renderApp({ hub, path: '/settings/memory' });
    await screen.findByRole('listitem', { name: 'Likes tea' });

    await userEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    const add = screen.getByRole('dialog', { name: 'Add a memory' });
    expect(document.activeElement).toBe(within(add).getByRole('textbox', { name: 'Memory' }));
    await userEvent.keyboard('Uses metric units');
    await userEvent.type(within(add).getByRole('textbox', { name: 'Category' }), 'Prefs{Enter}');
    await waitFor(() =>
      expect(hub.api.createMemory).toHaveBeenCalledWith({
        content: 'Uses metric units',
        category: 'Prefs',
      }),
    );
    expect(await screen.findByRole('listitem', { name: 'Uses metric units' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Prefs' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    let dialog = screen.getByRole('dialog', { name: 'Import memories' });
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Export to import' }),
      'Likes tea{Enter}Owns a bike',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await within(dialog).findByText('Imported 1 memory. Skipped 1 duplicate.')).toBeTruthy();
    expect(hub.api.importMemory).toHaveBeenCalledWith({
      format: 'text',
      data: 'Likes tea\nOwns a bike',
    });
    expect(await screen.findByRole('listitem', { name: 'Owns a bike' })).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Import more' }));
    await userEvent.click(within(dialog).getByRole('radio', { name: 'JSON' }));
    const area = within(dialog).getByRole('textbox', { name: 'Export to import' });
    await userEvent.type(area, 'oops');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/not valid JSON/);
    expect(hub.api.importMemory).toHaveBeenCalledTimes(1);
    await userEvent.clear(area);
    await userEvent.click(area);
    await userEvent.paste('[{"content": "Speaks Portuguese", "category": "Language"}]');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(
      await within(dialog).findByText('Imported 1 memory. Skipped 0 duplicates.'),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    dialog = screen.queryByRole('dialog') as HTMLElement;
    expect(dialog).toBeNull();
    expect(await screen.findByRole('region', { name: 'Language' })).toBeTruthy();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter memories' }), 'bike');
    expect(screen.getByRole('listitem', { name: 'Owns a bike' })).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'Likes tea' })).toBeNull();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter memories' }), 'zzz');
    expect(screen.getByText('No memories match “bikezzz”.')).toBeTruthy();
  });

  it('reports load and update failures, and shows a managed lock', async () => {
    const hub = createHub({
      managed: { 'memory.enabled': false },
      workspace: workspaceState({ memory: [memoryItem({ content: 'Likes tea' })] }),
    });
    await renderApp({ hub, path: '/settings/general' });
    hub.state.failNext.listMemory = fail('Hub busy');
    await userEvent.click(screen.getByRole('link', { name: 'Memory' }));
    expect(await screen.findByText('Hub busy')).toBeTruthy();
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: 'Use saved memories' });
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const row = await screen.findByRole('listitem', { name: 'Likes tea' });
    hub.state.failNext.updateMemory = fail('Conflict');
    await userEvent.click(within(row).getByRole('button', { name: 'Pin' }));
    expect(await screen.findByText('Could not update the memory: Conflict')).toBeTruthy();
    expect(within(row).queryByText('Pinned')).toBeNull();

    hub.state.failNext.createMemory = fail('Too long');
    await userEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    await userEvent.keyboard('Something');
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add memory' }),
    );
    expect(await within(screen.getByRole('dialog')).findByText('Too long')).toBeTruthy();
  });
});
