// The Network surface's frame and helpers (docs/04 §4.3, §9): tabs on desktop that keep the
// address, a list of sections on phones with each one a full page and a way back, the links
// between it and Settings → Network (egress), the words for statuses and Hub refusals, the
// fallback log grouping, the guided fixes, the setup step order, the settings form checks, and
// the fake's agreement with the Hub's rules.
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { NetworkPage } from '../src/network/NetworkPage.tsx';
import { networkSurfaceApi, type HubCall } from '../src/netsurface/api.ts';
import { NetworkSurface } from '../src/netsurface/NetworkSurface.tsx';
import { checkDraft, patchOf } from '../src/netsurface/NetworkSettings.tsx';
import { checkOptions, optionsOf } from '../src/netsurface/SetupPlan.tsx';
import { outcomeNotice } from '../src/netsurface/SetupRun.tsx';
import {
  commandText,
  errorFields,
  eventLines,
  guideFor,
  netErrorMessage,
  nextStep,
  optionText,
  runFrom,
  sectionFrom,
  setupRunPath,
  stepStatusChip,
  transportsText,
  undoableSteps,
  uptimeText,
} from '../src/netsurface/format.ts';
import { renderWithComputers } from './fakes-m6-computers.ts';
import {
  changeView,
  createNetworkHub,
  eventView,
  renderWithNetwork,
  stepView,
} from './fakes-m65-network.ts';
import { clearViewport, resetDom, setViewport } from './render.tsx';

afterEach(() => {
  resetDom();
  clearViewport();
  window.history.replaceState(null, '', '/');
});

describe('the Network surface (docs/04 §9)', () => {
  it('shows the sections as tabs on desktop and keeps the address', async () => {
    window.history.replaceState(null, '', '/network');
    await renderWithNetwork(<NetworkSurface section={null} />);
    expect(screen.getByRole('heading', { name: 'Network', level: 1 })).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Network sections' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Overview', 'Setup', 'Trust', 'Relay', 'Wake helpers']);
    expect(within(tabs).getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await screen.findByRole('heading', { name: 'How clients reach this Hub' });
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Relay' }));
    expect(window.location.pathname).toBe('/network/relay');
    for (const l of screen.getAllByRole('link', { name: 'Settings → Network' }))
      expect(l.getAttribute('href')).toBe('/settings/network');
  });

  it('opens the named section', async () => {
    await renderWithNetwork(<NetworkSurface section="trust" />);
    expect(screen.getByRole('tab', { name: 'Trust' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('heading', { name: 'Trust mode' })).toBeTruthy();
  });

  it('lists the sections on phones, each a full page with a way back', async () => {
    setViewport(390);
    const r = await renderWithNetwork(<NetworkSurface section={null} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Network sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/network/overview',
      '/network/setup',
      '/network/trust',
      '/network/relay',
      '/network/wake',
    ]);
    await userEvent.click(within(nav).getByRole('link', { name: /Wake helpers/ }));
    expect(window.location.pathname).toBe('/network/wake');
    r.unmount();
    await renderWithNetwork(<NetworkSurface section="wake" />);
    expect(screen.getByRole('heading', { name: 'Wake helpers', level: 1 })).toBeTruthy();
    const back = screen.getByRole('navigation', { name: 'Breadcrumb' });
    await userEvent.click(within(back).getByRole('link', { name: 'Network' }));
    expect(window.location.pathname).toBe('/network');
  });

  it('is linked from Settings → Network, which keeps its egress sections', async () => {
    await renderWithComputers(<NetworkPage />);
    await screen.findByRole('heading', { name: 'Network', level: 2 });
    const link = screen.getByRole('link', { name: 'Network page' });
    expect(link.getAttribute('href')).toBe('/network');
    await userEvent.click(link);
    expect(window.location.pathname).toBe('/network');
  });
});

describe('words and helpers', () => {
  it('reads paths and sections', () => {
    expect(sectionFrom('relay')).toBe('relay');
    expect(sectionFrom('nope')).toBeNull();
    expect(sectionFrom(null)).toBeNull();
    expect(runFrom('?run=r%201')).toBe('r 1');
    expect(runFrom('')).toBeNull();
    expect(setupRunPath('r 1')).toBe('/network/setup?run=r%201');
    expect(setupRunPath(null)).toBe('/network/setup');
  });

  it('turns Hub refusals into plain words', () => {
    const e = (reason: string, message = 'x', code = 'conflict') =>
      new ApiError(409, { code, message, retryable: false, details: { reason } });
    expect(netErrorMessage(e('nothing_to_roll_back'))).toBe('There is nothing to roll back.');
    expect(netErrorMessage(e('no_transport', 'x', 'validation'))).toMatch(/at least one transport/);
    expect(netErrorMessage(e('earlier_step_pending', 'apply "Join" first'))).toBe(
      'Apply “Join” first.',
    );
    expect(netErrorMessage(e('would_lock_out', 'this step could cut the lan path'))).toMatch(
      /^This step could cut the lan path. Connect another way/,
    );
    expect(netErrorMessage(e('trust_off'))).toMatch(/Choose a trust path first/);
    expect(netErrorMessage(e('mystery', 'something odd happened'))).toBe('Something odd happened.');
    expect(netErrorMessage(new Error('Failed to fetch'))).toMatch(/Cannot reach the Hub/);
    expect(
      errorFields(
        new ApiError(400, {
          code: 'validation',
          message: 'request failed validation',
          retryable: false,
          details: { issues: [{ path: 'options.controlUrl', message: 'invalid url' }] },
        }),
      ),
    ).toEqual({ 'options.controlUrl': 'Invalid url' });
    expect(errorFields(new Error('x'))).toEqual({});
  });

  it('groups a failed check with the new primary, and keeps unknown kinds', () => {
    const at = '2026-10-01T12:00:00.000Z';
    const lines = eventLines([
      eventView({
        id: 'p',
        kind: 'primary',
        transport: null,
        fromTransport: 'mesh',
        createdAt: at,
        detail: 'nothing passes its reachability test',
      }),
      eventView({ id: 'd', kind: 'down', transport: 'mesh', url: null, createdAt: at }),
      eventView({ id: 'u', kind: 'up', transport: 'relay', url: null }),
      eventView({ id: 'q', kind: 'primary', transport: 'relay', fromTransport: null }),
      eventView({ id: 'x', kind: 'mystery' as 'up', transport: 'lan', detail: 'hm' }),
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      'Mesh failed its check; no transport passes its check, so clients are told nothing.',
      'Relay passes its check again.',
      'Relay is now primary.',
      'LAN: mystery.',
    ]);
    expect(lines[0]!.tone).toBe('bad');
  });

  it('guides each kind of problem', () => {
    expect(guideFor('Relay: wss://r failing').actions).toEqual(['relay']);
    expect(guideFor('Trust: restart to apply').fix).toMatch(/next starts/);
    expect(
      guideFor('The Hub has not reported where it listens; nothing is advertised yet.').actions,
    ).toEqual([]);
    expect(guideFor('LAN: no LAN address').text).toBe('LAN: No LAN address');
  });

  it('orders setup steps and what can be undone', () => {
    const run = {
      steps: [
        stepView({ id: 'a', index: 0, status: 'verified' }),
        stepView({
          id: 'm',
          index: 1,
          status: 'manual',
          consent: { required: false, remembered: false },
        }),
        stepView({ id: 'b', index: 2, status: 'rollback_failed' }),
        stepView({ id: 'c', index: 3, status: 'pending' }),
        stepView({
          id: 'r',
          index: 4,
          kind: 'reachability',
          status: 'verified',
          consent: { required: false, remembered: false },
        }),
      ],
    };
    expect(nextStep(run)?.id).toBe('b');
    expect(undoableSteps(run).map((s) => s.id)).toEqual(['b', 'a']);
    expect(nextStep({ steps: [] })).toBeNull();
    expect(stepStatusChip('somewhere_new')).toEqual({
      text: 'somewhere new',
      tone: 'neutral',
      icon: 'alert',
    });
    expect(outcomeNotice(stepView({ title: 'X', status: 'failed', error: 'boom' })).text).toBe(
      'X failed: boom. What it ran was undone.',
    );
    expect(outcomeNotice(stepView({ title: 'X', status: 'skipped' })).tone).toBe('ok');
    expect(outcomeNotice(stepView({ title: 'X', status: 'odd_one' as 'pending' })).text).toBe(
      'X: odd one.',
    );
  });

  it('writes commands, options and lists for people', () => {
    expect(commandText(['ufw', 'allow', 'in on', "it's"])).toBe(`ufw allow 'in on' 'it'\\''s'`);
    expect(optionText({ authKey: 'stored', tags: ['tag:a', 'tag:b'], acl: true, port: 1 })).toBe(
      'authKey: Stored in the vault; tags: tag:a, tag:b; acl: Yes; port: 1',
    );
    expect(optionText(null)).toBe('None');
    expect(transportsText(['lan', 'mesh', 'relay'])).toBe('LAN, Mesh and Relay');
    expect(transportsText([])).toBeNull();
    expect(uptimeText({ checks: 0, ok: 0 })).toBeNull();
  });

  it('checks the settings form as the Hub does and sends only what changed', () => {
    const base = {
      lan: true,
      mesh: true,
      relay: true,
      directPublic: false,
      mdns: true,
      mdnsName: 'studio',
      includeLoopback: false,
      includeLinkLocal: false,
      directUrl: '',
      healthCheckSeconds: '60',
    };
    expect(checkDraft(base)).toEqual({});
    expect(Object.keys(checkDraft({ ...base, healthCheckSeconds: '5' }))).toEqual([
      'healthCheckSeconds',
    ]);
    expect(patchOf(base, base)).toEqual({});
    expect(patchOf(base, { ...base, mdnsName: '', directUrl: ' https://x.example ' })).toEqual({
      lan: { mdnsName: null },
      directPublic: { url: 'https://x.example' },
    });
  });

  it('builds plan options with only what was filled in, checked by the Hub’s schema', () => {
    const form = {
      controlUrl: ' https://hs.example.com ',
      authKey: '',
      hostname: '',
      tags: 'tag:nova-hub, tag:home',
      magicDns: true,
      advertiseRoutes: '',
      exitNode: false,
      certs: 'auto' as const,
      firewall: true,
      installClient: true,
      relayUrl: '',
      replaceExisting: false,
      hsUser: '',
      hsCliAddress: 'hs.example.com:50443',
      hsApiKey: '',
      hsAcl: true,
      wgInterface: '',
      wgAddress: '',
      wgListenPort: '',
      wgDns: '',
      peers: [],
    };
    const o = optionsOf('headscale', form);
    expect(o).toMatchObject({
      controlUrl: 'https://hs.example.com',
      tags: ['tag:nova-hub', 'tag:home'],
      headscale: { acl: true, cliAddress: 'hs.example.com:50443' },
    });
    expect(o.authKey).toBeUndefined();
    expect(checkOptions(o)).toEqual({});
    expect(Object.keys(checkOptions({ tags: ['nova'] }))).toEqual(['tags.0']);
  });
});

describe('the fake agrees with the Hub’s rules', () => {
  it('refuses turning every transport off, Direct public without a URL, and unknown helpers', async () => {
    const { api, state } = createNetworkHub();
    await expect(
      api.updateNetworkPanel({ transports: { lan: false, mesh: false, relay: false } }),
    ).rejects.toMatchObject({ status: 400, body: { details: { reason: 'no_transport' } } });
    await expect(
      api.updateNetworkPanel({ transports: { directPublic: true } }),
    ).rejects.toMatchObject({
      body: { details: { reason: 'url_required', field: 'directPublic.url' } },
    });
    await expect(api.updateNetworkPanel({ wakeHelpers: ['nope'] })).rejects.toMatchObject({
      body: { details: { reason: 'unknown_device' } },
    });
    await expect(api.updateNetworkPanel({ healthCheckSeconds: 5 })).rejects.toMatchObject({
      status: 400,
      body: { code: 'validation' },
    });
    expect((await api.updateNetworkPanel({ healthCheckSeconds: 60 })).change).toBeNull();
    expect(state.changes).toHaveLength(0);
  });

  it('rolls back the newest applied change, then answers 409', async () => {
    const { api, state } = createNetworkHub({
      changes: [changeView({ id: 'c0', status: 'rolled_back' })],
    });
    await api.updateNetworkPanel({ lan: { mdns: false } });
    expect(state.mdns).toBe(false);
    const r = await api.rollbackNetworkChange();
    expect(r.change.status).toBe('rolled_back');
    expect(state.mdns).toBe(true);
    await expect(api.rollbackNetworkChange()).rejects.toMatchObject({
      status: 409,
      body: { details: { reason: 'nothing_to_roll_back' } },
    });
    await expect(api.rollbackNetworkChange('c0')).rejects.toMatchObject({
      body: { details: { reason: 'rolled_back' } },
    });
    await expect(api.rollbackNetworkChange('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses setup steps in the Hub’s order', async () => {
    let allow = false;
    const { api } = createNetworkHub({}, ((k: string) =>
      k === 'network.setup.allowSystemChanges' ? allow : undefined) as never);
    const { run } = await api.planNetworkSetup('tailscale', { authKey: 'tskey-auth-12345678' });
    expect(run.options.authKey).toBe('stored');
    const [first, second] = run.steps;
    await expect(api.applyNetworkSetupStep(run.id, { stepId: second!.id })).rejects.toMatchObject({
      body: { details: { reason: 'earlier_step_pending' } },
    });
    await expect(api.applyNetworkSetupStep(run.id)).rejects.toMatchObject({
      status: 403,
      body: { details: { reason: 'system_changes_disabled' } },
    });
    allow = true;
    await expect(api.applyNetworkSetupStep(run.id)).rejects.toMatchObject({
      status: 403,
      body: {
        details: { reason: 'consent_required', stepId: first!.id, description: first!.description },
      },
    });
    const ok = await api.applyNetworkSetupStep(run.id, {
      consent: { stepId: first!.id, description: first!.description },
    });
    expect(ok.step.status).toBe('verified');
    await expect(api.applyNetworkSetupStep(run.id, { stepId: first!.id })).rejects.toMatchObject({
      body: { details: { reason: 'already_applied' } },
    });
    await expect(api.planNetworkSetup('headscale', {})).rejects.toMatchObject({
      body: { details: { reason: 'control_url_required' } },
    });
    await expect(
      api.planNetworkSetup('wireguard', {
        certs: 'mesh',
        wireguard: { address: '10.0.0.1/24', peers: [] },
      }),
    ).rejects.toMatchObject({
      body: { details: { reason: 'mesh_certs_unavailable' } },
    });
    await expect(api.rollbackNetworkSetup(run.id, 'nope')).rejects.toMatchObject({
      body: { details: { reason: 'not_last_step' } },
    });
  });

  it('refuses renewals by trust mode and revoking an unknown client', async () => {
    const { api, state } = createNetworkHub();
    state.trust.mode = 'none';
    await expect(api.renewTrust('all')).rejects.toMatchObject({
      body: { details: { reason: 'trust_off' } },
    });
    state.trust.mode = 'mesh';
    await expect(api.renewTrust('leaf')).rejects.toMatchObject({
      body: { details: { reason: 'no_local_ca' } },
    });
    await expect(api.renewTrust('mesh')).rejects.toMatchObject({
      body: { details: { reason: 'no_mesh_cert' } },
    });
    await expect(api.updateTrust({})).rejects.toMatchObject({ status: 400 });
    await expect(api.revokeRelayClient('nope')).rejects.toMatchObject({ status: 404 });
    await expect(api.updateRelay({ url: 'ftp://x' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('the client calls (contracts: apps/hub/src/{network,network-setup,trust,relay}.ts)', () => {
  it('uses the Hub’s routes, methods and bodies', async () => {
    const calls: [string, string, unknown][] = [];
    const call: HubCall = <T,>(method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return Promise.resolve({} as T);
    };
    const api = networkSurfaceApi(call);
    await api.getNetworkPanel();
    await api.updateNetworkPanel({ healthCheckSeconds: 30 });
    await api.testNetwork();
    await api.rollbackNetworkChange();
    await api.rollbackNetworkChange('c1');
    await api.getNetworkDiagnostics();
    await api.detectNetwork();
    await api.planNetworkSetup('netbird', { authKey: 'setup-key-123' });
    await api.applyNetworkSetupStep('r 1');
    await api.applyNetworkSetupStep('r1', {
      stepId: 's1',
      consent: { stepId: 's1', description: 'd' },
    });
    await api.verifyNetworkSetup('r1');
    await api.verifyNetworkSetup('r1', 's1');
    await api.listNetworkSetupRuns();
    await api.getNetworkSetupRun('r1');
    await api.rollbackNetworkSetup('r1');
    await api.rollbackNetworkSetup('r1', 's2');
    await api.listNetworkSetupConsents();
    await api.revokeNetworkSetupConsent('k1');
    await api.getTrust();
    await api.updateTrust({ mode: 'mesh' });
    await api.renewTrust('leaf');
    await api.getRelay();
    await api.updateRelay({ enabled: false });
    await api.testRelay();
    await api.listRelayClients();
    await api.revokeRelayClient('rc1');
    expect(api.trustCaUrl('crt')).toBe('/api/v1/trust/ca.crt');
    expect(calls).toEqual([
      ['GET', '/api/v1/network', undefined],
      ['PATCH', '/api/v1/network', { healthCheckSeconds: 30 }],
      ['POST', '/api/v1/network/test', {}],
      ['POST', '/api/v1/network/rollback', {}],
      ['POST', '/api/v1/network/rollback', { changeId: 'c1' }],
      ['GET', '/api/v1/network/diagnostics', undefined],
      ['POST', '/api/v1/network/setup', { action: 'detect' }],
      [
        'POST',
        '/api/v1/network/setup',
        { action: 'plan', provider: 'netbird', options: { authKey: 'setup-key-123' } },
      ],
      ['POST', '/api/v1/network/setup', { action: 'apply', runId: 'r 1' }],
      [
        'POST',
        '/api/v1/network/setup',
        { action: 'apply', runId: 'r1', stepId: 's1', consent: { stepId: 's1', description: 'd' } },
      ],
      ['POST', '/api/v1/network/setup', { action: 'verify', runId: 'r1' }],
      ['POST', '/api/v1/network/setup', { action: 'verify', runId: 'r1', stepId: 's1' }],
      ['GET', '/api/v1/network/setup/runs', undefined],
      ['GET', '/api/v1/network/setup/runs/r1', undefined],
      ['POST', '/api/v1/network/setup/runs/r1/rollback', {}],
      ['POST', '/api/v1/network/setup/runs/r1/rollback', { stepId: 's2' }],
      ['GET', '/api/v1/network/setup/consents', undefined],
      ['DELETE', '/api/v1/network/setup/consents/k1', undefined],
      ['GET', '/api/v1/trust', undefined],
      ['PATCH', '/api/v1/trust', { mode: 'mesh' }],
      ['POST', '/api/v1/trust/renew', { target: 'leaf' }],
      ['GET', '/api/v1/relay', undefined],
      ['PATCH', '/api/v1/relay', { enabled: false }],
      ['POST', '/api/v1/relay/test', {}],
      ['GET', '/api/v1/relay/clients', undefined],
      ['POST', '/api/v1/relay/clients/rc1/revoke', {}],
    ]);
  });
});
