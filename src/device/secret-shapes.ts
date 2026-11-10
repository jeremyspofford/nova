// Secret-shaped strings, wherever they are: a bearer or basic credential, a user:password in a URL,
// a JWT, the common API key and token shapes, a key=value whose key names a secret, a vault
// reference. The one list the diagnostics bundle and a device's own words are both scrubbed with.
// It lives with the device agent because the agent ships only src/device (mesh/agent.ts) and must
// scrub what its workloads wrote before any of it leaves the device; the hub imports it from here.
// No imports: the agent's bundle carries this file alone.

export const SHAPES: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 \u0000'],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1\u0000@'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '\u0000'],
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, '\u0000'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{12,}|\bgh[pousr]_[A-Za-z0-9]{12,}|\bglpat-[A-Za-z0-9_-]{12,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{12,}|\bAIza[0-9A-Za-z_-]{30,}/g, '\u0000'],
  [/\b((?:access_|refresh_|id_)?token|api[_-]?key|key|secret|password|code|sig|signature)=([^&\s"'<>]+)/gi, '$1=\u0000'],
  // "password: hunter2" in a program's error output; only the names that are always secrets.
  [/\b((?:access_|refresh_|id_)?token|api[_-]?key|secret|password|passwd)(\s*:\s*)([^\s"'<>,;]+)/gi, '$1$2\u0000'],
  [/secret:\/\/[A-Za-z0-9_./-]+/g, '\u0000'],
];

// `text` with every secret shape replaced by `marker`; `hit` hears of each one.
export function redactShapes(text: string, marker = '[redacted]', hit?: () => void): string {
  let out = text;
  for (const [re, to] of SHAPES) {
    out = out.replace(re, (...m) => {
      hit?.();
      let s = to;
      for (let i = 1; i <= 3; i++) s = s.replace(`$${i}`, typeof m[i] === 'string' ? m[i] : '');
      return s.replace('\u0000', marker);
    });
  }
  return out;
}
