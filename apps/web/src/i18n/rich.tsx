// Render a message whose placeholders are elements (FR-016): `rich(S.pressStop, { stop:
// <strong>{S.stop}</strong>, key: <Kbd keys={…} /> })`. The translation decides the order; the
// elements keep their own messages.
import { Fragment, type ReactNode } from 'react';
import { richMessage } from '@nova/i18n';

export function rich<K extends string>(
  format: (params: Record<K, string>) => string,
  values: Record<K, ReactNode>,
): ReactNode {
  return richMessage(format, values).map((part, i) => <Fragment key={i}>{part}</Fragment>);
}
