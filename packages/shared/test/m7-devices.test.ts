// M7 devices (FR-126, FR-137): the Relay registration token request and the setting that names
// its vault entry, which may only point at a registration token.
import { describe, expect, it } from 'vitest';
import {
  LOCAL_RUNTIME_SCOPE,
  RELAY_REGISTRATION_TOKEN_REF,
  SETTINGS,
  relayRegistrationTokenRefSchema,
  relayRegistrationTokenSchema,
  resolveSetting,
} from '../src/index.ts';

describe('M7 devices shapes', () => {
  it('takes a printable token or null, nothing else', () => {
    expect(relayRegistrationTokenSchema.parse({ token: 'abcdefgh-1234' })).toEqual({
      token: 'abcdefgh-1234',
    });
    expect(relayRegistrationTokenSchema.parse({ token: null })).toEqual({ token: null });
    for (const bad of [
      {},
      { token: 'short' },
      { token: 'with space x' },
      { token: 'x'.repeat(513) },
    ])
      expect(relayRegistrationTokenSchema.safeParse(bad).success).toBe(false);
    expect(relayRegistrationTokenSchema.safeParse({ token: 'abcdefgh', extra: 1 }).success).toBe(
      false,
    );
  });

  it('names only a registration token in the vault', () => {
    expect(relayRegistrationTokenRefSchema.parse(RELAY_REGISTRATION_TOKEN_REF)).toBe(
      RELAY_REGISTRATION_TOKEN_REF,
    );
    expect(relayRegistrationTokenRefSchema.parse('')).toBe('');
    for (const bad of [
      'secret://hub/identity',
      'secret://relay/x/route-token',
      'relay',
      'secret://relay/registration/',
    ])
      expect(relayRegistrationTokenRefSchema.safeParse(bad).success).toBe(false);
  });

  it('defaults: devices without a certificate accepted, no token, both security settings', () => {
    expect(resolveSetting('devices.tls.allowWithoutCertificate', {}).value).toBe(true);
    expect(resolveSetting('relay.registrationTokenRef', {}).value).toBe('');
    expect(SETTINGS['devices.tls.allowWithoutCertificate'].security).toBe(true);
    expect(SETTINGS['relay.registrationTokenRef'].security).toBe(true);
    expect(LOCAL_RUNTIME_SCOPE).toBe('local-runtime');
  });
});
