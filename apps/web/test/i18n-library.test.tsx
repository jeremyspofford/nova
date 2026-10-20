// The library in the pseudo-locale (FR-016): its filters, list, counts and empty states come from
// messages. Item titles are fixture data.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { LibraryItemView, LibraryKind } from '@nova/shared';
import { LIBRARY_TEXT } from '../src/library/LibraryView.tsx';
import { SIDEBAR_TEXT } from '../src/shell/strings.ts';
import { createHub } from './fakes.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

let n = 0;
function item(kind: LibraryKind, title: string, size: number | null = 1024): LibraryItemView {
  n++;
  return {
    kind,
    id: `${kind}${n}`,
    title,
    mime: null,
    size,
    threadId: null,
    projectId: null,
    href: `/chat/t${n}`,
    createdAt: '2026-10-01T12:00:00.000Z',
  };
}

describe('the library in a pseudo-locale', () => {
  it('shows the library, its filters and an empty search localized', async () => {
    const hub = createHub();
    hub.state.m4.library = [
      item('artifact', 'Launch plan'),
      item('attachment', 'invoice.pdf', 2048),
      item('source', 'Handbook', null),
    ];
    await activateTestLocale('en-XA');
    await renderApp({ hub, path: '/library', ready: false });
    await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });
    const heading = await screen.findByRole('heading', { name: LIBRARY_TEXT.title, level: 1 });
    const page = heading.closest('section')!;
    await within(page).findByRole('list', { name: LIBRARY_TEXT.list });
    const data = ['Launch plan', 'invoice.pdf', 'Handbook'];
    expectFullyLocalized(page, { data });

    await userEvent.click(within(page).getByRole('radio', { name: LIBRARY_TEXT.filter.image }));
    await within(page).findByText(LIBRARY_TEXT.noMatchTitle);
    expect(page.textContent).toContain(LIBRARY_TEXT.noMatchBody);
    expectFullyLocalized(page, { data });
  });
});
