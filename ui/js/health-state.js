// Readiness is distinct from liveness: optional or unchecked work is not verified.
export function checkState(name, c) {
  if (!c || c.ok === false) return 'Needs a look';
  if (name === 'passkeys' && !c.complete) return 'Needs setup';
  if (name === 'mesh' && (c.standby?.lag?.behind || c.replica?.sync?.unreachable_since || c.replica?.sync?.refused)) return 'Needs a look';
  if (c.available === null) return 'Not checked';
  if (c.available === false || c.configured === false) return 'Not configured';
  if (name === 'ingest' && c.model === false) return 'Limited';
  return 'Fine';
}

export const checkAction = (name) => ({
  passkeys: { href: '/settings#security', label: 'Set up passkeys' },
  ingest: { href: '/settings#models', label: 'Set up screening' },
  backups: { href: '/settings#backups', label: 'Set up backups' },
})[name] ?? null;
