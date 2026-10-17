// Hashing for the audit chain and input hashes (docs/12 §11, FR-104). The canonical JSON form is
// the one compute-node signatures already use (nodes/crypto.ts): keys sorted, no whitespace.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../nodes/crypto.ts';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The audit `input_hash` of a tool call's arguments or any other input; never the input itself.
 * The value is first normalised through JSON, so `undefined` members and dates hash as JSON would.
 */
export function auditInputHash(input: unknown): string {
  const json = JSON.stringify(input ?? null) as string | undefined;
  return sha256Hex(canonicalJson(JSON.parse(json ?? 'null')));
}
