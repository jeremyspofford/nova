// Small pieces the offline and sync views share: a chip that pairs icon and text (never color
// alone, docs/04 §7), a confirmation for destructive or outward-facing actions whose failure stays
// in the dialog (docs/04 §4.4), and a copy button that says when the browser refuses.
import { useRef, useState, type ReactNode } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import type { StatusSpec } from './format.ts';

export const PARTS_TEXT = defineMessages('offline.parts', {
  /** A chip's status with a detail: "Pending: 3 changes to pull". */
  withDetail: '{status}: {detail}',
  failed: 'That did not work.',
  cancel: 'Cancel',
  copy: 'Copy',
  copyThe: '{kind, select, answer {Copy the answer} other {Copy the text}}',
  copied: 'Copied.',
  notCopied:
    '{kind, select, answer {Could not copy. Select the answer and copy it yourself.} other {Could not copy. Select the text and copy it yourself.}}',
});

export function Chip({ spec, detail }: { spec: StatusSpec; detail?: string | null }) {
  return (
    <span className="nv-chip" data-status={spec.tone === 'neutral' ? undefined : spec.tone}>
      {spec.icon ? <Icon name={spec.icon} /> : <Spinner />}
      <span>{detail ? PARTS_TEXT.withDetail({ status: spec.text, detail }) : spec.text}</span>
    </span>
  );
}

export function Confirm({
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err, PARTS_TEXT.failed));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={title}
      description={description}
      onClose={onClose}
      initialFocusRef={cancel}
      className="ws-wide-dialog"
      footer={
        <>
          <Button ref={cancel} onClick={onClose}>
            {PARTS_TEXT.cancel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? <Spinner /> : null} {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Copy text; when the browser refuses, say so (the text stays on the page to select). */
export function CopyText({ text, kind }: { text: string; kind: 'text' | 'answer' }) {
  const toast = useToast();
  return (
    <Button
      variant="ghost"
      aria-label={PARTS_TEXT.copyThe({ kind })}
      onClick={() => {
        const fail = () => toast.show(PARTS_TEXT.notCopied({ kind }), { tone: 'error' });
        if (!navigator.clipboard) {
          fail();
          return;
        }
        navigator.clipboard
          .writeText(text)
          .then(() => toast.show(PARTS_TEXT.copied, { tone: 'success' }), fail);
      }}
    >
      <Icon name="copy" /> {PARTS_TEXT.copy}
    </Button>
  );
}
