// The flagged features in the pseudo-locale (FR-016): Settings → Experimental (both switches and
// their confirmations, the script limits, the adapters with a check, the adapter dialog, the
// check dialog, the remove confirmation), a Code session's script runs (off, and a run opened to
// its nested calls) and its delegations (off, a finished one, the delegate dialog) show every word
// through messages. Adapter, program, variable, host, session and tool names and an agent's reply
// are fixture data.
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ADAPTER_TEXT } from '../src/flagged/AdapterDialog.tsx';
import { DELEGATIONS_TEXT, DelegationsPane } from '../src/flagged/DelegationsPane.tsx';
import { EXPERIMENTAL_TEXT, ExperimentalSettings } from '../src/flagged/ExperimentalSettings.tsx';
import { EXPERIMENTAL_LABEL, FLAGGED_TEXT } from '../src/flagged/format.ts';
import { FLAG_OFF_TEXT, SCRIPTS_TEXT, ScriptRuns } from '../src/flagged/ScriptRuns.tsx';
import { codeSession } from './fakes-m5-code.ts';
import { adapterView, delegationView, renderWithWork, scriptRun } from './fakes-m7-work.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

const DATA = [
  'Coder',
  'coder 1.2',
  'coder-acp',
  '--acp',
  'CODER_KEY',
  'api.coder.example',
  'Parser work',
  'Fix the flaky test',
  'I fixed the test.',
  'fs.read',
  'fs.write',
  // Examples in the adapter form (a program, an argument, a host).
  'my-agent-acp',
  'api.example.com',
];

const session = codeSession({ id: 'cs1', title: 'Parser work', threadId: 't-cs1' });
const ON = { 'scripts.enabled': true, 'externalAgents.enabled': true };

describe('the flagged features in a pseudo-locale', () => {
  it('shows Settings → Experimental off, with the confirmation to turn it on', async () => {
    await activateTestLocale('en-XA');
    const { container } = await renderWithWork(<ExperimentalSettings />, { sessions: [session] });
    await screen.findByRole('heading', { name: EXPERIMENTAL_TEXT.title });
    expectFullyLocalized(container, { data: DATA });
    await userEvent.click(screen.getByRole('switch', { name: EXPERIMENTAL_TEXT.scripts.label }));
    expectFullyLocalized(
      screen.getByRole('dialog', { name: EXPERIMENTAL_TEXT.scripts.confirmTitle }),
      { data: DATA },
    );
  });

  it('shows Settings → Experimental on, with adapters and their dialogs', async () => {
    await activateTestLocale('en-XA');
    const checked = adapterView({
      id: 'ad1',
      lastCheck: {
        ok: true,
        at: '2026-10-01T12:00:00.000Z',
        agent: { name: 'coder', version: '1.2' },
        protocolVersion: 1,
        reason: null,
      },
    });
    const { container } = await renderWithWork(<ExperimentalSettings />, {
      sessions: [session],
      settings: ON,
      work: {
        adapters: [checked, adapterView({ id: 'ad2', enabled: false, env: {}, network: [] })],
        scriptRuns: [scriptRun({ threadId: 't-cs1' })],
      },
    });
    await screen.findByRole('list', { name: EXPERIMENTAL_TEXT.adapters.list });
    await screen.findByRole('list', { name: SCRIPTS_TEXT.list });
    expectFullyLocalized(container, { data: DATA });

    await userEvent.click(screen.getByRole('button', { name: EXPERIMENTAL_TEXT.adapters.add }));
    const add = screen.getByRole('dialog', { name: ADAPTER_TEXT.addTitle });
    await userEvent.click(within(add).getByRole('button', { name: ADAPTER_TEXT.addVariable }));
    await userEvent.click(within(add).getByRole('button', { name: ADAPTER_TEXT.add }));
    expectFullyLocalized(add, { data: DATA });
    await userEvent.click(within(add).getByRole('button', { name: FLAGGED_TEXT.cancel }));

    const row = screen.getAllByRole('listitem', { name: 'Coder' })[0]!;
    await userEvent.click(
      within(row).getByRole('button', { name: EXPERIMENTAL_TEXT.adapters.check }),
    );
    const check = screen.getByRole('dialog', {
      name: EXPERIMENTAL_TEXT.check.title({ name: 'Coder' }),
    });
    await userEvent.click(
      within(check).getByRole('button', { name: EXPERIMENTAL_TEXT.check.check }),
    );
    await within(check).findByRole('status');
    expectFullyLocalized(check, { data: DATA });
    await userEvent.click(within(check).getByRole('button', { name: FLAGGED_TEXT.close }));

    await userEvent.click(
      within(row).getByRole('button', { name: EXPERIMENTAL_TEXT.adapters.remove }),
    );
    expectFullyLocalized(
      screen.getByRole('dialog', {
        name: EXPERIMENTAL_TEXT.adapters.removeTitle({ name: 'Coder' }),
      }),
      { data: DATA },
    );
    // The page's name other areas render follows the locale.
    expect(EXPERIMENTAL_LABEL).toBe(FLAGGED_TEXT.where);
    expect(EXPERIMENTAL_LABEL).not.toBe('Settings → Experimental');
  });

  it("shows a session's script runs, off and with a run opened", async () => {
    await activateTestLocale('en-XA');
    const off = await renderWithWork(<ScriptRuns threadId="t-cs1" />, { sessions: [session] });
    screen.getByRole('heading', { name: FLAG_OFF_TEXT.scripts });
    expectFullyLocalized(off.container);
    resetDom();

    const on = await renderWithWork(<ScriptRuns threadId="t-cs1" />, {
      sessions: [session],
      settings: ON,
      work: {
        scriptRuns: [scriptRun({ threadId: 't-cs1', errorCode: 'cpu_limit', status: 'error' })],
      },
    });
    const list = await screen.findByRole('list', { name: SCRIPTS_TEXT.list });
    await userEvent.click(within(list).getAllByRole('button')[0]!);
    await screen.findByRole('list', { name: SCRIPTS_TEXT.nestedList });
    expectFullyLocalized(on.container, { data: DATA });
  });

  it("shows a session's delegations, off, finished and the delegate dialog", async () => {
    await activateTestLocale('en-XA');
    const off = await renderWithWork(<DelegationsPane sessionId="cs1" threadId="t-cs1" />, {
      sessions: [session],
    });
    screen.getByRole('heading', { name: FLAG_OFF_TEXT.agents });
    expectFullyLocalized(off.container);
    resetDom();

    const on = await renderWithWork(<DelegationsPane sessionId="cs1" threadId="t-cs1" />, {
      sessions: [session],
      settings: ON,
      work: {
        adapters: [adapterView({ id: 'ad1' })],
        delegations: [
          delegationView({ threadId: 't-cs1', stopReason: 'max_tokens' }),
          delegationView({
            threadId: 't-cs1',
            status: 'failed',
            error: 'does not own',
            agent: null,
          }),
        ],
      },
    });
    await screen.findByRole('list', { name: DELEGATIONS_TEXT.list });
    expectFullyLocalized(on.container, { data: DATA });
    await userEvent.click(screen.getByRole('button', { name: DELEGATIONS_TEXT.delegate }));
    const dialog = await screen.findByRole('dialog', { name: DELEGATIONS_TEXT.dialogTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: DELEGATIONS_TEXT.submit }));
    expectFullyLocalized(dialog, { data: DATA });
  });
});
