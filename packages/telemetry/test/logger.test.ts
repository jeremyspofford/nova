import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger, MemorySink, RotatingFileSink } from '../src/logger.ts';

const fixed = () => new Date('2026-10-17T00:00:00.000Z');

describe('Logger', () => {
  it('writes structured records with bindings and filters by level', () => {
    const sink = new MemorySink();
    const log = new Logger({
      module: 'hub',
      sinks: [sink],
      now: fixed,
      bindings: { requestId: 'r1' },
    });
    log.debug('hidden');
    log.info('started', { port: 8080 });
    expect(sink.records).toEqual([
      {
        ts: '2026-10-17T00:00:00.000Z',
        level: 'info',
        module: 'hub',
        msg: 'started',
        requestId: 'r1',
        port: 8080,
      },
    ]);
  });

  it('redacts secrets in messages and fields at the boundary', () => {
    const sink = new MemorySink();
    const log = new Logger({ module: 'hub', sinks: [sink], now: fixed });
    log.error('call failed with Bearer abcdefghijklmnop1234', {
      headers: { authorization: 'Bearer abcdefghijklmnop1234' },
      url: 'https://u:p4ssw0rd@example.com/x',
    });
    const text = JSON.stringify(sink.records);
    expect(text).not.toContain('abcdefghijklmnop1234');
    expect(text).not.toContain('p4ssw0rd');
  });

  it('builds children with module paths, merged bindings and per-module levels', () => {
    const sink = new MemorySink();
    const log = new Logger({
      module: 'hub',
      sinks: [sink],
      now: fixed,
      moduleLevels: { 'hub.http': 'debug' },
    });
    const http = log.child('http', { route: '/x' });
    http.debug('detail');
    log.debug('root detail');
    log.with({ a: 1 }).warn('w');
    expect(sink.records.map((r) => [r.module, r.level, r.msg])).toEqual([
      ['hub.http', 'debug', 'detail'],
      ['hub', 'warn', 'w'],
    ]);
    expect(sink.records[0]?.route).toBe('/x');
    expect(sink.records[1]?.a).toBe(1);
  });

  it('never throws when a sink fails, and keeps writing to the others', () => {
    const good = new MemorySink();
    const bad = {
      write() {
        throw new Error('disk full');
      },
    };
    const log = new Logger({ module: 'm', sinks: [bad, good], now: fixed, level: 'trace' });
    expect(() => log.trace('t')).not.toThrow();
    expect(good.records).toHaveLength(1);
  });
});

describe('RotatingFileSink', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rotates by size and keeps a bounded number of files', () => {
    dir = mkdtempSync(join(tmpdir(), 'nova-log-'));
    const path = join(dir, 'logs', 'hub.jsonl');
    const sink = new RotatingFileSink(path, { maxBytes: 200, maxFiles: 3 });
    const log = new Logger({ module: 'm', sinks: [sink], now: fixed });
    for (let i = 0; i < 20; i++) log.info(`message number ${i}`);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
    const last = readFileSync(path, 'utf8').trim().split('\n').at(-1)!;
    expect(JSON.parse(last).msg).toBe('message number 19');
  });
});
