// Managed policy in the pseudo-locale (FR-016): every word of Settings → Managed policy (how a
// setting is decided, the summary, each source and its status, the restrictions in sentences, the
// settings it sets, what it ignores, a member's note, the load error), the lock note on a control
// and the Settings banner comes from messages. Paths, setting keys and values, and the Hub's own
// words (a source's problem, the fail-closed reason) are data.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { UI_TEXT } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import { ManagedBanner, ManagedNote } from '../src/managed/ManagedNote.tsx';
import { ManagedPolicyPage } from '../src/managed/ManagedPolicyPage.tsx';
import {
  CHANNEL_LABEL,
  LOCK_SOURCE,
  MANAGED_STRINGS,
  restrictionLines,
} from '../src/managed/format.ts';
import { localSource, lockPolicy, noPolicy, renderWithManaged } from './fakes-m8-managed.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

/** Setting values the fixture policy sets (shown as they are). */
const VALUES = ['dark', 'defaults', 'off'];
/** The Code area's mode names (code/modes.ts), not this area's words. */
const MODE_NAMES = ['Bypass'];

describe('Managed policy in en-XA', () => {
  it('shows the page for a policy in force, with every restriction and ignored key', async () => {
    await activateTestLocale('en-XA');
    const view = lockPolicy({
      restrict: [
        {
          channel: 'local',
          restrict: {
            tools: { allow: [], deny: ['screen.*'] },
            mcpServers: { allow: ['corp-docs'], userAdded: false, localStdio: false },
            sessions: { local: false, ssh: false, sshHosts: ['*.build.corp.example'] },
            egress: { mode: 'allowlist', allow: ['registry.npmjs.org'] },
            telemetryExport: false,
            routing: { allowCloud: false },
            unverifiedInstalls: false,
            apps: false,
          },
        },
        { channel: 'remote', restrict: { egress: { mode: 'off' } } },
      ],
      ignored: [
        ...lockPolicy().ignored,
        {
          channel: 'local',
          key: 'chat.maxTokens',
          reason: 'invalid_value',
          message: 'chat.maxTokens must be a number',
        },
      ],
    });
    view.sources.push({
      ...localSource({ status: 'unreachable', problem: 'timeout', inForce: true, cached: true }),
      channel: 'remote',
      location: 'https://policy.corp.example/nova.json',
    });
    await renderWithManaged(<ManagedPolicyPage />, { managed: { view } });
    await screen.findByText(MANAGED_STRINGS.active);
    expect(
      screen.getByRole('list', {
        name: MANAGED_STRINGS.restrictionsFrom({ source: CHANNEL_LABEL.remote }),
      }),
    ).toBeTruthy();
    expectFullyLocalized(document.body, {
      data: [
        ...VALUES,
        'screen.*',
        'corp-docs',
        '*.build.corp.example',
        'registry.npmjs.org',
        'timeout',
        'chat.maxTokens must be a number',
      ],
    });
  });

  it('shows a policy that fails closed and a policy with no restrictions', async () => {
    await activateTestLocale('en-XA');
    const r = await renderWithManaged(<ManagedPolicyPage />, {
      managed: {
        view: {
          ...noPolicy(),
          failClosed: 'the policy file is not valid JSON',
          sources: [localSource({ status: 'invalid', problem: null, testOverride: true })],
        },
      },
    });
    await screen.findByText(MANAGED_STRINGS.failClosedTitle);
    expectFullyLocalized(document.body, { data: ['the policy file is not valid JSON'] });
    r.unmount();
    await renderWithManaged(<ManagedPolicyPage />, {
      managed: { view: lockPolicy({ restrict: [], settings: [], ignored: [] }) },
    });
    await screen.findByText(MANAGED_STRINGS.restrictNone);
    expectFullyLocalized(document.body);
  });

  it('tells a member the details are the owner’s, and says when the policy cannot load', async () => {
    await activateTestLocale('en-XA');
    const r = await renderWithManaged(<ManagedPolicyPage />, { as: 'member' });
    await screen.findByText(MANAGED_STRINGS.memberHidden);
    expectFullyLocalized(document.body);
    r.unmount();
    await renderWithManaged(<ManagedPolicyPage />, {
      prepare: (m) =>
        m.getManagedPolicy.mockRejectedValue(
          new ApiError(400, { code: 'validation', message: 'bad request', retryable: false }),
        ),
    });
    await screen.findByText(MANAGED_STRINGS.notAccepted);
    expect(screen.getByRole('button', { name: MANAGED_STRINGS.retry })).toBeTruthy();
    expectFullyLocalized(document.body);
  });

  it('shows the lock note and the Settings banner localized', async () => {
    await activateTestLocale('en-XA');
    const r = await renderWithManaged(<ManagedNote setting="code.allowBypass" />, {
      managed: { view: lockPolicy() },
    });
    await screen.findByText(LOCK_SOURCE.local);
    expect(document.body.textContent).toContain(UI_TEXT.managed);
    expectFullyLocalized(document.body);
    r.unmount();
    await renderWithManaged(<ManagedBanner />, { managed: { view: lockPolicy() } });
    const note = await screen.findByRole('note');
    expect(within(note).getByRole('link', { name: MANAGED_STRINGS.bannerSee })).toBeTruthy();
    expectFullyLocalized(note);
  });

  it('puts the restriction sentences and lists in the locale', async () => {
    await activateTestLocale('en-XA');
    const lines = restrictionLines({
      permissionModes: { deny: ['bypass'] },
      tools: { allow: [] },
      plugins: { allow: ['a', 'b'] },
    });
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      expectFullyLocalized(div, { data: [...MODE_NAMES, 'a', 'b'] });
    }
  });
});
