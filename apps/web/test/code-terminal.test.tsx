import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { openSession, threadStream } from './code-helpers.tsx';
import { FakeScreen, FakeSocket } from './fakes.ts';
import type { ExecSessionView } from '../src/code/extras.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const SID = 'cs-term';
const announcer = () => screen.getByTestId('announcer').textContent ?? '';

const exec = (over: Partial<ExecSessionView> = {}): ExecSessionView => ({
  id: 'ex1',
  threadId: `t-${SID}`,
  turnId: 'turn1',
  callId: 'call-42',
  cmd: 'npm run dev',
  cwd: '/home/me/app',
  startedAt: '2026-10-01T12:00:00Z',
  retained: true,
  ...over,
});

describe('Terminal pane (FR-066, FR-184)', () => {
  it('starts a shell bound to the session and draws it in the pane', async () => {
    const { hub } = await openSession({ id: SID });
    await userEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    const pane = screen.getByRole('region', { name: 'Terminal' });
    expect(within(pane).getByText('No terminal is open in this session.')).toBeTruthy();
    await userEvent.click(within(pane).getByRole('button', { name: 'Start a terminal' }));
    const api = hub.api as unknown as { createSessionTerminal: (id: string) => unknown };
    await waitFor(() => expect(api.createSessionTerminal).toHaveBeenCalledWith(SID));
    const tab = await within(pane).findByRole('tab', { name: 'Terminal 1' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const id = hub.state.m5code.terminals[0]!.id;
    await waitFor(() => expect(FakeSocket.all.some((s) => s.url.includes(id))).toBe(true));
    const socket = FakeSocket.for(id);
    socket.open();
    socket.frame({ type: 'output', data: 'ready\r\n' });
    const term = FakeScreen.all.at(-1)!;
    expect(term.written).toContain('ready');
    await waitFor(() => expect(term.focused).toBeGreaterThan(0));
    expect(announcer()).toMatch(/Terminal started in the session folder/);
    await userEvent.click(within(pane).getByRole('button', { name: 'Clear' }));
    expect(term.cleared).toBe(1);

    // A second one, then closing the first.
    await userEvent.click(
      within(pane).getByRole('button', { name: 'New terminal in this session' }),
    );
    expect(await within(pane).findByRole('tab', { name: 'Terminal 2' })).toBeTruthy();
    await userEvent.click(within(pane).getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(hub.api.closeTerminal).toHaveBeenCalledWith(id));
    await waitFor(() => expect(within(pane).getAllByRole('tab')).toHaveLength(1));
    socket.frame({ type: 'exit', code: 0 });
  });

  it('lists the session’s shells the Hub already runs, and explains a missing sandbox', async () => {
    const { hub } = await openSession(
      { id: SID },
      {
        hub: {},
        code: {
          failExtras: {
            createSessionTerminal: new ApiError(409, {
              code: 'sandbox_unavailable',
              message: 'No sandbox',
              retryable: false,
            }),
          },
        },
      },
    );
    hub.state.m4.terminals = [
      {
        id: 'term-old',
        threadId: `t-${SID}`,
        cwd: '/home/me/app',
        status: 'running',
        exitCode: null,
        createdAt: '2026-10-01T12:00:00Z',
      },
      {
        id: 'term-other',
        threadId: null,
        cwd: '/',
        status: 'running',
        exitCode: null,
        createdAt: '2026-10-01T12:00:00Z',
      },
    ];
    await userEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    const pane = screen.getByRole('region', { name: 'Terminal' });
    expect(await within(pane).findByRole('tab', { name: 'Terminal 1' })).toBeTruthy();
    expect(within(pane).getAllByRole('tab')).toHaveLength(1);
    await userEvent.click(
      within(pane).getByRole('button', { name: 'New terminal in this session' }),
    );
    expect(await within(pane).findByText(/this Hub has none/)).toBeTruthy();
    expect(
      within(pane).getByRole('button', { name: 'New terminal in this session' }),
    ).toHaveProperty('disabled', true);
  });

  it('lists the agent’s running commands with an agent chip and kills one', async () => {
    const { hub, s } = await openSession(
      { id: SID },
      { code: { exec: [exec(), exec({ id: 'ex2', cmd: 'npm test -- --watch', callId: null })] } },
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    const list = await screen.findByRole('list', { name: 'Agent commands' });
    const row = within(list).getByRole('listitem', { name: 'npm run dev' });
    expect(within(row).getByText('agent')).toBeTruthy();
    expect(within(row).getByText('call-42')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Kill npm run dev' }));
    const api = hub.api as unknown as { killExecSession: (id: string) => unknown };
    await waitFor(() => expect(api.killExecSession).toHaveBeenCalledWith('ex1'));
    await waitFor(() =>
      expect(within(list).queryByRole('listitem', { name: 'npm run dev' })).toBeNull(),
    );
    expect(announcer()).toMatch(/Stopped npm run dev/);

    // A new command the agent starts shows after its tool call.
    hub.state.m5code.exec = [...hub.state.m5code.exec, exec({ id: 'ex3', cmd: 'make serve' })];
    threadStream(s.threadId).emit(
      'tool.call.completed',
      { threadId: s.threadId, callId: 'call-50', tool: 'exec.run', status: 'ok' },
      s.threadId,
    );
    expect(await within(list).findByRole('listitem', { name: 'make serve' })).toBeTruthy();

    // A failed kill says so.
    const api2 = hub.state.m5code;
    api2.failExtras.killExecSession = new Error('Already gone');
    await userEvent.click(within(list).getByRole('button', { name: 'Kill make serve' }));
    expect(await screen.findByText(/Could not stop the command: Already gone/)).toBeTruthy();
  });

  it('says when the Hub cannot list agent commands, and when there are none', async () => {
    const { hub } = await openSession(
      { id: SID },
      {
        code: {
          failExtras: {
            listExecSessions: new ApiError(404, {
              code: 'not_found',
              message: 'Not found',
              retryable: false,
            }),
          },
        },
      },
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(await screen.findByText('This Hub does not list agent commands yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByText('The agent has no commands running in this session.'),
    ).toBeTruthy();
    expect(hub.state.m5code.exec).toHaveLength(0);
  });
});

describe('Symbol search (FR-074)', () => {
  it('finds a symbol and opens its file at the line', async () => {
    const text = 'import x from "y";\n\nexport function sum(a, b) {\n  return a + b;\n}\n';
    const { hub } = await openSession(
      { id: SID },
      {
        code: {
          symbols: [
            { name: 'sum', kind: 'function', path: 'src/sum.ts', line: 3, container: null },
            { name: 'sumAll', kind: 'function', path: 'src/all.ts', line: 9, container: 'Totals' },
            { name: 'other', kind: 'class', path: 'src/other.ts', line: 1, container: null },
          ],
        },
      },
    );
    hub.state.m4.contents.set('/home/me/app::src/all.ts', {
      root: '/home/me/app',
      path: 'src/all.ts',
      mime: 'text/plain',
      size: text.length,
      text: `${'// line\n'.repeat(8)}export function sumAll() {}\n`,
      sha256: 'sha-all',
      readOnly: false,
    });
    hub.state.m4.contents.set('/home/me/app::src/sum.ts', {
      root: '/home/me/app',
      path: 'src/sum.ts',
      mime: 'text/plain',
      size: text.length,
      text,
      sha256: 'sha-sum',
      readOnly: false,
    });
    const box = screen.getByRole('combobox', { name: 'Go to symbol' });
    await userEvent.type(box, 'sum');
    const list = await screen.findByRole('listbox', { name: 'Symbols found' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2));
    expect(hub.api.codeSymbols).toHaveBeenLastCalledWith(SID, 'sum');
    expect(within(list).getAllByRole('option')[1]!.textContent).toMatch(
      /sumAll function in Totals · src\/all.ts:9/,
    );
    await userEvent.keyboard('{ArrowDown}');
    expect(box.getAttribute('aria-activedescendant')).toMatch(/-opt-1$/);
    await userEvent.keyboard('{ArrowUp}{Enter}');
    expect(screen.getByRole('tab', { name: 'File' }).getAttribute('aria-selected')).toBe('true');
    const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Contents of sum.ts',
    });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe(
      'export function sum(a, b) {',
    );
    expect(hub.api.readFile).toHaveBeenCalledWith('/home/me/app', 'src/sum.ts');

    // A click on another result jumps there.
    await userEvent.type(box, 'All');
    const again = await screen.findByRole('listbox', { name: 'Symbols found' });
    await waitFor(() => expect(within(again).getAllByRole('option')).toHaveLength(1));
    await userEvent.click(within(again).getByRole('option'));
    const second = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Contents of all.ts',
    });
    await waitFor(() =>
      expect(second.value.slice(second.selectionStart, second.selectionEnd)).toBe(
        'export function sumAll() {}',
      ),
    );
  });

  it('says when nothing matches or the search fails, and Escape clears the box', async () => {
    const { hub } = await openSession({ id: SID });
    const box = screen.getByRole<HTMLInputElement>('combobox', { name: 'Go to symbol' });
    await userEvent.type(box, 'nothing');
    expect(
      await screen.findByText('No symbols match.', { selector: '[role="status"]' }),
    ).toBeTruthy();
    hub.state.failNext.codeSymbols = new Error('Index not ready');
    await userEvent.type(box, 'x');
    await waitFor(() =>
      expect(screen.getByText('Index not ready', { selector: '[role="status"]' })).toBeTruthy(),
    );
    await userEvent.keyboard('{Escape}{Escape}');
    expect(box.value).toBe('');
    expect(screen.getByRole('tab', { name: 'File' })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'File' }));
    expect(screen.getByText(/Find a symbol with Go to symbol above/)).toBeTruthy();
  });
});
