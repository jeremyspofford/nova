// The string half of the localization check (FR-016), without the DOM: what is left of a text
// after removing what may stay as it is (fixture data, pseudo-locale mirrored words, URLs, ids
// and the product name). Any plain ASCII letter left over did not come through messages.
import { PDF, RLM, RLO } from './pseudo.ts';

const MIRRORED = new RegExp(`${RLM}?${RLO}[^${PDF}]*${PDF}${RLM}?`, 'g');
const URL_LIKE = /\b(?:https?|wss?):\/\/\S+/g;
const ID_LIKE = /\b[a-z][a-z0-9-]*:[\w./@-]+/g;
const PRODUCT = /\bNova\b/g;
// U+2063 INVISIBLE SEPARATOR: not a letter, not white space.
const DATA_MARK = String.fromCharCode(0x2063);
/** What is left of `text` after removing everything allowed; any ASCII letter there is a miss. */
export function unlocalizedResidue(text: string, data: readonly string[] = []): string {
  // Fixture data becomes an invisible non-space mark, not a space: a host listed as data inside a
  // URL then leaves an address that still reads as one (`https://<mark>/x`).
  let t = text;
  for (const d of [...data].filter(Boolean).sort((a, b) => b.length - a.length))
    t = t.split(d).join(DATA_MARK);
  return t
    .replace(MIRRORED, ' ')
    .replace(URL_LIKE, ' ')
    .replace(ID_LIKE, ' ')
    .replace(PRODUCT, ' ')
    .split(DATA_MARK)
    .join(' ');
}

export function isUnlocalized(text: string, data: readonly string[] = []): boolean {
  return /[A-Za-z]/.test(unlocalizedResidue(text, data));
}
