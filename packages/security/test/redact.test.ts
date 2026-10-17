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
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'eyJhbGci',
    ],
  ])('masks a %s', (_name, input, secret) => {
    const out = r.redactString(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
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
