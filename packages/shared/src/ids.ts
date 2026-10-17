// UUIDv7 identifiers (docs/06: "IDs are UUIDv7 (sortable)").
// Layout (RFC 9562): 48-bit Unix ms timestamp | ver(4)=7 | rand_a(12) | var(2)=0b10 | rand_b(62).
// rand_a is used as a per-millisecond counter so ids generated in the same millisecond still
// sort in creation order.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

let lastMs = -1;
let counter = 0;

export interface UuidV7Options {
  /** Override the clock (tests). */
  now?: () => number;
  /** Override the random source (tests). Must fill the array in place. */
  random?: (bytes: Uint8Array<ArrayBuffer>) => void;
}

const defaultRandom = (bytes: Uint8Array<ArrayBuffer>): void => {
  globalThis.crypto.getRandomValues(bytes);
};

export function uuidv7(opts: UuidV7Options = {}): string {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? defaultRandom;
  let ms = now();
  if (ms < lastMs) ms = lastMs; // never go backwards, even if the wall clock does
  const bytes = new Uint8Array(16);
  random(bytes);
  if (ms === lastMs) {
    counter = (counter + 1) & 0xfff;
    if (counter === 0) ms = lastMs + 1; // counter overflow: borrow the next millisecond
  } else {
    counter = (((bytes[6] ?? 0) & 0x0f) << 8) | (bytes[7] ?? 0); // random start, 12 bits
    counter &= 0x7ff; // leave headroom so increments rarely overflow
  }
  lastMs = ms;

  // 48-bit timestamp, big-endian.
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  let out = '';
  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i] ?? 0];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

/** Milliseconds since the epoch encoded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  if (!isUuidV7(id)) throw new TypeError(`not a UUIDv7: ${id}`);
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** Reset generator state (tests only). */
export function resetUuidv7State(): void {
  lastMs = -1;
  counter = 0;
}
