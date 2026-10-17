import { beforeEach, describe, expect, it } from 'vitest';
import { isUuidV7, resetUuidv7State, uuidv7, uuidv7Timestamp } from '../src/ids.ts';

describe('uuidv7', () => {
  beforeEach(() => resetUuidv7State());

  it('produces RFC 9562 version-7 ids', () => {
    for (let i = 0; i < 100; i++) expect(isUuidV7(uuidv7())).toBe(true);
  });

  it('encodes the timestamp', () => {
    const t = Date.UTC(2026, 9, 17, 12, 0, 0, 123);
    expect(uuidv7Timestamp(uuidv7({ now: () => t }))).toBe(t);
  });

  it('sorts in creation order within the same millisecond', () => {
    const t = 1_760_000_000_000;
    const ids = Array.from({ length: 500 }, () => uuidv7({ now: () => t }));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never goes backwards when the clock does', () => {
    const a = uuidv7({ now: () => 2_000_000_000_000 });
    const b = uuidv7({ now: () => 1_000_000_000_000 });
    expect(b > a).toBe(true);
  });

  it('rolls into the next millisecond when the counter overflows', () => {
    const t = 1_760_000_000_000;
    const zero = (bytes: Uint8Array) => bytes.fill(0);
    const ids = Array.from({ length: 5000 }, () => uuidv7({ now: () => t, random: zero }));
    expect([...ids].sort()).toEqual(ids);
    expect(uuidv7Timestamp(ids.at(-1)!)).toBeGreaterThan(t);
  });

  it('rejects non-v7 strings', () => {
    expect(isUuidV7('00000000-0000-4000-8000-000000000000')).toBe(false);
    expect(() => uuidv7Timestamp('nope')).toThrow(TypeError);
  });
});
