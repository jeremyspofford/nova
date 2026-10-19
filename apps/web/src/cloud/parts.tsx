// Small pieces the M7 work views share (cloud runner, Code M7, flagged features): a state badge
// that pairs an icon with its word (docs/04 §7), facts in a definition list, a usage meter
// against a cap with its warning and capped state, a confirmation for destructive or
// outward-facing actions that keeps its failure on screen, and a back link for sub-pages.
import { useId, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, Icon, Spinner } from '@nova/ui';
import { Badge } from '../code/parts.tsx';
import { followLink } from '../work/nav.tsx';
import { formatSeconds, type StateSpec, type UsageLine } from './format.ts';
import './cloud.css';

export { useLoad, type Loaded } from '../netsurface/parts.tsx';

export function StateBadge({ spec, detail }: { spec: StateSpec; detail?: string | null }) {
  return (
    <Badge tone={spec.tone} icon={spec.icon}>
      {detail ? `${spec.text}: ${detail}` : spec.text}
    </Badge>
  );
}

/** A term and its value, in a definition list (`<dl className="cl-facts">`). */
export function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** One resource used against its cap: a meter, the numbers, and the warning or stop in words. */
export function UsageMeter({ line }: { line: UsageLine }) {
  const id = `um${useId()}`;
  const state = line.capped
    ? 'Stopped at this cap'
    : line.warn
      ? `Near the cap (${Math.round(line.share * 100)} %)`
      : null;
  return (
    <div className="cl-meter" data-state={line.capped ? 'capped' : line.warn ? 'warn' : undefined}>
      <span id={`${id}-l`} className="cl-meter-label">
        {line.label}
      </span>
      <meter
        min={0}
        max={line.cap}
        value={Math.min(line.used, line.cap)}
        low={line.cap * 0.8}
        high={line.cap * 0.99}
        optimum={0}
        aria-labelledby={`${id}-l`}
        aria-describedby={`${id}-t`}
      />
      <span id={`${id}-t`} className="cl-meter-text">
        {formatSeconds(line.used)} of {formatSeconds(line.cap)}
        {state ? (
          <span className="cl-meter-state">
            <Icon name={line.capped ? 'stop' : 'alert'} /> {state}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Confirm a destructive or outward-facing action. The confirm button shows progress; a failure
 * stays in the dialog (in `errorText`'s words) so the user can read it or cancel.
 */
export function ConfirmAction({
  open,
  title,
  description,
  confirmLabel,
  danger,
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
  onConfirm,
  onClose,
  errorText,
  children,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger: boolean;
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
      onClose={onClose}
      initialFocusRef={cancelRef}
      className="ws-wide-dialog"
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose}>
            Cancel
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

/** "← Cloud runner": the way back from a sub-page (full pages on phones, docs/04 §4.3). */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <nav aria-label="Breadcrumb" className="ws-breadcrumb">
      <a href={to} onClick={(e) => followLink(e, to)}>
        <Icon name="back" /> {label}
      </a>
    </nav>
  );
}

/** An in-app link that keeps the browser's behaviour for modified clicks. */
export function InAppLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a href={to} className={className} onClick={(e) => followLink(e, to)}>
      {children}
    </a>
  );
}

/** Untrusted text (logs, file contents, agent output) shown as text, never as HTML. */
export function TextBlock({ text, label }: { text: string; label: string }) {
  return (
    <pre className="cl-pre" aria-label={label} tabIndex={0}>
      {text}
    </pre>
  );
}
