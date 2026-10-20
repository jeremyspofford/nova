// The Computers views in the pseudo-locale (FR-016): the list with the Hub's sandbox and the
// settings every computer shares, one computer's page with its limits, snapshots, network and
// dialogs, and the before/after screenshots of the Activity trace. Agent names, snapshot labels,
// image names and the Hub's details are fixture data.
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ComputersView, VIEW_TEXT } from '../src/computers/ComputersView.tsx';
import { COMPUTERS_TEXT, formatMemory } from '../src/computers/format.ts';
import { SHOTS_TEXT, Shots } from '../src/computers/Shots.tsx';
import {
  computerView,
  renderWithComputers,
  scopeView,
  snapshotView,
} from './fakes-m6-computers.ts';
import {
  activateTestLocale,
  expectFullyLocalized,
  renderInLocale,
  resetTestLocale,
} from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

const AGENTS = [
  { id: 'ag1', name: 'Research' },
  { id: 'ag2', name: 'Ops' },
];

/** Agent names, snapshot labels and what the Hub says about a computer: the fakes' data. */
const DATA = [
  'Research',
  'Ops',
  'Before the upgrade',
  'Rootless container with the egress proxy.',
  'The device is not connected.',
  'podman 5',
];

describe('the Computers views in en-XA', () => {
  it('shows the list, the Hub’s sandbox and the shared settings localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithComputers(<ComputersView computerId={null} />, {
      computers: {
        agents: AGENTS,
        computers: [
          computerView({ id: 'c1', agentId: 'ag1', snapshotCount: 2 }),
          computerView({
            id: 'c2',
            agentId: 'ag2',
            kind: 'cloud',
            substrate: 'cloud_stub',
            provider: 'mock_cloud',
            state: 'stopped',
            lastUsedAt: null,
          }),
          computerView({
            id: 'c3',
            agentId: null,
            kind: 'local_host',
            deviceId: 'd1',
            substrate: 'host',
            state: 'degraded',
            detail: 'The device is not connected.',
          }),
        ],
      },
      sandbox: { substrate: 'container', available: true, detail: 'podman 5' },
    });
    const list = await screen.findByRole('list', { name: VIEW_TEXT.computers });
    await within(list).findByRole('link', {
      name: COMPUTERS_TEXT.title.agent({ agent: 'Research' }),
    });
    await screen.findByText(
      VIEW_TEXT.sandbox.runsIn({ sandbox: COMPUTERS_TEXT.hubSandboxes.container }),
      {
        exact: false,
      },
    );
    expectFullyLocalized(document.querySelector('.computers-page')!, { data: DATA });

    // A limit out of range shows its error in the locale too.
    const cpu = screen.getByRole('spinbutton', { name: VIEW_TEXT.limits.fields.cpus });
    await userEvent.clear(cpu);
    await userEvent.type(cpu, '100');
    expectFullyLocalized(document.querySelector('.computers-limits')!, { data: DATA });
  });

  it('shows one computer, its snapshots, its network and its dialogs localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithComputers(<ComputersView computerId="c1" />, {
      computers: {
        agents: AGENTS,
        computers: [computerView({ id: 'c1', agentId: 'ag1', snapshotCount: 1 })],
        snapshots: [snapshotView({ id: 's1', computerId: 'c1' })],
        scopes: [scopeView({ kind: 'agent', id: 'ag1', mode: 'limited', allow: ['a.test'] })],
      },
      settings: { 'computers.limits': { cpus: 1, memoryMb: 4096, wallClockSeconds: 600 } },
    });
    await screen.findByRole('heading', {
      name: COMPUTERS_TEXT.title.agent({ agent: 'Research' }),
      level: 1,
    });
    const net = screen.getByRole('region', { name: VIEW_TEXT.network.title });
    await within(net).findByText(/1/);
    expect(screen.getByRole('region', { name: VIEW_TEXT.resources.title }).textContent).toContain(
      formatMemory(4096),
    );
    expectFullyLocalized(document.querySelector('.computers-page')!, { data: DATA });

    await userEvent.click(screen.getByRole('button', { name: VIEW_TEXT.snapshot.take }));
    expectFullyLocalized(screen.getByRole('dialog', { name: VIEW_TEXT.snapshot.take }), {
      data: DATA,
    });
    await userEvent.keyboard('{Escape}');

    const snaps = screen.getByRole('list', { name: VIEW_TEXT.snapshot.title });
    await userEvent.click(within(snaps).getAllByRole('button')[0]!);
    expectFullyLocalized(screen.getByRole('dialog', { name: VIEW_TEXT.snapshot.restoreTitle }), {
      data: DATA,
    });
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(snaps).getAllByRole('button')[1]!);
    expectFullyLocalized(screen.getByRole('dialog', { name: VIEW_TEXT.snapshot.deleteTitle }), {
      data: DATA,
    });
  });

  it('shows a missing computer localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithComputers(<ComputersView computerId="nope" />, {
      computers: { agents: AGENTS, computers: [] },
    });
    await screen.findByRole('heading', { name: VIEW_TEXT.page.notFound });
    expectFullyLocalized(document.querySelector('.computers-page')!);
  });

  it('shows the screenshots of an action localized', async () => {
    await renderInLocale(
      'en-XA',
      <Shots shots={{ before: '/api/v1/shots/a.png', after: null }} title="Clicked Save" />,
    );
    const group = screen.getByRole('group', { name: SHOTS_TEXT.group({ title: 'Clicked Save' }) });
    expectFullyLocalized(group, { data: ['Clicked Save'] });
    await userEvent.click(within(group).getByRole('button'));
    expectFullyLocalized(screen.getByRole('dialog'), { data: ['Clicked Save'] });
  });
});
