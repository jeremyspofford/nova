import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { emitCode, openSession, threadStream } from './code-helpers.tsx';
import { codeChange, hunk } from './fakes-m5-code.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const SID = 'cs-diff';
const announcer = () => screen.getByTestId('announcer').textContent ?? '';
const diff = () => screen.getByRole('region', { name: 'Diff' });

function twoFiles() {
  const total = codeChange(SID, { id: 'ch-total', path: 'src/total.ts' });
  const notes = codeChange(SID, {
    id: 'ch-notes',
    path: 'docs/notes.md',
    kind: 'add',
    additions: 2,
    deletions: 0,
    hunks: [
      hunk({
        id: '0-1',
        header: '@@ -0,0 +1,2 @@',
        lines: [
          { kind: 'add', text: '# Notes', oldNo: null, newNo: 1 },
          { kind: 'add', text: 'Second line', oldNo: null, newNo: 2 },
        ],
      }),
    ],
  });
  return [total, notes];
}

describe('Diff pane (FR-064)', () => {
  it('lists files with counts and state, and draws the unified and split views', async () => {
    await openSession({ id: SID }, { code: { changes: twoFiles() } });
    const pane = await screen.findByRole('region', { name: 'Diff' });
    expect(screen.getByRole('tab', { name: 'Diff (2)' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const files = within(pane).getByRole('navigation', { name: 'Changed files' });
    expect(within(files).getByRole('button', { name: 'src/total.ts' })).toBeTruthy();
    expect(within(files).getAllByText('1 addition, 1 deletion')).toHaveLength(1);
    expect(within(files).getByText('2 additions, 0 deletions')).toBeTruthy();
    expect(within(pane).getByText('2 files,')).toBeTruthy();

    // Unified: removed and added lines say so in text, and the changed word is marked.
    const lines = within(pane).getByRole('table', { name: 'Lines of hunk 1 of src/total.ts' });
    const rows = within(lines).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain('Removed: const total = sum(1, 2);');
    expect(rows[2]!.textContent).toContain('Added: const total = sum(1, 3);');
    const marks = [...lines.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['2', '3']);
    // An added file has no pairs, so nothing is marked inside its lines.
    const added = within(pane).getByRole('table', { name: 'Lines of hunk 1 of docs/notes.md' });
    expect(added.querySelectorAll('mark')).toHaveLength(0);

    // Split: the removed and the added line share a row.
    await userEvent.click(within(pane).getByRole('button', { name: 'Split' }));
    expect(within(pane).getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const split = within(pane)
      .getAllByRole('row', { hidden: false })
      .filter((r) => r.closest('table')?.getAttribute('data-view') === 'split');
    const paired = split.find((r) => r.textContent.includes('sum(1, 2)'))!;
    expect(paired.textContent).toContain('sum(1, 3)');
    const contextRow = split.find((r) => r.textContent.includes('import { sum }'))!;
    expect(contextRow.querySelectorAll('td')).toHaveLength(4);

    // The file link jumps to the file.
    await userEvent.click(within(files).getByRole('button', { name: 'docs/notes.md' }));
    expect(document.activeElement?.textContent).toBe('docs/notes.md');
  });

  it('accepts and rejects hunks, files and everything, and shows a partly accepted file', async () => {
    const twoHunks = codeChange(SID, {
      id: 'ch-two',
      path: 'src/two.ts',
      hunks: [hunk({ id: '1-1' }), hunk({ id: '9-9', header: '@@ -9,2 +9,2 @@' })],
    });
    const [total, notes] = twoFiles();
    const { hub } = await openSession(
      { id: SID },
      { code: { changes: [twoHunks, total!, notes!] } },
    );
    const pane = await screen.findByRole('region', { name: 'Diff' });

    await userEvent.click(
      within(pane).getByRole('button', { name: 'Accept hunk 1 of src/two.ts' }),
    );
    await waitFor(() =>
      expect(hub.api.decideHunks).toHaveBeenCalledWith(SID, 'ch-two', {
        decisions: [{ hunkId: '1-1', accept: true }],
      }),
    );
    const first = await within(pane).findByRole('group', { name: 'hunk 1 of src/two.ts' });
    await waitFor(() => expect(within(first).getByText('Accepted')).toBeTruthy());
    expect(within(first).queryByRole('button', { name: /Accept hunk/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(announcer()).toMatch(/Hunk 1 of src\/two.ts accepted/);
    await userEvent.click(
      within(pane).getByRole('button', { name: 'Reject hunk 2 of src/two.ts' }),
    );
    expect(
      await within(pane).findByText(/Partly accepted: some hunks of this file are written/),
    ).toBeTruthy();

    // A whole file.
    await userEvent.click(within(pane).getByRole('button', { name: 'Reject src/total.ts' }));
    await waitFor(() => expect(hub.api.decideAll).toHaveBeenCalledWith(SID, false, ['ch-total']));
    await waitFor(() =>
      expect(within(pane).getByRole('button', { name: 'Reject src/total.ts' })).toHaveProperty(
        'disabled',
        true,
      ),
    );

    // Everything else, after a confirmation for Reject all.
    await userEvent.click(within(pane).getByRole('button', { name: /Reject all/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Reject all pending changes?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(hub.api.decideAll).toHaveBeenCalledTimes(1);
    await userEvent.click(within(pane).getByRole('button', { name: /Accept all/ }));
    await waitFor(() => expect(hub.api.decideAll).toHaveBeenLastCalledWith(SID, true));
    await waitFor(() =>
      expect(within(pane).getByRole('button', { name: /Accept all/ })).toHaveProperty(
        'disabled',
        true,
      ),
    );
    expect(announcer()).toMatch(/All pending changes accepted/);
  });

  it('rejects everything after confirming, and reports a failed decision', async () => {
    const { hub } = await openSession({ id: SID }, { code: { changes: twoFiles() } });
    const pane = await screen.findByRole('region', { name: 'Diff' });
    hub.state.failNext.decideHunks = new ApiError(409, {
      code: 'conflict',
      message: 'The file changed on disk',
      retryable: false,
    });
    await userEvent.click(
      within(pane).getByRole('button', { name: 'Accept hunk 1 of src/total.ts' }),
    );
    expect(
      await screen.findByText(/Could not accept the hunk: The file changed on disk/),
    ).toBeTruthy();
    await userEvent.click(within(pane).getByRole('button', { name: /Reject all/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Reject all pending changes?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Reject all' }));
    await waitFor(() => expect(hub.api.decideAll).toHaveBeenCalledWith(SID, false));
    expect(await within(pane).findAllByText('Rejected')).not.toHaveLength(0);
  });

  it('notes binary files and shows an empty state and a load error', async () => {
    const bin = codeChange(SID, {
      path: 'logo.png',
      binary: true,
      hunks: [],
      additions: 0,
      deletions: 0,
    });
    const { hub } = await openSession({ id: SID }, { code: { changes: [bin] } });
    const pane = await screen.findByRole('region', { name: 'Diff' });
    expect(within(pane).getByText('Binary file: there is no text diff to show.')).toBeTruthy();
    await userEvent.click(within(pane).getByRole('button', { name: 'Accept logo.png' }));
    await waitFor(() => expect(hub.api.decideAll).toHaveBeenCalledWith(SID, true, [bin.id]));
    expect(
      await within(pane).findByText('Accepted', { selector: '.code-file-head .code-state' }),
    ).toBeTruthy();
  });

  it('shows when there are no changes, and a load failure with Retry', async () => {
    const { hub } = await openSession(
      { id: SID },
      { hub: { failNext: { listChanges: new Error('Changes are unavailable') } } },
    );
    expect(await screen.findByText('Changes are unavailable')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'No changes yet' })).toBeTruthy();
    hub.state.m5code.changes = twoFiles();
    emitCode('code.changes.updated', { sessionId: SID });
    expect(await screen.findByRole('button', { name: 'src/total.ts' })).toBeTruthy();
  });

  it('follows change events and reloads after each turn of the session thread', async () => {
    const [total, notes] = twoFiles();
    const { hub, s } = await openSession({ id: SID }, { code: { changes: [total!] } });
    await within(diff()).findByRole('button', { name: 'src/total.ts' });
    hub.state.m5code.changes = [total!, notes!];
    // Another session's event changes nothing here.
    const before = hub.api.listChanges.mock.calls.length;
    emitCode('code.changes.updated', { sessionId: 'other' });
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.api.listChanges).toHaveBeenCalledTimes(before);
    emitCode('code.change.applied', { sessionId: SID, changeId: notes!.id, path: notes!.path });
    expect(await within(diff()).findByRole('button', { name: 'docs/notes.md' })).toBeTruthy();
    const sessionLoads = hub.api.getCodeSession.mock.calls.length;

    hub.state.m5code.changes = [total!];
    const es = threadStream(s.threadId);
    es.emit('turn.completed', { threadId: s.threadId, turnId: 'turn1' }, s.threadId);
    await waitFor(() =>
      expect(within(diff()).queryByRole('button', { name: 'docs/notes.md' })).toBeNull(),
    );
    expect(hub.api.getCodeSession.mock.calls.length).toBeGreaterThan(sessionLoads);
  });
});

describe('Diff comments (FR-065)', () => {
  it('batches line comments and sends them to the agent with Ctrl+Enter', async () => {
    const { hub } = await openSession({ id: SID }, { code: { changes: twoFiles() } });
    const pane = await screen.findByRole('region', { name: 'Diff' });
    // Removed lines take comments on the old side, others on the new side.
    expect(
      within(pane).queryByRole('button', { name: 'Comment on line 1 of src/total.ts' }),
    ).toBeTruthy();
    await userEvent.click(
      within(pane).getByRole('button', { name: 'Comment on removed line 2 of src/total.ts' }),
    );
    const boxes = within(pane).getAllByRole('textbox', {
      name: 'Comment on removed line 2 of src/total.ts',
    });
    expect(boxes).toHaveLength(1);
    expect(document.activeElement).toBe(boxes[0]);
    await userEvent.type(boxes[0]!, 'Why 3 here?');
    await userEvent.click(within(pane).getByRole('button', { name: 'Add comment' }));
    expect(within(pane).getByText('Why 3 here?')).toBeTruthy();
    expect(within(pane).getByText('Pending', { selector: '.code-draft-tag' })).toBeTruthy();
    const batch = within(pane).getByRole('region', { name: 'Pending comments' });
    expect(within(batch).getByText(/1 comment ready/)).toBeTruthy();

    // A second comment, sent together with the first straight from its box.
    await userEvent.click(
      within(pane).getByRole('button', { name: 'Comment on line 1 of docs/notes.md' }),
    );
    const second = within(pane).getByRole('textbox', {
      name: 'Comment on line 1 of docs/notes.md',
    });
    await userEvent.type(second, 'Title case, please');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(hub.api.addComments).toHaveBeenCalledWith(SID, {
        comments: [
          { changeId: 'ch-total', line: 2, side: 'old', body: 'Why 3 here?' },
          { changeId: 'ch-notes', line: 1, side: 'new', body: 'Title case, please' },
        ],
        submit: true,
      }),
    );
    await waitFor(() =>
      expect(within(pane).queryByRole('region', { name: 'Pending comments' })).toBeNull(),
    );
    expect(announcer()).toMatch(/Sent 2 comments to the agent/);
    // Sent comments show at their lines, and can be resolved.
    expect(within(pane).getByText('Title case, please')).toBeTruthy();
    const resolveButtons = within(pane).getAllByRole('button', { name: 'Resolve' });
    await userEvent.click(resolveButtons[0]!);
    await waitFor(() => expect(hub.api.resolveComment).toHaveBeenCalled());
    expect(await within(pane).findByText('Resolved')).toBeTruthy();
  });

  it('keeps the batch when sending fails, and lets a pending comment go', async () => {
    const { hub } = await openSession({ id: SID }, { code: { changes: twoFiles() } });
    const pane = await screen.findByRole('region', { name: 'Diff' });
    await userEvent.click(
      within(pane).getByRole('button', { name: 'Comment on line 2 of src/total.ts' }),
    );
    await userEvent.type(
      within(pane).getByRole('textbox', { name: 'Comment on line 2 of src/total.ts' }),
      'First',
    );
    await userEvent.click(within(pane).getByRole('button', { name: 'Add comment' }));
    hub.state.failNext.addComments = new Error('Hub offline');
    await userEvent.click(within(pane).getByRole('button', { name: /Send 1 comment/ }));
    expect(await screen.findByText(/Comments not sent: Hub offline/)).toBeTruthy();
    expect(within(pane).getByText('First')).toBeTruthy();
    // Escape closes an open box without adding it.
    await userEvent.click(
      within(pane).getByRole('button', { name: 'Comment on line 1 of docs/notes.md' }),
    );
    await userEvent.type(
      within(pane).getByRole('textbox', { name: 'Comment on line 1 of docs/notes.md' }),
      'Draft{Escape}',
    );
    expect(within(pane).queryByRole('textbox', { name: /Comment on line/ })).toBeNull();
    await userEvent.click(
      within(pane).getByRole('button', {
        name: 'Remove the pending comment on line 2 of src/total.ts',
      }),
    );
    expect(within(pane).queryByRole('region', { name: 'Pending comments' })).toBeNull();
  });
});
