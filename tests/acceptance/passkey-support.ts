// Test passkeys (Insertion #3 T2): tier 3 on Nova's own screen is approved with a passkey, so tests
// that act as that screen sign like it. One P-256 key per test process, two credentials enrolled
// for it (the first on trust, the second approved by the first), signing as a page opened at
// localhost would. The server checks every signature for real; nothing here relaxes it.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

type Send = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;

const pk = generateKeyPairSync('ec', { namedCurve: 'P-256' });
export const PASSKEY = {
  jwk: pk.privateKey.export({ format: 'jwk' }),
  spki: pk.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  ids: [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')],
  // Signature counters only go up: milliseconds since this process began, shared with the browser's.
  base: Date.now(),
};
const rpHash = () => createHash('sha256').update('localhost').digest();
export const consoleOrigin = (base: string) => base.replace('//127.0.0.1', '//localhost');
// Where the test passkeys were added. In a real mesh every console is http://localhost:4317 on its
// own machine; tests run nodes on one machine, so a node that got the passkeys by replication (a
// standby) is signed for as the address they were added at.
const enrolledAt = new Set<string>();
let lastEnrolled: string | null = null;
const signingOrigin = (base: string) => (enrolledAt.has(consoleOrigin(base)) || !lastEnrolled ? consoleOrigin(base) : lastEnrolled);

// An approval of challenge `c`, as the browser's passkey step sends it.
export function assertion(c: { id: string; digest: string; challenge: string }, origin: string, credential = PASSKEY.ids[0]!) {
  const n = Buffer.alloc(4); n.writeUInt32BE(Date.now() - PASSKEY.base + 2);
  const auth = Buffer.concat([rpHash(), Buffer.from([0x05]), n]);
  const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: c.challenge, origin }));
  const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(cdj).digest()]), pk.privateKey);
  return { id: c.id, digest: c.digest, credential_id: credential, authenticator_data: auth.toString('base64url'), client_data_json: cdj.toString('base64url'), signature: signature.toString('base64url') };
}

// The two test passkeys, enrolled as the person would on Nova's own screen at localhost.
export async function enrollPasskeys(send: Send, base: string) {
  const origin = consoleOrigin(base);
  const h = { 'x-nova': '1', origin };
  for (const [i, id] of PASSKEY.ids.entries()) {
    const o = (await send('POST', '/api/v1/security/passkeys/options', {}, h)).body;
    const cred = Buffer.from(id, 'base64url');
    const len = Buffer.alloc(2); len.writeUInt16BE(cred.length);
    const auth = Buffer.concat([rpHash(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, cred, Buffer.from([0xa0])]);
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: o.challenge, origin }));
    const r = await send('POST', '/api/v1/security/passkeys', { registration: o.registration, credential_id: id, public_key: PASSKEY.spki, authenticator_data: auth.toString('base64url'), client_data_json: cdj.toString('base64url'), name: `Test passkey ${i + 1}`, ...(o.approval ? { approval: assertion(o.approval, origin) } : {}) }, h);
    if (r.status !== 201) throw new Error(`enrolling a test passkey failed: ${JSON.stringify(r.body)}`);
  }
  enrolledAt.add(origin);
  lastEnrolled = origin;
}

// What the screen's passkey step does before a request with confirm: true: nothing where it
// doesn't apply (a paired device, or a body that already says what it carries), the two test
// passkeys when there are none yet, then an approval of exactly this request.
export async function withPasskey(send: Send, base: string, method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const b = body as Record<string, unknown> | undefined;
  if (!b || b.confirm !== true || 'passkey_approval' in b || !path.startsWith('/api/v1/') || /^\/api\/v1\/changes\/[^/]+\/rollback$/.test(path.split('?')[0]!)) return body;
  const state = await send('GET', '/api/v1/security/passkeys', undefined, headers);
  if (state.status !== 200) return body;
  if (!state.body.count) await enrollPasskeys(send, base);
  const c = await send('POST', '/api/v1/security/approvals', { method, path: path.slice('/api/v1'.length).split('?')[0], body: b }, { 'x-nova': '1', ...headers });
  if (c.status !== 200) throw new Error(`a test passkey approval failed: ${JSON.stringify(c.body)}`);
  return { ...b, passkey_approval: assertion(c.body, signingOrigin(base)) };
}
