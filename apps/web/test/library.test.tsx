import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { LibraryItemView, LibraryKind } from '@nova/shared';
import { inApp } from '../src/library/LibraryView.tsx';
import { createHub } from './fakes.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

let n = 0;
function item(
  kind: LibraryKind,
  title: string,
  over: Partial<LibraryItemView> = {},
): LibraryItemView {
  n++;
  return {
    kind,
    id: `${kind}${n}`,
    title,
    mime: null,
    size: 1024,
    threadId: null,
    projectId: null,
    href: `/chat/t${n}`,
    createdAt: '2026-10-01T12:00:00.000Z',
    ...over,
  };
}

const list = () => screen.findByRole('list', { name: 'Library items' });
const titles = async () =>
  within(await list())
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.library-item-title')?.textContent);

describe('library (FR-041)', () => {
  it('lists everything, filters by kind with the keyboard, and searches by title', async () => {
    const hub = createHub();
    hub.state.m4.library = [
      item('artifact', 'Launch plan'),
      item('attachment', 'invoice.pdf', { size: 2048 }),
      item('source', 'Handbook', { size: null }),
      item('image', 'Logo'),
    ];
    await renderApp({ hub, path: '/library' });
    expect(screen.getByRole('heading', { name: 'Library', level: 1 })).toBeTruthy();
    expect(await titles()).toEqual(['Launch plan', 'invoice.pdf', 'Handbook', 'Logo']);
    expect(screen.getByText('Attachment, 2.0 KB')).toBeTruthy();
    expect(screen.getByText('Source')).toBeTruthy();

    const kinds = screen.getByRole('radiogroup', { name: 'Kind' });
    await userEvent.click(within(kinds).getByRole('radio', { name: 'Artifacts' }));
    await waitFor(async () => expect(await titles()).toEqual(['Launch plan']));
    expect(hub.api.library).toHaveBeenLastCalledWith({ kind: 'artifact', limit: 50 });
    // Arrow keys move the choice.
    await userEvent.keyboard('{ArrowRight}');
    expect(
      within(kinds).getByRole('radio', { name: 'Attachments' }).getAttribute('aria-checked'),
    ).toBe('true');
    await waitFor(async () => expect(await titles()).toEqual(['invoice.pdf']));
    await userEvent.keyboard('{Home}');
    await waitFor(async () => expect(await titles()).toHaveLength(4));

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search the library' }), 'logo');
    await waitFor(async () => expect(await titles()).toEqual(['Logo']));
    expect(hub.api.library).toHaveBeenLastCalledWith({ q: 'logo', limit: 50 });
    await userEvent.click(within(kinds).getByRole('radio', { name: 'Sources' }));
    expect(await screen.findByRole('heading', { name: 'Nothing matches' })).toBeTruthy();
  });

  it('pages with Show more and opens items where they belong', async () => {
    const hub = createHub();
    hub.state.m4.library = Array.from({ length: 60 }, (_, i) =>
      item('artifact', `Doc ${String(i).padStart(2, '0')}`, { href: `/chat/thread-${i}` }),
    );
    await renderApp({ hub, path: '/library' });
    expect(await titles()).toHaveLength(50);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(async () => expect(await titles()).toHaveLength(60));
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(hub.api.library).toHaveBeenLastCalledWith({ cursor: '50', limit: 50 });
    await userEvent.click(screen.getByRole('link', { name: 'Doc 07' }));
    expect(window.location.pathname).toBe('/chat/thread-7');
  });

  it('shows empty, failed and loading states', async () => {
    const hub = createHub();
    hub.state.failNext.library = new Error('Library offline');
    await renderApp({ hub, path: '/library' });
    expect(await screen.findByText('Library offline')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Nothing here yet' })).toBeTruthy();
  });

  it('keeps links inside the app', () => {
    expect(inApp('/projects/p1')).toBe(true);
    expect(inApp('//evil.example/x')).toBe(false);
    expect(inApp('/\\evil.example')).toBe(false);
    expect(inApp('https://example.com')).toBe(false);
    expect(inApp('javascript:alert(1)')).toBe(false);
  });

  it('shows items with outside links as text and opens from the command', async () => {
    const hub = createHub();
    hub.state.m4.library = [item('file', 'Remote', { href: 'https://example.com/x' })];
    const { registry } = await renderApp({ hub });
    registry.run('library.open');
    expect(await screen.findByText('Remote')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Remote' })).toBeNull();
  });
});
