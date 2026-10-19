// A process's output buffer: the newest bytes (1 MiB by default), addressed by absolute offsets so
// a reader that went away reattaches where it stopped and learns how much was dropped meanwhile
// (FR-078 semantics, as the Hub's helpers keep them). Reads never split a UTF-8 sequence.

export interface OutputRead {
  data: string;
  /** Where the next read starts. */
  offset: number;
  /** Bytes dropped before the requested offset. */
  dropped: number;
}

export class OutputRing {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;
  /** Absolute offset of the first byte kept. */
  #start = 0;

  constructor(limit = 1024 * 1024) {
    this.#limit = limit;
  }

  /** Total bytes ever written. */
  get end(): number {
    return this.#start + this.#size;
  }

  append(b: Buffer): void {
    if (!b.length) return;
    this.#chunks.push(b);
    this.#size += b.length;
    while (this.#size > this.#limit && this.#chunks.length) {
      const first = this.#chunks[0]!;
      const over = this.#size - this.#limit;
      if (first.length <= over) {
        this.#chunks.shift();
        this.#size -= first.length;
        this.#start += first.length;
      } else {
        this.#chunks[0] = first.subarray(over);
        this.#size -= over;
        this.#start += over;
      }
    }
  }

  /**
   * Bytes from `offset` (at most `max`). `final` returns a trailing partial sequence too (the
   * process ended, nothing will complete it).
   */
  read(offset: number, max = 256 * 1024, final = false): OutputRead {
    let from = Math.max(offset, this.#start);
    const dropped = Math.max(0, this.#start - offset);
    const all = Buffer.concat(this.#chunks);
    let i = from - this.#start;
    // Skip continuation bytes at a start the ring cut into.
    if (dropped) {
      let skip = 0;
      while (skip < 3 && i < all.length && (all[i]! & 0xc0) === 0x80) {
        i++;
        skip++;
      }
      from += skip;
    }
    let j = Math.min(all.length, i + max);
    if (!final || j < all.length) j = completeEnd(all, i, j);
    return {
      data: all.subarray(i, j).toString('utf8'),
      offset: from + (j - i),
      dropped,
    };
  }
}

/** Move `end` back so the slice [start, end) never ends inside a UTF-8 sequence. */
function completeEnd(b: Buffer, start: number, end: number): number {
  for (let k = end - 1; k >= Math.max(start, end - 4); k--) {
    const c = b[k]!;
    if ((c & 0xc0) === 0x80) continue;
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return end - k >= need ? end : k;
  }
  return end;
}
