import { describe, expect, it } from 'vitest';
import { REDACTED, Redactor } from '@nova/security';
import { Logger, MemorySink, type LogRecord } from '../src/logger.ts';
import { RingSink } from '../src/ring.ts';

const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 0, 0, s)).toISOString();

function rec(i: number, over: Partial<LogRecord> = {}): LogRecord {
  return { ts: at(i), level: 'info', module: 'hub', msg: `m${i}`, ...over };
}

describe('RingSink', () => {
  it('keeps the last N records and returns them newest first', () => {
    const ring = new RingSink(3);
    for (let i = 0; i < 5; i++) ring.write(rec(i));
    expect(ring.size).toBe(3);
    expect(ring.query().map((e) => e.msg)).toEqual(['m4', 'm3', 'm2']);
    expect(ring.query({ limit: 1 }).map((e) => e.msg)).toEqual(['m4']);
  });

  it('filters by minimum level, module prefix and time', () => {
    const ring = new RingSink();
    ring.write(rec(1, { level: 'debug', module: 'hub.mcp' }));
    ring.write(rec(2, { level: 'warn', module: 'hub.mcp.client', port: 1 }));
    ring.write(rec(3, { level: 'error', module: 'hub.mcpx' }));
    ring.write(rec(4, { level: 'trace', module: 'hub' }));
    expect(ring.query({ level: 'warn' }).map((e) => e.msg)).toEqual(['m3', 'm2']);
    expect(ring.query({ module: 'hub.mcp' }).map((e) => e.msg)).toEqual(['m2', 'm1']);
    expect(ring.query({ since: at(3) }).map((e) => e.msg)).toEqual(['m4', 'm3']);
    expect(ring.query({ module: 'hub.mcp', level: 'warn' })[0]).toEqual({
      ts: at(2),
      level: 'warn',
      module: 'hub.mcp.client',
      msg: 'm2',
      fields: { port: 1 },
    });
  });

  it('redacts again on the way out, including secrets learned later', () => {
    const red = new Redactor([]);
    const ring = new RingSink(10, red);
    ring.write(
      rec(1, { msg: 'connected with value-learned-later', detail: { k: 'value-learned-later' } }),
    );
    red.addLiteral('value-learned-later');
    const [entry] = ring.query();
    expect(entry?.msg).toBe(`connected with ${REDACTED}`);
    expect(entry?.fields).toEqual({ detail: { k: REDACTED } });
    const lines = [...ring.exportLines()];
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('value-learned-later');
    expect(JSON.parse(lines[0]!)).toMatchObject({ ts: at(1), level: 'info', module: 'hub' });
  });

  it('exports oldest first after wrapping', () => {
    const ring = new RingSink(2);
    for (let i = 0; i < 3; i++) ring.write(rec(i));
    expect([...ring.exportLines()].map((l) => JSON.parse(l).msg)).toEqual(['m1', 'm2']);
  });

  it('rejects a bad capacity', () => {
    expect(() => new RingSink(0)).toThrow(RangeError);
  });
});

describe('Logger sink sharing', () => {
  it('adds a sink to a whole logger family and finds it by class', () => {
    const mem = new MemorySink();
    const root = new Logger({ module: 'hub', sinks: [mem] });
    const child = root.child('mcp');
    expect(root.findSink(RingSink)).toBeUndefined();
    const ring = new RingSink();
    child.addSink(ring);
    child.addSink(ring); // idempotent
    root.with({ a: 1 }).info('from root');
    child.child('client').warn('from grandchild');
    expect(root.findSink(RingSink)).toBe(ring);
    expect(ring.query().map((e) => e.module)).toEqual(['hub.mcp.client', 'hub']);
    expect(mem.records).toHaveLength(2);
    root.removeSink(ring);
    root.removeSink(ring);
    child.info('after removal');
    expect(ring.size).toBe(2);
    expect(mem.records).toHaveLength(3);
  });

  it('never mutates the array the caller passed', () => {
    const sinks = [new MemorySink()];
    new Logger({ module: 'm', sinks }).addSink(new RingSink());
    expect(sinks).toHaveLength(1);
  });
});
