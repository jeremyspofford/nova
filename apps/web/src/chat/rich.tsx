// Messages with elements inside (FR-016): a link or a <strong> in the middle of a sentence stays
// one message. Each placeholder gets a private-use marker, the translated text is split at the
// markers and the elements go where the translation put them, so word order is the
// translator's: `rich(S.inheritedFrom, { chat: <a href=…>{title}</a> })`.
import { Fragment, type ReactNode } from 'react';

const OPEN = '';
const CLOSE = '';
const MARKER = new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}`);

export function rich<K extends string>(
  message: (params: Record<K, string>) => string,
  nodes: Record<K, ReactNode>,
): ReactNode {
  const params = {} as Record<K, string>;
  for (const k of Object.keys(nodes) as K[]) params[k] = `${OPEN}${k}${CLOSE}`;
  return message(params)
    .split(MARKER)
    .map((part, i) =>
      i % 2 ? <Fragment key={i}>{nodes[part as K]}</Fragment> : part ? part : null,
    );
}
