// Which secret store the Hub uses (FR-101, docs/12 §5), chosen at startup by NOVA_SECRETS:
// `vault` (default) is the encrypted file vault; `keychain` uses the OS keychain and falls back
// to the vault with a warning when none is reachable (a headless Hub usually has no session
// bus). Switching to the keychain moves the vault's secrets into it.
import { KeychainStore, platformKeychain, type KeychainBackend } from './keychain.ts';
import { FileVault, type SecretStore, type VaultKey } from './vault.ts';
import type { Redactor } from '@nova/security';

export const SECRETS_MODES = ['vault', 'keychain'] as const;
export type SecretsMode = (typeof SECRETS_MODES)[number];

export interface OpenSecretStoreOptions {
  mode: SecretsMode;
  vaultPath: string;
  vaultKey: VaultKey;
  /** The keychain to try; defaults to this platform's (null: none). */
  keychain?: KeychainBackend | null;
  redactor?: Redactor;
}

export interface OpenedSecretStore {
  store: SecretStore;
  /** Secrets moved from the vault into the keychain on this start. */
  migrated: number;
  /** Something the operator should know (logged at startup, shown in Diagnostics). */
  warning: string | null;
}

export async function openSecretStore(opts: OpenSecretStoreOptions): Promise<OpenedSecretStore> {
  const vault = (warning: string | null) =>
    new FileVault(opts.vaultPath, opts.vaultKey, opts.redactor, { warning });
  if (opts.mode === 'vault') return { store: vault(null), migrated: 0, warning: null };

  const backend = opts.keychain === undefined ? platformKeychain() : opts.keychain;
  const probe = backend
    ? await backend.available()
    : { ok: false, detail: 'none on this platform' };
  if (!backend || !probe.ok) {
    const warning = `The OS keychain is unavailable (${probe.detail}); secrets stay in the encrypted vault.`;
    return { store: vault(warning), migrated: 0, warning };
  }
  const store = new KeychainStore(backend, opts.redactor);
  try {
    return { store, migrated: await moveVaultInto(vault(null), store), warning: null };
  } catch (err) {
    // The keychain works; a vault that cannot be read is reported, never silently dropped.
    const why = err instanceof Error ? err.message : String(err);
    return {
      store,
      migrated: 0,
      warning: `Secrets in the encrypted vault could not be moved to the OS keychain: ${why}`,
    };
  }
}

/** Copy each vault secret into the keychain, read it back, then remove it from the vault. */
async function moveVaultInto(from: FileVault, to: SecretStore): Promise<number> {
  if (!from.exists()) return 0;
  let moved = 0;
  for (const ref of await from.list()) {
    const value = (await from.get(ref)) ?? '';
    await to.put(ref, value);
    if ((await to.get(ref)) !== value)
      throw new Error(`${ref} did not read back from the keychain`);
    await from.delete(ref);
    moved++;
  }
  return moved;
}
