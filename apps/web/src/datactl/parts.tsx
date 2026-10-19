// Small pieces the data-controls views share: a loader with retry, an error box, and a confirmation
// dialog for destructive or outward-facing actions whose failure stays in the dialog in plain
// words (docs/04 §4.4, §6, §7).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, Spinner } from '@nova/ui';

export interface Fetched<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (fn: (prev: T | null) => T | null) => void;
}

/** Loads on mount and on `reload`; keeps the last data while it loads again. */
export function useFetched<T>(load: (() => Promise<T>) | null): Fetched<T> {
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
  const enabled = load !== null;
  useEffect(() => {
    const fn = loadRef.current;
    if (!fn) return;
    let alive = true;
    fn().then(
      (data) => alive && setState({ data, error: null, done: true }),
      (error: unknown) => alive && setState((s) => ({ data: s.data, error, done: true })),
    );
    return () => {
      alive = false;
    };
  }, [attempt, enabled]);
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

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="ws-error">
      <p>{message}</p>
      {onRetry ? <Button onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}

/**
 * Confirm an action that deletes or sends something. Cancel has focus first; the confirm button
 * shows progress and can wait for a condition (`ready`, say a typed name); a failure stays in the
 * dialog.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger,
  ready = true,
  onConfirm,
  onClose,
  errorText,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  ready?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  errorText: (err: unknown) => string;
  children?: ReactNode;
}) {
  if (!open) return null;
  return (
    <ConfirmBody
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      danger={danger ?? false}
      ready={ready}
      onConfirm={onConfirm}
      onClose={onClose}
      errorText={errorText}
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
  ready,
  onConfirm,
  onClose,
  errorText,
  children,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger: boolean;
  ready: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  errorText: (err: unknown) => string;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={title}
      description={description}
      onClose={() => {
        if (!busy) onClose();
      }}
      initialFocusRef={cancelRef}
      className="ws-wide-dialog"
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={busy || !ready}
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
