// `@`-mentions in the composer (FR-022, docs/04 §3): a fuzzy, grouped popover from GET /mentions,
// keyboard-only operation with the ARIA combobox pattern, removable chips sent with the message.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { MentionCandidate } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { message } from './fakes.ts';
import { announcer, openWith } from './chat-m3-helpers.tsx';
import { box } from './chat-helpers.tsx';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const CANDIDATES: MentionCandidate[] = [
  { kind: 'tool', ref: 'tool:fs.read', label: 'fs.read', detail: 'Read a file' },
  { kind: 'file', ref: 'file:/w/README.md', label: 'README.md', detail: '/w' },
  { kind: 'folder', ref: 'folder:/w/docs', label: 'docs', detail: null },
  { kind: 'mcp_server', ref: 'mcp:files', label: 'files', detail: 'MCP server' },
  { kind: 'file', ref: 'file:/w/docs/read-later.md', label: 'read-later.md', detail: '/w/docs' },
];

const listbox = () => screen.findByRole('listbox', { name: 'Mention suggestions' });
const combobox = () => screen.getByRole('combobox', { name: 'Message' });

describe('@-mentions (FR-022)', () => {
  it('opens a grouped popover, moves with arrows, chooses with Enter and sends the chip', async () => {
    const { hub, t } = await openWith({ m3: () => ({ mentions: CANDIDATES }) });
    await userEvent.type(box(), 'Look at @rea');
    const list = await listbox();
    await waitFor(() => expect(hub.api.mentions).toHaveBeenLastCalledWith('rea', t.id));
    await within(list).findByRole('option', { name: /fs\.read/ });
    const labels = within(list)
      .getAllByRole('group')
      .map((g) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent);
    expect(labels).toEqual(['Files', 'Tools']);
    // Prefix matches first, the Hub's order breaks ties; groups keep their order.
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'README.md/w',
      'read-later.md/w/docs',
      'fs.readRead a file',
    ]);
    const input = combobox();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    expect(within(list.parentElement!).getByRole('status').textContent).toBe('3 suggestions');

    await userEvent.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    await userEvent.keyboard('{ArrowUp}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[2]!.id);
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');

    // The token is replaced by a chip; the box is a plain text box again.
    const chips = screen.getByRole('list', { name: 'Mentions' });
    expect(within(chips).getByText('README.md')).toBeTruthy();
    expect(box().value).toBe('Look at ');
    expect(box().getAttribute('role')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(announcer()).toBe('Mentioned README.md.');
    expect(hub.api.sendMessage).not.toHaveBeenCalled();

    await userEvent.type(box(), 'please');
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenCalledWith(t.id, {
        text: 'Look at please',
        mentions: [{ kind: 'file', ref: 'file:/w/README.md' }],
      }),
    );
    // Sent: the chips are cleared with the draft.
    expect(screen.queryByRole('list', { name: 'Mentions' })).toBeNull();
  });

  it('groups files, folders, MCP servers and tools in that order; clicking chooses', async () => {
    await openWith({ m3: () => ({ mentions: CANDIDATES }) });
    await userEvent.type(box(), '@');
    const list = await listbox();
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(5));
    const labels = within(list)
      .getAllByRole('group')
      .map((g) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent);
    expect(labels).toEqual(['Files', 'Folders', 'MCP servers', 'Tools']);
    await userEvent.click(within(list).getByRole('option', { name: /files/ }));
    const chips = screen.getByRole('list', { name: 'Mentions' });
    expect(within(chips).getByText('files')).toBeTruthy();
    expect(document.activeElement).toBe(box());
    // Removing a chip keeps focus in the box.
    await userEvent.click(within(chips).getByRole('button', { name: 'Remove mention files' }));
    expect(screen.queryByRole('list', { name: 'Mentions' })).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it('closes on Escape without stopping a running reply, and reopens for a new @', async () => {
    const { hub, t } = await openWith({
      m3: () => ({ mentions: CANDIDATES }),
      messages: (tid) => [message(tid, { role: 'assistant', status: 'streaming', parts: [] })],
    });
    await userEvent.type(box(), 'and @do');
    await listbox();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(hub.api.cancel).not.toHaveBeenCalled();
    // Typing on in the same token keeps it closed; Tab is plain again.
    await userEvent.type(box(), 'cs');
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.type(box(), ' @fs');
    await within(await listbox()).findByRole('option', { name: /fs\.read/ });
    await userEvent.keyboard('{Tab}');
    expect(
      within(screen.getByRole('list', { name: 'Mentions' })).getByText('fs.read'),
    ).toBeTruthy();
    expect(t.id).toBeTruthy();
  });

  it('opens from the mention button and says when nothing matches or lookup fails', async () => {
    const { hub } = await openWith({ m3: () => ({ mentions: CANDIDATES }) });
    await userEvent.type(box(), 'see');
    await userEvent.click(
      screen.getByRole('button', { name: 'Mention a file, folder, tool or server' }),
    );
    expect(box().value).toBe('see @');
    expect(document.activeElement).toBe(box());
    await listbox();
    await userEvent.type(box(), 'zzz');
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' }).textContent).toBe('No matches'),
    );
    // Enter with no suggestion sends the text as typed.
    hub.state.failNext.mentions = new ApiError(500, { code: 'x', message: 'no', retryable: true });
    await userEvent.type(box(), 'q');
    await waitFor(() =>
      expect(screen.getByText('Suggestions are unavailable right now.')).toBeTruthy(),
    );
  });

  it('does not add the same item twice, and Enter waits while suggestions load', async () => {
    const { hub } = await openWith({ m3: () => ({ mentions: CANDIDATES }) });
    await userEvent.type(box(), '@READ{Enter}');
    expect(hub.api.sendMessage).not.toHaveBeenCalled();
    await within(await listbox()).findByRole('option', { name: /README/ });
    await userEvent.keyboard('{Enter}');
    await userEvent.type(box(), '@READ');
    await within(await listbox()).findByRole('option', { name: /README/ });
    await userEvent.keyboard('{Enter}');
    const chips = screen.getByRole('list', { name: 'Mentions' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(1);
  });
});
