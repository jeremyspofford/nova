// Small pieces of the fallback and bridge views: a chip that pairs icon and text, and a
// confirmation dialog whose focus starts on Cancel, whose confirm button shows progress, and which
// keeps a refusal in the dialog in plain words (docs/04 §4.4, §6, §7). With `acknowledge`, the
// confirm button stays off until the named risk is ticked (the elevated "all sites" grant).
import { useId, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, Icon, Spinner, type IconName } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { browserDeviceError, type Tone } from './format.ts';

const S = defineMessages('browserDevice.parts', {
  failed: 'That did not work.',
  cancel: 'Cancel',
});

export function Chip({ tone, icon, text }: { tone: Tone; icon: IconName; text: string }) {
  return (
    <span className="nv-chip" data-status={tone === 'neutral' ? undefined : tone}>
      <Icon name={icon} />
      <span>{text}</span>
    </span>
  );
}

export function ConfirmAction({
  title,
  description,
  confirmLabel,
  danger,
  acknowledge,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** A statement the user must tick before the confirm button works. */
  acknowledge?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !acknowledge || ticked;
  const run = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(browserDeviceError(err, S.failed));
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
            {S.cancel}
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
      {acknowledge ? (
        <label className="bdv-ack" htmlFor={`${id}-ack`}>
          <input
            id={`${id}-ack`}
            type="checkbox"
            checked={ticked}
            onChange={(e) => setTicked(e.target.checked)}
          />
          <span>{acknowledge}</span>
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
