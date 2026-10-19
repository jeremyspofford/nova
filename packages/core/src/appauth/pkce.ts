// PKCE (RFC 7636) with S256 only (ADR-097 D6): `plain` is refused, so an intercepted
// authorization request never reveals the verifier.
import { createHash, timingSafeEqual } from 'node:crypto';

/** A code verifier: 43-128 unreserved characters (RFC 7636 §4.1). */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge: BASE64URL of a SHA-256, 43 characters without padding (§4.2). */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isCodeVerifier(v: string): boolean {
  return VERIFIER.test(v);
}

export function isS256Challenge(v: string): boolean {
  return CHALLENGE.test(v);
}

/** BASE64URL(SHA-256(ASCII(verifier))). */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Whether the verifier matches the challenge, compared in constant time. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!isCodeVerifier(verifier) || !isS256Challenge(challenge)) return false;
  const a = Buffer.from(s256Challenge(verifier), 'ascii');
  const b = Buffer.from(challenge, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}
