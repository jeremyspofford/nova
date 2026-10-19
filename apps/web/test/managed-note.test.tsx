// "Managed by your organization" with its source (FR-106; docs/14 §1.2; J10 step 2): the shared
// lock note of every locked switch names where the lock comes from (the setting's own source, or
// the sources in force), stays the plain text where nothing is known, and the Settings banner says
// the Hub is managed, by what, and links to what applies.
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedBanner, ManagedNote } from '../src/managed/ManagedNote.tsx';
import { SwitchField } from '../src/settings/controls.tsx';
import { useSetting } from '../src/settings.tsx';
import {
  REMOTE_URL,
  localSource,
  lockPolicy,
  noPolicy,
  renderWithManaged,
} from './fakes-m8-managed.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

/** The Bypass switch as the Code settings show it: locked by the policy's settings layer. */
function BypassSwitch({ withKey = true }: { withKey?: boolean }) {
  const entry = useSetting('code.allowBypass');
  return (
    <SwitchField
      label="Allow Bypass"
      checked={entry.value}
      locked={entry.locked}
      onChange={() => undefined}
      {...(withKey ? { setting: 'code.allowBypass' } : {})}
    />
  );
}

describe('the lock note', () => {
  it('names the policy file on a switch the J10 policy locks, and disables it', async () => {
    const { api } = await renderWithManaged(<BypassSwitch />, { managed: { view: lockPolicy() } });
    const sw = screen.getByRole('switch', { name: 'Allow Bypass' });
    expect(sw.hasAttribute('disabled')).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
    expect(await screen.findByText('(policy file)')).toBeTruthy();
    // The note describes the switch.
    const lock = screen.getByText('Managed by your organization').parentElement!;
    expect(sw.getAttribute('aria-describedby')).toContain(lock.id);
    expect(api.getManagedPolicy).toHaveBeenCalledTimes(1);
  });

  it("names the setting's own source, else the sources in force", async () => {
    const view = lockPolicy({
      sources: [
        localSource({ status: 'active', inForce: true }),
        {
          ...localSource({ status: 'active', inForce: true }),
          channel: 'remote',
          location: REMOTE_URL,
        },
      ],
      settings: [
        { key: 'code.allowBypass', value: false, channel: 'remote', derivedFrom: null },
        { key: 'network.egressMode', value: 'off', channel: 'both', derivedFrom: null },
      ],
    });
    await renderWithManaged(
      <>
        <BypassSwitch />
        <ManagedNote setting="network.egressMode" />
        <ManagedNote />
      </>,
      { managed: { view } },
    );
    expect(await screen.findByText('(remote policy)')).toBeTruthy();
    expect(screen.getAllByText('(policy file and remote policy)')).toHaveLength(2);
  });

  it('stays the plain text without a Hub client, without the managed calls, or for a member', async () => {
    render(<SwitchField label="Alone" checked={false} locked onChange={() => undefined} />);
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
    expect(screen.queryByText(/\(policy file/)).toBeNull();
    resetDom();

    const old = await renderWithManaged(<BypassSwitch withKey={false} />, {
      managed: { view: lockPolicy() },
      unsupported: true,
    });
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
    expect(screen.queryByText(/\(policy file/)).toBeNull();
    expect(old.api.getManagedPolicy).not.toHaveBeenCalled();
    resetDom();

    const member = await renderWithManaged(<ManagedNote setting="code.allowBypass" />, {
      as: 'member',
      managed: { view: lockPolicy() },
    });
    await waitFor(() => expect(member.api.getManagedPolicy).toHaveBeenCalled());
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
    expect(screen.queryByText(/\(policy file/)).toBeNull();
  });

  it('can be a paragraph under a group of controls', async () => {
    await renderWithManaged(<ManagedNote as="p" id="lock-1" />, {
      managed: { view: lockPolicy() },
    });
    const note = document.getElementById('lock-1')!;
    expect(note.tagName).toBe('P');
    expect(await within(note).findByText('(policy file)')).toBeTruthy();
  });
});

describe('the Settings banner', () => {
  it('says the Hub is managed, by what, and links to the policy', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    await renderWithManaged(<ManagedBanner />, { managed: { view: lockPolicy() } });
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('Your organization manages this Hub.');
    expect(within(note).getByText('/etc/nova/managed-settings.json')).toBeTruthy();
    expect(note.textContent).toContain('Policy file on this Hub');
    const link = within(note).getByRole('link', { name: 'See the managed policy' });
    expect(link.getAttribute('href')).toBe('/settings/managed');
    await userEvent.click(link);
    expect(push).toHaveBeenCalledWith(null, '', '/settings/managed');
    push.mockRestore();
  });

  it('says every agent tool is denied while the policy fails closed', async () => {
    await renderWithManaged(<ManagedBanner />, {
      managed: {
        view: {
          ...noPolicy(),
          failClosed: 'the policy file is not valid JSON',
          sources: [localSource({ status: 'invalid', problem: 'not valid JSON' })],
        },
      },
    });
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain("Your organization's policy could not be read");
    expect(note.textContent).toContain('Every agent tool is denied until the policy is fixed.');
    expect(note.textContent).toContain('the policy file is not valid JSON');
  });

  it('shows nothing when no policy applies or the Hub keeps it from a member', async () => {
    const { api } = await renderWithManaged(<ManagedBanner />);
    await waitFor(() => expect(api.getManagedPolicy).toHaveBeenCalled());
    expect(screen.queryByRole('note')).toBeNull();
    resetDom();
    const member = await renderWithManaged(<ManagedBanner />, {
      as: 'member',
      managed: { view: lockPolicy() },
    });
    await waitFor(() => expect(member.api.getManagedPolicy).toHaveBeenCalled());
    expect(screen.queryByRole('note')).toBeNull();
  });
});
