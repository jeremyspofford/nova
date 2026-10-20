// A translated sentence with elements inside it (FR-016): the message keeps the whole sentence,
// each element sits at a placeholder. `embed(S.keysIn, { link: <SettingsLink … /> })` for
// 'Your keys are in {link}.' renders "Your keys are in ", the link, "." in any locale's order.
// Strings and numbers among the parts are passed to the message as they are (plural counts).
import { Fragment, type ReactNode } from 'react';

// A private-use character marks where each element goes; it never occurs in messages.
const SLOT = String.fromCharCode(0xe000);
const SPLIT = new RegExp(`${SLOT}(\\d+)${SLOT}`);

export function embed<P extends Record<string, string | number>>(
  message: (params: P) => string,
  parts: { readonly [K in keyof P]: ReactNode },
): ReactNode {
  const entries = Object.entries(parts as Record<string, ReactNode>);
  const params = Object.fromEntries(
    entries.map(([k, v], i) => [
      k,
      typeof v === 'string' || typeof v === 'number' ? v : `${SLOT}${i}${SLOT}`,
    ]),
  ) as P;
  // split with a capture group alternates text and slot indexes: [text, i, text, i, text].
  return message(params)
    .split(SPLIT)
    .map((piece, i) => (
      <Fragment key={i}>{i % 2 === 0 ? piece : entries[Number(piece)]?.[1]}</Fragment>
    ));
}
