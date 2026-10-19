// Secret redaction applied at every output boundary: logs, traces, tool results, error reports
// (FR-101, FR-118, docs/12 §5, docs/16 §1). Redaction never throws; when in doubt it masks.

export const REDACTED = '[REDACTED]';

export interface RedactionRule {
  id: string;
  pattern: RegExp;
  /**
   * Replace the whole match, or only the named group `secret`. A rule whose match is a named
   * group `pre` followed by `secret` (anything after it a lookahead) is replaced natively, which
   * is several times faster than a callback on text with many matches.
   */
  group?: 'secret';
  /**
   * How the repository secret scan uses the rule (scan.ts, FR-101): `token` matches are
   * findings by their shape alone; `context` matches only when the captured value is a plain
   * literal; `config` is `context` limited to configuration files.
   */
  scan?: 'token' | 'context' | 'config';
}

// Patterns are deliberately broad: a false positive costs a masked string, a false negative
// leaks a credential. Each pattern must be global, and must stay linear on any input: redaction
// runs on the event loop over untrusted text (page content, M7 browser review), so every
// repetition that could rescan the text from each start is bounded or anchored (redact-timing
// test).
export const DEFAULT_RULES: readonly RedactionRule[] = [
  {
    id: 'pem',
    // The body never spans another BEGIN marker and is at most 16 KiB (a 4096-bit key is about
    // 3.3 KiB), so a run of BEGIN markers without an END costs one pass, not one per marker.
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S]){0,16384}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
    scan: 'token',
  },
  // A private key cut off before its END line (a truncated paste or log line).
  {
    id: 'pem-header',
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s]*/g,
    scan: 'token',
  },
  {
    id: 'jwt',
    // Starts only where a run of token characters starts (not after a `-` inside one), so a run
    // like `-eyJ-eyJ-…` is scanned once.
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    scan: 'token',
  },
  {
    id: 'bearer',
    pattern: /\b(?<pre>(?:bearer|token)\s+)(?<secret>[A-Za-z0-9._~+/=-]{12,})/gi,
    group: 'secret',
    scan: 'context',
  },
  {
    id: 'authorization-header',
    pattern:
      /\b(?<pre>(?:authorization|x-api-key|api-key|cookie|set-cookie)\s*[:=]\s*)(?<secret>[^\s,;"']{6,}[^\n"']*)/gi,
    group: 'secret',
    scan: 'context',
  },
  {
    id: 'provider-key',
    // `(?:[A-Za-z0-9]+-)*` before the run matched nothing the run does not, and backtracked.
    pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    scan: 'token',
  },
  {
    id: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    scan: 'token',
  },
  { id: 'chat-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, scan: 'token' },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, scan: 'token' },
  { id: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, scan: 'token' },
  // Nova's own bearer tokens (tokens.ts) and enrollment tokens.
  { id: 'nova-token', pattern: /\bnv[sxdmae]_[A-Za-z0-9_-]{20,}/g, scan: 'token' },
  // Common prefixed tokens: source-hosting personal tokens, package registries, model hubs.
  {
    id: 'prefixed-token',
    pattern: /\b(?:glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})\b/g,
    scan: 'token',
  },
  { id: 'payment-key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, scan: 'token' },
  {
    id: 'mail-api-key',
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
    scan: 'token',
  },
  {
    id: 'url-credentials',
    // Anchored on `://` with the scheme behind it: unanchored, dotted text such as `a.a.a.…`
    // rescanned the run from every letter. Schemes are short (nothing real is over 32).
    pattern:
      /(?<=\b[a-z][a-z0-9+.-]{0,31})(?<pre>:\/\/[^\s:/@]{1,256}:)(?<secret>[^\s@/]{1,256})(?=@)/gi,
    group: 'secret',
    scan: 'context',
  },
  {
    id: 'secret-assignment-quoted',
    pattern:
      /(?<pre>\b(?:password|passwd|pwd|secret|api_?key|access_?token|refresh_?token|client_?secret)\b\s*["']?\s*[:=]\s*(?<q>["']))(?<secret>(?:(?!\k<q>)[^\n]){1,4096})(?=\k<q>)/gi,
    group: 'secret',
    scan: 'context',
  },
  {
    id: 'secret-assignment',
    pattern:
      /(?<pre>\b(?:password|passwd|pwd|secret|api_?key|access_?token|refresh_?token|client_?secret)\b\s*["']?\s*[:=]\s*)(?<secret>[^\s"',;]{4,})/gi,
    group: 'secret',
    scan: 'config',
  },
];

export interface RedactorOptions {
  /** Also mask this redactor's literals (a per-session redactor inherits the global one's). */
  literalsFrom?: Redactor;
}

/** Literals shorter than this are ignored unless the caller allows shorter ones. */
const MIN_LITERAL = 4;

export class Redactor {
  readonly #rules: RedactionRule[];
  /** Longest first, so a literal that contains another is masked whole. */
  #literals: string[] = [];
  readonly #parent: Redactor | null;

  constructor(rules: readonly RedactionRule[] = DEFAULT_RULES, opts: RedactorOptions = {}) {
    for (const r of rules) {
      if (!r.pattern.global) throw new TypeError(`redaction rule ${r.id} must use the g flag`);
    }
    this.#rules = [...rules];
    this.#parent = opts.literalsFrom ?? null;
  }

  /**
   * Register a known secret value (for example one just read from the keychain). Values under
   * 4 characters are ignored unless `minLength` allows them (a per-session redactor masks a
   * short password the user typed, at the cost of masking that text everywhere).
   */
  addLiteral(value: string, opts: { minLength?: number } = {}): void {
    if (value.length < Math.max(1, opts.minLength ?? MIN_LITERAL)) return;
    if (this.#literals.includes(value)) return;
    this.#literals = [...this.#literals, value].sort((a, b) => b.length - a.length);
  }

  /** This redactor's literals and the ones it inherits, longest first. */
  #allLiterals(): string[] {
    if (!this.#parent) return this.#literals;
    const all = new Set([...this.#literals, ...this.#parent.#allLiterals()]);
    return [...all].sort((a, b) => b.length - a.length);
  }

  addRule(rule: RedactionRule): void {
    if (!rule.pattern.global) throw new TypeError(`redaction rule ${rule.id} must use the g flag`);
    this.#rules.push(rule);
  }

  /**
   * Mask only the known literals (this redactor's and the inherited ones): for text already
   * redacted, where running the patterns again would mask the `[REDACTED]` markers' neighbours.
   */
  redactLiterals(input: string): string {
    let out = input;
    for (const lit of this.#allLiterals()) out = out.split(lit).join(REDACTED);
    return out;
  }

  redactString(input: string): string {
    let out = this.redactLiterals(input);
    for (const rule of this.#rules) {
      rule.pattern.lastIndex = 0;
      if (rule.group === 'secret' && rule.pattern.source.includes('(?<pre>')) {
        out = out.replace(rule.pattern, `$<pre>${REDACTED}`);
        continue;
      }
      out = out.replace(rule.pattern, (...args: unknown[]) => {
        const match = args[0] as string;
        if (rule.group !== 'secret') return REDACTED;
        const groups = args.at(-1) as Record<string, string | undefined> | undefined;
        const secret = groups?.secret;
        if (!secret) return REDACTED;
        const at = match.lastIndexOf(secret);
        return match.slice(0, at) + REDACTED + match.slice(at + secret.length);
      });
    }
    return out;
  }

  /** Deep-redact a JSON-like value. Keys that name secrets are masked whatever their value. */
  redact<T>(value: T, depth = 0): T {
    if (depth > 32) return REDACTED as unknown as T;
    if (typeof value === 'string') return this.redactString(value) as unknown as T;
    if (Array.isArray(value)) {
      return (value as unknown[]).map((v) => this.redact(v, depth + 1)) as unknown as T;
    }
    if (value instanceof Error) {
      return { name: value.name, message: this.redactString(value.message) } as unknown as T;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] =
          SECRET_KEY.test(k) && v !== null && v !== undefined && v !== ''
            ? REDACTED
            : this.redact(v, depth + 1);
      }
      return out as T;
    }
    return value;
  }
}

const SECRET_KEY =
  /^(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key|x-api-key)$/i;

export const defaultRedactor = new Redactor();
