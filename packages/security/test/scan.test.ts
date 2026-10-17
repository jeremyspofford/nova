// Real-looking values are assembled at run time so this file never trips the scan it tests.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FAKE_FILE_MARKER,
  FAKE_MARKER,
  isConfigFile,
  isPlainLiteral,
  looksFake,
  scanText,
} from '../src/scan.ts';
import { REDACTED, defaultRedactor } from '../src/redact.ts';

const join2 = (...parts: string[]) => parts.join('');
const GH = join2('gh', 'p_', 'R8kQ2mZ7vX4pL9wT3nB6yH1cJ5dF0sG2aE7u');
const PROVIDER = join2('sk', '-proj-', 'Zq7Lm2Vx9Rt4Wp8Ks3Hd6Jf1');
const PEM = join2(
  '-----BEGIN ',
  'PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
  '-----END PRIVATE KEY-----',
);
const PASSWORD = join2('Hq7', 'Zt2', 'Lm9', 'Pw4');

describe('scanText', () => {
  it('reports token-shaped secrets with a masked preview and their position', () => {
    const findings = scanText('src/config.ts', `const a = 1;\nconst token = '${GH}';\n`);
    expect(findings).toEqual([
      {
        path: 'src/config.ts',
        line: 2,
        column: 16,
        rule: 'github-token',
        preview: 'ghp_… (40 chars)',
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain(GH);
  });

  it('reports private key blocks once, even with long runs inside the key', () => {
    const findings = scanText('keys/server.pem', `${PEM}\n`);
    expect(findings.map((f) => f.rule)).toEqual(['pem']);
    const truncated = scanText('notes.txt', PEM.split('-----END')[0]!);
    expect(truncated.map((f) => f.rule)).toEqual(['pem-header']);
  });

  it('reports context matches only for plain literals', () => {
    expect(scanText('a.ts', `connect('postgres://app:${PASSWORD}@db/x')`)[0]?.rule).toBe(
      'url-credentials',
    );
    expect(scanText('a.ts', `const password = "${PASSWORD}";`)[0]?.rule).toBe(
      'secret-assignment-quoted',
    );
    expect(scanText('a.ts', 'headers.authorization = `Bearer ${session}`;')).toEqual([]);
    expect(scanText('a.ts', 'const apiKey = req.body.apiKey;')).toEqual([]);
    expect(scanText('a.ts', "apiKey: 'secret://provider/x/api_key'")).toEqual([]);
  });

  it('applies unquoted assignments to configuration files only', () => {
    const line = `password = ${PASSWORD}\n`;
    expect(scanText('deploy/.env', line).map((f) => f.rule)).toEqual(['secret-assignment']);
    expect(scanText('deploy/app.yaml', line)).toHaveLength(1);
    expect(scanText('src/app.ts', line)).toEqual([]);
  });

  it('stays quiet for fixtures that look fake or are marked', () => {
    expect(scanText('t.ts', "const k = 'sk-test-key-0123456789abcdef';")).toEqual([]);
    expect(scanText('t.ts', "const k = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';")).toEqual([]);
    expect(scanText('t.ts', `const k = '${GH}'; // ${FAKE_MARKER}`)).toEqual([]);
    expect(scanText('t.ts', `// ${FAKE_MARKER}\nconst k = '${GH}';`)).toEqual([]);
    expect(scanText('t.ts', `// ${FAKE_MARKER}\n\nconst k = '${GH}';`)).toHaveLength(1);
    expect(scanText('fixture.pem', `# ${FAKE_FILE_MARKER}\n${PEM}`)).toEqual([]);
  });

  it('accepts a custom rule list and skips rules without a scan class', () => {
    const rules = [
      { id: 'ticket', pattern: /\bTKT-[0-9A-Z]{8}\b/g, scan: 'token' as const },
      { id: 'ignored', pattern: /\bHq7\w+/g },
    ];
    expect(scanText('a.md', `see TKT-9Q2W7E4R and ${PASSWORD}`, rules).map((f) => f.rule)).toEqual([
      'ticket',
    ]);
    const empty = [
      { id: 'g', pattern: /(?<secret>x)?y/g, group: 'secret' as const, scan: 'token' as const },
    ];
    expect(scanText('a.md', 'y', empty)).toEqual([]);
  });

  it('sorts findings by position across rules', () => {
    const text = `const p = "${PROVIDER}";\nconst g = "${GH}";\nconst q = "${PROVIDER}";`;
    expect(scanText('a.ts', text).map((f) => [f.line, f.rule])).toEqual([
      [1, 'provider-key'],
      [2, 'github-token'],
      [3, 'provider-key'],
    ]);
  });
});

describe('heuristics', () => {
  it('classifies fake values', () => {
    expect(looksFake('sk-live-abcdefghijklmnop')).toBe(true);
    expect(looksFake('key-345678-x')).toBe(true);
    expect(looksFake('zzzzzz-key')).toBe(true);
    expect(looksFake('my-example-key')).toBe(true);
    expect(looksFake(PASSWORD)).toBe(false);
    expect(looksFake('a-b-c-d-e-f')).toBe(false); // separators break a run
  });

  it('recognises plain literals', () => {
    expect(isPlainLiteral(PASSWORD)).toBe(true);
    expect(isPlainLiteral('short1')).toBe(false);
    expect(isPlainLiteral('${process.env.KEY}')).toBe(false);
    expect(isPlainLiteral('lettersonly')).toBe(false);
    expect(isPlainLiteral('1234567890')).toBe(false);
    expect(isPlainLiteral('secret://a/b1234567')).toBe(false);
  });

  it('recognises configuration files', () => {
    expect(isConfigFile('.env')).toBe(true);
    expect(isConfigFile('deploy/.env.production')).toBe(true);
    expect(isConfigFile('config/app.TOML')).toBe(true);
    expect(isConfigFile('src/app.ts')).toBe(false);
  });
});

describe('redactor rules added for the scan', () => {
  it('masks Nova tokens, prefixed registry tokens and truncated key blocks', () => {
    const nova = join2('nv', 'x_', 'Q2mZ7vX4pL9wT3nB6yH1cJ5dF0sG2aE7uR8kQ2mZ7vX');
    const npm = join2('np', 'm_', 'R8kQ2mZ7vX4pL9wT3nB6yH1cJ5dF0sG2aE7u');
    const out = defaultRedactor.redactString(`a ${nova} b ${npm} c ${PEM.split('-----END')[0]!}`);
    expect(out).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED}`);
    expect(defaultRedactor.redactString('env_value and nvx_short')).toBe('env_value and nvx_short');
  });
});

describe('scripts/secret-scan.mjs', () => {
  const script = resolve(import.meta.dirname, '../../../scripts/secret-scan.mjs');
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nova-scan-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, '--root', dir, ...args], { encoding: 'utf8' });

  it('fails on a real-looking key and passes on an allowlisted fake', () => {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'src', 'ok.ts'), `const k = '${GH}'; // ${FAKE_MARKER}\n`);
    writeFileSync(join(dir, 'node_modules', 'dep', 'x.js'), `const k = '${GH}';\n`);
    writeFileSync(join(dir, 'image.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(GH)]));
    writeFileSync(join(dir, 'empty.txt'), '');
    const clean = run('--no-git');
    expect(clean.status).toBe(0);
    expect(clean.stdout).toMatch(/no secrets found in 1 files/);

    writeFileSync(join(dir, 'src', 'leak.ts'), `export const key = '${GH}';\n`);
    const dirty = run('--no-git');
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain('src/leak.ts:1:21  github-token  ghp_… (40 chars)');
    expect(dirty.stderr).not.toContain(GH);
  });

  it('exits 2 when the files cannot be listed', () => {
    const res = spawnSync(process.execPath, [script, '--root', join(dir, 'missing'), '--no-git'], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/cannot list files/);
  });
});
