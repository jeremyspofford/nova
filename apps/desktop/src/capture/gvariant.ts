// A reader for GVariant text, the form the `gdbus` CLI prints D-Bus replies in (GLib's
// g_variant_print with type annotations). The Linux attach-window provider (FR-214) talks AT-SPI
// over D-Bus through `gdbus`, so it needs to read replies like `([(':1.2', objectpath '/a')],)`.
// Tuples and arrays become JS arrays, dictionaries objects, variants their content.

export type GValue = string | number | boolean | null | GValue[] | { [key: string]: GValue };

const TYPE_WORDS = new Set([
  'byte',
  'int16',
  'uint16',
  'int32',
  'uint32',
  'int64',
  'uint64',
  'double',
  'handle',
  'objectpath',
  'signature',
  'boolean',
  'string',
]);

class Reader {
  readonly #s: string;
  #i = 0;
  constructor(s: string) {
    this.#s = s;
  }

  get done(): boolean {
    this.#ws();
    return this.#i >= this.#s.length;
  }

  #ws(): void {
    while (this.#i < this.#s.length && /\s/.test(this.#s[this.#i] ?? '')) this.#i++;
  }

  #peek(): string {
    this.#ws();
    return this.#s[this.#i] ?? '';
  }

  #expect(ch: string): void {
    if (this.#peek() !== ch) throw new SyntaxError(`expected ${ch} at ${this.#i}`);
    this.#i++;
  }

  #word(): string {
    this.#ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.#s.slice(this.#i));
    return m ? m[0] : '';
  }

  value(): GValue {
    const ch = this.#peek();
    if (ch === '(') return this.#tuple();
    if (ch === '[') return this.#array();
    if (ch === '{') return this.#dict();
    if (ch === '<') {
      this.#i++;
      const v = this.value();
      this.#expect('>');
      return v;
    }
    if (ch === "'" || ch === '"') return this.#string();
    if (ch === '@') {
      // `@as []`: a type annotation for an empty container; skip the type string.
      this.#i++;
      while (this.#i < this.#s.length && !/\s/.test(this.#s[this.#i] ?? '')) this.#i++;
      return this.value();
    }
    if (ch === 'b' && (this.#s[this.#i + 1] === "'" || this.#s[this.#i + 1] === '"')) {
      this.#i++;
      return this.#string();
    }
    const word = this.#word();
    if (word === 'true' || word === 'false') {
      this.#i += word.length;
      return word === 'true';
    }
    if (word === 'nothing') {
      this.#i += word.length;
      return null;
    }
    if (word === 'just') {
      this.#i += word.length;
      return this.value();
    }
    if (TYPE_WORDS.has(word)) {
      this.#i += word.length;
      return this.value();
    }
    return this.#number();
  }

  #tuple(): GValue[] {
    this.#expect('(');
    const out: GValue[] = [];
    while (this.#peek() !== ')') {
      out.push(this.value());
      if (this.#peek() === ',') this.#i++;
      else if (this.#peek() !== ')') throw new SyntaxError(`expected , or ) at ${this.#i}`);
    }
    this.#i++;
    return out;
  }

  #array(): GValue[] {
    this.#expect('[');
    const out: GValue[] = [];
    while (this.#peek() !== ']') {
      out.push(this.value());
      if (this.#peek() === ',') this.#i++;
      else if (this.#peek() !== ']') throw new SyntaxError(`expected , or ] at ${this.#i}`);
    }
    this.#i++;
    return out;
  }

  #dict(): { [key: string]: GValue } {
    this.#expect('{');
    const out: { [key: string]: GValue } = {};
    while (this.#peek() !== '}') {
      const k = this.value();
      this.#expect(':');
      out[typeof k === 'string' ? k : JSON.stringify(k)] = this.value();
      if (this.#peek() === ',') this.#i++;
      else if (this.#peek() !== '}') throw new SyntaxError(`expected , or } at ${this.#i}`);
    }
    this.#i++;
    return out;
  }

  #string(): string {
    const quote = this.#s[this.#i];
    this.#i++;
    let out = '';
    while (this.#i < this.#s.length) {
      const c = this.#s[this.#i] ?? '';
      if (c === quote) {
        this.#i++;
        return out;
      }
      if (c === '\\') {
        const n = this.#s[this.#i + 1] ?? '';
        this.#i += 2;
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'r') out += '\r';
        else if (n === 'a') out += '\x07';
        else if (n === 'b') out += '\b';
        else if (n === 'f') out += '\f';
        else if (n === 'v') out += '\v';
        else if (n === 'u' || n === 'U') {
          const len = n === 'u' ? 4 : 8;
          const hex = this.#s.slice(this.#i, this.#i + len);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len)
            throw new SyntaxError('bad unicode escape');
          out += String.fromCodePoint(parseInt(hex, 16));
          this.#i += len;
        } else if (/[0-7]/.test(n)) {
          // An octal escape of up to three digits (bytestrings).
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(this.#s[this.#i] ?? '')) oct += this.#s[this.#i++];
          out += String.fromCharCode(parseInt(oct, 8));
        } else out += n;
        continue;
      }
      out += c;
      this.#i++;
    }
    throw new SyntaxError('unterminated string');
  }

  #number(): number {
    this.#ws();
    const m = /^[-+]?(0x[0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|inf|nan)/.exec(
      this.#s.slice(this.#i),
    );
    if (!m) throw new SyntaxError(`unexpected input at ${this.#i}`);
    this.#i += m[0].length;
    return m[1]?.startsWith('0x') ? parseInt(m[0], 16) : Number(m[0]);
  }
}

/** Parse one GVariant text value (a whole `gdbus call` reply). */
export function parseGVariant(text: string): GValue {
  const r = new Reader(text.trim());
  const v = r.value();
  if (!r.done) throw new SyntaxError('trailing input');
  return v;
}
