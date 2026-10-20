// Small pieces shared by the team views: an error box with Retry that turns the member guard's
// refusal into the owner-only notice, the notice itself, and a confirmation dialog for destructive
// or outward-facing actions (docs/04 §4.4, §6, §7). The loader, chips, copy button and facts are
// the Network surface's (src/netsurface/parts.tsx).
import { useId, useRef, useState, type ReactNode } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, Icon, Spinner } from '@nova/ui';
import { TEAM_TEXT, isOwnerOnly, teamErrorMessage } from './format.ts';

export { Chip, CopyButton, Fact, useLoad, type Loaded } from '../netsurface/parts.tsx';

const PARTS_TEXT = defineMessages('team.parts', {
  belongsWhat: '“{what}” belongs to the whole Hub, so only its owner sees and changes it.',
  belongs: 'This part belongs to the whole Hub, so only its owner sees and changes it.',
  staysYours: 'Your own chats, memory, connectors and settings stay yours.',
  didNotWork: 'That did not work.',
});

/** Shown instead of a part of the Hub a member may not change (decision 5). */
export function OwnerOnlyNotice({ what }: { what?: string }) {
  return (
    <div className="ws-callout team-owner-only" role="note">
      <Icon name="shield" />
      <div className="stack">
        <p className="team-strong">{TEAM_TEXT.ownerOnly}</p>
        <p className="muted">
          {what ? PARTS_TEXT.belongsWhat({ what }) : PARTS_TEXT.belongs} {PARTS_TEXT.staysYours}
        </p>
      </div>
    </div>
  );
}

export function LoadError({
  error,
  fallback,
  onRetry,
  what,
}: {
  error: unknown;
  fallback: string;
  onRetry: () => void;
  /** Names the area in the owner-only notice. */
  what?: string;
}) {
  if (isOwnerOnly(error)) return <OwnerOnlyNotice what={what} />;
  return (
    <div role="alert" className="ws-error">
      <p>{teamErrorMessage(error, fallback)}</p>
      <Button onClick={onRetry}>{TEAM_TEXT.retry}</Button>
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
            {TEAM_TEXT.cancel}
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
          {teamErrorMessage(error, PARTS_TEXT.didNotWork)}
        </p>
      ) : null}
    </Dialog>
  );
}

/** An inline failure under a form or section (text, never HTML). */
export function FormError({ error, fallback }: { error: unknown; fallback: string }) {
  if (!error) return null;
  return (
    <p role="alert" className="nv-field-error">
      {teamErrorMessage(error, fallback)}
    </p>
  );
}

/** A labelled multi-line field, like TextField: hint and error linked to the box. */
export function TextAreaField({
  label,
  hint,
  error,
  value,
  onChange,
  rows = 3,
  maxLength,
  spellCheck,
}: {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  maxLength?: number;
  spellCheck?: boolean;
}) {
  const id = `ta${useId()}`;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="nv-field">
      <label className="nv-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="nv-input ws-textarea"
        rows={rows}
        maxLength={maxLength}
        spellCheck={spellCheck}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <span id={`${id}-hint`} className="nv-field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="nv-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
