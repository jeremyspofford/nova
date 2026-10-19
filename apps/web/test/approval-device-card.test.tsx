// The approval card for M7.5 device cards (docs/04 §2.6, docs/23 §6.3): a Hub-only card
// (`answerIn: 'hub'`) says it can be answered only in Nova; a card about a device
// (`scope: device:<id>`) says which device and links to it; such a card offers a plain "Deny" (no
// run continues, so there is no reason for an agent). Other cards keep "Deny and continue…".
import { useState } from 'react';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalView } from '@nova/shared';
import { ApprovalCard } from '../src/chat/ApprovalCard.tsx';
import type { ClientApproval } from '../src/chat/thread-state.ts';
import { HUB_ONLY_TEXT } from '../src/firmware/format.ts';
import { renderWithFirmware } from './fakes-m75-firmware.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

function approval(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'appr-1',
    threadId: null,
    turnId: null,
    callId: null,
    action: 'Change BIOS/firmware settings on Desk PC: wol Disabled -> LanOnly',
    tool: 'device.firmware.apply',
    argsPreview: JSON.stringify({ device: 'Desk PC', deviceId: 'd1' }),
    reason: 'Requested by the owner',
    tier: 'confirm_at_action',
    risk: 'high',
    userAsked: true,
    ruleId: null,
    options: ['allow_once', 'deny_continue'],
    alwaysScopes: [],
    status: 'pending',
    decision: null,
    decidedBy: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    decidedAt: null,
    runId: null,
    codeSessionId: null,
    threadTitle: null,
    answerIn: 'hub',
    scope: 'device:d1',
    ...over,
  };
}

function Card({ initial }: { initial: ApprovalView }) {
  const [a, setA] = useState<ClientApproval>(initial);
  return <ApprovalCard approval={a} onChange={setA} />;
}

async function show(a: ApprovalView) {
  const r = await renderWithFirmware(<Card initial={a} />);
  r.hub.state.m3.approvals = [a];
  return r;
}

describe('device approval cards', () => {
  it('says a Hub-only card is answered only in Nova, links its device, and denies plainly', async () => {
    const { hub } = await show(approval());
    const card = screen.getByRole('group', { name: 'Approval needed' });
    expect(within(card).getByText(HUB_ONLY_TEXT)).toBeTruthy();
    const link = within(card).getByRole('link', { name: 'On Desk PC' });
    expect(link.getAttribute('href')).toBe('/devices/d1');
    expect(within(card).queryByRole('button', { name: 'Deny and continue…' })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Deny' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(hub.api.decideApproval).toHaveBeenCalledWith({
      approvalId: 'appr-1',
      decision: 'deny_continue',
    });
    expect(await screen.findByText(/Approval: Denied/)).toBeTruthy();
  });

  it('follows the device link', async () => {
    await show(approval());
    await userEvent.click(screen.getByRole('link', { name: 'On Desk PC' }));
    expect(window.location.pathname).toBe('/devices/d1');
  });

  it('names an unnamed device generically, and needs no Hub-only line for a device card', async () => {
    await show(approval({ argsPreview: 'not json', answerIn: null, scope: 'device:d 2' }));
    const card = screen.getByRole('group', { name: 'Approval needed' });
    expect(within(card).getByRole('link', { name: 'On a device' }).getAttribute('href')).toBe(
      '/devices/d%202',
    );
    expect(within(card).queryByText(HUB_ONLY_TEXT)).toBeNull();
    expect(within(card).getByRole('button', { name: 'Deny' })).toBeTruthy();
  });

  it('keeps "Deny and continue" with its reason for a run’s tool call', async () => {
    await show(
      approval({
        threadId: 't1',
        callId: 'c1',
        tool: 'exec.run',
        argsPreview: '{"cmd":"ls"}',
        tier: 'pre_approvable',
        answerIn: null,
        scope: 'thread:t1',
      }),
    );
    const card = screen.getByRole('group', { name: 'Approval needed' });
    expect(within(card).queryByText(HUB_ONLY_TEXT)).toBeNull();
    expect(within(card).queryByRole('link')).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Deny and continue…' }));
    expect(
      screen.getByText('Returned to the agent as the tool result; the run continues.'),
    ).toBeTruthy();
  });
});
