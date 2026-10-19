// Code → Environments and Settings → Code in M7 (FR-062, FR-071, FR-212, FR-213): an SSH
// environment's pinned host key with its fingerprint, a mismatch explained (nothing was sent; what
// to check), replacing or forgetting the key (both ask first), SSH environments being off on this
// Hub; cloud environments listed with Manage and created from here; and the M7 Code settings (SSH
// on only after asking, what a handoff leaves behind, Best of N defaults).
import { createHash } from 'node:crypto';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeM7Settings } from '../src/code/CodeM7Settings.tsx';
import {
  hostKeyFingerprint,
  isHostKeyMismatch,
  isSshOff,
  parseHostKey,
} from '../src/code/SshHostKey.tsx';
import { savedEnvironment } from './fakes-m6-code.ts';
import { renderM6 } from './fakes-m6-code.ts';
import { cloudEnv, createWorkHub, renderWithWork, runnerOn } from './fakes-m7-work.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const BLOB = Buffer.from('ssh-ed25519-test-key-bytes-0123456789').toString('base64');
const KEY = `ssh-ed25519 ${BLOB}`;
const FP = `SHA256:${createHash('sha256').update(Buffer.from(BLOB, 'base64')).digest('base64').replace(/=+$/, '')}`;

function ssh(over: Parameters<typeof savedEnvironment>[0] = {}) {
  return savedEnvironment({
    id: 'env-ssh',
    kind: 'ssh',
    label: 'Build box',
    connection: {
      kind: 'ssh',
      host: 'build.example.com',
      port: 22,
      user: 'ci',
      auth: 'key',
      hostKey: KEY,
      root: null,
      hasCredential: true,
    },
    ...over,
  });
}

async function openEnvironments(environments: ReturnType<typeof savedEnvironment>[], work = {}) {
  const parts = await renderM6('/code/environments', [], { code: { environments } });
  const w = createWorkHub(parts.hub, work);
  Object.assign(parts.hub.api, w.api);
  await screen.findByRole('heading', { level: 1, name: 'Environments' });
  return { ...parts, work: w };
}

const row = (name: string) => screen.getByRole('listitem', { name });

describe('SSH host keys (FR-062)', () => {
  it('shows the pinned key’s fingerprint and explains a mismatch', async () => {
    await openEnvironments([
      ssh({
        status: 'down',
        detail: 'the host key of build.example.com does not match the pinned key; nothing was sent',
      }),
    ]);
    const r = row('Build box');
    expect(await within(r).findByText(FP)).toBeTruthy();
    expect(within(r).getByText(/Pinned host key \(ssh-ed25519\)/)).toBeTruthy();
    const alert = within(r).getByRole('alert');
    expect(alert.textContent).toMatch(/build\.example\.com answered with a different host key/);
    expect(alert.textContent).toMatch(/Nova refused to connect and sent nothing/);
  });

  it('replaces the pinned key after asking, refusing text that is not a key', async () => {
    const { api } = await openEnvironments([ssh()]);
    await userEvent.click(
      within(row('Build box')).getByRole('button', { name: 'Replace the pinned key…' }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Replace the host key of build.example.com?',
    });
    await userEvent.type(within(dialog).getByLabelText('Host public key'), 'hello');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace key' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/not a public key line/);
    await userEvent.clear(within(dialog).getByLabelText('Host public key'));
    await userEvent.type(
      within(dialog).getByLabelText('Host public key'),
      `build.example.com ${KEY} root@build`,
    );
    expect(await within(dialog).findByText(`Its fingerprint: ${FP}`)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace key' }));
    await waitFor(() =>
      expect(api.updateEnvironment).toHaveBeenCalledWith('env-ssh', {
        connection: { hostKey: KEY },
      }),
    );
  });

  it('forgets the pinned key after asking, and says when SSH is off on this Hub', async () => {
    const { api } = await openEnvironments([
      ssh({
        status: 'down',
        detail: 'SSH environments are off on this Hub; turn on code.ssh.enabled',
      }),
    ]);
    const r = row('Build box');
    expect(within(r).getByRole('note').textContent).toMatch(/SSH environments are off on this Hub/);
    expect(within(r).getByRole('link', { name: 'Settings → Code' }).getAttribute('href')).toBe(
      '/settings/code',
    );
    await userEvent.click(within(r).getByRole('button', { name: 'Forget the pinned key…' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Forget the host key of build.example.com?',
    });
    expect(dialog.textContent).toMatch(/trusts whatever key the host shows on the next connection/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Forget key' }));
    await waitFor(() =>
      expect(api.updateEnvironment).toHaveBeenCalledWith('env-ssh', {
        connection: { hostKey: null },
      }),
    );
    expect(await within(row('Build box')).findByText(/not pinned yet/)).toBeTruthy();
  });
});

describe('cloud environments in Code → Environments (FR-071)', () => {
  it('lists a cloud environment with Manage, and creates one from here', async () => {
    const cloud = savedEnvironment({
      id: 'cenv',
      kind: 'cloud',
      label: 'App cloud',
      connection: { ...cloudEnv().connection, folder: '/workspace/app' },
    });
    const { work } = await openEnvironments([cloud], { runner: runnerOn() });
    const r = row('App cloud');
    expect(within(r).getByText('Cloud')).toBeTruthy();
    expect(within(r).getByText('app on the cloud runner, in /workspace/app')).toBeTruthy();
    expect(within(r).queryByRole('button', { name: 'Edit…' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'New cloud environment' }));
    const dialog = await screen.findByRole('dialog', { name: 'New cloud environment' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Docs');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    await waitFor(() => expect(work.api.createCloudEnvironment).toHaveBeenCalled());
    await waitFor(() => expect(window.location.pathname).toBe('/settings/cloud'));
  });

  it('says the runner is not set up when creating from here', async () => {
    await openEnvironments([]);
    await userEvent.click(screen.getByRole('button', { name: 'New cloud environment' }));
    const dialog = await screen.findByRole('dialog', { name: 'New cloud environment' });
    expect(within(dialog).getByRole('note').textContent).toMatch(/No cloud runner is set up yet/);
    expect(within(dialog).getByRole('button', { name: 'Create environment' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('Settings → Code in M7', () => {
  it('turns SSH environments on only after asking, and saves the handoff and Best of N defaults', async () => {
    const { hub } = await renderWithWork(<CodeM7Settings />);
    await userEvent.click(screen.getByRole('switch', { name: 'Connect to SSH environments' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect to SSH environments?' });
    expect(hub.api.setSetting).not.toHaveBeenCalledWith('code.ssh.enabled', true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(hub.api.setSetting).toHaveBeenCalledWith('code.ssh.enabled', true));

    await userEvent.click(screen.getByRole('radio', { name: /Clean them up/ }));
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('code.handoffSource', 'clean'),
    );

    await userEvent.selectOptions(screen.getByLabelText('Attempts'), '4');
    const time = screen.getByLabelText('Time per attempt (minutes)');
    await userEvent.clear(time);
    await userEvent.type(time, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toMatch(/from 1 to 10,080/);
    await userEvent.clear(time);
    await userEvent.type(time, '45');
    await userEvent.type(screen.getByLabelText('Cost per attempt (US dollars)'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('code.attempts', {
        count: 4,
        budgets: { timeSeconds: 2700, tokens: null, costUsd: 2 },
      }),
    );
  });

  it('locks what managed policy sets', async () => {
    await renderWithWork(<CodeM7Settings />, { managed: { 'code.ssh.enabled': false } });
    expect(screen.getByRole('switch', { name: 'Connect to SSH environments' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('units', () => {
  it('reads host keys and health details', async () => {
    expect(parseHostKey('nope')).toBeNull();
    expect(parseHostKey(`host ${KEY} c`)).toEqual({ type: 'ssh-ed25519', blob: BLOB });
    expect(await hostKeyFingerprint(KEY)).toBe(FP);
    expect(await hostKeyFingerprint('x')).toBeNull();
    expect(isHostKeyMismatch({ detail: 'Host key verification failed.' })).toBe(true);
    expect(isHostKeyMismatch({ detail: null })).toBe(false);
    expect(isSshOff({ detail: 'SSH environments are off on this Hub' })).toBe(true);
  });
});
