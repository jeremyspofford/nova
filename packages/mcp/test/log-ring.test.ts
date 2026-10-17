// The redacted per-server log ring and the stderr line splitter (FR-043, FR-101).
import { describe, expect, it } from 'vitest';
import { Redactor } from '@nova/security';
import { LineSplitter, LogRing } from '../src/index.ts';

describe('log ring', () => {
  it('keeps the last lines, redacted and clipped', () => {
    const red = new Redactor();
    red.addLiteral('hunter2-secret');
    const ring = new LogRing(
      (t) => red.redactString(t),
      3,
      () => new Date(0),
    );
    for (let i = 0; i < 5; i++) ring.push('stderr', `line ${i}`);
    ring.push('protocol', 'password=hunter2-secret');
    ring.push('status', 'x'.repeat(3000));
    const lines = ring.lines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ ts: '1970-01-01T00:00:00.000Z', stream: 'stderr', text: 'line 4' });
    expect(lines[1]!.text).not.toContain('hunter2');
    expect(lines[2]!.text).toHaveLength(2001);
  });

  it('splits chunks into lines and cuts runaway lines', () => {
    const out: string[] = [];
    const split = new LineSplitter((l) => out.push(l), 8);
    split.write('one\r\ntw');
    split.write(Buffer.from('o\nthree-is-long'));
    split.flush();
    split.flush();
    expect(out).toEqual(['one', 'two', 'three-is', '-long']);
  });
});
