// `nova data export|import` (FR-105, ADR-097 D1/D5): the module the `nova` command wires. The Hub is
// a fake fetch; the token and passphrase never come from the command line.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_CLI_USAGE, runDataCommand, type DataCliIo } from '../src/index.ts';

let dir: string;
let out: string;
let err: string;
let calls: { url: string; init: RequestInit; body: string }[];
let answers: ((url: string) => Response | undefined)[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-datactl-cli-'));
  out = '';
  err = '';
  calls = [];
  answers = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function io(env: Record<string, string> = {}): DataCliIo {
  return {
    env: { NOVA_URL: 'https://hub.test/', NOVA_TOKEN: 'nvt_owner', ...env },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    now: () => new Date('2026-10-19T08:00:00Z'),
    fetch: (async (url: string, init: RequestInit) => {
      let body = '';
      if (typeof init.body === 'string') body = init.body;
      else if (init.body) {
        const chunks: Buffer[] = [];
        for await (const c of init.body as unknown as AsyncIterable<Uint8Array>)
          chunks.push(Buffer.from(c));
        body = Buffer.concat(chunks).toString('utf8');
      }
      calls.push({ url, init, body });
      for (const a of answers) {
        const r = a(url);
        if (r) return r;
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch,
  };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

describe('nova data', () => {
  it('exports to a file with the passphrase from the environment', async () => {
    answers.push((u) => (u.endsWith('/data/export') ? new Response('ARCHIVE-BYTES') : undefined));
    const file = join(dir, 'out.novaexport');
    const code = await runDataCommand(
      ['export', '--out', file, '--confirm', 'home-hub'],
      io({ NOVA_EXPORT_PASSPHRASE: 'pp from env' }),
    );
    expect(code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('ARCHIVE-BYTES');
    expect(calls[0]).toMatchObject({
      url: 'https://hub.test/api/v1/data/export',
      body: '{"passphrase":"pp from env","confirm":"home-hub"}',
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer nvt_owner',
    );
    expect(out).toContain('sealed with your passphrase');
  });

  it('talks to a Hub over https only (http only to this machine)', async () => {
    answers.push((u) => (u.endsWith('/data/export') ? new Response('A') : undefined));
    for (const url of ['http://hub.example', 'ftp://hub.example', 'not a url']) {
      err = '';
      expect(await runDataCommand(['export', '--out', join(dir, 'y')], io({ NOVA_URL: url }))).toBe(
        1,
      );
      expect(err, url).toMatch(/https|not a URL/);
    }
    expect(calls).toEqual([]);
    for (const url of ['http://127.0.0.1:7419', 'http://localhost:7419', 'https://hub.example']) {
      expect(
        await runDataCommand(
          ['export', '--out', join(dir, `ok-${calls.length}`)],
          io({ NOVA_URL: url }),
        ),
        url,
      ).toBe(0);
    }
  });

  it('asks for the Hub name before a sealed export', async () => {
    expect(await runDataCommand(['export'], io({ NOVA_EXPORT_PASSPHRASE: 'pp from env' }))).toBe(1);
    expect(err).toContain('--confirm');
    expect(calls).toEqual([]);
  });

  it('refuses a passphrase on the command line, and missing settings', async () => {
    expect(await runDataCommand(['export', '--passphrase', 'x'], io())).toBe(1);
    expect(err).toContain('never given on the command line');
    expect(await runDataCommand(['export'], { ...io(), env: {} })).toBe(1);
    expect(err).toContain('set NOVA_URL and NOVA_TOKEN');
    expect(await runDataCommand(['nope'], io())).toBe(2);
    expect(err).toContain(DATA_CLI_USAGE.split('\n')[0]);
  });

  it('uploads and checks, and imports only with --yes', async () => {
    const archive = join(dir, 'a.novaexport');
    writeFileSync(archive, 'ZIPDATA');
    const pass = join(dir, 'pass');
    writeFileSync(pass, 'file passphrase\n');
    answers.push((u) => (u.endsWith('/import/upload') ? json({ uploadId: 'u1' }, 201) : undefined));
    answers.push((u) =>
      u.endsWith('/import/check')
        ? json({
            rows: 12,
            tables: [1, 2],
            files: { count: 3 },
            hubEmpty: true,
            blockingTables: [],
            toReEnter: [],
            migratesFrom: 40,
          })
        : undefined,
    );
    answers.push((u) =>
      u.endsWith('/data/import')
        ? json({ rows: 12, toReEnter: ['secret://provider/p/api_key'] })
        : undefined,
    );
    expect(await runDataCommand(['import', archive, '--passphrase-file', pass], io())).toBe(0);
    expect(calls.map((c) => c.url.replace('https://hub.test', ''))).toEqual([
      '/api/v1/data/import/upload',
      '/api/v1/data/import/check',
    ]);
    expect(calls[0]!.body).toBe('ZIPDATA');
    expect(JSON.parse(calls[1]!.body)).toEqual({ uploadId: 'u1', passphrase: 'file passphrase' });
    expect(out).toContain('migrated forward from schema 40');
    expect(out).toContain('Run again with --yes');

    calls = [];
    expect(await runDataCommand(['import', archive, '--yes'], io())).toBe(0);
    expect(calls.at(-1)!.url).toBe('https://hub.test/api/v1/data/import');
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ uploadId: 'u1', confirm: true });
    expect(out).toContain('Secrets to enter again: secret://provider/p/api_key');
  });

  it('stops when the Hub is not empty or answers an error', async () => {
    const archive = join(dir, 'a.novaexport');
    writeFileSync(archive, 'Z');
    answers.push((u) => (u.endsWith('/import/upload') ? json({ uploadId: 'u1' }, 201) : undefined));
    answers.push((u) =>
      u.endsWith('/import/check')
        ? json({
            rows: 1,
            tables: [],
            files: { count: 0 },
            hubEmpty: false,
            blockingTables: ['thread'],
            toReEnter: [],
            migratesFrom: null,
          })
        : undefined,
    );
    expect(await runDataCommand(['import', archive, '--yes'], io())).toBe(1);
    expect(err).toContain('not empty (thread)');
    answers.unshift((u) =>
      u.endsWith('/data/export')
        ? json({ error: { code: 'policy_denied', message: 'only the owner' } }, 403)
        : undefined,
    );
    expect(await runDataCommand(['export', '--out', join(dir, 'x')], io())).toBe(1);
    expect(err).toContain('the Hub answered 403: only the owner');
  });
});
