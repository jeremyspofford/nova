// Small pieces shared by the channels, triggers and routing views: a status chip from a spec
// (icon plus text, never color alone, docs/04 §7), a copyable value, and the block that shows a
// secret once.
import { useId, useRef } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { rich } from '../i18n/rich.tsx';
import { CHANNEL_TEXT, copyText, midSentence, type ChipSpec } from './format.ts';

/** The shared pieces' words (FR-016). Header names and code stay as they are. */
export const PARTS_TEXT = defineMessages('channels.parts', {
  copied: '{label} copied.',
  copyFailed: 'Could not copy. The {label} is selected; copy it with your keyboard.',
  copyLabel: 'Copy {label}',
  copy: 'Copy',
  shownOnce: 'Shown once',
  onceHead:
    'Copy these now. They are shown only once; Nova keeps them in its secret store and never shows them again.',
  signing: {
    summary: 'How to sign a request',
    bearer: 'Send {header}.',
    timestamp:
      'Send {header} with the current time in Unix seconds; requests more than five minutes off are refused.',
    signature: 'Send {header}, the HMAC-SHA256 of {payload} made with the secret.',
    eventId: 'Optionally send {header}; an id seen before starts nothing.',
    messageId: 'Give each message its own {field}; a message id seen before is ignored.',
  },
  trustQuestion: 'Trust the From address?',
  keepChecking: 'Keep checking senders',
  trust: 'Trust the From address',
  checkOff: 'The sender check is off: anyone can write as a known sender.',
});

export function Chip({ spec, detail }: { spec: ChipSpec; detail?: string | null }) {
  return (
    <span className="nv-chip" data-status={spec.tone}>
      {spec.icon ? <Icon name={spec.icon} /> : <Spinner />}
      <span>{detail ? CHANNEL_TEXT.chipDetail({ status: spec.text, detail }) : spec.text}</span>
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
      toast.show(PARTS_TEXT.copied({ label }), { tone: 'success' });
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
    toast.show(PARTS_TEXT.copyFailed({ label: midSentence(label) }), { tone: 'error' });
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
          dir="ltr"
        >
          {value}
        </code>
        <Button
          onClick={() => void copy()}
          aria-label={PARTS_TEXT.copyLabel({ label: midSentence(label) })}
        >
          <Icon name="copy" /> {PARTS_TEXT.copy}
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
    <div className="ch-once" role="region" aria-label={PARTS_TEXT.shownOnce}>
      <p className="ch-once-head">
        <Icon name="shield" /> {PARTS_TEXT.onceHead}
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

/** The signing protocol's header names and formats: code, never translated. */
export const SIGNING = {
  bearer: 'Authorization: Bearer <token>',
  timestamp: 'x-nova-timestamp',
  signature: 'x-nova-signature: sha256=<hex>',
  payload: '<timestamp>.<body>',
  /** What a schedule's delivery signs. */
  deliveryPayload: '<x-nova-timestamp>.<body>',
  eventId: 'x-nova-event-id',
  messageId: 'id',
} as const;

/** How a signed request is made (webhook channels and webhook triggers). */
export function SigningHelp({ eventId }: { eventId?: boolean }) {
  const S = PARTS_TEXT.signing;
  return (
    <details className="ws-advanced">
      <summary>{S.summary}</summary>
      <ul className="ch-help">
        <li>{rich(S.bearer, { header: <code>{SIGNING.bearer}</code> })}</li>
        <li>{rich(S.timestamp, { header: <code>{SIGNING.timestamp}</code> })}</li>
        <li>
          {rich(S.signature, {
            header: <code>{SIGNING.signature}</code>,
            payload: <code>{SIGNING.payload}</code>,
          })}
        </li>
        {eventId ? (
          <li>{rich(S.eventId, { header: <code>{SIGNING.eventId}</code> })}</li>
        ) : (
          <li>{rich(S.messageId, { field: <code>{SIGNING.messageId}</code> })}</li>
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
        <strong>{PARTS_TEXT.trustQuestion}</strong>
      </p>
      <p id={`${id}-d`} className="ws-flush">
        {CHANNEL_TEXT.senderCheckOff}
      </p>
      <div className="row">
        <Button autoFocus onClick={onCancel}>
          {PARTS_TEXT.keepChecking}
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          {PARTS_TEXT.trust}
        </Button>
      </div>
    </div>
  );
}

/** Shown while an email binding's sender check is (to be) off. */
export function SenderCheckOffNotice() {
  return (
    <p className="ws-warning ch-check-off" role="note">
      <Icon name="alert" /> {PARTS_TEXT.checkOff}
    </p>
  );
}
