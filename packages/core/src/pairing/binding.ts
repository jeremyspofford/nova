// An enrollment token handed out by Add Device is bound to the device's key and to the device
// record the approval created (FR-132, ADR-094): `/agent/v1/register` and `/node/v1/register` must
// present the same key, and they activate that record instead of creating another. The binding
// rides in the `scopes` JSON of the token's `add_device_request` row (0005).

export interface EnrollKeyBinding {
  /** Raw Ed25519 public key, base64url. */
  publicKey: string;
  /** The pending device record approval created. */
  deviceId: string;
}

/** The binding stored with an enrollment token, or null for an unbound (owner-created) token. */
export function enrollBindingOf(scopes: string | null | undefined): EnrollKeyBinding | null {
  if (!scopes) return null;
  try {
    const v = JSON.parse(scopes) as { bind?: { publicKey?: unknown; deviceId?: unknown } } | null;
    const b = v?.bind;
    return b && typeof b.publicKey === 'string' && typeof b.deviceId === 'string'
      ? { publicKey: b.publicKey, deviceId: b.deviceId }
      : null;
  } catch {
    return null;
  }
}
