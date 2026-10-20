// What an extension's command returned, when one line of a toast does not hold it (FR-117; docs/26
// §9.3): the toast offers "Show the result", and this dialog shows the whole of it, a long text as
// written and anything else as formatted JSON (the extension's data, never translated). One dialog
// for the whole shell: it sits with the status bar, which the workspace always renders.
import { useSyncExternalStore } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog } from '@nova/ui';

export const RESULT_TEXT = defineMessages('extensions.result', {
  /** `title` is the command's title, as the extension wrote it. */
  title: 'Result of {title}',
  content: 'The result',
  close: 'Close',
});

interface Shown {
  title: string;
  full: { text: string; json: boolean };
}

let shown: Shown | null = null;
const subs = new Set<() => void>();

function set(next: Shown | null): void {
  shown = next;
  for (const fn of [...subs]) fn();
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};
const snapshot = () => shown;

/** Open the dialog with a command's whole result. */
export function showCommandResult(title: string, full: Shown['full']): void {
  set({ title, full });
}

/** The dialog of the last result asked for, while it is open. */
export function CommandResultDialog() {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!s) return null;
  const close = () => set(null);
  return (
    <Dialog
      open
      title={RESULT_TEXT.title({ title: s.title })}
      onClose={close}
      className="ws-wide-dialog"
      // The toast's button that opened it is gone by then.
      fallbackFocus={() => document.getElementById('main')}
      footer={<Button onClick={close}>{RESULT_TEXT.close}</Button>}
    >
      <div className="ext-result" role="region" aria-label={RESULT_TEXT.content} tabIndex={0}>
        {s.full.json ? (
          <pre dir="ltr">
            <code>{s.full.text}</code>
          </pre>
        ) : (
          <p className="ext-result-text" dir="auto">
            {s.full.text}
          </p>
        )}
      </div>
    </Dialog>
  );
}
