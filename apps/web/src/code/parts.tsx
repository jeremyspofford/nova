// Small pieces the M6 Code views share: a state badge that pairs an icon with its word (never
// color alone, docs/04 §7), a confirmation dialog for destructive or outward-facing actions, and
// an error banner with Retry.
import type { ReactNode } from 'react';
import { Button, Dialog, Icon, Spinner, type IconName } from '@nova/ui';
import type { Tone } from './m6-format.ts';
import './code.css';

export function Badge({
  tone,
  icon,
  children,
}: {
  tone: Tone;
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <span className="code-badge" data-tone={tone}>
      <Icon name={icon} /> {children}
    </span>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="ws-error">
      <p>{message}</p>
      {onRetry ? <Button onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}

/** Asks before an action that removes something or reaches outside (docs/04 §2.6, §6). */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger,
  busy,
  error,
  children,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
            {busy ? <Spinner /> : null} {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
