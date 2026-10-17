// The per-Hub data key that encrypts blobs at rest (FR-149 baseline). It lives in the secret
// store like any credential (vault or OS keychain), never in the database or on disk in clear.
import { randomBytes } from 'node:crypto';
import { NovaError } from '@nova/shared';
import type { SecretStore } from '@nova/secrets';

export const DATA_KEY_REF = 'secret://hub/data-key';

/** The Hub's 32-byte data key, created on first use. A damaged key fails closed. */
export async function loadDataKey(secrets: SecretStore): Promise<Buffer> {
  const stored = await secrets.get(DATA_KEY_REF);
  if (stored !== null) {
    const key = Buffer.from(stored, 'base64');
    if (key.length !== 32 || key.toString('base64') !== stored)
      throw new NovaError('server_error', 'the Hub data key in the secret store is damaged');
    return key;
  }
  const key = randomBytes(32);
  await secrets.put(DATA_KEY_REF, key.toString('base64'));
  return key;
}
