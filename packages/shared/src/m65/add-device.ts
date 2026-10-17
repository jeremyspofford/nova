// M6.5 Add Device API shapes (owned by the add-device area; FR-132, FR-140, docs/22 §4). The owner
// starts a pairing (a short code, single use, 5 minutes); the new device completes it with its
// Ed25519 public key and polls its status with signed requests; the owner approves after checking
// that both screens show the same confirmation code. Contract: contracts/hub-api.md §1.
import { z } from 'zod';
import { idSchema } from '../api.ts';

export const ADD_DEVICE_ROLES = ['client', 'compute', 'wake-helper'] as const;
export type AddDeviceRole = (typeof ADD_DEVICE_ROLES)[number];

/** What the joining device is: a browser/PWA, the native app, `novad`, or a compute node. */
export const ADD_DEVICE_KINDS = ['browser', 'novad', 'compute', 'native'] as const;
export type AddDeviceKind = (typeof ADD_DEVICE_KINDS)[number];

/** Which kinds may join with each role (a compute node runs `nova-compute` or `novad`). */
export const ADD_DEVICE_KINDS_BY_ROLE: Record<AddDeviceRole, readonly AddDeviceKind[]> = {
  client: ['browser', 'native', 'novad'],
  'wake-helper': ['novad'],
  compute: ['compute', 'novad'],
};

export const ADD_DEVICE_TRANSPORTS = ['direct', 'relay'] as const;
export type AddDeviceTransport = (typeof ADD_DEVICE_TRANSPORTS)[number];

export const ADD_DEVICE_REQUEST_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
export type AddDeviceRequestStatus = (typeof ADD_DEVICE_REQUEST_STATUSES)[number];

/** Request headers of the signed status poll. */
export const ADD_DEVICE_TIME_HEADER = 'x-nova-device-time';
export const ADD_DEVICE_SIGNATURE_HEADER = 'x-nova-device-signature';

/**
 * A scope name chosen at add time (docs/22 §4.2), e.g. `offline-replica`, `local-runtime` or a
 * capability name; shown on the success screen and editable later.
 */
export const addDeviceScopeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.:-]{0,63}$/, 'a lower-case scope name');

/** `POST /api/v1/devices/add/start` (owner session). */
export const addDeviceStartSchema = z
  .object({
    role: z.enum(ADD_DEVICE_ROLES),
    scopes: z.array(addDeviceScopeSchema).max(20).optional(),
    name: z.string().trim().min(1).max(100).optional(),
    transport: z.enum(ADD_DEVICE_TRANSPORTS).optional(),
  })
  .strict();
export type AddDeviceStartRequest = z.infer<typeof addDeviceStartSchema>;

/** `bootstrap`: the one-line install command for headless devices, or why there is none. */
export interface AddDeviceBootstrap {
  command: string | null;
  /** The same install for Windows (PowerShell), when the Hub has a Windows build. */
  powershell?: string | null;
  why: string | null;
}

/** 201 answer of `add/start`. The code is shown once; only its hash is kept. */
export interface AddDeviceStartView {
  pairingId: string;
  /** 8 characters, Crockford base32 without I, L, O, U, shown as `ABCD-EFGH`. */
  code: string;
  expiresAt: string;
  role: AddDeviceRole;
  scopes: string[];
  transport: AddDeviceTransport;
  /** The QR payload: `<hub>/add-device?p=<pairingId>…#c=<code>` (the code stays in the fragment). */
  qr: string;
  /** The same for the native app: `nova://add-device?h=<hub>&p=<pairingId>…#c=<code>`. */
  deepLink: string;
  /** The Hub's Add Device page for this pairing (without the code). */
  pageUrl: string;
  bootstrap: AddDeviceBootstrap;
  /** The Hub identity fingerprint the device pins; null until the Hub has an identity. */
  hubFingerprint: string | null;
  /** Healthy endpoints embedded in the QR payload (`e=`), best first. */
  endpoints: string[];
  /** For `transport: relay`: where the device claims the pairing. */
  relay: { relayUrl: string; relayPairingId: string } | null;
}

const publicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'a raw Ed25519 public key, base64url (32 bytes)');

const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');

/**
 * `POST /api/v1/devices/add/complete` (public; the code authenticates it), Add Device v2: the
 * device commits to a secret nonce (`commitment` = base64url SHA-256 of
 * `nova-add-device-commit-v1|<publicKey>|<deviceNonce>`) and reveals it later. `pairingId` comes
 * from the QR payload or the bootstrap command; a typed code has none, and the code alone finds its
 * pairing then, within a small guess budget of its own.
 */
export const addDeviceCompleteSchema = z
  .object({
    pairingId: idSchema.optional(),
    code: z.string().trim().min(8).max(20),
    publicKey: publicKeySchema,
    name: z.string().trim().min(1).max(100),
    platform: z.string().trim().min(1).max(50),
    kind: z.enum(ADD_DEVICE_KINDS),
    commitment: nonceSchema,
  })
  .strict();
export type AddDeviceCompleteRequest = z.infer<typeof addDeviceCompleteSchema>;

/** 202 answer of `add/complete`: the Hub's nonce; no confirmation before the reveal. */
export interface AddDeviceCompleteView {
  requestId: string;
  /** The pairing the code belongs to (the device needs it to compute the confirmation). */
  pairingId: string;
  /** Reveal before this (2 minutes); the owner then has 10 minutes to approve. */
  expiresAt: string;
  /** 32 random bytes from the Hub, base64url. */
  hubNonce: string;
  status: 'committed';
}

/**
 * `POST /api/v1/devices/add/reveal` (public; the commitment and the device key authenticate it),
 * with `x-nova-device-time` and `x-nova-device-signature` over
 * `nova-add-device-reveal-v1.<requestId>.<time>`. Once per request.
 */
export const addDeviceRevealSchema = z.object({ requestId: idSchema, nonce: nonceSchema }).strict();
export type AddDeviceRevealRequest = z.infer<typeof addDeviceRevealSchema>;

/** 200 answer of `add/reveal`: the request is now pending for the owner. */
export interface AddDeviceRevealView {
  requestId: string;
  /** Six digits; both screens show it as `123 456`. */
  confirmation: string;
  status: 'pending';
  /**
   * The Hub identity's Ed25519 signature (base64url) over
   * `nova-add-device-reveal-v1|<requestId>|<pairingId>|<publicKey>|<confirmation>`; null while the
   * Hub has no identity. A device with a pin must verify it.
   */
  hubSignature: string | null;
}

/** What the first approved status poll hands out, exactly once. */
export type AddDeviceGrant =
  | { type: 'session'; token: string; certificatePem?: string }
  | { type: 'novad'; enrollToken: string; certificatePem?: string }
  | { type: 'compute'; enrollToken: string; certificatePem?: string };

/** `GET /api/v1/devices/add/status/:requestId` (public; signed by the device key). */
export interface AddDeviceStatusView {
  status: AddDeviceRequestStatus;
  /** Set once approved. */
  deviceId?: string;
  grant?: AddDeviceGrant;
}

/** A device's request to join, for the owner (`GET /api/v1/devices/add/requests`). */
export interface AddDeviceRequestView {
  id: string;
  pairingId: string;
  role: AddDeviceRole;
  kind: AddDeviceKind;
  name: string;
  platform: string;
  scopes: string[];
  confirmation: string;
  /** SHA-256 of the device's public key, hex. */
  fingerprint: string;
  via: AddDeviceTransport;
  status: AddDeviceRequestStatus;
  deviceId: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export const addDeviceRequestsQuerySchema = z
  .object({ status: z.enum([...ADD_DEVICE_REQUEST_STATUSES, 'all']).optional() })
  .strict();

/** `POST /api/v1/devices/add/requests/:id/approve` (owner session). */
export const addDeviceApproveSchema = z
  .object({
    confirmation: z
      .string()
      .trim()
      .regex(/^\d{3} ?\d{3}$/, 'the six-digit code the device shows'),
  })
  .strict();
export type AddDeviceApproveRequest = z.infer<typeof addDeviceApproveSchema>;

/** Every device record of the account, whatever it runs (FR-140; `GET /api/v1/devices/all`). */
export interface DeviceSummaryView {
  id: string;
  name: string;
  /** The device table's kind: `client`, `compute`, `wake-helper` or `hub`. */
  kind: string;
  /** How it joined through Add Device; null for devices enrolled another way. */
  addedAs: AddDeviceKind | null;
  roles: string[];
  scopes: string[];
  platform: string | null;
  status: 'pending' | 'active' | 'revoked' | 'unreachable';
  fingerprint: string;
  /** Live device sessions (browsers and apps). */
  sessions: number;
  novadVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

/** `PUT /api/v1/devices/:id/scopes` (owner session). */
export const deviceScopesSchema = z
  .object({ scopes: z.array(addDeviceScopeSchema).max(20) })
  .strict();
