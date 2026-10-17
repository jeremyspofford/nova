// Spaces and Pages (FR-036): spaces are listed and created, a space shows its pages and how agent
// edits land, the editor saves versions against the version it loaded (a stale save keeps the
// user's text next to the newer version), history restores, comments anchor to a selected
// passage, agent proposals are accepted or rejected (a stale one only when forced), and the
// editor follows live updates.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { SpacesView } from '../src/spaces/SpacesView.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  agentEdit,
  commentView,
  pageView,
  proposalView,
  renderWithSpaces,
  spaceView,
  versionView,
  type M6SpacesState,
} from './fakes-m6-spaces.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const SPACE = () => spaceView({ id: 'sp1', name: 'Handbook', description: 'How we work' });
const PAGE = (over = {}) =>
  pageView({
    id: 'pg1',
    spaceId: 'sp1',
    title: 'Welcome',
    content: 'Hello there.\nSecond line.',
    ...over,
  });

function openPage(spaces: Partial<M6SpacesState> = {}) {
  return renderWithSpaces(<SpacesView spaceId="sp1" pageId="pg1" />, {
    spaces: { spaces: [SPACE()], pages: [PAGE()], ...spaces },
  });
}

const text = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Page text (Markdown)' });
const stream = () => FakeEventSource.for('/api/v1/events/stream');
const panelTab = (name: RegExp) => screen.getByRole('tab', { name });

describe('the list of spaces (FR-036)', () => {
  it('starts empty and creates a space with the preferred way agent edits land', async () => {
    const { api } = await renderWithSpaces(<SpacesView spaceId={null} pageId={null} />, {
      settings: { 'spaces.agentEdits': 'direct' },
    });
    expect(await screen.findByRole('heading', { name: 'No spaces yet' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Create a space' }));
    const dialog = screen.getByRole('dialog', { name: 'New space' });
    const create = within(dialog).getByRole('button', { name: 'Create space' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Team notes');
    // The setting chose the default; it can still be changed here.
    expect(
      within(dialog).getByRole<HTMLInputElement>('radio', { name: 'Edit directly' }).checked,
    ).toBe(true);
    await userEvent.click(create);
    expect(api.createSpace).toHaveBeenCalledWith({
      name: 'Team notes',
      description: null,
      agentEdits: 'direct',
    });
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/spaces\/sp-\d+$/));
  });

  it('lists spaces with their page count and agent edit mode, and retries a failed load', async () => {
    const { spaces } = await renderWithSpaces(<SpacesView spaceId={null} pageId={null} />, {
      spaces: {
        spaces: [SPACE(), spaceView({ id: 'sp2', name: 'Recipes', agentEdits: 'direct' })],
        pages: [PAGE(), PAGE({ id: 'pg2' })],
      },
    });
    const list = await screen.findByRole('list', { name: 'Spaces' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('2 pages');
    expect(rows[0]!.textContent).toContain('Agent edits wait for your review');
    expect(rows[1]!.textContent).toContain('0 pages');
    expect(rows[1]!.textContent).toContain('Agents edit directly');
    await userEvent.click(within(list).getByRole('link', { name: 'Recipes' }));
    expect(window.location.pathname).toBe('/spaces/sp2');
    expect(spaces.api.listSpaces).toHaveBeenCalledTimes(1);
  });

  it('shows an error with Retry when the spaces cannot load', async () => {
    const hub = await renderWithSpaces(<SpacesView spaceId={null} pageId={null} />, {
      spaces: { spaces: [SPACE()] },
    });
    // Fail the next load, then reload through a live event.
    hub.spaces.failNext.listSpaces = new ApiError(503, {
      code: 'unavailable',
      message: 'The Hub is busy.',
      retryable: true,
    });
    await screen.findByRole('list', { name: 'Spaces' });
    stream().emit('space.created', { spaceId: 'sp9' });
    expect((await screen.findByRole('alert')).textContent).toContain('The Hub is busy.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('a space (FR-036)', () => {
  it('lists pages in order with their badges, changes the agent edit mode and adds a page', async () => {
    const { api } = await renderWithSpaces(<SpacesView spaceId="sp1" pageId={null} />, {
      spaces: {
        spaces: [SPACE()],
        pages: [PAGE({ id: 'pg2', title: 'Second', position: 1 }), PAGE({ position: 0 })],
        comments: [commentView({ pageId: 'pg1' })],
        proposals: [proposalView({ pageId: 'pg1' })],
      },
    });
    expect(await screen.findByRole('heading', { name: 'Handbook', level: 1 })).toBeTruthy();
    const pages = await screen.findByRole('list', { name: 'Pages' });
    const rows = within(pages).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual(['Welcome', 'Second']);
    expect(rows[0]!.textContent).toContain('1 open comment');
    expect(rows[0]!.textContent).toContain('1 proposal');

    await userEvent.click(screen.getByRole('radio', { name: 'Edit directly' }));
    expect(api.updateSpace).toHaveBeenCalledWith('sp1', { agentEdits: 'direct' });
    await waitFor(() =>
      expect(screen.getByTestId('announcer').textContent).toContain(
        'Agents now edit pages directly.',
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: 'New page' }));
    await userEvent.type(screen.getByLabelText('Title'), 'Onboarding');
    await userEvent.click(screen.getByRole('button', { name: 'Add page' }));
    expect(api.createSpacePage).toHaveBeenCalledWith('sp1', { title: 'Onboarding', content: '' });
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/spaces\/sp1\/pg-\d+$/));
  });

  it('accepts and rejects proposed new pages', async () => {
    const { api, state } = await renderWithSpaces(<SpacesView spaceId="sp1" pageId={null} />, {
      spaces: {
        spaces: [SPACE()],
        proposals: [
          proposalView({
            id: 'pr1',
            pageId: null,
            baseVersion: null,
            title: 'FAQ',
            content: '# FAQ',
            summary: 'Common questions',
          }),
          proposalView({ id: 'pr2', pageId: null, baseVersion: null, title: 'Glossary' }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: 'Proposed new pages' });
    const faq = within(list).getAllByRole('listitem')[0]!;
    await userEvent.click(within(faq).getByRole('button', { name: 'Show the page' }));
    expect(within(faq).getByRole('heading', { name: 'FAQ' })).toBeTruthy();
    await userEvent.click(within(faq).getByRole('button', { name: 'Accept' }));
    expect(api.acceptSpaceProposal).toHaveBeenCalledWith('sp1', 'pr1');
    expect(await screen.findByText('Added the page “FAQ”.')).toBeTruthy();
    expect(state.pages.map((p) => p.title)).toEqual(['FAQ']);
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Proposed new pages' })).getAllByRole('listitem'),
      ).toHaveLength(1),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(api.rejectSpaceProposal).toHaveBeenCalledWith('sp1', 'pr2');
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Proposed new pages' })).toBeNull(),
    );
    expect(await screen.findByRole('link', { name: 'FAQ' })).toBeTruthy();
  });

  it('renames and deletes a space after confirming', async () => {
    const { api, state } = await renderWithSpaces(<SpacesView spaceId="sp1" pageId={null} />, {
      spaces: { spaces: [SPACE()], pages: [PAGE()] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Field guide');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateSpace).toHaveBeenCalledWith('sp1', {
      name: 'Field guide',
      description: 'How we work',
    });
    expect(await screen.findByRole('heading', { name: 'Field guide', level: 1 })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this space?' });
    expect(dialog.textContent).toContain('1 page');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.deleteSpace).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete space' }));
    await waitFor(() => expect(window.location.pathname).toBe('/spaces'));
    expect(state.spaces).toEqual([]);
  });

  it('says when the space is gone', async () => {
    await renderWithSpaces(<SpacesView spaceId="nope" pageId={null} />);
    expect(await screen.findByRole('heading', { name: 'Space not found' })).toBeTruthy();
  });
});

describe('the page editor (FR-036)', () => {
  it('saves a new version against the version it loaded, with a change note and Ctrl+S', async () => {
    const { api } = await openPage();
    expect(await screen.findByRole('heading', { name: 'Welcome', level: 1 })).toBeTruthy();
    expect(screen.getByText('All changes saved')).toBeTruthy();
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(save.disabled).toBe(true);
    await userEvent.type(text(), ' More.');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Change note (optional)'), 'Tidy');
    await userEvent.click(save);
    expect(api.saveSpacePage).toHaveBeenCalledWith('sp1', 'pg1', {
      baseVersion: 1,
      title: 'Welcome',
      content: 'Hello there.\nSecond line. More.',
      summary: 'Tidy',
    });
    expect(await screen.findByText('Version 2')).toBeTruthy();
    expect(screen.getByText('All changes saved')).toBeTruthy();
    expect(screen.getByTestId('announcer').textContent).toContain('Saved as version 2.');

    // Ctrl+S saves the next edit against version 2.
    await userEvent.type(text(), '!');
    await userEvent.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(api.saveSpacePage).toHaveBeenCalledTimes(2));
    expect(api.saveSpacePage.mock.calls[1]![2]).toMatchObject({ baseVersion: 2 });
    expect(await screen.findByText('Version 3')).toBeTruthy();
  });

  it('previews Markdown with charts', async () => {
    await openPage({
      pages: [
        PAGE({
          content: '# Title\n\n```chart\n{"type":"pie","labels":["A","B"],"values":[1,2]}\n```',
        }),
      ],
    });
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    await userEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Pie chart/ })).toBeTruthy();
  });

  it('keeps the user’s text when someone saved first, then keeps mine or discards it', async () => {
    const { api, state } = await openPage();
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    await userEvent.clear(text());
    await userEvent.type(text(), 'Mine.');
    // An agent saves version 2 behind the editor's back.
    agentEdit(state, 'pg1', 'Hello there.\nTheirs.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const banner = await screen.findByRole('alert', { name: 'Newer version' });
    expect(banner.textContent).toContain('version 2 was saved by an agent');
    expect(text().value).toBe('Mine.');
    const diff = within(banner).getByLabelText('Differences between version 2 and your text');
    expect(diff.textContent).toContain('Theirs.');
    expect(diff.textContent).toContain('Mine.');
    await userEvent.click(within(banner).getByRole('button', { name: 'Keep mine and save' }));
    expect(api.saveSpacePage).toHaveBeenLastCalledWith('sp1', 'pg1', {
      baseVersion: 2,
      title: 'Welcome',
      content: 'Mine.',
    });
    expect(await screen.findByText('Version 3')).toBeTruthy();
    expect(screen.queryByRole('alert', { name: 'Newer version' })).toBeNull();

    // Again, but this time the user discards their text.
    await userEvent.type(text(), ' Draft');
    agentEdit(state, 'pg1', 'Agent text.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const again = await screen.findByRole('alert', { name: 'Newer version' });
    await userEvent.click(within(again).getByRole('button', { name: 'Discard mine' }));
    expect(text().value).toBe('Agent text.');
    expect(screen.getByText('Version 4')).toBeTruthy();
    expect(screen.getByText('All changes saved')).toBeTruthy();
  });

  it('shows an error toast for a failed save that is not a conflict', async () => {
    const { spaces } = await openPage();
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    spaces.failNext.saveSpacePage = new ApiError(500, {
      code: 'internal',
      message: 'Disk full.',
      retryable: true,
    });
    await userEvent.type(text(), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save: Disk full.')).toBeTruthy();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('restores an earlier version after confirming', async () => {
    const { api } = await openPage({
      pages: [PAGE({ version: 2, content: 'Second draft.' })],
      versions: [
        {
          ...versionView({ pageId: 'pg1', version: 1, summary: 'First cut' }),
          content: 'First draft.',
        },
      ],
    });
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    await userEvent.click(panelTab(/History/));
    const list = await screen.findByRole('list', { name: 'Versions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Version 2');
    expect(rows[0]!.textContent).toContain('Current');
    expect(rows[1]!.textContent).toContain('First cut');
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'View version 1' }));
    const view = await screen.findByRole('dialog', { name: 'Version 1' });
    expect(await within(view).findByText('First draft.')).toBeTruthy();
    await userEvent.click(within(view).getByRole('button', { name: 'Restore this version' }));
    const confirm = screen.getByRole('dialog', { name: 'Restore version 1?' });
    expect(confirm.textContent).toContain('newest version (3)');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Restore version 1' }));
    expect(api.restoreSpacePage).toHaveBeenCalledWith('sp1', 'pg1', { version: 1, baseVersion: 2 });
    expect(await screen.findByText('Restored version 1 as version 3.')).toBeTruthy();
    expect(text().value).toBe('First draft.');
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Versions' }).textContent).toContain(
        'Restored from version 1',
      ),
    );
  });

  it('refuses a restore when the page moved on, and loads the newer version', async () => {
    const { state } = await openPage({
      pages: [PAGE({ version: 2, content: 'Second draft.' })],
      versions: [{ ...versionView({ pageId: 'pg1', version: 1 }), content: 'First draft.' }],
    });
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    agentEdit(state, 'pg1', 'Third, by an agent.');
    await userEvent.click(panelTab(/History/));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore version 1' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore version 1' }),
    );
    expect(await screen.findByText(/The page changed \(now version 3\)/)).toBeTruthy();
    expect(text().value).toBe('Third, by an agent.');
  });

  it('comments on a selected passage, replies, resolves and reopens', async () => {
    const { api } = await openPage({
      comments: [
        commentView({
          id: 'old',
          pageId: 'pg1',
          body: 'Was here',
          detached: true,
          anchor: { kind: 'range', start: 0, end: 3, quote: 'Bye' },
        }),
      ],
    });
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    expect(await screen.findByText('The text this comment pointed to has changed.')).toBeTruthy();

    // Nothing selected yet.
    await userEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));
    expect(screen.getByText('Select some text in the page first.')).toBeTruthy();

    act(() => text().setSelectionRange(6, 11));
    await userEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));
    expect(screen.getByText('Comment on this passage')).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'Your comment on the passage' });
    await waitFor(() => expect(document.activeElement).toBe(box));
    await userEvent.type(box, 'Friendlier?');
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(api.createPageComment).toHaveBeenCalledWith('sp1', 'pg1', {
      body: 'Friendlier?',
      anchor: { kind: 'range', start: 6, end: 11, quote: 'there' },
      version: 1,
    });
    const list = await screen.findByRole('list', { name: 'Comments' });
    const item = await within(list).findByText('Friendlier?');
    const li = item.closest('li')!;
    expect(within(li).getByText('there').tagName).toBe('BLOCKQUOTE');
    expect(panelTab(/Comments \(2\)/)).toBeTruthy();

    await userEvent.click(within(li).getByRole('button', { name: 'Reply' }));
    await userEvent.type(within(li).getByRole('textbox', { name: 'Your reply' }), 'Agreed');
    await userEvent.click(within(li).getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(api.createPageComment).toHaveBeenCalledTimes(2));
    expect(api.createPageComment.mock.calls[1]![2]).toMatchObject({ body: 'Agreed' });
    expect(await within(li).findByText('Agreed')).toBeTruthy();

    await userEvent.click(within(li).getByRole('button', { name: 'Resolve' }));
    expect(api.resolvePageComment).toHaveBeenCalledWith('sp1', 'pg1', expect.any(String), true);
    await waitFor(() => expect(screen.queryByText('Friendlier?')).toBeNull());
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show resolved (1)' }));
    const resolved = screen.getByText('Friendlier?').closest('li')!;
    await userEvent.click(within(resolved).getByRole('button', { name: 'Reopen' }));
    expect(api.resolvePageComment).toHaveBeenLastCalledWith(
      'sp1',
      'pg1',
      expect.any(String),
      false,
    );
  });

  it('adds a page comment and deletes one; a passage comment needs saved text', async () => {
    const { api } = await openPage();
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    await userEvent.type(screen.getByRole('textbox', { name: 'Comment on the page' }), 'Nice page');
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(api.createPageComment).toHaveBeenCalledWith('sp1', 'pg1', { body: 'Nice page' });
    const li = (await screen.findByText('Nice page')).closest('li')!;
    await userEvent.click(within(li).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Nice page')).toBeNull());
    expect(api.deletePageComment).toHaveBeenCalled();

    await userEvent.type(text(), 'x');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Comment on selection' }).disabled,
    ).toBe(true);
    expect(screen.getByText('Save first to comment on a passage.')).toBeTruthy();
  });

  it('accepts and rejects proposed edits, and forces a stale one only on request', async () => {
    const { api, state } = await openPage({
      proposals: [
        proposalView({
          id: 'pr1',
          pageId: 'pg1',
          baseVersion: 1,
          content: 'Hello there.\nSecond line.\nThird line.',
          summary: 'Add a line',
        }),
        proposalView({
          id: 'pr2',
          pageId: 'pg1',
          baseVersion: 1,
          content: 'Short.',
          summary: 'Shorten',
        }),
      ],
    });
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    await userEvent.click(panelTab(/Proposals \(2\)/));
    const list = await screen.findByRole('list', { name: 'Proposed edits' });
    const add = within(list).getByRole('listitem', { name: 'Add a line' });
    expect(within(add).getByText('1 line added')).toBeTruthy();
    expect(within(add).getByLabelText('Changes proposed in “Add a line”').textContent).toContain(
      'Third line.',
    );
    await userEvent.click(within(add).getByRole('button', { name: 'Accept' }));
    expect(api.acceptSpaceProposal).toHaveBeenCalledWith('sp1', 'pr1', {});
    expect(await screen.findByText('Accepted. The page is now version 2.')).toBeTruthy();
    expect(text().value).toBe('Hello there.\nSecond line.\nThird line.');

    // The other proposal was made on version 1: accepting it needs a deliberate force.
    const short = await within(
      await screen.findByRole('list', { name: 'Proposed edits' }),
    ).findByRole('listitem', { name: 'Shorten' });
    expect(short.textContent).toContain('The page changed since this was proposed');
    expect(within(short).queryByRole('button', { name: 'Accept' })).toBeNull();
    await userEvent.click(within(short).getByRole('button', { name: 'Accept anyway' }));
    expect(api.acceptSpaceProposal).toHaveBeenLastCalledWith('sp1', 'pr2', { force: true });
    expect(await screen.findByText('Accepted. The page is now version 3.')).toBeTruthy();
    expect(state.pages[0]!.content).toBe('Short.');
    await waitFor(() =>
      expect(screen.getByText('No proposed edits. Agent proposals show here.')).toBeTruthy(),
    );
  });

  it('marks a proposal stale when the Hub says the page moved on, and rejects one', async () => {
    const { api, state } = await openPage({
      proposals: [proposalView({ id: 'pr1', pageId: 'pg1', baseVersion: 1, summary: 'Warmer' })],
    });
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    await userEvent.click(panelTab(/Proposals/));
    // The Hub's view moves on while the editor still shows version 1 (no event arrives).
    agentEdit(state, 'pg1', 'Moved on.');
    const item = await screen.findByRole('listitem', { name: 'Warmer' });
    await userEvent.click(within(item).getByRole('button', { name: 'Accept' }));
    expect(
      await screen.findByText(/The page changed since this was proposed\. Look at the changes/),
    ).toBeTruthy();
    // The editor loads the newer version, so the proposal now reads as stale.
    await waitFor(() => expect(text().value).toBe('Moved on.'));
    const again = await screen.findByRole('listitem', { name: 'Warmer' });
    expect(within(again).getByRole('button', { name: 'Accept anyway' })).toBeTruthy();
    await userEvent.click(within(again).getByRole('button', { name: 'Reject' }));
    expect(api.rejectSpaceProposal).toHaveBeenCalledWith('sp1', 'pr1');
    expect(await screen.findByText('Proposal rejected.')).toBeTruthy();
  });

  it('reloads quietly on a live update, and offers a comparison when there are edits', async () => {
    const { state, api } = await openPage();
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    agentEdit(state, 'pg1', 'Live from an agent.');
    stream().emit('space.page.updated', {
      spaceId: 'sp1',
      pageId: 'pg1',
      version: 2,
      authorKind: 'agent',
    });
    await waitFor(() => expect(text().value).toBe('Live from an agent.'));
    expect(screen.getByText('Version 2')).toBeTruthy();
    // An event about another page, or an old version, changes nothing.
    stream().emit('space.page.updated', { spaceId: 'sp1', pageId: 'pg9', version: 7 });
    stream().emit('space.page.updated', { spaceId: 'sp1', pageId: 'pg1', version: 2 });
    expect(api.getSpacePage).toHaveBeenCalledTimes(2);

    await userEvent.type(text(), ' Mine');
    agentEdit(state, 'pg1', 'Even newer.');
    stream().emit('space.page.updated', {
      spaceId: 'sp1',
      pageId: 'pg1',
      version: 3,
      authorKind: 'agent',
    });
    const status = await screen.findByRole('status', { name: 'Newer version' });
    expect(status.textContent).toContain('A newer version (3) is available, made by an agent.');
    expect(text().value).toBe('Live from an agent. Mine');
    await userEvent.click(within(status).getByRole('button', { name: 'Compare with mine' }));
    const banner = await screen.findByRole('alert', { name: 'Newer version' });
    expect(banner.textContent).toContain('Even newer.');
  });

  it('says when the page is deleted while open, keeping unsaved text', async () => {
    await openPage();
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    fireEvent.change(text(), { target: { value: 'Unsaved words' } });
    stream().emit('space.page.deleted', { spaceId: 'sp1', pageId: 'pg1' });
    expect(await screen.findByRole('heading', { name: 'This page was deleted' })).toBeTruthy();
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your unsaved text' }).value,
    ).toBe('Unsaved words');
  });
});

describe('deleting and ordering pages (FR-036)', () => {
  it('deletes a page after confirming; its open proposals end as rejected', async () => {
    const { api, state } = await openPage({
      proposals: [
        proposalView({ id: 'pr-open', pageId: 'pg1' }),
        proposalView({ id: 'pr-done', pageId: 'pg1', status: 'accepted' }),
      ],
    });
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Delete page' }));
    let dialog = screen.getByRole('dialog', { name: 'Delete “Welcome”?' });
    expect(dialog.textContent).toContain('Its history and comments go with it');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.deleteSpacePage).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete page' }));
    dialog = screen.getByRole('dialog', { name: 'Delete “Welcome”?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete page' }));
    expect(api.deleteSpacePage).toHaveBeenCalledWith('sp1', 'pg1');
    await waitFor(() => expect(window.location.pathname).toBe('/spaces/sp1'));
    expect(await screen.findByText('Deleted “Welcome”.')).toBeTruthy();
    expect(state.pages).toEqual([]);
    expect(state.proposals.map((x) => [x.id, x.status])).toEqual([
      ['pr-open', 'rejected'],
      ['pr-done', 'accepted'],
    ]);
    // Its own delete event is not news to the editor that made it.
    stream().emit('space.page.deleted', { spaceId: 'sp1', pageId: 'pg1' });
    expect(screen.queryByRole('heading', { name: 'This page was deleted' })).toBeNull();
  });

  it('keeps the dialog open with the reason when the delete fails', async () => {
    const { spaces, state } = await openPage();
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    spaces.failNext.deleteSpacePage = new ApiError(503, {
      code: 'unavailable',
      message: 'The Hub is busy.',
      retryable: true,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Delete page' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete “Welcome”?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete page' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('The Hub is busy.');
    expect(window.location.pathname).not.toBe('/spaces/sp1');
    expect(state.pages).toHaveLength(1);
    // A second try goes through.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete page' }));
    await waitFor(() => expect(window.location.pathname).toBe('/spaces/sp1'));
  });

  const ordered = () =>
    within(screen.getByRole('list', { name: 'Pages' }))
      .getAllByRole('link')
      .map((a) => a.textContent);

  it('moves a page down and up by swapping positions, keeping focus and announcing it', async () => {
    const { api, state } = await renderWithSpaces(<SpacesView spaceId="sp1" pageId={null} />, {
      spaces: {
        spaces: [SPACE()],
        pages: [
          PAGE({ id: 'pg1', title: 'First', position: 0 }),
          PAGE({ id: 'pg2', title: 'Second', position: 1 }),
          PAGE({ id: 'pg3', title: 'Third', position: 2 }),
        ],
      },
    });
    await screen.findByRole('list', { name: 'Pages' });
    expect(ordered()).toEqual(['First', 'Second', 'Third']);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Move First up' }).disabled).toBe(
      true,
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Move Third down' }).disabled,
    ).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Move Second down' }));
    expect(api.updateSpacePage).toHaveBeenCalledWith('sp1', 'pg2', { position: 2 });
    expect(api.updateSpacePage).toHaveBeenCalledWith('sp1', 'pg3', { position: 1 });
    expect(ordered()).toEqual(['First', 'Third', 'Second']);
    await waitFor(() =>
      expect(screen.getByTestId('announcer').textContent).toContain(
        'Moved “Second” to position 3 of 3.',
      ),
    );
    // At the bottom, Down is disabled, so focus lands on the same row's Up.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Second up' })),
    );
    expect(state.pages.map((p) => [p.id, p.position])).toEqual([
      ['pg1', 0],
      ['pg2', 2],
      ['pg3', 1],
    ]);

    // Keyboard: Enter on the focused Up moves it back.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(ordered()).toEqual(['First', 'Second', 'Third']));
    await waitFor(() => expect(api.updateSpacePage).toHaveBeenCalledTimes(4));
  });

  it('renumbers pages that share a position, in the new order', async () => {
    const { api } = await renderWithSpaces(<SpacesView spaceId="sp1" pageId={null} />, {
      spaces: {
        spaces: [SPACE()],
        pages: [
          PAGE({ id: 'pg1', title: 'Older', position: 0, createdAt: '2026-10-01T10:00:00.000Z' }),
          PAGE({ id: 'pg2', title: 'Newer', position: 0, createdAt: '2026-10-01T11:00:00.000Z' }),
        ],
      },
    });
    await screen.findByRole('list', { name: 'Pages' });
    // Equal positions fall back to creation time.
    expect(ordered()).toEqual(['Older', 'Newer']);
    await userEvent.click(screen.getByRole('button', { name: 'Move Newer up' }));
    await waitFor(() => expect(api.updateSpacePage).toHaveBeenCalledTimes(1));
    expect(api.updateSpacePage).toHaveBeenCalledWith('sp1', 'pg1', { position: 1 });
    await waitFor(() => expect(api.listSpacePages).toHaveBeenCalledTimes(2));
    expect(ordered()).toEqual(['Newer', 'Older']);
  });

  it('says when a move fails and shows the Hub’s order again', async () => {
    const { spaces } = await renderWithSpaces(<SpacesView spaceId="sp1" pageId={null} />, {
      spaces: {
        spaces: [SPACE()],
        pages: [
          PAGE({ id: 'pg1', title: 'First', position: 0 }),
          PAGE({ id: 'pg2', title: 'Second', position: 1 }),
        ],
      },
    });
    await screen.findByRole('list', { name: 'Pages' });
    spaces.failNext.updateSpacePage = new ApiError(500, {
      code: 'internal',
      message: 'Disk full.',
      retryable: true,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Move Second up' }));
    expect(await screen.findByText('Could not move it: Disk full.')).toBeTruthy();
    // Only the other page's update went through, so both share a position: creation order.
    await waitFor(() => expect(spaces.api.listSpacePages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ordered()).toEqual(['First', 'Second']));
  });
});
