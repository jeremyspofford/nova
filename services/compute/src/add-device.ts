// Adding this compute node with a code (FR-132, docs/22 §4; contracts/hub-api.md §1), Add Device v2
// (commit-then-reveal). The node sends the pairing code, its new Ed25519 public key and a commitment
// to a secret nonce; the Hub answers with its own nonce; the node reveals its nonce (signed by its
// key) and gets the confirmation and the Hub identity's signature over it. With a pin (`--pin`) the
// node checks that the Hub's public key from hello hashes to the pin and that the signature
// verifies; it always computes the confirmation itself and stops on any mismatch. Then it polls
// its status and, once the owner approves on the Hub, registers with the one-use `nve_` token it
// was granted, which the Hub bound to that same key, presenting the device certificate the grant
// carries (local-CA mode). An https:// Hub is trusted through the pin (hub-tls.ts: its signed
// identity statement on the connection itself, before anything is sent).
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { hostname } from 'node:os';
import { Backend, guardedFetch } from './backend.ts';
import { HubClient, HubError } from './hub-client.ts';
import { HubTls } from './hub-tls.ts';
import { generateKeys } from './identity.ts';
import { enroll, plainHttpUrl, type EnrollOptions } from './node.ts';
import { loadState, statePath, type NodeState } from './state.ts';

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{8}$`);

/** The canonical code (upper case, no dash, O → 0, I/L → 1), or null when it is not one. */
export function normalizeAddDeviceCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_PATTERN.test(s) ? s : null;
}

/** The device's secret nonce: 32 random bytes, base64url. */
export function newAddDeviceNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** The commitment `complete` carries: base64url SHA-256 of `nova-add-device-commit-v1|<key>|<nonce>`. */
export function addDeviceCommitment(publicKey: string, nonce: string): string {
  return createHash('sha256')
    .update(`nova-add-device-commit-v1|${publicKey}|${nonce}`, 'utf8')
    .digest('base64url');
}

/**
 * The confirmation both screens show (v2): SHA-256 of `nova-add-device-v2|<hub fingerprint or ''>|
 * <pairingId>|<publicKey>|<code>|<deviceNonce>|<hubNonce>`, as a big-endian integer mod 10^6, six
 * digits. The Hub computes the same (packages/core/src/pairing/code.ts).
 */
export function addDeviceConfirmation(input: {
  hubFingerprint: string;
  pairingId: string;
  publicKey: string;
  code: string;
  deviceNonce: string;
  hubNonce: string;
}): string {
  const code = normalizeAddDeviceCode(input.code) ?? input.code;
  const digest = createHash('sha256')
    .update(
      [
        'nova-add-device-v2',
        input.hubFingerprint,
        input.pairingId,
        input.publicKey,
        code,
        input.deviceNonce,
        input.hubNonce,
      ].join('|'),
      'utf8',
    )
    .digest();
  let r = 0;
  for (const b of digest) r = (r * 256 + b) % 1_000_000;
  return String(r).padStart(6, '0');
}

function signText(privateKeyPem: string, text: string): string {
  return sign(null, Buffer.from(text, 'utf8'), createPrivateKey(privateKeyPem)).toString(
    'base64url',
  );
}

/** The status poll's signature: Ed25519 over `nova-add-device-status-v1.<requestId>.<time>`. */
export function signAddDeviceStatus(
  privateKeyPem: string,
  requestId: string,
  time: number,
): string {
  return signText(privateKeyPem, `nova-add-device-status-v1.${requestId}.${time}`);
}

/** The reveal's signature: Ed25519 over `nova-add-device-reveal-v1.<requestId>.<time>`. */
export function signAddDeviceReveal(
  privateKeyPem: string,
  requestId: string,
  time: number,
): string {
  return signText(privateKeyPem, `nova-add-device-reveal-v1.${requestId}.${time}`);
}

/** The Hub fingerprint a pin names: base64url SHA-256 of the raw public key. */
export function hubKeyFingerprint(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url');
}

/**
 * True when `signature` is the Hub key's Ed25519 signature over
 * `nova-add-device-reveal-v1|<requestId>|<pairingId>|<publicKey>|<confirmation>`.
 */
export function verifyHubReveal(
  hubPublicKey: string,
  signature: string,
  statement: { requestId: string; pairingId: string; publicKey: string; confirmation: string },
): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(hubPublicKey) || !/^[A-Za-z0-9_-]{86}$/.test(signature))
    return false;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: hubPublicKey },
      format: 'jwk',
    });
    const text = [
      'nova-add-device-reveal-v1',
      statement.requestId,
      statement.pairingId,
      statement.publicKey,
      statement.confirmation,
    ].join('|');
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** `123456` → `123 456`. */
export function formatConfirmation(confirmation: string): string {
  return `${confirmation.slice(0, 3)} ${confirmation.slice(3)}`;
}

function platformName(): string {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

export interface JoinOptions extends Omit<
  EnrollOptions,
  'token' | 'keys' | 'pin' | 'trust' | 'certificatePem'
> {
  /** The pairing code the Hub shows (`ABCD-EFGH`). */
  code: string;
  /** From the QR payload or the install command (`--pairing`); a typed code finds its own. */
  pairingId?: string;
  /**
   * The Hub identity fingerprint to pin (`--pin`): the Hub's key from hello must hash to it, and
   * the Hub's signature over the confirmation must verify with that key.
   */
  pin?: string;
  /** Called once with the six digits to show (`123456`). */
  onConfirmation?: (confirmation: string) => void;
  /** Between status polls (default 2 s; a poll is sent at most once per second). */
  pollIntervalMs?: number;
  /** Give up after this long (default 11 minutes: the Hub keeps a request 10). */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Add this node to a Hub with a pairing code, then register it. Prints nothing. */
export async function joinWithCode(opts: JoinOptions): Promise<NodeState> {
  const existing = loadState(opts.dataDir);
  if (existing?.enrollment) {
    throw new Error(
      `this node is already enrolled (node ${existing.enrollment.nodeId}); ` +
        `remove ${statePath(opts.dataDir)} to enroll again`,
    );
  }
  const code = normalizeAddDeviceCode(opts.code);
  if (!code) throw new TypeError('the code has 8 letters and digits, like ABCD-EFGH');
  const hubUrl = plainHttpUrl(opts.hubUrl, 'the Hub URL');
  const backendUrl = plainHttpUrl(opts.backendUrl, 'the backend URL');
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // The owner should not approve a node whose models cannot be served.
  try {
    await new Backend({
      url: backendUrl,
      kind: opts.backendKind ?? 'ollama',
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }).models();
  } catch (err) {
    throw new Error(
      `the model backend at ${backendUrl} did not answer: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  // Over https:// the pin decides which certificates to trust; without one, the system's roots.
  const tls =
    opts.pin !== undefined
      ? new HubTls({ trust: { pin: opts.pin, caPem: null, listed: [] } })
      : null;
  const hub = new HubClient({
    hubUrl,
    fetch: guardedFetch([hubUrl], tls ? tls.fetch(opts.fetch) : opts.fetch),
  });
  const hello = await hub.hello();
  const hubPublicKey = typeof hello.hubPublicKey === 'string' ? hello.hubPublicKey : null;
  let hubFingerprint = typeof hello.hubFingerprint === 'string' ? hello.hubFingerprint : '';
  if (opts.pin !== undefined) {
    // The pin names the key, not a string the Hub reports: the key must hash to it.
    if (!hubPublicKey || hubKeyFingerprint(hubPublicKey) !== opts.pin) {
      throw new Error('this is not your Hub: its key does not match the pin; nothing was sent');
    }
    hubFingerprint = opts.pin;
  }
  const keys = generateKeys();
  const nonce = newAddDeviceNonce();
  const name = (opts.name ?? hostname()).trim().slice(0, 100) || 'compute node';
  const done = await hub.addDeviceComplete({
    ...(opts.pairingId ? { pairingId: opts.pairingId } : {}),
    code,
    publicKey: keys.publicKey,
    name,
    platform: platformName(),
    kind: 'compute',
    commitment: addDeviceCommitment(keys.publicKey, nonce),
  });
  const revealTime = Math.floor(now() / 1000);
  const revealed = await hub.addDeviceReveal(
    { requestId: done.requestId, nonce },
    {
      time: revealTime,
      signature: signAddDeviceReveal(keys.privateKeyPem, done.requestId, revealTime),
    },
  );
  const mine = addDeviceConfirmation({
    hubFingerprint,
    pairingId: done.pairingId,
    publicKey: keys.publicKey,
    code,
    deviceNonce: nonce,
    hubNonce: done.hubNonce,
  });
  if (opts.pin !== undefined) {
    const ok =
      revealed.hubSignature !== null &&
      verifyHubReveal(hubPublicKey!, revealed.hubSignature, {
        requestId: done.requestId,
        pairingId: done.pairingId,
        publicKey: keys.publicKey,
        confirmation: revealed.confirmation,
      });
    if (!ok) throw new Error('this is not your Hub: its signature does not match the pin');
  }
  // A different number means the Hub saw another key or nonce: someone may sit between the two.
  if (mine !== revealed.confirmation) {
    throw new Error(
      `the Hub shows a different confirmation than this node (${formatConfirmation(mine)}); do not approve it`,
    );
  }
  opts.onConfirmation?.(mine);

  const deadline = now() + (opts.timeoutMs ?? 11 * 60_000);
  const interval = Math.max(1, opts.pollIntervalMs ?? 2000);
  let last = 0;
  let token: string | null = null;
  let certificatePem: string | null = null;
  while (!token) {
    if (now() > deadline) throw new Error('nobody approved this node on the Hub in time');
    const t = Math.floor(now() / 1000);
    // Each poll must carry a newer time than the last one the Hub accepted.
    if (t > last) {
      last = t;
      try {
        const s = await hub.addDeviceStatus(done.requestId, {
          time: t,
          signature: signAddDeviceStatus(keys.privateKeyPem, done.requestId, t),
        });
        if (s.status === 'denied') throw new Error('the owner denied this node on the Hub');
        if (s.status === 'expired') throw new Error('the request expired; start Add Device again');
        if (s.status === 'approved') {
          if (s.grant?.type !== 'compute' || !s.grant.enrollToken)
            throw new Error('the Hub approved this node but sent no enrollment token');
          token = s.grant.enrollToken;
          certificatePem =
            typeof s.grant.certificatePem === 'string' &&
            s.grant.certificatePem.startsWith('-----BEGIN CERTIFICATE-----')
              ? s.grant.certificatePem
              : null;
          break;
        }
      } catch (err) {
        // A busy or briefly unreachable Hub is retried until the deadline.
        if (!(err instanceof HubError) || !(err.status === 0 || err.status === 429)) throw err;
      }
    }
    await sleep(interval);
  }
  return enroll({
    ...opts,
    token,
    keys,
    certificatePem,
    ...(tls ? { trust: tls.trust } : {}),
  });
}
