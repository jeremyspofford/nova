// The ICU MessageFormat subset Nova uses (ADR-097, D9): `{name}`, `{n, plural, =0 {…} one {…}
// other {…}}` with `#`, and `{x, select, a {…} other {…}}`, nested freely. Apostrophes quote as in
// ICU: `''` is one apostrophe and `'{`, `'}` or `'#` start a literal run up to the next lone
// apostrophe; any other apostrophe is literal text ("Don't" needs no escaping).

export type MessageNode =
  | { type: 'text'; value: string }
  | { type: 'arg'; name: string }
  | { type: 'pound' }
  | { type: 'plural'; name: string; options: Record<string, MessageNode[]> }
  | { type: 'select'; name: string; options: Record<string, MessageNode[]> };

export class MessageSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = 'MessageSyntaxError';
    this.offset = offset;
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLURAL_KEYS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const MAX_DEPTH = 8;

/** Parse a message; throws MessageSyntaxError with the offset of the first problem. */
export function parseMessage(source: string): MessageNode[] {
  let i = 0;

  const skipSpace = () => {
    while (i < source.length && /\s/.test(source[i]!)) i++;
  };
  const word = (): string => {
    const start = i;
    while (i < source.length && /[A-Za-z0-9_=-]/.test(source[i]!)) i++;
    return source.slice(start, i);
  };

  const nodes = (inPlural: boolean, depth: number, nested: boolean): MessageNode[] => {
    if (depth > MAX_DEPTH) throw new MessageSyntaxError('messages nest too deeply', i);
    const out: MessageNode[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ type: 'text', value: text });
      text = '';
    };
    while (i < source.length) {
      const c = source[i]!;
      if (c === "'") {
        const next = source[i + 1];
        if (next === "'") {
          text += "'";
          i += 2;
        } else if (next === '{' || next === '}' || (next === '#' && inPlural)) {
          // A quoted literal run up to the next lone apostrophe ('' inside is one apostrophe).
          i++;
          for (;;) {
            if (i >= source.length) throw new MessageSyntaxError('unterminated quote', i);
            if (source[i] === "'") {
              if (source[i + 1] === "'") {
                text += "'";
                i += 2;
                continue;
              }
              i++;
              break;
            }
            text += source[i];
            i++;
          }
        } else {
          text += c;
          i++;
        }
      } else if (c === '{') {
        flush();
        out.push(argument(inPlural, depth));
      } else if (c === '}') {
        if (!nested) throw new MessageSyntaxError('unmatched }', i);
        flush();
        return out;
      } else if (c === '#' && inPlural) {
        flush();
        out.push({ type: 'pound' });
        i++;
      } else {
        text += c;
        i++;
      }
    }
    if (nested) throw new MessageSyntaxError('missing }', i);
    flush();
    return out;
  };

  const argument = (inPlural: boolean, depth: number): MessageNode => {
    const open = i;
    i++; // {
    skipSpace();
    const name = word();
    if (!IDENT.test(name)) throw new MessageSyntaxError('expected an argument name', open + 1);
    skipSpace();
    if (source[i] === '}') {
      i++;
      return { type: 'arg', name };
    }
    if (source[i] !== ',') throw new MessageSyntaxError('expected , or }', i);
    i++;
    skipSpace();
    const kind = word();
    if (kind !== 'plural' && kind !== 'select')
      throw new MessageSyntaxError(`unsupported argument type "${kind}"`, i - kind.length);
    skipSpace();
    if (source[i] !== ',') throw new MessageSyntaxError('expected , after the type', i);
    i++;
    const options: Record<string, MessageNode[]> = {};
    for (;;) {
      skipSpace();
      if (i >= source.length) throw new MessageSyntaxError('missing }', i);
      if (source[i] === '}') {
        i++;
        break;
      }
      const at = i;
      const key = word();
      if (!key) throw new MessageSyntaxError('expected an option key', i);
      if (kind === 'plural' && !/^=\d+$/.test(key) && !PLURAL_KEYS.has(key))
        throw new MessageSyntaxError(`unknown plural category "${key}"`, at);
      if (Object.hasOwn(options, key))
        throw new MessageSyntaxError(`duplicate option "${key}"`, at);
      skipSpace();
      if (source[i] !== '{') throw new MessageSyntaxError('expected { after an option key', i);
      i++;
      options[key] = nodes(kind === 'plural' || inPlural, depth + 1, true);
      i++; // }
    }
    if (!options.other) throw new MessageSyntaxError(`${kind} needs an "other" option`, open);
    return { type: kind, name, options };
  };

  return nodes(false, 0, false);
}

export type ArgKind = 'arg' | 'plural' | 'select';

/** Every argument a message reads, with the strongest kind it is used as (plural > select > arg). */
export function messageArgs(nodes: readonly MessageNode[]): Map<string, ArgKind> {
  const out = new Map<string, ArgKind>();
  const rank: Record<ArgKind, number> = { arg: 0, select: 1, plural: 2 };
  const visit = (list: readonly MessageNode[]) => {
    for (const n of list) {
      if (n.type === 'arg' || n.type === 'plural' || n.type === 'select') {
        const kind: ArgKind = n.type;
        const was = out.get(n.name);
        if (!was || rank[kind] > rank[was]) out.set(n.name, kind);
      }
      if (n.type === 'plural' || n.type === 'select')
        for (const o of Object.values(n.options)) visit(o);
    }
  };
  visit(nodes);
  return out;
}

/** Plural categories and `=N` keys used by the message's plurals, per argument. */
export function pluralKeys(nodes: readonly MessageNode[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (list: readonly MessageNode[]) => {
    for (const n of list) {
      if (n.type === 'plural') {
        const keys = out.get(n.name) ?? new Set<string>();
        for (const k of Object.keys(n.options)) keys.add(k);
        out.set(n.name, keys);
      }
      if (n.type === 'plural' || n.type === 'select')
        for (const o of Object.values(n.options)) visit(o);
    }
  };
  visit(nodes);
  return out;
}

/** Back to message syntax, quoting what would otherwise be read as syntax. */
export function serializeMessage(nodes: readonly MessageNode[], inPlural = false): string {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out += quoteText(n.value, inPlural);
        break;
      case 'arg':
        out += `{${n.name}}`;
        break;
      case 'pound':
        out += '#';
        break;
      case 'plural':
      case 'select': {
        const opts = Object.entries(n.options)
          .map(([k, v]) => `${k} {${serializeMessage(v, inPlural || n.type === 'plural')}}`)
          .join(' ');
        out += `{${n.name}, ${n.type}, ${opts}}`;
        break;
      }
    }
  }
  return out;
}

/**
 * Quote syntax characters as one run: two quoted runs side by side (`'}''}'`) would read back as
 * a quoted apostrophe. An apostrophe is `''` inside a run and outside one alike.
 */
function quoteText(text: string, inPlural: boolean): string {
  let out = '';
  let open = false;
  for (const ch of text) {
    if (ch === '{' || ch === '}' || (ch === '#' && inPlural)) {
      if (!open) out += "'";
      open = true;
      out += ch;
    } else if (ch === "'") {
      out += "''";
    } else {
      if (open) out += "'";
      open = false;
      out += ch;
    }
  }
  return open ? `${out}'` : out;
}

export type MessageParams = Readonly<Record<string, string | number>>;

interface FormatContext {
  locale: string;
  params: MessageParams | undefined;
  plurals: (locale: string) => Intl.PluralRules;
  number: (locale: string) => Intl.NumberFormat;
}

/**
 * Format a parsed message. A missing argument shows as `{name}` so the gap is visible instead of
 * crashing the screen; numbers format in `locale`.
 */
export function formatNodes(
  nodes: readonly MessageNode[],
  ctx: FormatContext,
  pound: number | null = null,
): string {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out += n.value;
        break;
      case 'pound':
        out += pound === null ? '#' : ctx.number(ctx.locale).format(pound);
        break;
      case 'arg': {
        const v = ctx.params?.[n.name];
        out +=
          v === undefined || v === null
            ? `{${n.name}}`
            : typeof v === 'number'
              ? ctx.number(ctx.locale).format(v)
              : String(v);
        break;
      }
      case 'plural': {
        const raw = ctx.params?.[n.name];
        const value = typeof raw === 'number' ? raw : Number(raw);
        if (raw === undefined || raw === null || !Number.isFinite(value)) {
          out += `{${n.name}}`;
          break;
        }
        const exact = n.options[`=${value}`];
        const branch =
          exact ?? n.options[ctx.plurals(ctx.locale).select(value)] ?? n.options.other ?? [];
        out += formatNodes(branch, ctx, value);
        break;
      }
      case 'select': {
        const raw = ctx.params?.[n.name];
        if (raw === undefined || raw === null) {
          out += `{${n.name}}`;
          break;
        }
        const key = String(raw);
        const branch = (Object.hasOwn(n.options, key) ? n.options[key] : n.options.other) ?? [];
        out += formatNodes(branch, ctx, pound);
        break;
      }
    }
  }
  return out;
}
