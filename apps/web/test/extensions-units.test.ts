// Pure helpers of the extensions and the marketplace (FR-117, FR-049): registry ids for extension
// commands, refusals in plain words, catalog locations and ids, managed policy's source in words.
import { describe, expect, it } from 'vitest';
import type { ManagedPolicyView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import {
  commandErrorText,
  extensionCommandKey,
  extensionErrorMessage,
  parseExtensionCommand,
  publisherText,
  readBundleFile,
  registeredText,
} from '../src/extensions/format.ts';
import {
  isCatalogLocation,
  isGitLocation,
  marketErrorMessage,
  marketTabPath,
  newCatalogId,
  parseMarketTab,
} from '../src/market/format.ts';
import { lockChannel } from '../src/managed/format.ts';

const refusal = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

describe('extension command ids', () => {
  it('are valid keyboard.bindings keys and never shared by two commands', () => {
    const ids = [
      extensionCommandKey('com.example.a-b', 'c'),
      extensionCommandKey('com.example.a', 'b-c'),
      extensionCommandKey('com.example.a.b', 'c'),
      extensionCommandKey('com.example.a', 'b.c'),
      extensionCommandKey('com.example.a', 'b_c'),
      extensionCommandKey('com.example.a', 'bC'),
    ];
    for (const id of ids) expect(id).toMatch(/^[a-z][a-zA-Z0-9.]*$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parseExtensionCommand('ext:com.example.a/count')).toEqual({
      extensionId: 'com.example.a',
      commandId: 'count',
    });
    expect(parseExtensionCommand('mcp:x.y')).toBeNull();
  });
});

describe('extension words', () => {
  it('says every refusal in plain words', () => {
    expect(
      extensionErrorMessage(refusal(403, 'policy_denied', 'x', { reason: 'owner_only' })),
    ).toBe('Only the owner of this Hub can manage extensions.');
    expect(
      extensionErrorMessage(
        refusal(403, 'policy_denied', 'only signed ones', { reason: 'managed' }),
      ),
    ).toBe('Managed by your organization: only signed ones');
    expect(extensionErrorMessage(refusal(410, 'request_expired', 'x'))).toBe(
      'This preview expired. Choose the file again.',
    );
    expect(extensionErrorMessage(refusal(409, 'conflict', 'x'))).toMatch(
      /changed since the preview/,
    );
    expect(
      extensionErrorMessage(
        refusal(400, 'validation', 'x', { reason: 'sideload_confirmation_required' }),
      ),
    ).toMatch(/Tick that you trust its source/);
    expect(extensionErrorMessage(refusal(400, 'validation', 'the arguments are not JSON'))).toBe(
      'This was refused: the arguments are not JSON.',
    );
    expect(extensionErrorMessage(new TypeError('Failed to fetch'))).toMatch(/Cannot reach the Hub/);
  });

  it('says why a command failed, and what is running', () => {
    expect(commandErrorText('Count', null)).toBe('Count did not finish.');
    expect(commandErrorText('Count', { code: 'extension_unavailable', message: '' })).toMatch(
      /not running/,
    );
    expect(commandErrorText('Count', { code: 'extension_busy', message: '' })).toMatch(/busy/);
    expect(commandErrorText('Count', { code: 'policy_denied', message: '' })).toMatch(
      /did not declare/,
    );
    expect(commandErrorText('Count', { code: 'cancelled', message: '' })).toBe(
      'Count was cancelled.',
    );
    expect(
      registeredText({
        commands: 2,
        panels: 1,
        tools: 0,
        hooks: 0,
        themes: 0,
        keybindings: 0,
        menus: 0,
        statusItems: 0,
        events: 3,
      }),
    ).toBe('2 commands, 1 panel, 3 event listeners');
  });

  it('reads only .novax files up to the size the Hub accepts', async () => {
    expect(await readBundleFile(new File(['x'], 'a.zip'))).toEqual({
      ok: false,
      error: 'Choose a .novax file.',
    });
    const ok = await readBundleFile(new File(['hé'], 'a.novax'));
    expect(ok).toEqual({ ok: true, bundle: 'aMOp', fileName: 'a.novax' });
    const big = new File(['x'], 'big.novax');
    Object.defineProperty(big, 'size', { value: 33 * 1024 * 1024 });
    expect(await readBundleFile(big)).toEqual({
      ok: false,
      error: 'This file is larger than 32 MB, the largest bundle the Hub accepts.',
    });
  });
});

describe('marketplace words', () => {
  it('says every refusal in plain words', () => {
    expect(
      marketErrorMessage(refusal(400, 'validation', 'x', { reason: 'catalog_signature_invalid' })),
    ).toMatch(/This catalog was refused/);
    expect(
      marketErrorMessage(refusal(400, 'validation', 'x', { reason: 'bundle_invalid' })),
    ).toMatch(/cannot be installed, even unverified/);
    expect(
      marketErrorMessage(
        refusal(400, 'capability_missing', 'x', { reason: 'installer_missing', kind: 'pet' }),
      ),
    ).toBe('This Hub cannot install pets yet.');
    expect(
      marketErrorMessage(
        refusal(400, 'validation', 'x', { reason: 'permission_diff_not_accepted' }),
      ),
    ).toMatch(/accept the permission changes/);
    expect(
      marketErrorMessage(refusal(403, 'policy_denied', 'x', { reason: 'sideload_disabled' })),
    ).toMatch(/Installing unverified items is turned off/);
    expect(
      marketErrorMessage(refusal(403, 'policy_denied', 'x', { reason: 'kind_not_allowed' })),
    ).toMatch(/this kind of item is turned off/);
    expect(marketErrorMessage(refusal(409, 'conflict', 'x', { reason: 'name_taken' }))).toMatch(
      /already exists/,
    );
    expect(marketErrorMessage(refusal(404, 'not_found', 'x'))).toMatch(/no longer there/);
  });

  it('knows catalog locations, ids and tabs', () => {
    expect(isCatalogLocation('/srv/catalog')).toBe(true);
    expect(isCatalogLocation('https://catalog.example.com/index.json')).toBe(true);
    expect(isCatalogLocation('http://catalog.example.com')).toBe(false);
    expect(isCatalogLocation('relative/path')).toBe(false);
    expect(isGitLocation('git@github.example:team/catalog')).toBe(true);
    expect(isGitLocation('https://git.example.com/team/catalog.git#main')).toBe(true);
    expect(isGitLocation('https://catalog.example.com')).toBe(false);
    expect(newCatalogId('Team Catalog!', [])).toBe('team-catalog');
    expect(newCatalogId('Team Catalog', ['team-catalog'])).toBe('team-catalog-2');
    expect(newCatalogId('Nova sample', [])).toBe('nova-sample-2');
    expect(newCatalogId('***', [])).toBe('catalog');
    expect(parseMarketTab('pets')).toBe('pets');
    expect(parseMarketTab('nope')).toBe('plugins');
    expect(parseMarketTab(null)).toBe('plugins');
    expect(marketTabPath('plugins')).toBe('/marketplace');
    expect(marketTabPath('catalogs')).toBe('/marketplace/catalogs');
  });

  it('names an extension’s publisher only when trusted, else by its key’s fingerprint', () => {
    const key = 'KWyGeoNcQVUoD7fIgkwppFWhQZbPo5ynx1JyVjt5-O0';
    expect(publisherText({ key: null, name: null, fingerprint: null, trusted: false })).toBe(
      'Not signed',
    );
    expect(
      publisherText({ key, name: 'Example Labs', fingerprint: '1a2b:3c4d', trusted: true }),
    ).toBe('Example Labs');
    // A name for a key nobody trusts is never shown.
    expect(
      publisherText({ key, name: 'Example Labs', fingerprint: '1a2b:3c4d', trusted: false }),
    ).toBe('Key 1a2b:3c4d, not trusted');
    expect(publisherText({ key, name: null, fingerprint: null, trusted: false })).toBe(
      'A publisher you do not trust',
    );
  });

  it('says where managed policy comes from (the shared lock note’s source)', () => {
    const view: ManagedPolicyView = {
      active: true,
      failClosed: null,
      sources: [
        {
          channel: 'local',
          location: '/etc/nova/managed-settings.json',
          status: 'active',
          problem: null,
          inForce: true,
          cached: false,
          serial: null,
          loadedAt: null,
          checkedAt: '2026-10-19T09:00:00.000Z',
        },
        {
          channel: 'remote',
          location: 'https://policy.example.com/p.json',
          status: 'active',
          problem: null,
          inForce: true,
          cached: false,
          serial: 2,
          loadedAt: null,
          checkedAt: '2026-10-19T09:00:00.000Z',
        },
      ],
      settings: [
        { key: 'sdk.enabled', value: false, channel: 'local', derivedFrom: null },
        { key: 'market.allowSideload', value: false, channel: 'both', derivedFrom: null },
      ],
      restrict: [
        { channel: 'local', restrict: { unverifiedInstalls: false } },
        { channel: 'remote', restrict: { unverifiedInstalls: false, extensions: { deny: ['x'] } } },
      ],
      egress: null,
      ignored: [],
      checkedAt: '2026-10-19T09:00:00.000Z',
    };
    expect(lockChannel(view, 'sdk.enabled')).toBe('local');
    expect(lockChannel(view, 'market.allowSideload')).toBe('both');
    expect(lockChannel(view, 'restrict.unverifiedInstalls')).toBe('both');
    expect(lockChannel(view, 'restrict.extensions')).toBe('remote');
    // Not named by the policy: the sources in force.
    expect(lockChannel(view, 'appearance.theme')).toBe('both');
    expect(lockChannel(null, 'sdk.enabled')).toBeNull();
  });
});
