// Artifacts (FR-038) and the Activity tab: artifact cards open the Inspector, each kind renders
// safely (HTML sandboxed to scripts only), updates re-render, and the trace refreshes on events.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ArtifactKind } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { message } from './fakes.ts';
import { artifactView, inspector, openWith, stubFetch } from './chat-m3-helpers.tsx';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.unstubAllGlobals();
});

const content = (id: string) => `/api/v1/artifacts/${id}/content`;

describe('artifacts (FR-038)', () => {
  it('opens an artifact card in the Inspector and renders Markdown', async () => {
    stubFetch({ [content('art1')]: '# Launch plan\n\n- ship it' });
    const { hub } = await openWith({
      messages: (tid) => [
        message(tid, {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Here is the plan.' },
            { type: 'artifact', artifactId: 'art1', kind: 'markdown', title: 'Launch plan' },
          ],
        }),
      ],
      m3: (tid) => ({ artifacts: [artifactView(tid, { title: 'Launch plan' })] }),
    });
    // Switch away first, so opening the card has to bring the tab back.
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Files' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open artifact: Launch plan (Document)' }),
    );
    const tab = within(inspector()).getByRole('tab', { name: 'Artifacts' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const viewer = await within(inspector()).findByRole('article', { name: 'Launch plan' });
    expect(
      await within(viewer).findByRole('heading', { name: 'Launch plan', level: 1 }),
    ).toBeTruthy();
    expect(within(viewer).getByText('ship it')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(viewer).getByRole('heading', { level: 3 })),
    );
    const download = within(viewer).getByRole('link', { name: /Download/ });
    expect(download.getAttribute('href')).toBe(content('art1'));
    // Back to the list of this chat's artifacts.
    await userEvent.click(within(inspector()).getByRole('button', { name: /All artifacts/ }));
    const list = within(inspector()).getByRole('list', { name: 'Artifacts in this chat' });
    expect(within(list).getByRole('button', { name: /Launch plan/ })).toBeTruthy();
    expect(hub.api.listArtifacts).toHaveBeenCalled();
  });

  it('renders code with the built-in highlighter', async () => {
    stubFetch({ [content('art1')]: 'export const answer = 42; // why' });
    await openWith({
      m3: (tid) => ({
        artifacts: [
          artifactView(tid, { kind: 'code', title: 'answer.ts', language: 'typescript' }),
        ],
      }),
    });
    await userEvent.click(await within(inspector()).findByRole('button', { name: /answer\.ts/ }));
    const code = await within(inspector()).findByLabelText('Code: answer.ts');
    expect(code.querySelector('.nv-tok-keyword')?.textContent).toBe('export');
    expect(code.querySelector('.nv-tok-number')?.textContent).toBe('42');
    expect(code.querySelector('.nv-tok-comment')?.textContent).toBe('// why');
  });

  it('runs HTML only in a scripts-only sandbox, never same-origin', async () => {
    const { hub, t, es } = await openWith({
      m3: (tid) => ({
        artifacts: [artifactView(tid, { kind: 'html', title: 'Chart page', mime: 'text/html' })],
      }),
    });
    await userEvent.click(await within(inspector()).findByRole('button', { name: /Chart page/ }));
    const frame = await within(inspector()).findByTitle('Artifact: Chart page');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('src')).toBe(`${content('art1')}?v=1.0`);

    // An update re-renders it with the new version.
    hub.state.m3.artifacts = [
      artifactView(t.id, { kind: 'html', title: 'Chart page', mime: 'text/html', version: 2 }),
    ];
    es.emit('artifact.updated', { artifactId: 'art1', threadId: t.id, kind: 'html' }, t.id);
    await waitFor(() =>
      expect(within(inspector()).getByTitle('Artifact: Chart page').getAttribute('src')).toBe(
        `${content('art1')}?v=2.1`,
      ),
    );
  });

  it.each([
    ['image', 'image/png'],
    ['svg', 'image/svg+xml'],
    ['chart', 'image/svg+xml'],
  ] as [ArtifactKind, string][])('shows %s artifacts as images', async (kind, mime) => {
    await openWith({
      m3: (tid) => ({ artifacts: [artifactView(tid, { kind, mime, title: 'Picture' })] }),
    });
    await userEvent.click(await within(inspector()).findByRole('button', { name: /Picture/ }));
    const img = await within(inspector()).findByRole('img', { name: 'Picture' });
    expect(img.getAttribute('src')).toBe(`${content('art1')}?v=1.0`);
  });

  it('shows chart data that is not an image as JSON', async () => {
    stubFetch({ [content('art1')]: '{"series": [1, 2]}' });
    await openWith({
      m3: (tid) => ({
        artifacts: [artifactView(tid, { kind: 'chart', mime: 'application/json', title: 'Sales' })],
      }),
    });
    await userEvent.click(await within(inspector()).findByRole('button', { name: /Sales/ }));
    const code = await within(inspector()).findByLabelText('Chart data: Sales');
    expect(code.querySelector('.nv-tok-attr')?.textContent).toBe('"series"');
  });

  it('opens PDFs in the browser viewer and offers other files as downloads', async () => {
    await openWith({
      m3: (tid) => ({
        artifacts: [
          artifactView(tid, { kind: 'pdf', mime: 'application/pdf', title: 'Report' }),
          artifactView(tid, {
            id: 'art2',
            kind: 'file',
            mime: 'application/zip',
            title: 'bundle.zip',
            size: 2048,
          }),
        ],
      }),
    });
    await userEvent.click(await within(inspector()).findByRole('button', { name: /Report/ }));
    await within(inspector()).findByRole('article', { name: 'Report' });
    const pdf = inspector().querySelector('object')!;
    expect(pdf.getAttribute('aria-label')).toBe('Report');
    expect(pdf.getAttribute('type')).toBe('application/pdf');
    expect(pdf.getAttribute('data')).toBe(`${content('art1')}?v=1.0`);
    await userEvent.click(within(inspector()).getByRole('button', { name: /All artifacts/ }));
    await userEvent.click(within(inspector()).getByRole('button', { name: /bundle\.zip/ }));
    const viewer = await within(inspector()).findByRole('article', { name: 'bundle.zip' });
    expect(viewer.textContent).toContain('cannot be previewed');
    expect(viewer.textContent).toContain('2 KB');
    const link = within(viewer).getByRole('link', { name: /Download/ });
    expect(link.getAttribute('download')).toBe('bundle.zip');
  });

  it('re-fetches text when a live artifact changes, and recovers from a failed load', async () => {
    const fetchFn = stubFetch({ [content('art1')]: { status: 500 } });
    const { t, es } = await openWith({
      m3: (tid) => ({ artifacts: [artifactView(tid, { title: 'Notes', live: true })] }),
    });
    await userEvent.click(await within(inspector()).findByRole('button', { name: /Notes/ }));
    const viewer = await within(inspector()).findByRole('article', { name: 'Notes' });
    expect(viewer.textContent).toContain('live');
    expect((await within(viewer).findByRole('alert')).textContent).toContain('Server error');
    stubFetch({ [content('art1')]: 'first draft' });
    await userEvent.click(within(viewer).getByRole('button', { name: 'Retry' }));
    expect(await within(viewer).findByText('first draft')).toBeTruthy();
    const again = stubFetch({ [content('art1')]: 'second draft' });
    es.emit('artifact.updated', { artifactId: 'art1', threadId: t.id, kind: 'markdown' }, t.id);
    expect(await within(viewer).findByText('second draft')).toBeTruthy();
    expect(again).toHaveBeenCalledWith(`${content('art1')}?v=1.1`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(fetchFn).toHaveBeenCalled();
  });

  it('lists new artifacts as they are created, and handles an empty or failed list', async () => {
    const { hub, t, es } = await openWith({
      hub: {
        failNext: {
          listArtifacts: new ApiError(500, { code: 'x', message: 'Disk busy.', retryable: true }),
        },
      },
    });
    expect((await within(inspector()).findByRole('alert')).textContent).toContain('Disk busy.');
    await userEvent.click(within(inspector()).getByRole('button', { name: 'Retry' }));
    expect(await within(inspector()).findByText(/No artifacts in this chat yet/)).toBeTruthy();
    hub.state.m3.artifacts = [artifactView(t.id, { title: 'Fresh doc' })];
    es.emit('artifact.created', { artifactId: 'art1', threadId: t.id, kind: 'markdown' }, t.id);
    expect(await within(inspector()).findByRole('button', { name: /Fresh doc/ })).toBeTruthy();
  });

  it('fetches an opened artifact that is not in the list by id', async () => {
    stubFetch({ [content('elsewhere')]: 'from another chat' });
    const { hub } = await openWith({
      messages: (tid) => [
        message(tid, {
          role: 'assistant',
          parts: [{ type: 'artifact', artifactId: 'elsewhere', kind: 'markdown', title: null }],
        }),
      ],
      m3: () => ({ artifacts: [artifactView('other', { id: 'elsewhere', title: null })] }),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open artifact: Document (Document)' }),
    );
    await waitFor(() => expect(hub.api.getArtifact).toHaveBeenCalledWith('elsewhere'));
    expect(await within(inspector()).findByText('from another chat')).toBeTruthy();
  });

  it('shows the commands and menu entries that open the panels', async () => {
    const { registry } = await openWith();
    act(() => {
      registry.run('chat.activity');
    });
    expect(
      within(inspector()).getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected'),
    ).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Show artifacts' }));
    expect(
      within(inspector()).getByRole('tab', { name: 'Artifacts' }).getAttribute('aria-selected'),
    ).toBe('true');
  });
});

describe('activity tab', () => {
  it('lists the chat trace and refreshes on tool and approval events', async () => {
    const { hub, t, es } = await openWith({
      m3: (tid) => ({
        activity: new Map([
          [
            tid,
            [
              {
                id: 'a1',
                ts: '2026-10-01T12:00:00.000Z',
                kind: 'turn' as const,
                title: 'Turn started',
                detail: null,
                status: 'running',
                callId: null,
                turnId: 'turn1',
              },
            ],
          ],
        ]),
      }),
    });
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Activity' }));
    const list = await within(inspector()).findByRole('list', { name: 'Activity in this chat' });
    expect(within(list).getByText('Turn started')).toBeTruthy();
    hub.state.m3.activity.set(t.id, [
      ...hub.state.m3.activity.get(t.id)!,
      {
        id: 'a2',
        ts: '2026-10-01T12:00:02.000Z',
        kind: 'tool_call',
        title: 'fs.read',
        detail: 'notes/a.md',
        status: 'ok',
        callId: 'c1',
        turnId: 'turn1',
      },
    ]);
    // Text deltas do not refresh it; a finished tool call does.
    es.emit('chat.delta', { threadId: t.id, messageId: 'x', type: 'text_delta', text: 'hi' }, t.id);
    es.emit(
      'tool.call.completed',
      { callId: 'c1', status: 'ok', durationMs: 5, resultPreview: '' },
      t.id,
    );
    expect(await within(inspector()).findByText('fs.read')).toBeTruthy();
    expect(within(inspector()).getByText('notes/a.md')).toBeTruthy();
    expect(hub.api.activity).toHaveBeenCalledTimes(2);
  });

  it('shows an empty state, and an error with Retry', async () => {
    const { hub } = await openWith();
    hub.state.failNext.activity = new ApiError(500, {
      code: 'x',
      message: 'Trace unavailable.',
      retryable: true,
    });
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Activity' }));
    expect((await within(inspector()).findByRole('alert')).textContent).toContain(
      'Trace unavailable.',
    );
    await userEvent.click(within(inspector()).getByRole('button', { name: 'Retry' }));
    expect(
      await within(inspector()).findByText('Nothing has happened in this chat yet.'),
    ).toBeTruthy();
  });
});
