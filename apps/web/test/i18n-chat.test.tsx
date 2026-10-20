// The chat area in the pseudo-locale (FR-016): every word chat owns comes from messages. Regions
// other areas own are skipped (named where they are), and fixture data (titles, message text,
// tool titles, the Hub's approval text) is passed as data.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { MessageView, ThreadView } from '@nova/shared';
import { App } from '../src/App.tsx';
import { ACTIVITY_TEXT } from '../src/chat/ActivityPanel.tsx';
import { APPROVAL_TEXT } from '../src/chat/ApprovalCard.tsx';
import { ARTIFACT_KIND_TEXT, ARTIFACT_TEXT } from '../src/chat/Artifacts.tsx';
import { BRANCHES_TEXT } from '../src/chat/BranchesPanel.tsx';
import { COMPARE_TEXT } from '../src/chat/CompareView.tsx';
import { COMPOSER_TEXT } from '../src/chat/Composer.tsx';
import { SEARCH_TEXT } from '../src/chat/SearchPanel.tsx';
import { SIDE_CHAT_TEXT } from '../src/chat/SideChat.tsx';
import { CHAT_TEXT } from '../src/chat/strings.ts';
import { TOOL_TEXT } from '../src/chat/ToolCard.tsx';
import { SHELL_TEXT, SIDEBAR_TEXT } from '../src/shell/strings.ts';
import { artifactView, approvalView, stubFetch, toolPart } from './chat-m3-helpers.tsx';
import { m3State, type M3State } from './fakes-m3.ts';
import {
  createHub,
  fakeEventSource,
  fakeTerminalScreen,
  fakeWebSocket,
  message,
  testRegistry,
  thread,
  type HubState,
} from './fakes.ts';
import { resetDom } from './render.tsx';
import { expectFullyLocalized, renderInLocale, resetTestLocale } from './i18n.ts';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

/** Fixture text: chat titles, message text, tool titles, model names and the Hub's words. */
const DATA = [
  'Trip to Lisbon',
  'Branch plan',
  'Quick question',
  'Plan three days in Lisbon',
  'itinerary.pdf',
  'Day one: Alfama.',
  'Read file',
  'fs.read',
  'fs.write',
  'Write file',
  'Write notes/plan.md',
  'Writing files asks first.',
  'This tool (fs.write) in this project',
  'Commands starting with npm test',
  'Network host api.example.com',
  'Plan',
  'Mock fast',
  'Mock smart',
  'Lisbon guide',
  'visitlisbon.com',
  'The old town by the river.',
  'Turn started',
  'running',
  'I will write the plan.',
];

/**
 * Regions other areas own: the composer's image button (images), its + menu (extensions), the
 * open-in-window button (shellbridge), the share items (team), the shell around the chat, and the
 * key-binding chips (packages/ui).
 */
const OTHER_AREAS = ['.nv-kbds', '.composer-plus'];

function chatMessages(tid: string): MessageView[] {
  return [
    message(tid, {
      id: 'm1',
      role: 'user',
      parts: [
        { type: 'text', text: 'Plan three days in Lisbon' },
        {
          type: 'file',
          attachmentId: 'att1',
          name: 'itinerary.pdf',
          mime: 'application/pdf',
          size: 2048,
        },
      ],
    }),
    message(tid, {
      id: 'm2',
      role: 'assistant',
      model: 'pa1/mock-fast',
      siblingIds: ['m2', 'm2b'],
      parts: [
        { type: 'text', text: 'Day one: Alfama.' },
        toolPart({ callId: 'c-read', durationMs: 1500 }),
        {
          type: 'artifact',
          artifactId: 'art1',
          kind: 'markdown',
          title: 'Plan',
          version: 1,
        },
      ],
      citations: [
        {
          id: 'cit1',
          idx: 1,
          title: 'Lisbon guide',
          url: 'https://visitlisbon.com/guide',
          snippet: 'The old town by the river.',
        },
      ],
    } as Partial<MessageView>),
    message(tid, {
      id: 'm3',
      role: 'assistant',
      status: 'streaming',
      turnId: 'turn1',
      model: 'pa1/mock-fast',
      parts: [
        { type: 'text', text: 'I will write the plan.' },
        toolPart({
          callId: 'call1',
          tool: 'fs.write',
          title: 'Write file',
          status: 'awaiting_approval',
          approvalId: 'ap1',
          resultPreview: null,
          durationMs: null,
        }),
      ],
    }),
  ];
}

async function renderChat(
  locale: string,
  opts: {
    path?: (t: ThreadView) => string;
    threads?: (t: ThreadView) => ThreadView[];
    m3?: (tid: string) => Partial<M3State>;
    hub?: Partial<HubState>;
  } = {},
) {
  const t = thread({ title: 'Trip to Lisbon' });
  const hub = createHub({
    ...opts.hub,
    threads: [t, ...(opts.threads?.(t) ?? [])],
    m3: m3State({
      approvals: [approvalView(t.id)],
      artifacts: [artifactView(t.id)],
      ...opts.m3?.(t.id),
    }),
  });
  hub.state.messages.set(t.id, chatMessages(t.id));
  const registry = testRegistry();
  window.history.replaceState(null, '', opts.path?.(t) ?? `/chat/${t.id}`);
  const utils = await renderInLocale(
    locale,
    <App
      api={hub.api}
      registry={registry}
      eventSource={fakeEventSource}
      takeSetupCode={() => null}
      announceEveryMs={0}
      webSocket={fakeWebSocket}
      terminalScreen={fakeTerminalScreen}
    />,
  );
  await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });
  return { ...utils, hub, t };
}

const inspector = () => screen.getByRole('complementary', { name: SHELL_TEXT.inspector });

describe('the chat in a pseudo-locale', () => {
  it('shows a chat with tool calls, an approval, an artifact and sources fully localized', async () => {
    stubFetch({});
    const { t } = await renderChat('en-XA');
    const chat = await screen.findByRole('region', { name: 'Trip to Lisbon' });
    await within(chat).findByText('Day one: Alfama.');
    await within(chat).findByRole('heading', { name: APPROVAL_TEXT.needed });
    expect(within(chat).getByRole('group', { name: TOOL_TEXT.card({ title: 'Read file' }) }));
    expect(
      within(chat).getByRole('button', {
        name: ARTIFACT_TEXT.openArtifact({ title: 'Plan', kind: ARTIFACT_KIND_TEXT.markdown }),
      }),
    ).toBeTruthy();
    expectFullyLocalized(chat, { data: DATA, skip: OTHER_AREAS });

    // The tool card's details, the approval's scope chooser and the deny form.
    await userEvent.click(within(chat).getByRole('button', { name: /Read file/ }));
    const decisions = within(chat).getByRole('group', { name: APPROVAL_TEXT.decision });
    await userEvent.click(within(decisions).getAllByRole('button')[2]!);
    expect(within(chat).getByRole('form', { name: APPROVAL_TEXT.alwaysAllow })).toBeTruthy();
    await userEvent.click(within(chat).getAllByRole('radio')[1]!);
    expectFullyLocalized(chat, { data: DATA, skip: OTHER_AREAS });

    // The chat list in the sidebar is chat's too.
    const list = document.querySelector('.thread-list');
    expect(list).toBeTruthy();
    expectFullyLocalized(list!, { data: DATA });

    // The chat options menu.
    await userEvent.click(screen.getByRole('button', { name: CHAT_TEXT.options }));
    expectFullyLocalized(screen.getByRole('menu'), {
      // Share items are team's.
      skip: ['[role="menuitem"]:not([id])'],
    });
    await userEvent.keyboard('{Escape}');
    expect(t.title).toBe('Trip to Lisbon');
  });

  it('shows the inspector panels localized: artifacts, activity, branches and side chat', async () => {
    stubFetch({ '/api/v1/artifacts/art1/content': '# Plan\n\nDay one.' });
    await renderChat('en-XA', {
      threads: (t) => [
        thread({ title: 'Branch plan', parentThreadId: t.id, branchFromMessageId: 'm1' }),
        thread({ title: 'Quick question', parentThreadId: t.id, side: true }),
      ],
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
    await screen.findByRole('region', { name: 'Trip to Lisbon' });
    const tabs = within(inspector()).getByRole('tablist');

    await userEvent.click(within(tabs).getByRole('tab', { name: SHELL_TEXT.tabs.artifacts }));
    const artifacts = await within(inspector()).findByRole('list', { name: ARTIFACT_TEXT.list });
    expectFullyLocalized(artifacts, { data: DATA });
    await userEvent.click(within(artifacts).getByRole('button'));
    const viewer = await within(inspector()).findByRole('article');
    await within(viewer).findByText('Day one.');
    expectFullyLocalized(viewer, { data: [...DATA, 'Day one.'] });

    await userEvent.click(within(tabs).getByRole('tab', { name: SHELL_TEXT.tabs.activity }));
    const activity = await within(inspector()).findByRole('region', { name: ACTIVITY_TEXT.title });
    await within(activity).findByText('Turn started');
    expectFullyLocalized(activity, { data: DATA });

    await userEvent.click(within(tabs).getByRole('tab', { name: SHELL_TEXT.tabs.branches }));
    const tree = await within(inspector()).findByRole('tree', { name: BRANCHES_TEXT.title });
    expectFullyLocalized(tree.parentElement!, { data: DATA });

    await userEvent.click(within(tabs).getByRole('tab', { name: SHELL_TEXT.tabs.side }));
    const side = await within(inspector()).findByRole('region', { name: SIDE_CHAT_TEXT.title });
    expectFullyLocalized(side, { data: DATA });
  });

  it('shows search, compare and a new chat localized', async () => {
    const { t, hub } = await renderChat('en-XA', {
      hub: {
        searchHits: [],
      },
    });
    hub.state.searchHits.push({
      threadId: t.id,
      messageId: 'm1',
      threadTitle: 'Trip to Lisbon',
      snippet: 'Plan three <mark>days</mark> in Lisbon',
      createdAt: '2026-10-01T12:00:00.000Z',
      role: 'user',
    });
    await screen.findByRole('region', { name: 'Trip to Lisbon' });
    await userEvent.click(screen.getByRole('button', { name: SIDEBAR_TEXT.search }));
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH_TEXT.label }), 'days');
    const hits = await screen.findByRole('list', { name: SEARCH_TEXT.list });
    const panel = hits.closest('.search-panel')!;
    expect(panel.textContent).toContain(SEARCH_TEXT.results({ n: 1 }));
    expectFullyLocalized(panel, { data: [...DATA, 'Plan three ', 'days', ' in Lisbon'] });
  });

  it('shows the compare view localized', async () => {
    const other = thread({ title: 'Branch plan' });
    await renderChat('en-XA', {
      threads: () => [other],
      path: (t) => `/chat/${t.id}?compare=${other.id}`,
    });
    const view = await screen.findByRole('region', { name: COMPARE_TEXT.title });
    await within(view).findByText('Day one: Alfama.');
    expectFullyLocalized(view, { data: DATA, skip: OTHER_AREAS });
  });

  it('shows an empty new chat and a temporary one localized', async () => {
    await renderChat('en-XA', { path: () => '/chat?temporary=1' });
    const chat = await screen.findByRole('region', { name: CHAT_TEXT.newTemporaryChat });
    expect(within(chat).getByRole('note').textContent).toContain(CHAT_TEXT.temporaryBanner);
    expect(
      within(chat)
        .getByRole('textbox', { name: COMPOSER_TEXT.message })
        .getAttribute('placeholder'),
    ).toBe(COMPOSER_TEXT.placeholder);
    expectFullyLocalized(chat, { data: DATA, skip: OTHER_AREAS });
  });
});

describe('the chat in Arabic', () => {
  it('shows the composer and the chat words in Arabic, right to left', async () => {
    await renderChat('ar');
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    const chat = await screen.findByRole('region', { name: 'Trip to Lisbon' });
    const box = within(chat).getByRole('textbox', { name: COMPOSER_TEXT.message });
    expect(COMPOSER_TEXT.message).toBe('الرسالة');
    expect(box.getAttribute('placeholder')).toBe('راسل Nova');
    expect(within(chat).getByRole('log', { name: CHAT_TEXT.messages })).toBeTruthy();
    expect(CHAT_TEXT.messages).toBe('الرسائل');
  });
});
