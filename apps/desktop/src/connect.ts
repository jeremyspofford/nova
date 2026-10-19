// Connecting the shell to its Hub (FR-134, docs/22 §5). The address and the pin come from Add Device
// (the deep link, the Hub's QR link) or are typed on first run. The Hub is verified with a fresh
// nonce before any credential, code or cookie reaches it; a refusal sends nothing and says why.
import { randomBytes } from 'node:crypto';
import { shellIdentityStatementSchema, type HubIdentityStatement } from '@nova/shared';
import { hubOriginOf, joinTarget, routeDeepLink } from './deeplinks.ts';
import { checkStatement, pinnedTrust, verifyHubIdentity, type PinnedTrust } from './pinning.ts';
import { isLoopbackHost, probeIdentity, type IdentityProbe } from './probe.ts';

const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;

export type ConnectRefusal =
  | 'invalid_input'
  | 'insecure_transport'
  | 'unreachable'
  | 'identity_unavailable'
  | 'bad_response'
  | 'untrusted_certificate'
  | 'pin_mismatch'
  | 'bad_signature'
  | 'nonce_mismatch'
  | 'no_certificate'
  | 'not_listed'
  | 'not_server_certificate'
  | 'host_mismatch'
  | 'expired';

/** How later connections to the Hub are checked. */
export type HubTrust =
  | PinnedTrust
  /** The owner turned pinning off: the platform's trust store decides (docs/22 §5 step 5). */
  | { kind: 'platform'; host: string }
  /** This computer's own Hub over plain HTTP: the statement was checked, there is no TLS. */
  | { kind: 'loopback-http'; host: string };

export interface ConnectOk {
  ok: true;
  origin: string;
  pin: string;
  trust: HubTrust;
  /** The join page to open first (an Add Device link), else null. */
  joinPath: string | null;
}

export interface ConnectFail {
  ok: false;
  reason: ConnectRefusal;
  message: string;
  origin: string | null;
}

export interface ConnectTarget {
  /** The Hub's address first, then the other endpoints an Add Device link lists. */
  origins: string[];
  pin: string;
  joinPath: string | null;
}

export interface ConnectDeps {
  probe?: (origin: string, nonce: string) => Promise<IdentityProbe>;
  nonce?: () => string;
  now?: () => Date;
}

const fail = (reason: ConnectRefusal, origin: string | null, detail?: string): ConnectFail => ({
  ok: false,
  reason,
  message: refusalMessage(reason, origin, detail),
  origin,
});

/** The sentence the shell shows for a refusal. Every refusal says that nothing was sent. */
export function refusalMessage(
  reason: ConnectRefusal,
  origin: string | null,
  detail?: string,
): string {
  const at = origin ?? 'the Hub';
  switch (reason) {
    case 'invalid_input':
      return detail ?? 'Paste the Add Device link, or enter the Hub address and its fingerprint.';
    case 'insecure_transport':
      return `${at} serves plain HTTP, which the app uses only for a Hub on this computer. Turn on HTTPS on the Hub (Network, Trust), then add this computer again.`;
    case 'unreachable':
      return `Cannot reach ${at}${detail ? ` (${detail})` : ''}. Check the address and that the Hub is running.`;
    case 'identity_unavailable':
      return `${at} cannot prove its identity right now (its identity key is not available). Check Network, Trust on the Hub. Nothing was sent to it.`;
    case 'bad_response':
      return `${at} did not answer with a Hub identity statement. Nothing was sent to it.`;
    case 'untrusted_certificate':
      return `The certificate of ${at} is not trusted by this computer, and the Hub does not ask apps to pin it. Nothing was sent to it.`;
    case 'pin_mismatch':
      return `This is not the Hub you added: its identity does not match the fingerprint. Nothing was sent to it.`;
    case 'bad_signature':
    case 'nonce_mismatch':
      return `The identity statement of ${at} did not verify, so the connection may have been tampered with. Nothing was sent to it.`;
    case 'no_certificate':
    case 'not_listed':
    case 'not_server_certificate':
    case 'host_mismatch':
      return `The certificate ${at} presented is not one its identity vouches for, so the connection may have been intercepted. Nothing was sent to it.`;
    case 'expired':
      return `The certificate of ${at} has expired. Renew it on the Hub (Network, Trust). Nothing was sent to it.`;
  }
}

/** A Hub address as typed: `hub.local:7443` means https; only the origin is kept. */
export function normalizeHubUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > 2000) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  return hubOriginOf(withScheme);
}

/** A fingerprint as typed or pasted: spaces and line breaks are ignored. */
export function normalizePin(raw: string): string | null {
  const pin = raw.replace(/\s+/g, '');
  return FINGERPRINT.test(pin) ? pin : null;
}

/** What to connect to, from an Add Device link or a typed address and fingerprint. */
export function parseConnectInput(input: {
  link?: string | undefined;
  url?: string | undefined;
  pin?: string | undefined;
}): ConnectTarget | ConnectFail {
  const link = input.link?.trim();
  if (link) {
    let target = /^(web\+)?nova:/i.test(link) ? routeDeepLink(link) : null;
    if (!target && /^https?:\/\//i.test(link)) {
      try {
        const u = new URL(link);
        if (u.pathname === '/add-device')
          target = joinTarget(u.origin, u.searchParams, u.hash.replace(/^#/, ''));
      } catch {
        target = null;
      }
    }
    if (!target || target.kind !== 'add-device')
      return fail('invalid_input', null, 'That is not an Add Device link.');
    if (!target.hubUrl) return fail('invalid_input', null, 'The link does not name a Hub.');
    // Without a fingerprint there is nothing to verify the Hub against, so nothing is sent.
    if (!target.pin)
      return fail(
        'invalid_input',
        target.hubUrl,
        'The link carries no Hub fingerprint, so the app cannot check the Hub. Enter the fingerprint the Hub shows under Network, Trust.',
      );
    return {
      origins: [target.hubUrl, ...target.endpoints.filter((e) => e !== target.hubUrl)],
      pin: target.pin,
      joinPath: target.path,
    };
  }
  const origin = normalizeHubUrl(input.url ?? '');
  if (!origin)
    return fail('invalid_input', null, 'Enter the Hub address, like https://hub.local:7443.');
  const pin = normalizePin(input.pin ?? '');
  if (!pin)
    return fail(
      'invalid_input',
      origin,
      'Enter the Hub fingerprint: 43 letters, digits, - and _, shown on the Hub under Network, Trust.',
    );
  return { origins: [origin], pin, joinPath: null };
}

/** Verify one address of the Hub against the pin (docs/22 §5 steps 2-6). */
export async function verifyHub(
  origin: string,
  pin: string,
  deps: ConnectDeps = {},
): Promise<ConnectOk | ConnectFail> {
  const url = new URL(origin);
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname))
    return fail('insecure_transport', origin);
  // At least 128 bits, fresh for every check (step 3).
  const nonce = (deps.nonce ?? (() => randomBytes(24).toString('base64url')))();
  let probe: IdentityProbe;
  try {
    probe = await (deps.probe ?? probeIdentity)(origin, nonce);
  } catch (err) {
    return fail('unreachable', origin, err instanceof Error ? err.message : String(err));
  }
  if (probe.status === 409) return fail('identity_unavailable', origin);
  if (probe.status !== 200) return fail('bad_response', origin, `HTTP ${probe.status}`);
  const parsed = shellIdentityStatementSchema.safeParse(probe.body);
  if (!parsed.success) return fail('bad_response', origin);
  const statement: HubIdentityStatement = parsed.data;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'http:') {
    const bad = checkStatement(statement, pin, nonce);
    return bad
      ? fail(bad, origin)
      : { ok: true, origin, pin, trust: { kind: 'loopback-http', host }, joinPath: null };
  }
  const check = verifyHubIdentity({
    statement,
    pin,
    nonce,
    host,
    chain: probe.chain,
    now: (deps.now ?? (() => new Date()))(),
  });
  if (check.result === 'refused') return fail(check.reason, origin);
  if (check.result === 'use_platform_roots')
    return probe.platformTrusted
      ? { ok: true, origin, pin, trust: { kind: 'platform', host }, joinPath: null }
      : fail('untrusted_certificate', origin);
  return {
    ok: true,
    origin,
    pin,
    trust: pinnedTrust(statement, probe.chain, host),
    joinPath: null,
  };
}

/**
 * Connect to the first address that verifies. Only an unreachable address moves on to the next
 * one; any other refusal (a wrong identity above all) stops at once.
 */
export async function connectHub(
  target: ConnectTarget,
  deps: ConnectDeps = {},
): Promise<ConnectOk | ConnectFail> {
  let first: ConnectFail | null = null;
  for (const origin of target.origins) {
    const res = await verifyHub(origin, target.pin, deps);
    if (res.ok) return { ...res, joinPath: target.joinPath };
    if (res.reason !== 'unreachable') return res;
    first ??= res;
  }
  return first ?? fail('invalid_input', null);
}

/** What connecting to `target` would replace, when it is another Hub (another identity). */
export interface Replacement {
  current: string;
  next: string;
  fingerprint: string;
}

/**
 * Another Hub replaces the current one only after an explicit confirmation naming both (any
 * page can send an Add Device link): its windows close and its data on this computer goes.
 */
export function replacementOf(
  current: { url: string; pin: string } | null,
  target: ConnectTarget,
): Replacement | null {
  if (!current || current.pin === target.pin) return null;
  return { current: current.url, next: target.origins[0] ?? '', fingerprint: target.pin };
}

export function replacementMessage(r: Replacement): string {
  return `This replaces ${r.current} with another Hub, ${r.next} (fingerprint ${r.fingerprint}). Nova closes the current Hub's windows and deletes its data on this computer.`;
}
