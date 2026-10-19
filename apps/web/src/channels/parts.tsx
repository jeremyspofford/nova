// Small pieces shared by the channels, triggers and routing views: a status chip from a spec
// (icon plus text, never color alone, docs/04 §7), a copyable value, and the block that shows a
// secret once.
import { useId, useRef } from 'react';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { SENDER_CHECK_OFF_TEXT, copyText, type ChipSpec } from './format.ts';

export function Chip({ spec, detail }: { spec: ChipSpec; detail?: string | null }) {
  return (
    <span className="nv-chip" data-status={spec.tone}>
      {spec.icon ? <Icon name={spec.icon} /> : <Spinner />}
      <span>{detail ? `${spec.text}: ${detail}` : spec.text}</span>
    </span>
  );
}

/** A value to paste somewhere else, with a Copy button that falls back to selecting it. */
export function CopyValue({
  label,
  value,
  hint,
  secret,
}: {
  label: string;
  value: string;
  hint?: string;
  /** A secret: the copy toast does not repeat it and the text is not spell-checked. */
  secret?: boolean;
}) {
  const toast = useToast();
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const copy = async () => {
    if (await copyText(value)) {
      toast.show(`${label} copied.`, { tone: 'success' });
      return;
    }
    const el = ref.current;
    const sel = window.getSelection();
    if (el && sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    toast.show(
      `Could not copy. The ${label.toLowerCase()} is selected; copy it with your keyboard.`,
      {
        tone: 'error',
      },
    );
  };
  return (
    <div className="ch-copy" role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className="nv-field-label">
        {label}
      </span>
      <div className="ch-copy-row">
        <code
          ref={ref}
          className="ch-copy-value"
          aria-describedby={hint ? `${id}-hint` : undefined}
          spellCheck={secret ? false : undefined}
        >
          {value}
        </code>
        <Button onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>
          <Icon name="copy" /> Copy
        </Button>
      </div>
      {hint ? (
        <span id={`${id}-hint`} className="nv-field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Secrets generated in the browser and stored by the Hub: shown here once, never again. */
export function SecretsOnce({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="ch-once" role="region" aria-label="Shown once">
      <p className="ch-once-head">
        <Icon name="shield" /> Copy these now. They are shown only once; Nova keeps them in its
        secret store and never shows them again.
      </p>
      {items.map((i) => (
        <CopyValue key={i.label} label={i.label} value={i.value} secret />
      ))}
    </div>
  );
}

/** A labelled multi-line text field with a hint and an error, like TextField. */
export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  maxLength,
  spellCheck,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  placeholder?: string;
  maxLength?: number;
  spellCheck?: boolean;
}) {
  const id = `ta${useId()}`;
  const describedBy =
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className="nv-field">
      <label className="nv-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="nv-input ws-textarea"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        spellCheck={spellCheck}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
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

/** How a signed request is made (webhook channels and webhook triggers). */
export function SigningHelp({ eventId }: { eventId?: boolean }) {
  return (
    <details className="ws-advanced">
      <summary>How to sign a request</summary>
      <ul className="ch-help">
        <li>
          Send <code>Authorization: Bearer &lt;token&gt;</code>.
        </li>
        <li>
          Send <code>x-nova-timestamp</code> with the current time in Unix seconds; requests more
          than five minutes off are refused.
        </li>
        <li>
          Send <code>x-nova-signature: sha256=&lt;hex&gt;</code>, the HMAC-SHA256 of{' '}
          <code>&lt;timestamp&gt;.&lt;body&gt;</code> made with the secret.
        </li>
        {eventId ? (
          <li>
            Optionally send <code>x-nova-event-id</code>; an id seen before starts nothing.
          </li>
        ) : (
          <li>
            Give each message its own <code>id</code>; a message id seen before is ignored.
          </li>
        )}
      </ul>
    </details>
  );
}

/**
 * The confirmation turning an email binding's sender check off needs (the Hub refuses it
 * unconfirmed). Inline, so it works inside the Add channel dialog; Keep checking is focused.
 */
export function SenderCheckOffConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  return (
    <div
      className="ws-callout ch-confirm"
      role="group"
      aria-labelledby={`${id}-q`}
      aria-describedby={`${id}-d`}
    >
      <p id={`${id}-q`} className="ws-flush">
        <strong>Trust the From address?</strong>
      </p>
      <p id={`${id}-d`} className="ws-flush">
        {SENDER_CHECK_OFF_TEXT}
      </p>
      <div className="row">
        <Button autoFocus onClick={onCancel}>
          Keep checking senders
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          Trust the From address
        </Button>
      </div>
    </div>
  );
}

/** Shown while an email binding's sender check is (to be) off. */
export function SenderCheckOffNotice() {
  return (
    <p className="ws-warning ch-check-off" role="note">
      <Icon name="alert" /> The sender check is off: anyone can write as a known sender.
    </p>
  );
}
