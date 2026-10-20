// Pseudo-locales (D9), generated from the English source at runtime so they never go stale:
// - `en-XA`: every ASCII letter accented, the message bracketed and about 35 % longer, so
//   untranslated or clipped text stands out;
// - `ar-XB`: right-to-left; every word is wrapped in RLO…PDF (shown mirrored) with RLM marks, so
//   the layout runs right to left while the text stays readable to a tester.
// Only literal text changes: placeholders, plurals, selects and `#` stay intact.
import { parseMessage, serializeMessage, type MessageNode } from './icu.ts';

export const PSEUDO_LOCALES = ['en-XA', 'ar-XB'] as const;
export type PseudoLocale = (typeof PSEUDO_LOCALES)[number];

export function isPseudoLocale(tag: string): tag is PseudoLocale {
  return (PSEUDO_LOCALES as readonly string[]).includes(tag);
}

// prettier-ignore
const ACCENTS: Record<string, string> = {
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ',
  M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ',
  Y: 'Ý', Z: 'Ž', a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ',
  k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ',
  w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
};

/** Right-to-left override, pop directional formatting, right-to-left mark. */
export const RLO = '\u202E';
export const PDF = '\u202C';
export const RLM = '\u200F';

const PADDING = 'one two three four five six seven eight nine ten';

/** Accent every ASCII letter (used for `en-XA` text and for `fmt` output under `en-XA`). */
export function accent(text: string): string {
  return text.replace(/[A-Za-z]/g, (c) => ACCENTS[c] ?? c);
}

/** Wrap each run of letters in RLO…PDF between RLM marks (`ar-XB`). */
export function mirror(text: string): string {
  return text.replace(/[A-Za-z]+(?:['’][A-Za-z]+)*/g, (w) => `${RLM}${RLO}${w}${PDF}${RLM}`);
}

/** The pseudo-locale's transform for plain text that is not a message (fmt output, names). */
export function pseudoText(locale: PseudoLocale, text: string): string {
  return locale === 'en-XA' ? accent(text) : mirror(text);
}

function mapText(nodes: readonly MessageNode[], fn: (s: string) => string): MessageNode[] {
  return nodes.map((n) => {
    if (n.type === 'text') return { type: 'text', value: fn(n.value) };
    if (n.type === 'plural' || n.type === 'select') {
      const options: Record<string, MessageNode[]> = {};
      for (const [k, v] of Object.entries(n.options)) options[k] = mapText(v, fn);
      return { ...n, options };
    }
    return n;
  });
}

function letterCount(nodes: readonly MessageNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.type === 'text') count += n.value.replace(/[^A-Za-z]/g, '').length;
    // A plural or select counts its longest branch.
    if (n.type === 'plural' || n.type === 'select')
      count += Math.max(0, ...Object.values(n.options).map(letterCount));
  }
  return count;
}

/**
 * The pseudo-locale version of a source message, still a valid message with the same
 * placeholders. A message that does not parse is returned unchanged (the check reports it).
 */
export function pseudoLocalize(source: string, locale: PseudoLocale): string {
  let nodes: MessageNode[];
  try {
    nodes = parseMessage(source);
  } catch {
    return source;
  }
  if (locale === 'ar-XB') return serializeMessage(mapText(nodes, mirror));
  const letters = letterCount(nodes);
  if (letters === 0) return source;
  const body = serializeMessage(mapText(nodes, accent));
  const want = Math.ceil(letters * 0.35);
  let pad = '';
  while (pad.replace(/\s/g, '').length < want) pad += (pad ? ' ' : '') + PADDING;
  const words = pad.split(' ');
  let extra = '';
  for (const w of words) {
    if (extra.replace(/\s/g, '').length >= want) break;
    extra += (extra ? ' ' : '') + w;
  }
  return `[${body} ${accent(extra)}]`;
}
