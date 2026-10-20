// Small pieces shared by the Network surface's sections: a loader with retry, chips that pair
// icon and text, an error box with Retry, a confirmation dialog
// for destructive or outward-facing actions (docs/04 §4.4, §6, §7) and a copy button.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, Icon, Spinner, useToast } from '@nova/ui';
import { NET_TEXT, netErrorMessage, type ChipSpec } from './format.ts';

export const PARTS_TEXT = defineMessages('netsurface.parts', {
  retry: 'Retry',
  cancel: 'Cancel',
  failed: 'That did not work.',
  copy: 'Copy',
  copyWhat: 'Copy {what}',
  copiedWhat: '{what} copied.',
  copyFailedWhat: 'Could not copy. Select the {what} and copy it yourself.',
});
const S = PARTS_TEXT;

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (fn: (prev: T | null) => T | null) => void;
}

/** Loads on mount and whenever `key` changes; `reload` loads again and keeps what it had. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown; done: boolean }>({
    data: null,
    error: null,
    done: false,
  });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    let alive = true;
    loadRef.current().then(
      (data) => alive && setState({ data, error: null, done: true }),
      (error: unknown) => alive && setState((s) => ({ data: s.data, error, done: true })),
    );
    return () => {
      alive = false;
    };
  }, [key, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const setData = useCallback(
    (fn: (prev: T | null) => T | null) => setState((s) => ({ ...s, data: fn(s.data) })),
    [],
  );
  return {
    data: state.data,
    error: state.error,
    loading: !state.done && state.data === null,
    reload,
    setData,
  };
}

/** A chip: icon plus text, never color alone (docs/04 §7). */
export function Chip({ spec, detail }: { spec: ChipSpec; detail?: string | null }) {
  return (
    <span className="nv-chip" data-status={spec.tone === 'neutral' ? undefined : spec.tone}>
      {spec.icon ? <Icon name={spec.icon} /> : <Spinner />}
      <span>{detail ? NET_TEXT.chipDetail({ text: spec.text, detail }) : spec.text}</span>
    </span>
  );
}

export function LoadError({
  error,
  fallback,
  onRetry,
}: {
  error: unknown;
  fallback: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="ws-error">
      <p>{netErrorMessage(error, fallback)}</p>
      <Button onClick={onRetry}>{S.retry}</Button>
    </div>
  );
}

/**
 * Confirm a destructive or outward-facing action. The confirm button shows progress; a failure
 * stays in the dialog so the user can read it or cancel.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  if (!open) return null;
  return (
    <ConfirmBody
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      danger={danger ?? false}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {children}
    </ConfirmBody>
  );
}

function ConfirmBody({
  title,
  description,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={title}
      description={description}
      onClose={onClose}
      initialFocusRef={cancelRef}
      className="ws-wide-dialog"
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose}>
            {S.cancel}
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
          {netErrorMessage(error, S.failed)}
        </p>
      ) : null}
    </Dialog>
  );
}

/** The words of a copy button: its accessible name and the two toasts. */
export interface CopyText {
  copy: string;
  copied: string;
  failed: string;
}

/**
 * Copy a value; when the browser refuses, say so (the value stays on the page to select). Pass
 * `text` (whole messages); `what` (a noun, put into "Copy {what}" lower-cased) is for callers
 * not converted yet.
 */
export function CopyButton({
  value,
  what,
  text,
}: { value: string } & ({ text: CopyText; what?: never } | { what: string; text?: never })) {
  const toast = useToast();
  const t: CopyText = text ?? {
    copy: S.copyWhat({ what: (what ?? '').toLowerCase() }),
    copied: S.copiedWhat({ what: what ?? '' }),
    failed: S.copyFailedWhat({ what: (what ?? '').toLowerCase() }),
  };
  return (
    <Button
      variant="ghost"
      aria-label={t.copy}
      onClick={() => {
        const done = () => toast.show(t.copied, { tone: 'success' });
        const fail = () => toast.show(t.failed, { tone: 'error' });
        if (!navigator.clipboard) {
          fail();
          return;
        }
        navigator.clipboard.writeText(value).then(done, fail);
      }}
    >
      <Icon name="copy" /> {S.copy}
    </Button>
  );
}

/** A term and its value, in a definition list. */
export function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
