// Network → Setup (FR-136; docs/22 §6; docs/04 §9 flow 2): detection, choosing a mesh with help
// on each (and iOS), options checked with the Hub's schema and its provider rules, write-only
// keys, a plan that changes nothing, host changes as a security setting (asked before turning on,
// locked by managed policy, never a dead Apply), the one-time consent with the exact text the Hub
// requires, automatic rollback shown clearly, a failed undo, the lock-out guard, rolling back a
// step or the whole run, remembered consents with revoke, run history and live updates.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { SetupSection } from '../src/netsurface/Setup.tsx';
import { FakeEventSource } from './fakes.ts';
import { detectionView, renderWithNetwork, runView, stepView } from './fakes-m65-network.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');
const region = (name: string) => screen.getByRole('region', { name });
const ON = { 'network.setup.allowSystemChanges': true };

function twoStepRun(over: Parameters<typeof runView>[0] = {}) {
  return runView({
    id: 'run1',
    provider: 'tailscale',
    status: 'planned',
    options: { authKey: 'stored', hostname: 'nova-hub' },
    steps: [
      stepView({
        id: 's1',
        runId: 'run1',
        index: 0,
        kind: 'mesh.up',
        provider: 'tailscale',
        title: 'Join the tailnet',
        description: 'Log the Hub in to Tailscale as nova-hub (tailscale up --auth-key=<secret>).',
        affects: ['lan'],
        undoCommands: [['tailscale', 'logout']],
        undoAffects: ['mesh'],
      }),
      stepView({
        id: 's2',
        runId: 'run1',
        index: 1,
        kind: 'firewall.ports',
        provider: 'ufw',
        title: 'Firewall',
        description: 'Allow 8443/tcp on tailscale0 in ufw.',
        commands: [['ufw', 'allow', 'in', 'on', 'tailscale0', 'to', 'any', 'port', '8443']],
      }),
      stepView({
        id: 's3',
        runId: 'run1',
        index: 2,
        kind: 'mesh.routes',
        provider: 'tailscale',
        title: 'Approve routes',
        description: 'Approve the routes in the admin console.',
        commands: [],
        systemChange: false,
        status: 'manual',
        consent: { required: false, remembered: false },
      }),
      stepView({
        id: 's4',
        runId: 'run1',
        index: 3,
        kind: 'reachability',
        provider: 'hub',
        title: 'Reachability test',
        description: 'Test that the Hub answers on its mesh address.',
        commands: [],
        systemChange: false,
        consent: { required: false, remembered: false },
      }),
    ],
    ...over,
  });
}

async function openRun(
  network: NonNullable<Parameters<typeof renderWithNetwork>[1]>['network'] = {},
  settings: Record<string, unknown> = ON,
  managed: Record<string, unknown> = {},
) {
  window.history.replaceState(null, '', '/network/setup?run=run1');
  const r = await renderWithNetwork(<SetupSection />, {
    network: { runs: [twoStepRun()], ...network },
    settings,
    managed,
  });
  await screen.findByRole('heading', { name: 'Tailscale setup' });
  return r;
}

const step = (title: string) => screen.getByRole('listitem', { name: title });
/** The page's outcome notice (the announcer repeats its text for screen readers). */
const notice = async (text: string | RegExp) => {
  await waitFor(() => expect(document.querySelector('.net-notice')).not.toBeNull());
  const el = [...document.querySelectorAll<HTMLElement>('.net-notice')].find((n) =>
    typeof text === 'string' ? n.textContent?.includes(text) : text.test(n.textContent ?? ''),
  );
  if (!el) throw new Error(`no notice with ${String(text)}`);
  return el;
};

describe('the assistant’s first page (FR-136, docs/22 §6)', () => {
  it('shows what Nova finds: platform, LAN, DNS, firewall, meshes and interfaces', async () => {
    await renderWithNetwork(<SetupSection />, {
      network: {
        detection: detectionView({
          meshes: [
            {
              provider: 'tailscale',
              installed: true,
              version: '1.76.1',
              loggedIn: true,
              state: 'Running',
              controlUrl: 'https://controlplane.tailscale.com',
              ips: ['100.64.0.5'],
              dnsName: 'studio.tail.ts.net',
              tags: ['tag:nova-hub'],
              peers: [
                { name: 'phone', dnsName: null, ips: [], online: true, os: 'iOS', tags: [] },
                { name: 'nas', dnsName: null, ips: [], online: false, os: 'linux', tags: [] },
              ],
              routes: [],
              exitNode: false,
              detail: null,
            },
            { ...detectionView().meshes[2]!, installed: true, detail: 'needs login' },
          ],
        }),
      },
    });
    const found = await screen.findByRole('region', { name: 'What Nova finds' });
    await within(found).findByText('linux');
    expect(found.textContent).toContain('192.168.1.0/24');
    expect(found.textContent).toContain('192.168.1.1');
    expect(found.textContent).toContain('ufw, active');
    const meshes = within(found).getByRole('list', { name: 'Meshes found' });
    const ts = within(meshes).getByRole('listitem', { name: 'Tailscale' });
    expect(within(ts).getByText('Connected')).toBeTruthy();
    expect(ts.textContent).toContain('1 of 2 peers online');
    expect(
      within(within(meshes).getByRole('listitem', { name: 'NetBird' })).getByText(
        'Installed, not connected',
      ),
    ).toBeTruthy();
    expect(within(found).getByRole('list', { name: 'Network interfaces' }).textContent).toContain(
      '192.168.1.10/24',
    );
  });

  it('says when detection fails, with Retry', async () => {
    const hub = await renderWithNetwork(<SetupSection />);
    await screen.findByRole('region', { name: 'What Nova finds' });
    hub.network.failNext.detectNetwork = new ApiError(500, {
      code: 'server_error',
      message: 'ip: not found',
      retryable: true,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Look again' }));
    expect((await within(region('What Nova finds')).findByRole('alert')).textContent).toContain(
      'Ip: not found.',
    );
  });

  it('helps choose a mesh, checks the options with the Hub’s rules and plans', async () => {
    const { api } = await renderWithNetwork(<SetupSection />);
    const plan = await screen.findByRole('region', { name: 'Set up a mesh' });
    expect(plan.textContent).toContain(
      'On iPhone and iPad, a self-hosted mesh works only with NetBird',
    );
    expect(
      within(plan).getByRole('radio', { name: 'Headscale: Self-hosted, recommended' }),
    ).toBeTruthy();
    await userEvent.click(
      within(plan).getByRole('radio', { name: 'Tailscale: Managed, easiest on phones' }),
    );

    // The schema runs here first: a bad name never reaches the Hub.
    const form = within(plan).getByRole('form', { name: 'Tailscale options' });
    await userEvent.type(within(form).getByLabelText('Name on the mesh'), 'Bad Name');
    await userEvent.click(within(form).getByRole('button', { name: 'Make a plan' }));
    expect(within(form).getByText(/Lowercase letters, digits and hyphens/)).toBeTruthy();
    expect(api.planNetworkSetup).not.toHaveBeenCalled();

    // The Hub's provider rule: Tailscale needs an auth key to join.
    await userEvent.clear(within(form).getByLabelText('Name on the mesh'));
    await userEvent.click(within(form).getByRole('button', { name: 'Make a plan' }));
    await waitFor(() => expect(api.planNetworkSetup).toHaveBeenCalledTimes(1));
    expect(
      await within(form).findByText('A tailscale auth key (authKey) is required to join.'),
    ).toBeTruthy();

    const key = within(form).getByLabelText<HTMLInputElement>('Auth key (write-only)');
    expect(key.type).toBe('password');
    await userEvent.type(key, 'tskey-auth-abcdef123456');
    await userEvent.click(within(form).getByRole('button', { name: 'Make a plan' }));
    await waitFor(() => expect(window.location.search).toMatch(/^\?run=/));
    expect(api.planNetworkSetup).toHaveBeenLastCalledWith(
      'tailscale',
      expect.objectContaining({ authKey: 'tskey-auth-abcdef123456', certs: 'auto' }),
    );
    // The run page: the key is only "stored".
    await screen.findByRole('heading', { name: 'Tailscale setup' });
    await userEvent.click(screen.getByText('Options'));
    expect(screen.getByText('Stored in the vault')).toBeTruthy();
    expect(document.body.textContent).not.toContain('tskey-auth-abcdef123456');
  });

  it('plans WireGuard with peers and shows the Hub’s public key', async () => {
    await renderWithNetwork(<SetupSection />);
    const plan = await screen.findByRole('region', { name: 'Set up a mesh' });
    await userEvent.click(within(plan).getByRole('radio', { name: 'WireGuard: Plain tunnels' }));
    const form = within(plan).getByRole('form', { name: 'WireGuard options' });
    await userEvent.click(within(form).getByRole('button', { name: 'Make a plan' }));
    expect(
      within(form).getByText('Enter the Hub’s address on the WireGuard network.'),
    ).toBeTruthy();
    await userEvent.type(
      within(form).getByLabelText("The Hub's address on the WireGuard network"),
      '10.77.0.1/24',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Add a peer' }));
    const peer = within(form).getByRole('group', { name: 'Peer 1' });
    await userEvent.type(within(peer).getByLabelText('Public key'), 'not-a-key');
    await userEvent.type(within(peer).getByLabelText('Allowed addresses'), '10.77.0.2/32');
    await userEvent.click(within(form).getByRole('button', { name: 'Make a plan' }));
    expect(within(peer).getByText('A WireGuard key')).toBeTruthy();
    await userEvent.clear(within(peer).getByLabelText('Public key'));
    await userEvent.type(
      within(peer).getByLabelText('Public key'),
      'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Make a plan' }));
    await screen.findByRole('heading', { name: 'WireGuard setup' });
    expect(screen.getByText('The Hub’s WireGuard public key (add it to each peer)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy public key' })).toBeTruthy();
  });

  it('lists past runs and remembered consents, and revokes one after asking', async () => {
    const { api } = await renderWithNetwork(<SetupSection />, {
      network: {
        runs: [twoStepRun({ status: 'completed' })],
        consents: [
          {
            id: 'k1',
            kind: 'mesh.up',
            provider: 'tailscale',
            description: 'Log the Hub in to Tailscale.',
            grantedAt: '2026-10-01T12:00:00.000Z',
          },
        ],
      },
    });
    const runs = await screen.findByRole('list', { name: 'Setup runs' });
    const row = within(runs).getByRole('listitem', { name: 'Tailscale setup' });
    expect(within(row).getByText('Done')).toBeTruthy();
    expect(row.textContent).toContain('1 of 4 steps done');
    const allowed = await screen.findByRole('list', { name: 'Allowed changes' });
    const item = within(allowed).getByRole('listitem', { name: 'Join the mesh with Tailscale' });
    await userEvent.click(
      within(item).getByRole('button', { name: 'Revoke Join the mesh with Tailscale' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Revoke this permission?' });
    expect(dialog.textContent).toContain('Nova asks again');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.revokeNetworkSetupConsent).toHaveBeenCalledWith('k1'));
    expect(await within(region('What you allowed')).findByText('Nothing yet.')).toBeTruthy();

    await userEvent.click(within(row).getByRole('link', { name: 'Tailscale setup' }));
    expect(window.location.search).toBe('?run=run1');
  });

  it('asks before turning host changes on, and turns them off at once', async () => {
    const { hub } = await renderWithNetwork(<SetupSection />);
    const sw = await screen.findByRole('switch', {
      name: "Let Nova change this computer's network",
    });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(sw);
    const dialog = screen.getByRole('dialog', { name: "Let Nova change this computer's network?" });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(hub.state.settings['network.setup.allowSystemChanges']).toBe(true);
    await userEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
    expect(hub.state.settings['network.setup.allowSystemChanges']).toBe(false);
  });
});

describe('a setup run (docs/22 §6 steps 2-8)', () => {
  it('shows each step with what it does, what it could cut and its commands', async () => {
    await openRun();
    const s1 = step('Join the tailnet');
    expect(within(s1).getByText('Not applied')).toBeTruthy();
    expect(within(s1).getByText('Changes this computer')).toBeTruthy();
    expect(s1.textContent).toContain('Log the Hub in to Tailscale as nova-hub');
    expect(s1.textContent).toContain('Could cut the LAN path to the Hub.');
    expect(s1.textContent).toContain('Nova asks you to allow it before it runs.');
    await userEvent.click(within(s1).getByText('Commands'));
    expect(within(s1).getByLabelText('Commands it runs').textContent).toBe(
      'tailscale up --auth-key=<secret>',
    );
    expect(within(s1).getByLabelText('Undo commands').textContent).toBe('tailscale logout');
    expect(within(step('Approve routes')).getByText('By hand')).toBeTruthy();
    expect(step('Approve routes').textContent).toContain('do it by hand');
    // Only the next step offers Apply.
    expect(within(s1).getByRole('button', { name: 'Apply' })).toBeTruthy();
    expect(within(step('Firewall')).queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('never offers a dead Apply: with host changes off it says so and leads to the switch', async () => {
    await openRun({}, {});
    const s1 = step('Join the tailnet');
    expect(within(s1).queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(s1.textContent).toContain('needs host changes on');
    await userEvent.click(within(s1).getByRole('button', { name: 'Go to host changes' }));
    expect(document.activeElement?.textContent).toBe('Host changes');
  });

  it('says when managed policy keeps host changes off', async () => {
    await openRun({}, {}, { 'network.setup.allowSystemChanges': false });
    const s1 = step('Join the tailnet');
    expect(s1.textContent).toContain('your organization keeps host changes off');
    expect(within(s1).queryByRole('button')).toBeNull();
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
  });

  it('asks for consent with the exact text, applies, and remembers it', async () => {
    const { api, state } = await openRun();
    await userEvent.click(within(step('Join the tailnet')).getByRole('button', { name: 'Apply' }));
    const dialog = screen.getByRole('dialog', { name: 'Allow: Join the tailnet?' });
    expect(within(dialog).getByLabelText('What you allow').textContent).toBe(
      'Log the Hub in to Tailscale as nova-hub (tailscale up --auth-key=<secret>).',
    );
    expect(dialog.textContent).toContain('It could cut the LAN path to the Hub');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow and apply' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.applyNetworkSetupStep).toHaveBeenCalledWith('run1', {
      stepId: 's1',
      consent: {
        stepId: 's1',
        description: 'Log the Hub in to Tailscale as nova-hub (tailscale up --auth-key=<secret>).',
      },
    });
    expect(within(step('Join the tailnet')).getByText('Done')).toBeTruthy();
    expect(await notice('Join the tailnet: done, and it passed its checks.')).toBeTruthy();
    expect(state.consents).toHaveLength(1);
    expect(
      within(step('Join the tailnet')).getByText('You allowed this kind of change before.'),
    ).toBeTruthy();
    // The next step is now the firewall.
    expect(within(step('Firewall')).getByRole('button', { name: 'Apply' })).toBeTruthy();
  });

  it('opens the consent with the Hub’s own text when the Hub asks for it', async () => {
    // The page thinks the consent is remembered; it was revoked elsewhere meanwhile.
    const desc = twoStepRun().steps[0]!.description;
    const { network, api } = await openRun({
      consents: [
        {
          id: 'k',
          kind: 'mesh.up',
          provider: 'tailscale',
          description: desc,
          grantedAt: '2026-10-01T12:00:00.000Z',
        },
      ],
    });
    expect(
      within(step('Join the tailnet')).getByText('You allowed this kind of change before.'),
    ).toBeTruthy();
    network.failNext.applyNetworkSetupStep = new ApiError(403, {
      code: 'policy_denied',
      message: 'confirm this step first: send its description back',
      retryable: false,
      details: {
        reason: 'consent_required',
        stepId: 's1',
        description: 'The Hub’s current text for this step.',
      },
    });
    await userEvent.click(within(step('Join the tailnet')).getByRole('button', { name: 'Apply' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allow: Join the tailnet?' });
    expect(within(dialog).getByLabelText('What you allow').textContent).toBe(
      'The Hub’s current text for this step.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow and apply' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.applyNetworkSetupStep).toHaveBeenLastCalledWith('run1', {
      stepId: 's1',
      consent: { stepId: 's1', description: 'The Hub’s current text for this step.' },
    });
  });

  it('shows an automatic rollback clearly', async () => {
    await openRun({
      outcomes: { s1: 'rolled_back' },
      consents: [
        {
          id: 'k',
          kind: 'mesh.up',
          provider: 'tailscale',
          description: twoStepRun().steps[0]!.description,
          grantedAt: '2026-10-01T12:00:00.000Z',
        },
      ],
    });
    await userEvent.click(within(step('Join the tailnet')).getByRole('button', { name: 'Apply' }));
    expect(
      await notice(
        /Join the tailnet did not pass its checks, so Nova rolled it back: the mesh path failed its reachability test/,
      ),
    ).toBeTruthy();
    const s1 = step('Join the tailnet');
    expect(within(s1).getByText('Rolled back')).toBeTruthy();
    expect(s1.textContent).toContain(
      'Rolled back automatically: the mesh path failed its reachability test',
    );
    expect(within(s1).getByRole('list', { name: 'Checks' }).textContent).toContain(
      'mesh reachable: failed (timed out)',
    );
    expect(within(s1).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says when an undo failed and offers to roll back again', async () => {
    const desc = twoStepRun().steps[0]!.description;
    const { api } = await openRun({
      outcomes: { s1: 'rollback_failed' },
      consents: [
        {
          id: 'k',
          kind: 'mesh.up',
          provider: 'tailscale',
          description: desc,
          grantedAt: '2026-10-01T12:00:00.000Z',
        },
      ],
    });
    await userEvent.click(within(step('Join the tailnet')).getByRole('button', { name: 'Apply' }));
    expect(await notice(/Nova could not undo it/)).toBeTruthy();
    const s1 = step('Join the tailnet');
    expect(within(s1).getByText('Undo failed')).toBeTruthy();
    await userEvent.click(within(s1).getByRole('button', { name: 'Roll back again' }));
    const dialog = screen.getByRole('dialog', { name: 'Roll back this step?' });
    expect(dialog.textContent).toContain('Undoing could cut the Mesh path');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(api.rollbackNetworkSetup).toHaveBeenCalledWith('run1', 's1'));
    expect(await notice('Rolled back.')).toBeTruthy();
    expect(within(step('Join the tailnet')).getByText('Rolled back')).toBeTruthy();
  });

  it('shows the lock-out guard’s refusal on the step', async () => {
    const desc = twoStepRun().steps[0]!.description;
    await openRun({
      lockOut: ['s1'],
      consents: [
        {
          id: 'k',
          kind: 'mesh.up',
          provider: 'tailscale',
          description: desc,
          grantedAt: '2026-10-01T12:00:00.000Z',
        },
      ],
    });
    await userEvent.click(within(step('Join the tailnet')).getByRole('button', { name: 'Apply' }));
    expect((await within(step('Join the tailnet')).findByRole('alert')).textContent).toContain(
      'This step could cut the lan path you are using, and no other path to the Hub passes its test. Connect another way',
    );
  });

  it('rolls back the last step or the whole run after asking', async () => {
    const run = twoStepRun({
      status: 'in_progress',
      steps: twoStepRun().steps.map((s) =>
        s.id === 's1' || s.id === 's2' ? { ...s, status: 'verified' as const } : s,
      ),
    });
    const { api, network } = await openRun({ runs: [run] });
    expect(
      within(step('Join the tailnet')).queryByRole('button', { name: 'Roll back this step' }),
    ).toBeNull();
    network.failNext.rollbackNetworkSetup = new ApiError(409, {
      code: 'conflict',
      message: 'only the last applied step can be rolled back alone; roll back the run instead',
      retryable: false,
      details: { reason: 'not_last_step' },
    });
    await userEvent.click(
      within(step('Firewall')).getByRole('button', { name: 'Roll back this step' }),
    );
    let dialog = screen.getByRole('dialog', { name: 'Roll back this step?' });
    expect(dialog.textContent).toContain('Nova undoes “Firewall”');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'Roll back the whole run instead.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(screen.getByRole('button', { name: 'Roll back the whole run' }));
    dialog = screen.getByRole('dialog', { name: 'Roll back the whole run?' });
    expect(within(dialog).getByRole('list').textContent).toContain('Firewall');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await waitFor(() =>
      expect(api.rollbackNetworkSetup).toHaveBeenLastCalledWith('run1', undefined),
    );
    await waitFor(() => expect(within(step('Firewall')).getByText('Rolled back')).toBeTruthy());
    expect(within(step('Join the tailnet')).getByText('Rolled back')).toBeTruthy();
  });

  it('hides rollback while host changes are off, and says why', async () => {
    const run = twoStepRun({
      steps: twoStepRun().steps.map((s) =>
        s.id === 's1' ? { ...s, status: 'verified' as const } : s,
      ),
    });
    await openRun({ runs: [run] }, {});
    expect(screen.queryByRole('button', { name: /Roll back/ })).toBeNull();
    expect(
      screen.getByText('Rolling back changes this computer, so it needs host changes on.'),
    ).toBeTruthy();
  });

  it('checks the run and shows each result', async () => {
    const run = twoStepRun({
      steps: twoStepRun().steps.map((s) =>
        s.id === 's1' ? { ...s, status: 'verified' as const } : s,
      ),
    });
    const { state } = await openRun({ runs: [run], verifyOk: false });
    await userEvent.click(screen.getByRole('button', { name: 'Check everything' }));
    expect(await notice('Some checks did not pass.')).toBeTruthy();
    expect(screen.getAllByRole('list', { name: 'Checks' })[0]!.textContent).toContain(
      'mesh reachable: failed (timed out)',
    );
    state.verifyOk = true;
    await userEvent.click(
      within(step('Join the tailnet')).getByRole('button', { name: 'Check this step' }),
    );
    expect(await notice('Every check passed.')).toBeTruthy();
  });

  it('keeps an unknown step status readable, follows live steps, and says when a run is gone', async () => {
    const run = twoStepRun({
      steps: twoStepRun().steps.map((s) =>
        s.id === 's2' ? { ...s, status: 'queued' as 'pending' } : s,
      ),
    });
    const { state } = await openRun({ runs: [run] });
    expect(within(step('Firewall')).getByText('queued')).toBeTruthy();
    state.runs[0]!.steps[0]!.status = 'verified';
    stream().emit('network.setup.step', {
      runId: 'run1',
      stepId: 's1',
      kind: 'mesh.up',
      provider: 'tailscale',
      status: 'verified',
      autoRolledBack: false,
    });
    await waitFor(() => expect(within(step('Join the tailnet')).getByText('Done')).toBeTruthy());
    state.runs = [];
    stream().emit('network.setup.step', { runId: 'run1', stepId: 's1', status: 'rolled_back' });
    expect(await screen.findByText('This setup run is not on this Hub.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Back to setup' }));
    expect(window.location.search).toBe('');
  });
});
