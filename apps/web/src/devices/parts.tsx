// Small pieces shared by the Devices views: a loader with retry, chips that pair icon and text,
// an error box with Retry, an "unavailable because…" note, a confirmation dialog for
// destructive or outward-facing actions (docs/04 §4.4, §6, §7), and copying to the clipboard.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, Icon, Spinner, useToast, type IconName } from '@nova/ui';
import type { DeviceView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { DEVICE_STATUS, deviceErrorMessage, type ChipTone } from './format.ts';

export const PARTS_TEXT = defineMessages('devices.parts', {
  updateRequired: 'Update required',
  retry: 'Retry',
  cancel: 'Cancel',
  failed: 'That did not work.',
  /** What was copied, named in the toast. */
  copied:
    '{what, select, code {Code copied.} link {Link copied.} command {Command copied.} windowsCommand {Windows command copied.} bootToken {Boot token copied.} ipxeAddress {iPXE address copied.} other {Copied.}}',
  copyFailed:
    '{what, select, code {Could not copy. The code is selected; copy it with your keyboard.} link {Could not copy. The link is selected; copy it with your keyboard.} command {Could not copy. The command is selected; copy it with your keyboard.} windowsCommand {Could not copy. The Windows command is selected; copy it with your keyboard.} bootToken {Could not copy. The boot token is selected; copy it with your keyboard.} ipxeAddress {Could not copy. The iPXE address is selected; copy it with your keyboard.} other {Could not copy. The text is selected; copy it with your keyboard.}}',
});

/** What `useCopy` copies, so its toast can name it. */
export type CopyWhat = 'code' | 'link' | 'command' | 'windowsCommand' | 'bootToken' | 'ipxeAddress';

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
export function Chip({
  tone,
  icon,
  text,
}: {
  tone: ChipTone;
  icon: IconName | null;
  text: string;
}) {
  return (
    <span className="nv-chip" data-status={tone === 'neutral' ? undefined : tone}>
      {icon ? <Icon name={icon} /> : <Spinner />}
      <span>{text}</span>
    </span>
  );
}

export function DeviceStatusChip({ status }: { status: DeviceView['status'] }) {
  const s = DEVICE_STATUS[status];
  return <Chip tone={s.tone} icon={s.icon} text={s.text} />;
}

export function UpdateRequiredChip() {
  return <Chip tone="needs_input" icon="alert" text={PARTS_TEXT.updateRequired} />;
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
      <p>{deviceErrorMessage(error, fallback)}</p>
      <Button onClick={onRetry}>{PARTS_TEXT.retry}</Button>
    </div>
  );
}

/** Why a section's actions are off. */
export function Unavailable({ children }: { children: ReactNode }) {
  return (
    <p className="devices-unavailable">
      <Icon name="alert" /> <span>{children}</span>
    </p>
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
  return open ? (
    <ConfirmBody
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      danger={danger}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {children}
    </ConfirmBody>
  ) : null;
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
  danger?: boolean | undefined;
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
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose}>
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
          {deviceErrorMessage(error, PARTS_TEXT.failed)}
        </p>
      ) : null}
    </Dialog>
  );
}

/**
 * Copy text to the clipboard; when the browser refuses, select it on the page (`el`) so the user
 * can copy it with the keyboard. `what` names it in the toast: "Command copied."
 */
export function useCopy(): (text: string, el: HTMLElement | null, what: CopyWhat) => Promise<void> {
  const toast = useToast();
  return useCallback(
    async (text, el, what) => {
      try {
        if (!navigator.clipboard) throw new Error('no clipboard');
        await navigator.clipboard.writeText(text);
        toast.show(PARTS_TEXT.copied({ what }), { tone: 'success' });
      } catch {
        const sel = window.getSelection();
        if (el && sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        toast.show(PARTS_TEXT.copyFailed({ what }), { tone: 'error' });
      }
    },
    [toast],
  );
}
