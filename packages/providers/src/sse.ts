// Incremental Server-Sent Events parser (WHATWG "event stream" format), reduced to what model
// streams use: `data:` fields joined per event, comments and other fields ignored.

export class SseParser {
  #buf = '';
  #data: string[] = [];

  /** Feed decoded text; returns the data payload of every event completed by it. */
  push(text: string): string[] {
    this.#buf += text;
    const out: string[] = [];
    for (;;) {
      const i = this.#buf.search(/[\r\n]/);
      if (i < 0) break;
      // A lone CR at the end may be the first half of CRLF: wait for the next chunk.
      if (this.#buf[i] === '\r' && i === this.#buf.length - 1) break;
      const eol = this.#buf[i] === '\r' && this.#buf[i + 1] === '\n' ? 2 : 1;
      const line = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(i + eol);
      this.#line(line, out);
    }
    return out;
  }

  /** End of stream: dispatch a final event that was not followed by a blank line. */
  end(): string[] {
    const out: string[] = [];
    if (this.#buf) this.#line(this.#buf.replace(/\r$/, ''), out);
    this.#buf = '';
    if (this.#data.length) out.push(this.#data.join('\n'));
    this.#data = [];
    return out;
  }

  #line(line: string, out: string[]): void {
    if (line === '') {
      if (this.#data.length) out.push(this.#data.join('\n'));
      this.#data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.#data.push(value);
  }
}
