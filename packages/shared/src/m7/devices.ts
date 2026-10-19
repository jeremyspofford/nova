// M7 devices (FR-126, FR-128, docs/22 §5 and §9): mutual TLS for novad devices and compute
// nodes, the Relay registration token, and the local runtime's scope.
import { z } from 'zod';

/** The scope that lets novad's local runtime serve local models (docs/22 §4.2, FR-128). */
export const LOCAL_RUNTIME_SCOPE = 'local-runtime';

/**
 * What the Hub saw of a device's certificate on its last HTTPS call (FR-126): `verified` (a
 * device certificate of the Hub local CA for this device), `missing` (none presented, accepted
 * while `devices.tls.allowWithoutCertificate` is on) or `refused`.
 */
export const DEVICE_TLS_STATES = ['verified', 'missing', 'refused'] as const;
export type DeviceTlsState = (typeof DEVICE_TLS_STATES)[number];

/**
 * Why a client certificate was refused: the trust area's check (`certificate_revoked`,
 * `certificate_expired`, `certificate_unknown_issuer`, …), `certificate_mismatch` (another
 * device's certificate) or `certificate_required` (none, and the setting requires one).
 */
export type DeviceTlsReason = `certificate_${string}`;

export interface DeviceTlsView {
  deviceId: string;
  /** `novad` (a device running novad) or `compute` (a compute node). */
  kind: 'novad' | 'compute';
  name: string | null;
  certificate: DeviceTlsState;
  reason: DeviceTlsReason | null;
  /** The verified certificate's serial (lower-case hex). */
  serial: string | null;
  lastHttpsAt: string;
}

/** `GET /api/v1/devices/tls`: every device seen over HTTPS, newest first. */
export interface DeviceTlsSummaryView {
  /** Whether a device without a certificate is refused over HTTPS (the setting turned off). */
  requireCertificate: boolean;
  items: DeviceTlsView[];
  /** Plain-language problems for diagnostics (devices without a certificate, refusals). */
  problems: string[];
}

/** A `secret://` reference for the Relay registration token (`relay.registrationTokenRef`). */
export const RELAY_REGISTRATION_TOKEN_REF = 'secret://relay/registration/token';

/**
 * `relay.registrationTokenRef`: empty for none, else a reference under
 * `secret://relay/registration/` (never another secret's: the connector sends what it names to
 * the Relay).
 */
export const relayRegistrationTokenRefSchema = z.union([
  z.literal(''),
  z
    .string()
    .max(200)
    .regex(
      /^secret:\/\/relay\/registration\/[A-Za-z0-9_.-]{1,64}$/,
      'a secret://relay/registration/… reference',
    ),
]);

/**
 * `PUT /api/v1/relay/registration-token`: the bearer token a private Relay wants when a Hub
 * registers (services/relay `NOVA_RELAY_REGISTRATION_TOKEN`), or null to remove it. Stored in
 * the vault; never answered back.
 */
export const relayRegistrationTokenSchema = z
  .object({
    token: z
      .string()
      .min(8)
      .max(512)
      .regex(/^[\x21-\x7e]+$/, 'printable characters without spaces')
      .nullable(),
  })
  .strict();
export type RelayRegistrationTokenInput = z.infer<typeof relayRegistrationTokenSchema>;

/** Whether a registration token is set (its value never leaves the vault). */
export interface RelayRegistrationTokenView {
  registrationToken: boolean;
}
