// Network → Trust (FR-134; docs/22 §5): the trust modes with what each means, the restart
// notice, the Hub's fingerprint, the CA's fingerprint and its root to download with install hints,
// the Hub and mesh certificates with renewal (and the Hub's 409 reasons), managed policy, a missing
// identity key, problems, certificates issued and live updates.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { TrustSection } from '../src/netsurface/Trust.tsx';
import { FakeEventSource } from './fakes.ts';
import { renderWithNetwork, trustView } from './fakes-m65-network.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

const region = (name: string) => screen.getByRole('region', { name });

async function open(network: NonNullable<Parameters<typeof renderWithNetwork>[1]>['network'] = {}) {
  const r = await renderWithNetwork(<TrustSection />, { network });
  await screen.findByRole('heading', { name: 'Trust mode' });
  return r;
}

describe('trust (FR-134)', () => {
  it('explains each mode and saves a change, with the restart notice when it needs one', async () => {
    const { api, state } = await open({
      trust: trustView({
        mode: 'none',
        ca: null,
        leaf: null,
        serving: { scheme: 'http', source: 'none' },
      }),
    });
    expect(screen.getByText('The Hub serves plain HTTP now.')).toBeTruthy();
    const mode = region('Trust mode');
    expect(within(mode).getByRole('radio', { name: 'None (plain HTTP)' })).toHaveProperty(
      'checked',
      true,
    );
    expect(mode.textContent).toContain('Install its root on each device once');
    expect(mode.textContent).toContain('Nothing to install; best for phones and remote use');
    const save = within(mode).getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(save.disabled).toBe(true);
    await userEvent.click(within(mode).getByRole('radio', { name: 'Hub local CA' }));
    expect(within(mode).getByText(/HTTPS starts when the Hub next starts/)).toBeTruthy();
    expect(within(mode).getByRole('switch', { name: 'Also serve mesh certificates' })).toBeTruthy();
    await userEvent.click(save);
    await waitFor(() => expect(api.updateTrust).toHaveBeenCalledWith({ mode: 'local-ca' }));
    expect(state.trust.mode).toBe('local-ca');
    expect(await screen.findByText(/Restart the Hub to apply the trust mode/)).toBeTruthy();
    expect(state.changes[0]!.kind).toBe('trust.mode');
  });

  it('shows the Hub’s identity and the root to install, with hints for each platform', async () => {
    await open();
    expect(screen.getByLabelText('Hub fingerprint').textContent).toBe('hubFp_8Qx3c2T9b0');
    expect(screen.getByRole('button', { name: 'Copy fingerprint' })).toBeTruthy();
    const root = region("The Hub's root certificate");
    expect(root.textContent).toContain('AB:CD:EF:01');
    expect(within(root).getByRole('link', { name: /\.crt/ }).getAttribute('href')).toBe(
      '/api/v1/trust/ca.crt',
    );
    expect(within(root).getByRole('link', { name: /\.pem/ }).getAttribute('href')).toBe(
      '/api/v1/trust/ca.pem',
    );
    await userEvent.click(within(root).getByText('How to install it'));
    for (const p of ['Windows', 'macOS', 'Linux', 'iPhone and iPad', 'Android'])
      expect(within(root).getByRole('heading', { name: p })).toBeTruthy();
    expect(root.textContent).toContain('update-ca-certificates');
  });

  it('offers no root download outside local-CA mode, and says why', async () => {
    await open({
      trust: trustView({
        mode: 'mesh',
        meshCert: {
          host: 'studio.tail.ts.net',
          notAfter: '2026-12-01T00:00:00.000Z',
          status: 'expiring',
        },
      }),
    });
    const root = region("The Hub's root certificate");
    expect(within(root).queryByRole('link')).toBeNull();
    expect(root.textContent).toContain('only while the mode is Hub local CA');
    const certs = region('Certificates the Hub serves');
    expect(within(certs).getByText('Expiring soon')).toBeTruthy();
    expect(certs.textContent).toContain('studio.tail.ts.net');
  });

  it('renews, and says why the Hub refuses', async () => {
    const { api, network } = await open();
    const certs = region('Certificates the Hub serves');
    expect(certs.textContent).toContain('studio.local, 192.168.1.10');
    await userEvent.click(within(certs).getByRole('button', { name: 'Renew now' }));
    await waitFor(() => expect(api.renewTrust).toHaveBeenCalledWith('leaf'));
    expect((await screen.findAllByText('Hub certificate renewed.')).length).toBeGreaterThan(0);
    network.failNext.renewTrust = new ApiError(409, {
      code: 'conflict',
      message: 'nothing to renew in this trust mode',
      retryable: false,
      details: { reason: 'no_local_ca' },
    });
    await userEvent.click(within(certs).getByRole('button', { name: 'Renew now' }));
    expect((await within(certs).findByRole('alert')).textContent).toBe(
      'This Hub does not use its local CA, so it has no certificate of its own to renew.',
    );
    expect(
      within(certs).getByText(
        'None yet. Network Setup gets one when the mesh offers certificates.',
      ),
    ).toBeTruthy();
  });

  it('says when managed policy refuses a change', async () => {
    await open({ managedTrust: ['pinNativeShells'] });
    const mode = region('Trust mode');
    await userEvent.click(within(mode).getByRole('switch', { name: 'Native apps pin this Hub' }));
    await userEvent.click(within(mode).getByRole('button', { name: 'Save' }));
    expect((await within(mode).findByRole('alert')).textContent).toBe(
      'Your organization manages this setting.',
    );
    await userEvent.click(within(mode).getByRole('button', { name: 'Reset' }));
    expect(
      within(mode)
        .getByRole('switch', { name: 'Native apps pin this Hub' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('copes with a missing identity key, a start fallback, problems and an unknown mode', async () => {
    await open({
      trust: trustView({
        mode: 'pinned' as 'mesh',
        hubFingerprint: null,
        hubPublicKey: null,
        serving: {
          scheme: 'http',
          source: 'none',
          fallbackReason: 'the certificate file could not be read',
        },
        problems: ['the Hub certificate expired', 'the identity key could not be loaded'],
      }),
    });
    expect(screen.getByText(/The Hub cannot load its identity key right now/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy fingerprint' })).toBeNull();
    expect(
      screen.getByText(
        /serves plain HTTP on this computer only: the certificate file could not be read/,
      ),
    ).toBeTruthy();
    const problems = screen.getByRole('list', { name: 'Certificate problems' });
    expect(problems.textContent).toContain('The Hub certificate expired');
    expect(problems.textContent).toContain('Native apps warn about an expired certificate');
    expect(screen.getByText(/The Hub uses a mode this page does not know: pinned/)).toBeTruthy();
  });

  it('lists the certificates issued, and follows trust events', async () => {
    const { state } = await open({
      trust: trustView({
        issued: [
          {
            id: 'c1',
            kind: 'device',
            serial: '0a',
            subject: 'CN=Phone',
            deviceId: 'd1',
            role: 'client',
            sans: ['urn:nova:device:d1'],
            notBefore: '2026-10-01T12:00:00.000Z',
            notAfter: '2099-10-01T12:00:00.000Z',
            createdAt: '2026-10-01T12:00:00.000Z',
            supersededAt: null,
            revokedAt: '2026-10-02T12:00:00.000Z',
          },
          {
            id: 'c2',
            kind: 'hub_tls',
            serial: '0b',
            subject: 'CN=studio',
            deviceId: null,
            role: null,
            sans: ['studio.local'],
            notBefore: '2026-10-01T12:00:00.000Z',
            notAfter: '2099-12-30T12:00:00.000Z',
            createdAt: '2026-10-01T12:00:00.000Z',
            supersededAt: null,
            revokedAt: null,
          },
        ],
      }),
    });
    const issued = screen.getByRole('list', { name: 'Certificates issued' });
    expect(
      within(within(issued).getByRole('listitem', { name: 'Device CN=Phone' })).getByText(
        'Revoked',
      ),
    ).toBeTruthy();
    expect(
      within(within(issued).getByRole('listitem', { name: 'Hub certificate CN=studio' })).getByText(
        'In use',
      ),
    ).toBeTruthy();
    state.trust = { ...state.trust, restartRequired: true };
    FakeEventSource.for('/api/v1/events/stream').emit('trust.changed', {
      reason: 'mode',
      restartRequired: true,
    });
    expect(await screen.findByText(/Restart the Hub to apply the trust mode/)).toBeTruthy();
  });

  it('shows a load error with Retry', async () => {
    const r = await renderWithNetwork(<TrustSection />);
    await screen.findByRole('heading', { name: 'Trust mode' });
    r.network.failNext.getTrust = new ApiError(500, {
      code: 'server_error',
      message: 'internal error',
      retryable: true,
    });
    FakeEventSource.for('/api/v1/events/stream').emit('trust.changed', { reason: 'leaf_issued' });
    expect((await screen.findByRole('alert')).textContent).toContain('Internal error.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
