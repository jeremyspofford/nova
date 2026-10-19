// secret-scan: fake-file (every credential below is a made-up fixture)
// Every redaction rule stays linear on hostile input (M7 browser review finding 1): redaction runs
// on the event loop over untrusted text (a page's console, its URLs, headers and bodies), and one
// rule that rescans the text from every start freezes the Hub. Each rule runs alone over inputs
// built to defeat it, at the capture caps and at 1-2 MB, and must finish well under 50 ms.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, REDACTED, Redactor } from '../src/redact.ts';

const FAMILIES: Record<string, string | ((n: number) => string)> = {
  'BEGIN markers without an END': '-----BEGIN PRIVATE KEY-----',
  'a BEGIN then a long header run': (n) => `-----BEGIN ${'A'.repeat(n)}`,
  'bare BEGIN prefixes': '-----BEGIN ',
  'END markers': '-----END PRIVATE KEY-----',
  'dotted run': 'a.',
  'dotted, dashed run': 'a.b-',
  'scheme-like run': 'ab+cd-ef.',
  'repeated ://': 'a://',
  'a scheme then a long user': (n) => `x://${'b'.repeat(n)}`,
  'a scheme, user, then a long secret': (n) => `x://u:${'p'.repeat(n)}`,
  'eyJ then a dash': 'eyJ-',
  'a dash then eyJ': '-eyJ',
  'eyJ then a long run': (n) => `eyJ${'a'.repeat(n)}`,
  'short JWT segments': 'eyJaaaaaaaaa.aaaaaaa.',
  'provider prefixes': 'sk-',
  'provider groups': 'sk-a-',
  'GitHub prefix, then an underscore': (n) => `ghp_${'a'.repeat(n)}_`,
  'chat prefixes': 'xoxb-',
  'mail key dashes': (n) => `SG.${'a-'.repeat(n / 2)}`,
  'mail key dots': 'SG.',
  'an unclosed quoted password': (n) => `password="${'a'.repeat(n)}`,
  'mixed quotes': `password:"aa password:'aa `,
  'repeated quoted keys': `api_key = '`,
  'a token, then spaces': (n) => `token${' '.repeat(n)}`,
  'a header name, then spaces': (n) => `authorization:${' '.repeat(n)}`,
  'repeated cookie=': 'cookie=',
  'a base64 run': 'AbC+/9=',
  'nova prefixes': 'nvs_-',
  newlines: '\n',
};

function input(family: string | ((n: number) => string), n: number): string {
  if (typeof family === 'function') return family(n).slice(0, n + 16);
  return family.repeat(Math.ceil(n / family.length)).slice(0, n);
}

/** The best of two runs (a GC pause is not the regex). */
function ms(r: Redactor, text: string): number {
  let best = Infinity;
  for (let i = 0; i < 2; i++) {
    const t0 = performance.now();
    r.redactString(text);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('every rule is linear on hostile input', () => {
  // The capture caps (console text, URLs, header values, bodies), then 1 and 2 MB.
  for (const size of [2_000, 4_000, 16_384, 1_000_000, 2_000_000]) {
    it(`finishes well under 50 ms at ${size} characters`, () => {
      const slow: string[] = [];
      for (const rule of DEFAULT_RULES) {
        const r = new Redactor([rule]);
        for (const [name, family] of Object.entries(FAMILIES)) {
          const t = ms(r, input(family, size));
          if (t >= 50) slow.push(`${rule.id} on ${name}: ${t.toFixed(0)} ms`);
        }
      }
      expect(slow).toEqual([]);
    }, 120_000);
  }

  it('still masks what the bounded rules are for', () => {
    const r = new Redactor();
    // secret-scan: fake
    const key = `-----BEGIN PRIVATE KEY-----\n${'QUJD'.repeat(800)}\n-----END PRIVATE KEY-----`;
    expect(r.redactString(`a ${key} b`)).toBe(`a ${REDACTED} b`);
    // A key and a certificate after it: the match stops at the key's END.
    const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(r.redactString(`${key}\n${cert}`)).toBe(`${REDACTED}\n${cert}`);
    // A body over 16 KiB is no longer one match; the truncated-key rule still masks its head.
    const huge = `-----BEGIN PRIVATE KEY-----\n${'QUJD'.repeat(5_000)}\n-----END PRIVATE KEY-----`;
    expect(r.redactString(huge)).not.toContain('QUJD');
    for (const url of ['https://ada:pw-123@x.example/p', 'see foo.https://ada:pw-123@x.example']) {
      expect(r.redactString(url)).toContain(`:ada:${REDACTED}@`.slice(1));
      expect(r.redactString(url)).not.toContain('pw-123');
    }
    // secret-scan: fake
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P';
    expect(r.redactString(`Bearer: (${jwt})`)).toBe(`Bearer: (${REDACTED})`);
    expect(r.redactString('key sk-ant-api03-abcdefghijklmnopqrstuv end')).toBe(
      `key ${REDACTED} end`,
    );
    expect(r.redactString(`password = "a'b c"`)).toBe(`password = "${REDACTED}"`);
  });
});
