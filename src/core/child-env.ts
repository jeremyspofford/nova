// Ambient parent data is untrusted: copy only these finite, public process settings.
// Never forward whole prefixes (even LC_ or XDG_), authentication, session identity,
// runtime injection options, or shell startup selectors. Adding a name needs review.
const PUBLIC_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES',
  'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'TZ',
  'TERM', 'COLORTERM', 'NO_COLOR',
];

export function inheritedChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PUBLIC_ENV) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
