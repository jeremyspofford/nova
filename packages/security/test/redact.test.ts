import { describe, expect, it } from 'vitest';
import { REDACTED, Redactor, defaultRedactor } from '../src/redact.ts';

const r = defaultRedactor;

describe('redactString', () => {
  it.each([
    [
      'provider key',
      'key sk-proj-abcdefghijklmnopqrstuvwx1234 used',
      'sk-proj-abcdefghijklmnopqrstuvwx1234',
    ],
    [
      'github token',
      'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    ],
    ['chat token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
    ['aws key', 'AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    [
      'jwt',
      // secret-scan: fake
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'eyJhbGci',
    ],
  ])('masks a %s', (_name, input, secret) => {
    const out = r.redactString(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  // Every Nova token prefix (redact.ts `nova-token`), the PXE boot token `nvb_` and the extension
  // bridge token `nvbr_` included; a bare prefix or a short value is not a token.
  it.each([
    'nvs',
    'nvx',
    'nvd',
    'nvm',
    'nva',
    'nve',
    'nvb',
    'nvbr',
    'nvc',
    'nvn',
    'nvdm',
    'nvi',
    'nvr',
    'nvlr',
  ])('masks a Nova %s_ token', (prefix) => {
    const token = `${prefix}_Q2xhdWRlIHdhcyBoZXJlIDIwMjYtMTAtMTkK-x_y`;
    const out = r.redactString(`hello ${token} there`);
    expect(out).toBe(`hello ${REDACTED} there`);
  });

  it('leaves Nova-like words that are not tokens alone', () => {
    for (const text of [
      'nvbr_short',
      'nvq_Q2xhdWRlIHdhcyBoZXJlIDIwMjYtMTAtMTkK',
      'xnvbr_Q2xhdWRlIHdhcyBoZXJl',
    ])
      expect(r.redactString(text)).toBe(text);
  });

  it('keeps the label of bearer and header values', () => {
    expect(r.redactString('Authorization: Bearer abcdefghijklmnop123')).toBe(
      `Authorization: ${REDACTED}`,
    );
    expect(r.redactString('bearer abcdefghijklmnop123 trailing')).toBe(
      `bearer ${REDACTED} trailing`,
    );
  });

  it('masks passwords in URLs and assignments', () => {
    expect(r.redactString('postgres://nova:hunter2@db:5432/x')).toBe(
      `postgres://nova:${REDACTED}@db:5432/x`,
    );
    expect(r.redactString('password="correct horse"')).toBe(`password="${REDACTED}"`);
    expect(r.redactString("secret: 'a b c' next")).toBe(`secret: '${REDACTED}' next`);
    expect(r.redactString('api_key: 12345678')).toBe(`api_key: ${REDACTED}`);
  });

  it('masks PEM private keys', () => {
    // secret-scan: fake
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(r.redactString(`x ${pem} y`)).toBe(`x ${REDACTED} y`);
  });

  it('leaves ordinary text alone', () => {
    const text = 'The skipped tests are in src/tasks, see token count 1200.';
    expect(r.redactString(text)).toBe(text);
  });

  it('masks registered literals everywhere', () => {
    const red = new Redactor();
    red.addLiteral('s3cr3t-value');
    red.addLiteral('ab'); // too short, ignored
    expect(red.redactString('a s3cr3t-value b s3cr3t-value')).toBe(`a ${REDACTED} b ${REDACTED}`);
    expect(red.redactString('ab')).toBe('ab');
  });

  it('masks short literals when allowed, the longest first, and inherits literals', () => {
    const parent = new Redactor([]);
    parent.addLiteral('global-secret-1');
    const red = new Redactor([], { literalsFrom: parent });
    red.addLiteral('ab', { minLength: 1 });
    red.addLiteral('ab', { minLength: 1 }); // registered once
    red.addLiteral('', { minLength: 0 }); // never an empty literal
    red.addLiteral('ab%21cd', { minLength: 1 });
    expect(red.redactString('x ab y ab%21cd z global-secret-1')).toBe(
      `x ${REDACTED} y ${REDACTED} z ${REDACTED}`,
    );
    // A literal added to the parent later still applies.
    parent.addLiteral('later-secret');
    expect(red.redactString('later-secret')).toBe(REDACTED);
    // Literals only: the patterns are not run again over already-masked text.
    expect(red.redactLiterals('token=[REDACTED]&page=2 later-secret')).toBe(
      `token=[REDACTED]&page=2 ${REDACTED}`,
    );
    expect(parent.redactString('ab')).toBe('ab');
  });

  it('keeps a custom secret rule without a pre group on the callback path', () => {
    const red = new Redactor([{ id: 'pin', pattern: /pin (?<secret>\d{4})/g, group: 'secret' }]);
    expect(red.redactString('pin 1234 ok')).toBe(`pin ${REDACTED} ok`);
    const empty = new Redactor([{ id: 'opt', pattern: /x(?<secret>\d)?/g, group: 'secret' }]);
    expect(empty.redactString('ax')).toBe(`a${REDACTED}`);
  });

  it('rejects non-global custom rules', () => {
    expect(() => new Redactor([{ id: 'x', pattern: /x/ }])).toThrow(/g flag/);
    expect(() => new Redactor().addRule({ id: 'y', pattern: /y/ })).toThrow(/g flag/);
    const red = new Redactor([]);
    red.addRule({ id: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g });
    expect(red.redactString('id 123-45-6789')).toBe(`id ${REDACTED}`);
  });
});

describe('redact (deep)', () => {
  it('masks secret-named keys and nested strings', () => {
    const out = r.redact({
      headers: { authorization: 'Basic abc', accept: 'json' },
      nested: [{ password: 'x' }, 'sk-ant-api03-abcdefghijklmnopqrstuv'],
      empty: { token: '' },
      n: 3,
      flag: true,
      nothing: null,
    });
    expect(out).toEqual({
      headers: { authorization: REDACTED, accept: 'json' },
      nested: [{ password: REDACTED }, REDACTED],
      empty: { token: '' },
      n: 3,
      flag: true,
      nothing: null,
    });
  });

  it('turns errors into redacted plain objects and caps depth', () => {
    expect(r.redact(new Error('failed with sk-abcdefghijklmnopqrstu'))).toEqual({
      name: 'Error',
      message: `failed with ${REDACTED}`,
    });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(JSON.stringify(r.redact(deep))).toContain(REDACTED);
  });
});
