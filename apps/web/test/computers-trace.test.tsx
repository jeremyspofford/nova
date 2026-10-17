// Before/after screenshots in the Activity trace (FR-098, docs/11 §9): browser and screen actions
// show lazy thumbnails with alt text that open full size; a screenshot past its retention says
// "Screenshot no longer kept"; one never taken says so; only the Hub's own image paths load; and
// replay names computer steps.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityItemView } from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { isHubImagePath } from '../src/computers/Shots.tsx';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { ActivityTrace } from '../src/work/ActivityTrace.tsx';
import { createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { computerItem } from './fakes-m6-computers.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

function renderTrace(items: ActivityItemView[]) {
  const hub = createHub();
  hub.state.m3.activity.set('th1', items);
  render(
    <ServicesProvider api={hub.api} eventSource={fakeEventSource} registry={testRegistry()}>
      <ToastProvider>
        <AnnouncerProvider>
          <ActivityTrace refId="th1" version={0} />
        </AnnouncerProvider>
      </ToastProvider>
    </ServicesProvider>,
  );
  return hub;
}

const trace = () => screen.findByRole('list', { name: 'Activity trace' });

describe('screenshots in the Activity trace (FR-098)', () => {
  it('shows lazy before and after thumbnails that open full size', async () => {
    renderTrace([computerItem({ id: 'a1', title: 'Browser: click #submit' })]);
    const list = await trace();
    const shots = within(list).getByRole('group', { name: 'Screenshots: Browser: click #submit' });
    const before = within(shots).getByRole<HTMLImageElement>('img', {
      name: 'Before: Browser: click #submit',
    });
    expect(before.getAttribute('src')).toBe('/api/v1/browser/actions/ba1/screenshots/before');
    expect(before.getAttribute('loading')).toBe('lazy');
    const after = within(shots).getByRole<HTMLImageElement>('img', {
      name: 'After: Browser: click #submit',
    });
    expect(after.getAttribute('src')).toBe('/api/v1/browser/actions/ba1/screenshots/after');

    await userEvent.click(
      within(shots).getByRole('button', { name: 'Open the after screenshot full size' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'After: Browser: click #submit' });
    const full = within(dialog).getByRole('img', { name: 'After: Browser: click #submit' });
    expect(full.getAttribute('src')).toBe('/api/v1/browser/actions/ba1/screenshots/after');
    const tab = within(dialog).getByRole('link', { name: /Open in a new tab/ });
    expect(tab.getAttribute('target')).toBe('_blank');
    expect(tab.getAttribute('rel')).toBe('noopener noreferrer');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says a screenshot past its retention is no longer kept', async () => {
    renderTrace([computerItem({ id: 'a1' })]);
    const list = await trace();
    const before = within(list).getByRole('img', { name: /^Before:/ });
    fireEvent.error(before);
    expect(within(list).getByText('Screenshot no longer kept')).toBeTruthy();
    expect(within(list).queryByRole('img', { name: /^Before:/ })).toBeNull();
    // The other one still opens.
    expect(within(list).getByRole('img', { name: /^After:/ })).toBeTruthy();
  });

  it('says when a screenshot was not captured, and never loads an outside URL', async () => {
    renderTrace([
      computerItem({
        id: 'a1',
        title: 'Screen: click in Spreadsheet',
        shots: { before: null, after: 'https://evil.test/x.png' },
      }),
    ]);
    const list = await trace();
    expect(within(list).getAllByText('Not captured')).toHaveLength(2);
    expect(within(list).queryByRole('img')).toBeNull();
  });

  it('shows no screenshots for a computer item without them, and names it in replay', async () => {
    renderTrace([
      computerItem({ id: 'a1', title: 'Browser opened https://example.test', shots: undefined }),
      {
        id: 'a2',
        ts: '2026-10-01T12:00:01.000Z',
        kind: 'tool_call',
        title: 'fs.read notes.md',
        detail: null,
        status: 'ok',
        callId: 'c1',
        turnId: 't1',
      },
    ]);
    const list = await trace();
    expect(within(list).queryByRole('group')).toBeNull();
    // The step opens to its details with the kind in words.
    await userEvent.click(
      within(list).getByRole('button', { name: /Browser opened https:\/\/example\.test/ }),
    );
    expect(within(list).getByText('Computer')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Replay' }));
    const replay = screen.getByRole('group', { name: 'Replay' });
    expect(within(replay).getByRole('status').textContent).toBe(
      'Step 1 of 2: Computer, Browser opened https://example.test',
    );
  });
});

describe('isHubImagePath', () => {
  it('accepts only the Hub API paths', () => {
    expect(isHubImagePath('/api/v1/browser/actions/a/screenshots/before')).toBe(true);
    expect(isHubImagePath('/api/v1/computers/c/screen/actions/a/after')).toBe(true);
    expect(isHubImagePath(null)).toBe(false);
    expect(isHubImagePath('')).toBe(false);
    expect(isHubImagePath('https://evil.test/a.png')).toBe(false);
    expect(isHubImagePath('//evil.test/a.png')).toBe(false);
    expect(isHubImagePath('/api/v1/../../etc/passwd')).toBe(false);
    expect(isHubImagePath('data:image/png;base64,AAAA')).toBe(false);
  });
});
