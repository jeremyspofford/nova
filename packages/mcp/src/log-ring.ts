// A per-server ring of recent log lines (FR-043): the server's stderr, protocol notices and status
// changes. Every line is redacted when it is recorded (FR-101), so the ring never holds a secret.
import type { McpLogLine } from '@nova/shared';

export const LOG_RING_SIZE = 500;
const LINE_MAX = 2000;

export class LogRing {
  readonly #lines: McpLogLine[] = [];
  readonly #size: number;
  readonly #redact: (text: string) => string;
  readonly #now: () => Date;

  constructor(redact: (text: string) => string, size = LOG_RING_SIZE, now = () => new Date()) {
    this.#redact = redact;
    this.#size = size;
    this.#now = now;
  }

  push(stream: McpLogLine['stream'], text: string): void {
    const clipped = text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)}…` : text;
    this.#lines.push({ ts: this.#now().toISOString(), stream, text: this.#redact(clipped) });
    if (this.#lines.length > this.#size) this.#lines.splice(0, this.#lines.length - this.#size);
  }

  /** Oldest first. */
  lines(): McpLogLine[] {
    return this.#lines.map((l) => ({ ...l }));
  }
}

/** Split a byte stream into lines; a line longer than `max` is cut and recorded in pieces. */
export class LineSplitter {
  #buf = '';
  readonly #emit: (line: string) => void;
  readonly #max: number;

  constructor(emit: (line: string) => void, max = 4096) {
    this.#emit = emit;
    this.#max = max;
  }

  write(chunk: Buffer | string): void {
    this.#buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let i: number;
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      this.#emit(this.#buf.slice(0, i).replace(/\r$/, ''));
      this.#buf = this.#buf.slice(i + 1);
    }
    while (this.#buf.length > this.#max) {
      this.#emit(this.#buf.slice(0, this.#max));
      this.#buf = this.#buf.slice(this.#max);
    }
  }

  flush(): void {
    if (this.#buf) this.#emit(this.#buf);
    this.#buf = '';
  }
}
