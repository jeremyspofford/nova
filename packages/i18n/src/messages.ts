// `defineMessages` (D9): messages are declared next to the code that shows them, as a literal
// object under a repo-unique namespace. The result is typed from the literal: a message without
// placeholders reads as a string (`S.title`), a message with placeholders is a function taking
// exactly those (`S.resets({ date })`); plural arguments take a number, select arguments a
// string, plain `{name}` arguments a string or a number. Objects nest (`S.kind.editor.label`), and
// each read translates in the active locale.
import { messageArgs } from './icu.ts';
import { parsedMessage, translate } from './locale.ts';

/** A literal message tree: keys to messages or to nested trees. */
export interface MessageTree {
  readonly [key: string]: string | MessageTree;
}

// ---- placeholder extraction at the type level ---------------------------------------------------

// prettier-ignore
type IdentChar =
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p'
  | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
  | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V'
  | 'W' | 'X' | 'Y' | 'Z' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '_';

type IsIdent<S extends string> = S extends ''
  ? false
  : S extends `${infer C}${infer R}`
    ? C extends IdentChar
      ? R extends ''
        ? true
        : IsIdent<R>
      : false
    : false;

type Space = ' ' | '\n' | '\t' | '\r';
type Trim<S extends string> = S extends `${Space}${infer R}`
  ? Trim<R>
  : S extends `${infer R}${Space}`
    ? Trim<R>
    : S;

/** Drop quoted literal runs (`'{…'`, `'}…'`, `'#…'`) and escaped apostrophes (`''`). */
type Unquote<S extends string, Acc extends string = ''> = S extends `${infer A}'${infer B}`
  ? B extends `'${infer C}`
    ? Unquote<C, `${Acc}${A}`>
    : B extends `{${string}` | `}${string}` | `#${string}`
      ? B extends `${string}'${infer C}`
        ? Unquote<C, `${Acc}${A}`>
        : `${Acc}${A}`
      : Unquote<B, `${Acc}${A}'`>
  : `${Acc}${S}`;

/** The first brace in `S`: `['{' | '}', what follows it]`, or `[]` when there is none. */
type NextBrace<S extends string> = S extends `${infer A}{${infer B}`
  ? A extends `${string}}${infer A2}`
    ? ['}', `${A2}{${B}`]
    : ['{', B]
  : S extends `${string}}${infer B}`
    ? ['}', B]
    : [];

type Frame = 'body' | 'options';

/**
 * Walk the message brace by brace with a stack of frames: in a body a `{` starts an argument
 * (`{name}` or `{name, kind, options}`); in an argument's options a `{` starts an option's body.
 * Collects `[name, kind]` for every argument.
 */
type Walk<S extends string, Stack extends Frame[], Acc = never> = Stack extends [
  ...infer Outer extends Frame[],
  infer Top,
]
  ? NextBrace<S> extends ['{', infer B extends string]
    ? Top extends 'options'
      ? Walk<B, [...Stack, 'body'], Acc>
      : B extends `${infer Head}}${infer R}`
        ? Head extends `${string},${string}`
          ? B extends `${infer Name},${infer Kind},${infer R2}`
            ? Walk<R2, [...Stack, 'options'], Acc | [Trim<Name>, Trim<Kind>]>
            : Acc
          : Walk<R, Stack, IsIdent<Trim<Head>> extends true ? Acc | [Trim<Head>, 'arg'] : Acc>
        : Acc
    : NextBrace<S> extends ['}', infer R extends string]
      ? Walk<R, Outer, Acc>
      : Acc
  : Acc;

type Entries<S extends string> = Walk<S, ['body']>;

type KindsOf<E, N> = E extends [N, infer K] ? K : never;
type ParamOf<K> = 'plural' extends K ? number : 'select' extends K ? string : string | number;

/** The names of a message's placeholders (never when it has none). */
export type MessageArgNames<S extends string> = NamesOf<Entries<Unquote<S>>>;
type NamesOf<E> = E extends [infer N, unknown] ? N : never;

/** The params object a message takes. */
export type MessageParamsOf<S extends string> = {
  [N in MessageArgNames<S> & string]: ParamOf<KindsOf<Entries<Unquote<S>>, N>>;
};

/** What `defineMessages` returns for a tree. */
export type Messages<M> = {
  readonly [K in keyof M]: M[K] extends string
    ? [MessageArgNames<M[K]>] extends [never]
      ? string
      : (params: MessageParamsOf<M[K]>) => string
    : Messages<M[K]>;
};

// ---- runtime ------------------------------------------------------------------------------------

/** Every message declared so far: id → English source. */
const declared = new Map<string, string>();

export const NAMESPACE_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
export const KEY_PATTERN = /^[^.\s]+$/;

/**
 * Declare an area's messages. `namespace` must be unique across the repo (`npm run i18n:check`
 * enforces it); ids are `<namespace>.<key>` with nested keys joined by dots. Pass a literal
 * object: the check reads it statically to write the English catalog.
 */
export function defineMessages<const M extends MessageTree>(
  namespace: string,
  messages: M,
): Messages<M> {
  if (!NAMESPACE_PATTERN.test(namespace))
    throw new Error(`invalid message namespace "${namespace}"`);
  return build(namespace, '', messages) as Messages<M>;
}

function build(namespace: string, prefix: string, tree: MessageTree): object {
  const out = {};
  for (const [k, value] of Object.entries(tree)) {
    if (!KEY_PATTERN.test(k)) throw new Error(`invalid message key "${k}" in ${namespace}`);
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof value !== 'string') {
      Object.defineProperty(out, k, { value: build(namespace, key, value), enumerable: true });
      continue;
    }
    declared.set(`${namespace}.${key}`, value);
    const nodes = parsedMessage(value);
    const hasArgs = nodes !== null && messageArgs(nodes).size > 0;
    Object.defineProperty(
      out,
      k,
      hasArgs
        ? {
            value: (params: Readonly<Record<string, string | number>>) =>
              translate(namespace, key, value, params),
            enumerable: true,
          }
        : { get: () => translate(namespace, key, value), enumerable: true },
    );
  }
  return Object.freeze(out);
}

/**
 * The plain message under `key` in a group, or undefined for a key the group does not have: for
 * lookups by a value from elsewhere (an error code, a route name).
 * `messageFor(S.reason, code) ?? S.reasonOther`.
 */
export function messageFor(group: object, key: string): string | undefined {
  if (!Object.hasOwn(group, key)) return undefined;
  const value: unknown = (group as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

// Private-use markers around a placeholder's name: no translation or pseudo-locale touches them.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);

// Bivariant on purpose: a message's params type names its own placeholders (`{n: number}`).
type RichFormat<K extends string> = {
  bivariant(params: Record<K, string | number>): string;
}['bivariant'];

/**
 * A message whose placeholders are elements (a link, a key cap, emphasis) rather than text: the
 * translated text pieces with each value where its placeholder falls, in the translation's order.
 * `richMessage(S.pressStop, { stop: <strong>…</strong>, key: <Kbd … /> })`; the web wraps it in
 * `rich()` to render. Strings and numbers among the values go into the message as they are, so a
 * plural or select placeholder still chooses its branch; only elements become pieces.
 */
export function richMessage<K extends string, V>(
  format: RichFormat<K>,
  values: Record<K, V | string | number>,
): Array<string | V> {
  const names = Object.keys(values) as K[];
  const markers = {} as Record<K, string | number>;
  for (const n of names) {
    const v = values[n];
    markers[n] = typeof v === 'string' || typeof v === 'number' ? v : `${OPEN}${n}${CLOSE}`;
  }
  const out: Array<string | V> = [];
  const pattern = new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}`, 'g');
  const text = format(markers);
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const name = m[1] as K;
    out.push(Object.hasOwn(values, name) ? (values[name] as V) : m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The English source of every message declared so far, by id (for tests and tooling). */
export function declaredMessages(): ReadonlyMap<string, string> {
  return declared;
}
