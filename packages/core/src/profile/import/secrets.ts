// Finding secrets in imported configuration (FR-200, docs/08 §4.2 rule 3, docs/12 §5): values
// under names such as *TOKEN*, *KEY*, *SECRET*, *PASSWORD* and auth headers, and values that
// match the redactor's known token shapes. Found values move to the vault on apply; the preview
// only ever shows them masked.
import { DEFAULT_RULES } from '@nova/security';

const SECRET_WORDS = new Set([
  'token',
  'tokens',
  'key',
  'apikey',
  'secret',
  'secrets',
  'password',
  'passwd',
  'pwd',
  'pass',
  'passphrase',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'cookie',
  'session',
  'bearer',
  'private',
  'pat',
]);

const TOKEN_RULES = DEFAULT_RULES.filter((r) => r.scan === 'token');

/** Words of a name: `GITHUB_TOKEN`, `X-Api-Key`, `apiKey` → github token / x api key / api key. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether a variable, header, flag or parameter name holds a credential. */
export function isSecretName(name: string): boolean {
  return words(name).some((w) => SECRET_WORDS.has(w));
}

/** Whether a value has the shape of a known token (provider keys, PATs, JWTs, private keys). */
export function looksLikeToken(value: string): boolean {
  return TOKEN_RULES.some((r) => {
    r.pattern.lastIndex = 0;
    return r.pattern.test(value);
  });
}

/**
 * A value that points at a secret instead of holding one: an environment interpolation
 * (`${NAME}`, `$NAME`, `${env:NAME}`), a vault reference or an obvious placeholder.
 */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return (
    v === '' ||
    v.startsWith('secret://') ||
    /^\$\{[^}]+\}$/.test(v) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v) ||
    /^<[^>]+>$/.test(v) ||
    /^(your[-_ ]|changeme|xxx+$)/i.test(v)
  );
}

/** A secret under this name, or with this value, that should move to the vault. */
export function isSecret(name: string, value: string): boolean {
  if (isPlaceholder(value)) return false;
  return isSecretName(name) || looksLikeToken(value);
}

/** Distinct token-shaped values in free text (instruction files, project prompts). */
export function findTextSecrets(text: string): string[] {
  const found = new Set<string>();
  for (const r of TOKEN_RULES) {
    r.pattern.lastIndex = 0;
    for (const m of text.matchAll(r.pattern)) if (m[0].length >= 8) found.add(m[0]);
  }
  // Longest first, so a value inside a longer one is replaced with it.
  return [...found].sort((a, b) => b.length - a.length);
}

/** Never more than two leading characters; short values are fully masked. */
export function maskSecret(value: string): string {
  return value.length >= 12 ? `${value.slice(0, 2)}…••••` : '••••';
}
