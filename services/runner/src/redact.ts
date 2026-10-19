// Redaction for what the runner reports back (contracts/rest-api.md §5: logs are redacted): the
// setup log tail, command lines in run views and repository URLs. A best-effort pass over common
// credential shapes; command output itself is returned as it is, to the Hub that owns it, which
// redacts again before anything reaches a person or a model.

const PATTERNS: [RegExp, string][] = [
  // Private key blocks.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[redacted private key]',
  ],
  // Credentials in URLs: scheme://user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[redacted]@'],
  // Authorization headers and bearer tokens.
  [/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s"']+/gi, '$1[redacted]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  // Well-known token prefixes.
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted token]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[redacted token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted token]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted key]'],
  [/\bnvrun_[A-Za-z0-9_-]{20,}\b/g, '[redacted token]'],
  // key=value pairs whose key names a secret.
  [
    /\b((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"']+)/gi,
    '$1[redacted]',
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, by] of PATTERNS) out = out.replace(re, by);
  return out;
}

/** A repository URL without its user information (the full URL stays in the environment). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    return redact(url);
  }
}
