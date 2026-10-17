// secret-scan: fake-file (fixture tokens, passwords and key headers only)
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { codeSession } from './fakes-m5-code.ts';
import { device, processView, renderM6, savedEnvironment } from './fakes-m6-code.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const announcer = () => screen.getByTestId('announcer').textContent ?? '';
const list = () => screen.getByRole('list', { name: 'Environments' });
const row = (name: string) => within(list()).getByRole('listitem', { name });

describe('Environments page (FR-062)', () => {
  it('lists every environment with its kind, connection, health and sessions; This Hub is built in', async () => {
    const local = savedEnvironment({ kind: 'local', detail: 'Git 2.47; sandbox ready' });
    const ssh = savedEnvironment({
      kind: 'ssh',
      label: 'Build box',
      status: 'down',
      detail: 'the helper did not answer',
      connection: {
        kind: 'ssh',
        host: 'build.example.com',
        port: 2222,
        user: 'ci',
        auth: 'key',
        hostKey: 'ssh-ed25519 AAAA',
        root: '/srv/src',
        hasCredential: true,
      },
    });
    const box = savedEnvironment({ kind: 'container', label: 'Node box', status: 'unknown' });
    const s = codeSession({ environmentId: ssh.id });
    await renderM6('/code/environments', [s], { code: { environments: [local, ssh, box] } });

    expect(await screen.findByRole('heading', { level: 1, name: 'Environments' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Environments' }).getAttribute('aria-current')).toBe(
      'page',
    );
    const hub = row('This Hub');
    expect(within(hub).getByText('Built in')).toBeTruthy();
    expect(within(hub).getByText('Ready')).toBeTruthy();
    expect(within(hub).getByText('Git 2.47; sandbox ready')).toBeTruthy();
    expect(within(hub).queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(within(hub).queryByRole('button', { name: /Delete/ })).toBeNull();

    const build = row('Build box');
    expect(within(build).getByText('SSH host')).toBeTruthy();
    expect(within(build).getByText('Unavailable')).toBeTruthy();
    expect(within(build).getByText('ci@build.example.com:2222 in /srv/src')).toBeTruthy();
    expect(within(build).getByText('Key: set')).toBeTruthy();
    expect(within(build).getByText('Host key pinned')).toBeTruthy();
    expect(within(build).getByText('1 active session')).toBeTruthy();
    // The key itself is never part of the page.
    expect(document.body.textContent).not.toContain('PRIVATE KEY');

    expect(within(row('Node box')).getByText('Image node:22')).toBeTruthy();
    expect(within(row('Node box')).getByText('Not checked')).toBeTruthy();
  });

  it('checks an environment and announces its health', async () => {
    const box = savedEnvironment({ kind: 'container', label: 'Node box', status: 'unknown' });
    const r = await renderM6('/code/environments', [], {
      code: { environments: [box] },
      m6: {
        checkResults: { [box.id]: { status: 'down', detail: 'no container engine on this Hub' } },
      },
    });
    const node = await screen.findByRole('listitem', { name: 'Node box' });
    await userEvent.click(within(node).getByRole('button', { name: 'Check' }));
    expect(await within(node).findByText('no container engine on this Hub')).toBeTruthy();
    expect(within(node).getByText('Unavailable')).toBeTruthy();
    expect(r.api.checkEnvironment).toHaveBeenCalledWith(box.id);
    await waitFor(() => expect(announcer()).toMatch(/Node box: Unavailable/));
  });

  it('creates an SSH environment with a write-only key, then checks it', async () => {
    const r = await renderM6('/code/environments', [], {
      code: { environments: [savedEnvironment({ kind: 'local' })] },
    });
    await userEvent.click(await screen.findByRole('button', { name: /New environment/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New environment' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'SSH host' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Build box');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Host' }),
      'build.example.com',
    );
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'User' }), 'ci');

    // Without a key the form says what is missing; nothing is sent.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    expect(await within(dialog).findByText('Paste the private key.')).toBeTruthy();
    expect(r.api.createEnvironment).not.toHaveBeenCalled();

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Private key' }),
      '-----BEGIN OPENSSH PRIVATE KEY-----',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    await waitFor(() =>
      expect(r.api.createEnvironment).toHaveBeenCalledWith({
        kind: 'ssh',
        label: 'Build box',
        connection: {
          host: 'build.example.com',
          port: 22,
          user: 'ci',
          auth: 'key',
          hostKey: null,
          root: null,
        },
        credential: { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----' },
      }),
    );
    const created = await screen.findByRole('listitem', { name: 'Build box' });
    expect(within(created).getByText('Key: set')).toBeTruthy();
    // A new environment is checked at once.
    await waitFor(() => expect(within(created).getByText('Ready')).toBeTruthy());
    expect(Object.values(r.m6.credentials)).toEqual([
      { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----' },
    ]);
    expect(document.body.textContent).not.toContain('BEGIN OPENSSH');
  });

  it('creates a container environment with a setup script, and says what the Hub refused', async () => {
    const r = await renderM6('/code/environments', [], {
      code: { environments: [savedEnvironment({ kind: 'local' })] },
    });
    await userEvent.click(await screen.findByRole('button', { name: /New environment/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New environment' });
    // Container is the first kind.
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Node box');
    const image = within(dialog).getByRole('textbox', { name: 'Container image' });
    await userEvent.type(image, 'Node 22');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    expect(await within(dialog).findByText(/Enter an image reference in lowercase/)).toBeTruthy();
    await userEvent.clear(image);
    await userEvent.type(image, 'node:22');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Setup script (optional)' }),
      'npm ci',
    );
    r.failNext.createEnvironment = new ApiError(500, {
      code: 'server_error',
      message: 'The keychain is locked',
      retryable: false,
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    expect(await within(dialog).findByText('The keychain is locked')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    await waitFor(() =>
      expect(r.api.createEnvironment).toHaveBeenLastCalledWith({
        kind: 'container',
        label: 'Node box',
        connection: { image: 'node:22', setupScript: 'npm ci' },
      }),
    );
    const created = await screen.findByRole('listitem', { name: 'Node box' });
    expect(within(created).getByText('Image node:22, with a setup script')).toBeTruthy();
  });

  it('lets a distro name be typed when the device cannot list them', async () => {
    const r = await renderM6('/code/environments', [], {
      code: { environments: [savedEnvironment({ kind: 'local' })] },
      m6: { devices: [device({ id: 'dev-win', name: 'Gaming PC', platform: 'win32' })] },
    });
    r.failNext.listWslDistros = new ApiError(400, {
      code: 'capability_missing',
      message: 'the device is offline',
      retryable: false,
    });
    await userEvent.click(await screen.findByRole('button', { name: /New environment/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New environment' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'WSL' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'PC');
    await userEvent.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Device' }),
      'dev-win',
    );
    expect(await within(dialog).findByText('the device is offline')).toBeTruthy();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Distro' }), 'Debian');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    await waitFor(() =>
      expect(r.api.createEnvironment).toHaveBeenCalledWith({
        kind: 'wsl',
        label: 'PC',
        connection: { deviceId: 'dev-win', distro: 'Debian' },
      }),
    );
  });

  it('creates a WSL environment on a Windows device from the distros it reports', async () => {
    const win = device({ id: 'dev-win', name: 'Gaming PC', platform: 'win32' });
    const mac = device({ id: 'dev-mac', name: 'MacBook', platform: 'darwin' });
    const r = await renderM6('/code/environments', [], {
      code: { environments: [savedEnvironment({ kind: 'local' })] },
      m6: {
        devices: [win, mac],
        wslDistros: {
          'dev-win': [{ name: 'Ubuntu', default: true, state: 'running', version: 2 }],
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: /New environment/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New environment' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'WSL' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'PC Ubuntu');
    const deviceSelect = await within(dialog).findByRole<HTMLSelectElement>('combobox', {
      name: 'Device',
    });
    // Only Windows devices can run WSL.
    expect([...deviceSelect.options].map((o) => o.textContent)).toEqual([
      'Choose a device',
      'Gaming PC',
    ]);
    await userEvent.selectOptions(deviceSelect, 'dev-win');
    const distro = await within(dialog).findByRole('combobox', { name: 'Distro' });
    await userEvent.selectOptions(distro, 'Ubuntu');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    await waitFor(() =>
      expect(r.api.createEnvironment).toHaveBeenCalledWith({
        kind: 'wsl',
        label: 'PC Ubuntu',
        connection: { deviceId: 'dev-win', distro: 'Ubuntu' },
      }),
    );
    const created = await screen.findByRole('listitem', { name: 'PC Ubuntu' });
    expect(within(created).getByText('Ubuntu on Gaming PC')).toBeTruthy();
  });

  it('says when no device can host the environment, with a link to add one', async () => {
    await renderM6('/code/environments', [], {
      code: { environments: [savedEnvironment({ kind: 'local' })] },
    });
    await userEvent.click(await screen.findByRole('button', { name: /New environment/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New environment' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Device' }));
    expect(
      await within(dialog).findByText(/No device runs the Nova device agent yet/),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('link', { name: 'Add a device in Settings → Devices' }),
    ).toHaveProperty('pathname', '/settings/devices');
  });

  it('edits an SSH environment: a new host needs the key again; the stored key is kept otherwise', async () => {
    const ssh = savedEnvironment({ kind: 'ssh', label: 'Build box' });
    const r = await renderM6('/code/environments', [], { code: { environments: [ssh] } });
    const build = await screen.findByRole('listitem', { name: 'Build box' });
    await userEvent.click(within(build).getByRole('button', { name: /Edit/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Build box' });
    expect(
      within(dialog).getByText(/A key is set\. Leave the fields below empty to keep it/),
    ).toBeTruthy();
    // The stored key never comes back into the form.
    expect(
      within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'Replace the private key' })
        .value,
    ).toBe('');
    const host = within(dialog).getByRole('textbox', { name: 'Host' });
    await userEvent.clear(host);
    await userEvent.type(host, 'other.example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        'A new host, user or sign-in method needs the key or password again.',
      ),
    ).toBeTruthy();
    expect(r.api.updateEnvironment).not.toHaveBeenCalled();

    // Back to the old host, a new name only: the key stays.
    await userEvent.clear(host);
    await userEvent.type(host, 'build.example.com');
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Build server');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(r.api.updateEnvironment).toHaveBeenCalledWith(ssh.id, {
        label: 'Build server',
        connection: {
          host: 'build.example.com',
          port: 22,
          user: 'me',
          auth: 'key',
          hostKey: null,
          root: null,
        },
      }),
    );
    expect(await screen.findByRole('listitem', { name: 'Build server' })).toBeTruthy();
  });

  it('refuses to delete an environment active sessions use, and deletes an unused one', async () => {
    const used = savedEnvironment({ kind: 'container', label: 'Used box' });
    const spare = savedEnvironment({ kind: 'container', label: 'Spare box' });
    const s = codeSession({ environmentId: used.id });
    await renderM6('/code/environments', [s], { code: { environments: [used, spare] } });
    await userEvent.click(
      within(await screen.findByRole('listitem', { name: 'Used box' })).getByRole('button', {
        name: /Delete/,
      }),
    );
    let dialog = await screen.findByRole('dialog', { name: 'Delete Used box?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(
      await within(dialog).findByText('1 active Code session(s) use this environment'),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(within(row('Spare box')).getByRole('button', { name: /Delete/ }));
    dialog = await screen.findByRole('dialog', { name: 'Delete Spare box?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Spare box' })).toBeNull());
    expect(screen.getByRole('listitem', { name: 'Used box' })).toBeTruthy();
  });

  it('reattaches to a process on an SSH host: buffered output, then new output from there', async () => {
    const ssh = savedEnvironment({ kind: 'ssh', label: 'Build box' });
    const p = processView(ssh.id, { cmd: 'npm run e2e', outputBytes: 40, sessionId: 'cs-x' });
    const r = await renderM6('/code/environments', [], {
      code: { environments: [ssh] },
      m6: {
        processes: [p],
        outputs: { [p.id]: { data: 'step 3 ok\nstep 4 ok\n', dropped: 120 } },
      },
    });
    const build = await screen.findByRole('listitem', { name: 'Build box' });
    await userEvent.click(within(build).getByRole('button', { name: /Processes/ }));
    const procs = await within(build).findByRole('list', { name: 'Processes on Build box' });
    const proc = within(procs).getByRole('listitem', { name: 'npm run e2e' });
    expect(within(proc).getByText('Running')).toBeTruthy();
    expect(within(proc).getByRole('link', { name: 'Open its session' })).toHaveProperty(
      'pathname',
      '/code/cs-x',
    );
    await userEvent.click(within(proc).getByRole('button', { name: /Show output/ }));
    const out = await within(proc).findByLabelText('Output of npm run e2e');
    expect(out.textContent).toBe('step 3 ok\nstep 4 ok\n');
    expect(within(proc).getByText(/120 bytes before this point were dropped/)).toBeTruthy();
    expect(r.api.readEnvironmentOutput).toHaveBeenLastCalledWith(ssh.id, p.id, 0);

    // The process went on while nobody read it: the next read starts where the last stopped.
    r.m6.outputs[p.id] = { data: 'step 3 ok\nstep 4 ok\nstep 5 ok\n', dropped: 120 };
    await userEvent.click(within(proc).getByRole('button', { name: /Read new output/ }));
    await waitFor(() => expect(out.textContent).toBe('step 3 ok\nstep 4 ok\nstep 5 ok\n'));
    expect(r.api.readEnvironmentOutput).toHaveBeenLastCalledWith(ssh.id, p.id, 140);
  });

  it('shows a load failure with Retry, and an empty state', async () => {
    const r = await renderM6('/code/environments', [], { code: { environments: [] } });
    expect(await screen.findByRole('heading', { name: 'No environments yet' })).toBeTruthy();
    r.failNext.listSavedEnvironments = new ApiError(500, {
      code: 'server_error',
      message: 'Hub is restarting',
      retryable: true,
    });
    // Navigating away and back reloads.
    await userEvent.click(screen.getByRole('link', { name: 'Sessions' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Environments' }));
    expect(await screen.findByText('Hub is restarting')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'No environments yet' })).toBeTruthy();
  });
});
