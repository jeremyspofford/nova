// Settings → Managed policy (FR-106; docs/12 §10; J10 step 2): what applies and where it comes
// from, every source status in words, the restrictions in plain sentences, the settings it sets
// with their source, the keys it does not apply and why; the owner's reload (and its refusal); a
// member's view (refused by the Hub, or allowed); a fresh read on `managed.policy.changed`.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { ManagedPolicyPage, sameApplied } from '../src/managed/ManagedPolicyPage.tsx';
import {
  derivedText,
  egressLines,
  formatPolicyValue,
  lockChannel,
  restrictionLines,
  sourceStatusText,
} from '../src/managed/format.ts';
import { FakeEventSource } from './fakes.ts';
import {
  LOCAL_PATH,
  REMOTE_URL,
  localSource,
  lockPolicy,
  noPolicy,
  renderWithManaged,
} from './fakes-m8-managed.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

const section = (name: string) => screen.getByRole('region', { name });

describe('Managed policy page', () => {
  it('shows what the J10 policy applies, its source, the restrictions and what it ignores', async () => {
    const { api } = await renderWithManaged(<ManagedPolicyPage />, {
      managed: { view: lockPolicy() },
    });
    expect(
      await screen.findByText("Your organization's policy is in force on this Hub."),
    ).toBeTruthy();
    expect(api.getManagedPolicy).toHaveBeenCalled();

    // How a setting is decided.
    const how = section('How a setting is decided');
    expect(
      within(how)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      "Nova's default.",
      "This Hub's settings, as you set them.",
      "Your organization's policy, which locks the setting.",
    ]);

    const sources = section('Sources');
    expect(within(sources).getByRole('heading', { name: 'Policy file on this Hub' })).toBeTruthy();
    expect(within(sources).getByText('In force')).toBeTruthy();
    expect(within(sources).getByText('Read, checked and in force.')).toBeTruthy();
    expect(within(sources).getByText(LOCAL_PATH)).toBeTruthy();
    expect(within(sources).getByText('3')).toBeTruthy();

    const restrictions = section('Restrictions');
    expect(within(restrictions).getByText('These modes are turned off: Bypass.')).toBeTruthy();
    expect(within(restrictions).getByText('Agents have no network access.')).toBeTruthy();

    const table = within(section('Settings it sets')).getByRole('table');
    const row = (key: string) => within(table).getByText(key).closest('tr')!;
    expect(row('code.allowBypass').textContent).toContain('Off');
    expect(row('code.allowBypass').textContent).toContain(
      'Follows from the permission modes restriction.',
    );
    expect(row('network.egressMode').textContent).toContain('Follows from the network access');
    expect(row('appearance.theme').textContent).toContain('dark');
    expect(row('appearance.theme').textContent).toContain('Policy file on this Hub');

    const ignored = section('Not applied');
    expect(within(ignored).getByText('relay.url').closest('tr')!.textContent).toContain(
      'Nova cannot tell whether this value tightens or loosens the setting',
    );
    expect(within(ignored).getByText('privacy.crashReports').closest('tr')!.textContent).toContain(
      'It would loosen a security setting',
    );
    // Never a raw reason code.
    expect(screen.queryByText(/\b(unordered|unknown_key|invalid_value|manual_mode)\b/)).toBeNull();
  });

  it('says plainly when no policy applies', async () => {
    await renderWithManaged(<ManagedPolicyPage />);
    expect(
      await screen.findByText(
        'No managed policy applies to this Hub. Every setting is yours to change.',
      ),
    ).toBeTruthy();
    expect(within(section('Sources')).getByText('Not present')).toBeTruthy();
    expect(screen.getByText('There is no policy file at this location.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Restrictions' })).toBeNull();
  });

  it('reloads for the owner and says whether anything changed', async () => {
    const { api, state, hub } = await renderWithManaged(<ManagedPolicyPage />);
    const button = await screen.findByRole('button', { name: 'Check for changes' });
    await userEvent.click(button);
    expect(api.reloadManagedPolicy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('The policy was read again. Nothing changed.')).toBeTruthy();

    // The administrator installs the J10 policy; the next check finds it.
    state.next = lockPolicy();
    await userEvent.click(screen.getByRole('button', { name: 'Check for changes' }));
    expect(await screen.findByText('The policy was read again.')).toBeTruthy();
    expect(screen.getByText('These modes are turned off: Bypass.')).toBeTruthy();
    expect(hub.state.managed['code.allowBypass']).toBe(false);
  });

  it('keeps the page and says why when the reload is refused', async () => {
    const { api } = await renderWithManaged(<ManagedPolicyPage />, {
      managed: { view: lockPolicy() },
    });
    api.reloadManagedPolicy.mockRejectedValueOnce(
      new ApiError(403, {
        code: 'policy_denied',
        message: 'owner only',
        retryable: false,
        details: { reason: 'owner_only' },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Check for changes' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only the owner of this Hub can check the policy for changes.',
    );
    expect(screen.getByText('These modes are turned off: Bypass.')).toBeTruthy();
  });

  it('shows a policy that fails closed, and sources that are ignored, refused or cached', async () => {
    await renderWithManaged(<ManagedPolicyPage />, {
      managed: {
        view: {
          ...lockPolicy(),
          failClosed: 'the policy file is not valid JSON (Unexpected token)',
          sources: [
            localSource({
              status: 'invalid',
              problem: 'not valid JSON (Unexpected token)',
              inForce: true,
              serial: 2,
            }),
            {
              ...localSource(),
              channel: 'remote',
              location: REMOTE_URL,
              status: 'refused',
              problem: 'the signature does not match the pinned key',
              inForce: true,
              cached: true,
              serial: 7,
            },
          ],
        },
      },
    });
    expect(await screen.findByText("Your organization's policy could not be read")).toBeTruthy();
    expect(
      screen.getByText(
        'Every agent tool is denied until the policy is fixed. The last good policy stays in force.',
      ),
    ).toBeTruthy();
    const sources = section('Sources');
    expect(within(sources).getByText('Cannot be read')).toBeTruthy();
    expect(
      within(sources).getByText(
        'It cannot be read, so every agent tool is denied: not valid JSON (Unexpected token).',
      ),
    ).toBeTruthy();
    expect(
      within(sources).getByText('The last good policy from this source stays in force.'),
    ).toBeTruthy();
    expect(within(sources).getByText('Refused')).toBeTruthy();
    expect(
      within(sources).getByText('Refused: the signature does not match the pinned key.'),
    ).toBeTruthy();
    expect(
      within(sources).getByText('In force from the copy kept on this Hub (the last good one).'),
    ).toBeTruthy();
    expect(within(sources).getByText(REMOTE_URL)).toBeTruthy();
  });

  it('shows a member the policy without the reload when the Hub answers them', async () => {
    await renderWithManaged(<ManagedPolicyPage />, {
      as: 'member',
      managed: { view: lockPolicy(), memberCanRead: true },
    });
    expect(await screen.findByText('These modes are turned off: Bypass.')).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByText('Only the owner of this Hub can check the policy for changes.'),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Check for changes' })).toBeNull();
  });

  it('tells a member the policy applies when the Hub keeps its details for the owner', async () => {
    await renderWithManaged(<ManagedPolicyPage />, {
      as: 'member',
      managed: { view: lockPolicy() },
    });
    expect(
      await screen.findByText(
        "Your organization's policy applies to everyone on this Hub. Only the Hub's owner can see its details here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check for changes' })).toBeNull();
  });

  it('reads the policy again when the Hub says it changed', async () => {
    const { state, api } = await renderWithManaged(<ManagedPolicyPage />);
    await screen.findByText(
      'No managed policy applies to this Hub. Every setting is yours to change.',
    );
    state.view = lockPolicy();
    const before = api.getManagedPolicy.mock.calls.length;
    act(() => FakeEventSource.for('/api/v1/events/stream').open());
    FakeEventSource.for('/api/v1/events/stream').emit('managed.policy.changed', {
      active: true,
      failClosed: false,
      sources: [{ channel: 'local', status: 'active' }],
    });
    expect(await screen.findByText('These modes are turned off: Bypass.')).toBeTruthy();
    expect(api.getManagedPolicy.mock.calls.length).toBeGreaterThan(before);
  });

  it('says when the policy cannot be loaded, and retries', async () => {
    const offline = new TypeError('Failed to fetch');
    const { api } = await renderWithManaged(<ManagedPolicyPage />, {
      managed: { view: lockPolicy() },
      prepare: (m) => {
        m.getManagedPolicy.mockRejectedValueOnce(offline).mockRejectedValueOnce(offline);
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Cannot reach the Hub. Check your connection and try again.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('These modes are turned off: Bypass.')).toBeTruthy();
    expect(api.getManagedPolicy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('treats a client without the managed calls as no policy', async () => {
    await renderWithManaged(<ManagedPolicyPage />, { unsupported: true });
    expect(
      screen.getByText('No managed policy applies to this Hub. Every setting is yours to change.'),
    ).toBeTruthy();
  });
});

describe('managed words', () => {
  it('puts every restriction in a plain sentence', () => {
    const lines = restrictionLines({
      permissionModes: { allow: ['manual', 'plan'] },
      tools: { allow: [], deny: ['screen.*'] },
      plugins: { allow: ['com.corp.*'] },
      extensions: { deny: ['com.bad.*'] },
      mcpServers: { allow: ['corp-docs'], userAdded: false, localStdio: false },
      sessions: { local: false, ssh: false, sshHosts: ['*.build.corp.example'] },
      folders: { allow: ['~/src'], deny: ['/etc'] },
      browserDomains: { allow: ['*.corp.example'], deny: ['*.bank.example'] },
      egress: { mode: 'allowlist', allow: ['registry.npmjs.org'], deny: ['paste.example'] },
      telemetryExport: false,
      routing: { allowCloud: false, providers: ['ollama', 'node'] },
      unverifiedInstalls: false,
      apps: false,
    });
    expect(lines).toEqual([
      'Code sessions may use only these modes: Manual, Plan. Manual is always allowed.',
      'Agents may use only these tools: none.',
      'Agents may not use these tools: screen.*.',
      'Only these plugins may be used: com.corp.*.',
      'These extensions may not be used: com.bad.*.',
      'Only these MCP servers may be used: corp-docs.',
      'MCP servers you add yourself are not allowed.',
      'MCP servers that run as programs on this Hub (stdio) are not allowed.',
      "Code sessions on this Hub's own files are turned off.",
      'Code sessions over SSH are turned off.',
      'SSH sessions may connect only to: *.build.corp.example.',
      'Sessions, project folders and tool roots may use only these folders: ~/src.',
      'These folders are off limits: /etc.',
      'The agent browser may open only these sites: *.corp.example.',
      'The agent browser may not open these sites: *.bank.example.',
      'Agents may reach only the hosts that are allowed.',
      'Agents may reach hosts only within: registry.npmjs.org.',
      'Hosts agents may never reach: paste.example.',
      'Telemetry export (OpenTelemetry/OTLP) stays off.',
      'Cloud models are turned off: only local models and compute nodes.',
      'Models may come only from: Ollama, Compute node.',
      'Only plugins, extensions and bundles with a verified signature can be installed.',
      'No third-party app or MCP client can be authorized.',
    ]);
    expect(restrictionLines({ egress: { mode: 'limited' } })).toEqual([
      "Agents' network access is limited.",
    ]);
    expect(restrictionLines({})).toEqual([]);
  });

  it('says which hosts agents may reach under the egress ceiling, and why (ADR-097)', () => {
    const ceilings = [['api.example.com']];
    expect(egressLines(null)).toEqual([]);
    expect(egressLines({ ceilings, own: [], effective: ['api.example.com'], note: null })).toEqual([
      'Hosts agents may reach now: api.example.com.',
    ]);
    expect(
      egressLines({
        ceilings,
        own: ['a.example', 'api.example.com'],
        effective: ['api.example.com'],
        note: null,
      }),
    ).toEqual([
      'Hosts agents may reach now: api.example.com.',
      "These hosts on your allow list are outside the policy's and do not apply: a.example.",
    ]);
    expect(egressLines({ ceilings, own: ['a.example'], effective: [], note: null })[1]).toMatch(
      /None of the hosts on your own allow list/,
    );
  });

  it('formats values, derived settings, source statuses and lock sources', () => {
    expect(formatPolicyValue(true)).toBe('On');
    expect(formatPolicyValue(null)).toBe('Not set');
    expect(formatPolicyValue('')).toBe('Empty');
    expect(formatPolicyValue([])).toBe('None');
    expect(formatPolicyValue(['a', 'b'])).toBe('a, b');
    expect(formatPolicyValue(1500)).toBe('1,500');
    expect(formatPolicyValue({ x: 'y'.repeat(300) }).length).toBe(200);
    expect(derivedText('restrict.apps')).toBe('Follows from the apps restriction.');
    expect(sourceStatusText(localSource({ status: 'unreachable', problem: 'timeout' }))).toBe(
      'It could not be fetched: timeout.',
    );
    expect(sourceStatusText(localSource({ status: 'ignored', problem: null }))).toBe(
      'Ignored, so nothing in it applies: no reason given.',
    );
    expect(sourceStatusText({ ...localSource(), channel: 'remote' })).toBe(
      'No remote policy is configured.',
    );
    const view = lockPolicy();
    expect(lockChannel(null)).toBeNull();
    expect(lockChannel(view, 'code.allowBypass')).toBe('local');
    expect(lockChannel(view, 'not.in.policy')).toBe('local');
    expect(lockChannel(noPolicy())).toBeNull();
    expect(
      lockChannel({
        settings: [],
        sources: [
          localSource({ inForce: true }),
          { ...localSource({ inForce: true }), channel: 'remote' },
        ],
      }),
    ).toBe('both');
    // The test file (tests only) is layered over the others.
    expect(
      lockChannel({
        settings: [],
        sources: [
          localSource({ inForce: true }),
          { ...localSource({ inForce: true }), channel: 'test', testOverride: true },
        ],
      }),
    ).toBe('test');
    // A restriction part names the sources whose restrict block sets it.
    const both = {
      settings: [],
      sources: [
        localSource({ inForce: true }),
        { ...localSource({ inForce: true }), channel: 'remote' as const },
      ],
      restrict: [
        { channel: 'local' as const, restrict: { unverifiedInstalls: false } },
        {
          channel: 'remote' as const,
          restrict: { unverifiedInstalls: false, extensions: { deny: ['x'] } },
        },
      ],
    };
    expect(lockChannel(both, 'restrict.extensions')).toBe('remote');
    expect(lockChannel(both, 'restrict.unverifiedInstalls')).toBe('both');
    // A part no block sets falls back to the sources in force.
    expect(lockChannel({ ...both, sources: [both.sources[0]!] }, 'restrict.tools')).toBe('local');
    const later = { ...view, checkedAt: '2027-01-01T00:00:00.000Z' };
    expect(sameApplied(view, later)).toBe(true);
    expect(sameApplied(view, noPolicy())).toBe(false);
  });
});
