// Exact-value scrubbing at the broker's edges (§8): the value a use injected (and, for basic auth,
// the user:value pair it sent), in its raw, base64, base64url, hex, URL-encoded (either case, and
// form-encoded), and JSON-escaped forms, is replaced in what the target sent back: a response, or a
// program's output through the launcher. Only target-sent text is scrubbed, never text core wrote:
// scrubbing core's own text would tell core whether it guessed a value.
// Stated limits: values shorter than 6 characters aren't hunted (they would match ordinary text);
// HTML entities, UTF-16 and other encodings a target might use aren't; and a target that echoes
// text core sent it can, by being scrubbed, confirm a guess about the value used (rate-capped).

export const MARK = '[redacted by the broker]';

export function formsOf(value: string): string[] {
  if (value.length < 6) return [];
  const b = Buffer.from(value, 'utf8');
  const forms = new Set([
    value, b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'),
    b.toString('hex'), b.toString('hex').toUpperCase(), encodeURIComponent(value), JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase()), encodeURIComponent(value).replace(/%20/g, '+'),
    JSON.stringify(value).slice(1, -1).replace(/\//g, '\\/'),
  ]);
  return [...forms].filter((f) => f.length >= 6).sort((x, y) => y.length - x.length);
}

export class Scrubber {
  #forms: string[] = [];
  #longest = 0;
  hits = 0;
  constructor(values: Iterable<string> = []) { this.set(values); }
  set(values: Iterable<string>) {
    const all = new Set<string>();
    for (const v of values) for (const f of formsOf(v)) all.add(f);
    this.#forms = [...all].sort((x, y) => y.length - x.length);
    this.#longest = this.#forms[0]?.length ?? 0;
  }
  get size() { return this.#forms.length; }
  get longest() { return this.#longest; }
  text(s: string): string {
    let out = s;
    for (const f of this.#forms) if (out.includes(f)) { this.hits++; out = out.split(f).join(MARK); }
    return out;
  }
  // Recursively, for an answer about to be written.
  any<T>(v: T): T {
    if (typeof v === 'string') return this.text(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.any(x)) as T;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.text(k), this.any(x)])) as T;
    return v;
  }
}

// For a stream (a program's stdout through the launcher): holds back the last longest-1 characters
// so a value split across two chunks is still caught.
export class StreamScrubber {
  #s: Scrubber;
  #tail = '';
  constructor(s: Scrubber) { this.#s = s; }
  push(chunk: string): string {
    const text = this.#s.text(this.#tail + chunk);
    const keep = Math.max(0, this.#s.longest - 1);
    if (text.length <= keep) { this.#tail = text; return ''; }
    this.#tail = keep ? text.slice(-keep) : '';
    return keep ? text.slice(0, -keep) : text;
  }
  end(): string { const t = this.#s.text(this.#tail); this.#tail = ''; return t; }
}
