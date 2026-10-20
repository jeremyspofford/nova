// The Network surface and the connection item in the pseudo-locale (FR-016): every word the
// Network pages and the transport's path line own comes from messages. What the Hub writes (problem
// lines, details, summaries, step titles and descriptions), names, ids and addresses are fixture
// data and stay as they are (D9).
import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { accent } from '@nova/i18n';
import { NetworkSurface } from '../src/netsurface/NetworkSurface.tsx';
import { SetupSection } from '../src/netsurface/Setup.tsx';
import { PATH_TEXT, pathDetail, pathText } from '../src/relaytransport/path.ts';
import type { TransportSnapshot } from '../src/relaytransport/transport.ts';
import {
  changeView,
  detectionView,
  endpoint,
  eventView,
  reachability,
  relayClient,
  renderWithNetwork,
  runView,
  stepView,
  transportView,
  trustView,
  wakeHelper,
} from './fakes-m65-network.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { clearViewport, resetDom, setViewport } from './render.tsx';

afterEach(() => {
  resetDom();
  clearViewport();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

const T0 = '2026-10-01T12:00:00.000Z';

/** English words as they read in en-XA, to find an element by its (pseudo) name. */
const xa = (english: string) => new RegExp(accent(english).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** The page, once a heading of the section (by its en-XA words) is on screen. */
async function page(heading: string) {
  await screen.findByRole('heading', { name: xa(heading) });
  return document.querySelector<HTMLElement>('.net-page') ?? document.body;
}

describe('the Network surface in en-XA', () => {
  it('shows the Overview fully localized', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/network');
    await renderWithNetwork(<NetworkSurface section="overview" />, {
      network: {
        checked: [
          transportView({ transport: 'lan', endpoints: [endpoint()] }),
          transportView({
            transport: 'mesh',
            status: 'down',
            detail: 'timed out',
            endpoints: [
              endpoint({
                transport: 'mesh',
                url: 'https://studio.tail.ts.net:8443',
                health: 'failing',
                detail: 'timed out',
              }),
            ],
          }),
          transportView({ transport: 'relay', status: 'none', detail: 'the Relay is off' }),
          transportView({ transport: 'direct', enabled: false, status: 'off' }),
        ],
        problems: ['Mesh: https://studio.tail.ts.net:8443 timed out', 'Something new'],
        events: [
          eventView({ id: 'p', kind: 'primary', transport: 'mesh', fromTransport: 'lan' }),
          eventView({ id: 'd', kind: 'down', transport: 'lan', url: null, detail: 'refused' }),
          eventView({ id: 'a', kind: 'advertised', transport: 'lan' }),
        ],
        changes: [
          changeView({ summary: 'Changed transports' }),
          changeView({
            summary: 'Changed mdns',
            kind: 'network.setup.step',
            actor: 'system',
            status: 'applied',
            error: 'exit code 1',
          }),
          changeView({ summary: 'Changed trust', kind: 'trust.mode', status: 'rolled_back' }),
        ],
        devices: [
          reachability({
            name: 'Desk PC',
            endpoints: [
              {
                transport: 'lan',
                url: 'http://192.168.1.30:7420',
                healthy: true,
                latencyMs: 4,
                checkedAt: T0,
              },
              {
                transport: 'mesh',
                url: 'http://100.64.0.9:7420',
                healthy: false,
                latencyMs: null,
                checkedAt: T0,
              },
            ],
          }),
          reachability({
            name: 'Phone',
            reachable: false,
            relayPaired: true,
            lastSeenAt: null,
          }),
        ],
        mesh: {
          source: 'headscale',
          provider: 'headscale',
          rules: 3,
          tags: ['tag:nova-hub'],
          groups: ['group:family'],
        },
        relayStatus: { state: 'connected', url: 'wss://relay.example.com', latencyMs: 31 },
      },
    });
    const root = await page('Recent transport events');
    expectFullyLocalized(root, {
      data: [
        // What the Hub wrote, names and kinds it reports.
        'https://studio.tail.ts.net:8443 timed out',
        'Something new',
        'timed out',
        'Timed out',
        'refused',
        'Refused',
        'eth0',
        'Changed transports',
        'Changed mdns',
        'Changed trust',
        'exit code 1',
        'Desk PC',
        'Phone',
        'novad',
        'headscale',
        'The Relay is off',
        // The mDNS name the Hub answers to.
        'studio',
      ],
    });

    // The rollback dialog: its words, the change summary as data.
    await userEvent.click(
      screen.getAllByRole('button', { name: xa('Roll back the last change') })[0]!,
    );
    const dialog = await screen.findByRole('dialog');
    expectFullyLocalized(dialog, { data: ['Changed transports'] });
  });

  it('lists the sections on phones, localized', async () => {
    await activateTestLocale('en-XA');
    setViewport(390);
    await renderWithNetwork(<NetworkSurface section={null} />);
    const nav = screen.getByRole('navigation', { name: xa('Network sections') });
    expect(within(nav).getAllByRole('link')).toHaveLength(5);
    expectFullyLocalized(document.querySelector('.net-page')!);
  });

  it('shows Setup (what Nova finds, a plan form, runs, permissions) localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithNetwork(<SetupSection />, {
      network: {
        detection: detectionView({
          meshes: [
            {
              ...detectionView().meshes[1]!,
              installed: true,
              version: '1.76.1',
              loggedIn: true,
              state: 'Running',
              ips: ['100.64.0.5'],
              tags: ['tag:nova-hub'],
              peers: [
                { name: 'phone', dnsName: null, ips: [], online: true, os: 'iOS', tags: [] },
                { name: 'nas', dnsName: null, ips: [], online: false, os: 'linux', tags: [] },
              ],
              routes: ['192.168.1.0/24'],
              exitNode: true,
            },
            { ...detectionView().meshes[2]!, installed: true, detail: 'needs login' },
          ],
        }),
        runs: [runView({ id: 'run1', createdAt: T0, updatedAt: '2026-10-01T13:00:00.000Z' })],
        consents: [
          {
            id: 'c1',
            kind: 'mesh.up',
            provider: 'tailscale',
            description: 'Log the Hub in to Tailscale.',
            grantedAt: T0,
          },
        ],
      },
      settings: { 'network.setup.allowSystemChanges': true },
    });
    await screen.findByRole('list', { name: xa('Meshes found') });
    await screen.findByRole('list', { name: xa('Allowed changes') });
    await userEvent.click(screen.getByRole('radio', { name: /^Tailscale:/ }));
    const data = [
      'Headscale',
      'Tailscale',
      'NetBird',
      'WireGuard',
      'linux',
      'lan',
      'apt',
      'eth0',
      'lo',
      'ufw',
      'Running',
      'needs login',
      'not installed',
      'tag:nova-hub',
      'Log the Hub in to Tailscale.',
      'nova-hub',
      'nova',
    ];
    expectFullyLocalized(document.body, { data });

    // Every mesh's own fields.
    for (const mesh of ['Headscale', 'NetBird', 'WireGuard']) {
      await userEvent.click(screen.getByRole('radio', { name: new RegExp(`^${mesh}:`) }));
      if (mesh === 'WireGuard')
        await userEvent.click(screen.getByRole('button', { name: xa('Add a peer') }));
      expectFullyLocalized(document.body, { data: [...data, 'wg-nova'] });
    }
  });

  it('shows a setup run, its steps, a notice and the consent dialog localized', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/network/setup?run=run1');
    const steps = [
      stepView({
        id: 's1',
        runId: 'run1',
        index: 0,
        title: 'Join the tailnet',
        description: 'Log the Hub in to Tailscale.',
        affects: ['lan', 'mesh'],
        undoCommands: [['tailscale', 'logout']],
        status: 'verified',
        appliedAt: T0,
        verifiedAt: T0,
        checks: [
          { name: 'mesh up', ok: true, detail: null },
          { name: 'reachable', ok: false, detail: 'no answer' },
        ],
      }),
      stepView({
        id: 's2',
        runId: 'run1',
        index: 1,
        kind: 'firewall.ports',
        provider: 'ufw',
        title: 'Firewall',
        description: 'Allow 8443/tcp in ufw.',
        status: 'rolled_back',
        autoRolledBack: true,
        error: 'port busy',
      }),
      stepView({
        id: 's3',
        runId: 'run1',
        index: 2,
        kind: 'mesh.routes',
        title: 'Approve routes',
        description: 'Approve the routes in the admin console.',
        commands: [],
        systemChange: false,
        status: 'manual',
        consent: { required: false, remembered: false },
      }),
    ];
    await renderWithNetwork(<SetupSection />, {
      network: {
        runs: [
          runView({
            id: 'run1',
            provider: 'wireguard',
            status: 'in_progress',
            options: { authKey: 'stored', tags: ['tag:a'], magicDns: true },
            outputs: { wireguardPublicKey: 'pubKEY=' },
            steps,
          }),
        ],
      },
      settings: { 'network.setup.allowSystemChanges': true },
    });
    await screen.findByRole('list', { name: xa('Steps') });
    const data = [
      'WireGuard',
      'Join the tailnet',
      'Log the Hub in to Tailscale.',
      'Firewall',
      'Allow 8443/tcp in ufw.',
      'port busy',
      'Approve routes',
      'Approve the routes in the admin console.',
      'mesh up',
      'reachable',
      'no answer',
      'authKey',
      'tags',
      'magicDns',
      'ufw',
      'pubKEY=',
      'Tailscale',
    ];
    expectFullyLocalized(document.body, { data });

    // Apply the next step: the Hub's exact text to allow, in the dialog's own words.
    await userEvent.click(screen.getByRole('button', { name: xa('Roll back the whole run') }));
    const dialog = await screen.findByRole('dialog');
    expectFullyLocalized(dialog, { data });
  });

  it('shows Trust fully localized, with the install hints open', async () => {
    await activateTestLocale('en-XA');
    await renderWithNetwork(<NetworkSurface section="trust" />, {
      network: {
        trust: trustView({
          serving: { scheme: 'https', source: 'explicit' },
          restartRequired: true,
          problems: ['the Hub certificate expired', 'name outside the constraints'],
          meshCert: {
            host: 'studio.tail.ts.net',
            notAfter: '2026-12-30T12:00:00.000Z',
            status: 'expiring',
          },
          issued: [
            {
              id: 'i1',
              serial: '01',
              deviceId: null,
              notBefore: T0,
              kind: 'hub_tls',
              subject: 'CN=studio',
              role: null,
              sans: ['studio.local'],
              notAfter: '2026-12-30T12:00:00.000Z',
              createdAt: T0,
              revokedAt: null,
              supersededAt: null,
            },
            {
              id: 'i2',
              serial: '02',
              deviceId: 'dev9',
              notBefore: T0,
              kind: 'device',
              subject: 'CN=Phone',
              role: 'client',
              sans: [],
              notAfter: '2020-12-30T12:00:00.000Z',
              createdAt: T0,
              revokedAt: null,
              supersededAt: null,
            },
          ],
        }),
      },
    });
    const root = await page('Trust mode');
    await screen.findByRole('list', { name: xa('Certificate problems') });
    await userEvent.click(screen.getByText(xa('How to install it')));
    await userEvent.click(screen.getByText(xa('What it may sign')));
    expectFullyLocalized(root, {
      data: [
        'The Hub certificate expired',
        'Name outside the constraints',
        'hubFp_8Qx3c2T9b0',
        'AB:CD:EF:01',
        'CN=Nova Hub CA',
        'CN=studio',
        'CN=Phone',
        'client',
        'studio.local',
        'studio.tail.ts.net',
        'local',
        'lan',
        '192.168.0.0/16',
        '/usr/local/share/ca-certificates/',
        '/etc/pki/ca-trust/source/anchors/',
        'sudo update-ca-certificates',
        'sudo update-ca-trust',
        '.crt',
        '.pem',
      ],
    });
  });

  it('shows the Relay fully localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithNetwork(<NetworkSurface section="relay" />, {
      network: {
        relay: {
          enabled: true,
          url: 'wss://relay.example.com',
          selfHosted: true,
          effectiveUrl: 'wss://relay.example.com',
          registrationToken: true,
          status: {
            state: 'connected',
            detail: 'registered as route r1',
            url: 'wss://relay.example.com',
            routeId: 'r1',
            since: T0,
            latencyMs: 31,
          },
          clients: { active: 1, pending: 1 },
        },
        relayClients: [
          relayClient({ id: 'rc1', name: 'Sam’s phone' }),
          relayClient({ id: 'rc2', name: 'Old laptop', kind: 'browser', status: 'revoked' }),
        ],
        relayTest: {
          ok: true,
          url: 'wss://relay.example.com',
          reachable: true,
          latencyMs: 31,
          version: '1.2.0',
          state: 'connected',
          detail: null,
        },
      },
    });
    const root = await page('Connection');
    await screen.findByRole('list', { name: xa('Paired clients') });
    await userEvent.click(screen.getByRole('button', { name: xa('Test') }));
    await screen.findByText(xa('The Hub is connected to it.'));
    await userEvent.click(screen.getByText(xa('Revoked and denied')));
    const data = [
      'wss://relay.example.com',
      'Registered as route r1',
      'Sam’s phone',
      'Old laptop',
      'iOS',
      'rc1',
      'rc2',
      'r1',
      '1.2.0',
    ];
    expectFullyLocalized(root, { data });
    await userEvent.click(
      screen.getByRole('button', { name: new RegExp(`^\\[${accent('Revoke')} Sam’s phone`) }),
    );
    expectFullyLocalized(await screen.findByRole('dialog'), { data });
  });

  it('shows the Wake helpers fully localized', async () => {
    const nuc = wakeHelper({ deviceId: 'wh1', name: 'Garage NUC' });
    const nas = wakeHelper({ deviceId: 'wh2', name: 'NAS', status: 'unreachable', subnets: [] });
    await activateTestLocale('en-XA');
    await renderWithNetwork(<NetworkSurface section="wake" />, {
      network: {
        availableHelpers: [nuc, nas],
        wakeHelpers: ['wh1', 'gone'],
        recentWakes: [
          {
            id: 'w1',
            deviceId: 'pc1',
            deviceName: 'Desk PC',
            via: 'wh1',
            viaName: 'Garage NUC',
            status: 'sent',
            mac: 'aa:bb:cc:dd:ee:ff',
            error: null,
            createdAt: T0,
          },
          {
            id: 'w2',
            deviceId: 'pc2',
            deviceName: null,
            via: null,
            viaName: null,
            status: 'rate_limited',
            mac: '11:22:33:44:55:66',
            error: 'too many wakes this hour',
            createdAt: T0,
          },
        ],
      },
    });
    const root = await page('Recent wakes');
    expectFullyLocalized(root, {
      data: [
        'Garage NUC',
        'NAS',
        'Desk PC',
        '192.168.1.20',
        '192.168.1.0/24',
        'aa:bb:cc:dd:ee:ff',
        '11:22:33:44:55:66',
        'too many wakes this hour',
      ],
    });
  });
});

describe('the connection item in en-XA', () => {
  const snap = (over: Partial<TransportSnapshot>): TransportSnapshot => ({
    path: null,
    paired: false,
    relayState: null,
    checking: false,
    unreachable: false,
    revoked: false,
    attempts: [],
    advertised: [],
    ...over,
  });

  it('says which way this browser reaches the Hub in the active locale', async () => {
    await activateTestLocale('en-XA');
    expect(pathText(snap({ checking: true }))).toBe(PATH_TEXT.checking);
    expect(PATH_TEXT.checking).toMatch(/^\[Çĥéçķîñĝ/);
    const mesh = snap({
      path: { via: 'origin', transport: 'mesh', url: 'https://m', latencyMs: 12, since: 0 },
    });
    const relay = snap({
      path: { via: 'relay', transport: 'relay', url: 'wss://r', latencyMs: null, since: 0 },
    });
    for (const s of [snap({}), snap({ revoked: true }), mesh, relay]) {
      const host = document.createElement('p');
      host.textContent = `${pathText(s)} ${pathDetail(s)}`;
      expectFullyLocalized(host, { data: ['https://m'] });
    }
  });
});
