// A channel's settings, opened from its row (FR-088, FR-110, docs/13 §4): name, who can read it,
// the shared thread for private channels, unknown senders, rate limits and the kind's settings
// (Telegram's delivery mode, an email binding's mailbox); its credentials, write-only (set or not
// set, replaced by name, never shown; ones the Hub makes itself are only shown as set); how
// approvals are answered there; and the inbound address to paste into the other service. Only the
// fields that changed are sent. Turning an email binding's sender check off asks first and sends
// the Hub's `confirmSenderCheckNone` only after the user confirmed. M8: an email binding may sign
// in with OAuth (its provider settings, and the authorization with Authorize and Sign out).
import { useId, useState } from 'react';
import { defineMessages, messageFor } from '@nova/i18n';
import {
  updateChannelBindingSchema,
  type ChannelAudience,
  type ChannelBindingViewM7,
} from '@nova/shared';
import { Button, Dialog, Icon, RadioGroup, SelectField, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { useChannelsApi } from './api.ts';
import {
  APPROVAL_HINT,
  CHANNEL_TEXT,
  CHOICE_HINT,
  CONFIG_KEYS,
  CONFIG_TEXT,
  CREDENTIAL_TEXT,
  GENERATED_CREDENTIALS,
  INBOUND_HINT,
  MAIL_OAUTH_KEYS,
  REF_TEXT,
  absoluteUrl,
  configChoices,
  errorField,
  isConfirmRequired,
  issueErrors,
  midSentence,
  randomSecret,
} from './format.ts';
import { MailOAuthPanel, usesMailOAuth } from './MailOAuth.tsx';
import {
  CopyValue,
  SecretsOnce,
  SenderCheckOffConfirm,
  SenderCheckOffNotice,
  SigningHelp,
} from './parts.tsx';

/** A channel's settings' words (FR-016). Names, ids and the Hub's errors are data. */
export const BINDING_TEXT = defineMessages('channels.binding', {
  form: '{name} settings',
  name: 'Name',
  refValue: '{label}: {value}',
  audience: 'Who can read it',
  private: { label: 'Private', description: 'Only you.' },
  shared: {
    label: 'Shared',
    description: 'Other people read it; private details are checked first.',
  },
  inappPrivate: 'The in-app channel is always private.',
  mainThread: "Use the agent's main thread",
  mainThreadHint: 'Your private channels and the in-app channel share one thread.',
  unknown: 'Answer people Nova does not know',
  unknownHint: 'Off: only people listed under People get answers here.',
  rateLimit: 'Rate limit',
  rateLimitHint: 'The most messages the agent answers here; more are dropped.',
  perMinute: 'Per minute',
  perHour: 'Per hour',
  bot: 'Bot: {name}',
  mailbox: 'Mailbox',
  mailboxHint: 'The mailbox the agent reads and answers from. Mail already in it is never read.',
  webhookNeedsHttps: 'Webhook needs an https public address (below on this page).',
  saving: 'Saving…',
  save: 'Save changes',
  discard: 'Discard',
  saved: '{name} saved.',
  saveFailed: 'Could not save the channel.',
  saveFailedWith: 'Could not save: {error}',
  inbound: 'Inbound address',
  credentials: {
    legend: 'Credentials',
    shared:
      '{kind, select, email {Uses the mailbox of {name}. Replacing one changes it for every channel that uses it.} telegram {Uses the bot of {name}. Replacing one changes it for every channel that uses it.} other {Uses the app of {name}. Replacing one changes it for every channel that uses it.}}',
    kept: 'Kept in the Hub’s secret store; values are never shown.',
    set: 'Set',
    notSet: 'Not set',
    madeByNova: 'Made by Nova',
    replaceLabel: 'Replace {label}',
    replace: 'Replace',
    newLabel: 'New {label}',
    save: 'Save',
    cancel: 'Cancel',
    tooShort: 'Enter at least 8 characters.',
    replaced: '{name} replaced.',
    replaceFailed: 'Could not replace it.',
    rotate: 'New token and secret',
    rotateTitle: 'Make a new token and secret?',
    rotateWhat:
      'The current ones stop working at once. Give the new ones to the service on the other side.',
    rotateConfirm: 'Make new ones',
  },
});

interface Draft {
  label: string;
  audience: ChannelAudience;
  sharePrimaryThread: boolean;
  allowUnknown: boolean;
  perMinute: string;
  perHour: string;
  config: Record<string, string>;
  /** The user confirmed turning the email sender check off (`senderCheck: none`). */
  confirmNone: boolean;
}

function draftOf(b: ChannelBindingViewM7): Draft {
  const config: Record<string, string> = {};
  for (const k of CONFIG_KEYS[b.kind] ?? []) config[k] = b.config[k] ?? '';
  return {
    label: b.label,
    audience: b.audience,
    sharePrimaryThread: b.sharePrimaryThread,
    allowUnknown: b.allowUnknown,
    perMinute: String(b.rateLimit.perMinute),
    perHour: String(b.rateLimit.perHour),
    config,
    confirmNone: false,
  };
}

/** The PATCH body: only what differs from the binding. */
export function settingsPatch(b: ChannelBindingViewM7, d: Draft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (d.label.trim() !== b.label) patch.label = d.label.trim();
  if (d.audience !== b.audience) patch.audience = d.audience;
  const share = d.audience === 'private' && d.sharePrimaryThread;
  if (share !== b.sharePrimaryThread) patch.sharePrimaryThread = share;
  if (d.allowUnknown !== b.allowUnknown) patch.allowUnknown = d.allowUnknown;
  const perMinute = Number(d.perMinute);
  const perHour = Number(d.perHour);
  if (perMinute !== b.rateLimit.perMinute || perHour !== b.rateLimit.perHour)
    patch.rateLimit = { perMinute, perHour };
  const config: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(d.config)) {
    const next = v.trim() ? v.trim() : null;
    if (next !== (b.config[k] ?? null)) config[k] = next;
  }
  if (Object.keys(config).length) patch.config = config;
  return patch;
}

export function BindingSettings({
  binding,
  publicUrl,
  sharedWithLabel,
  onSaved,
}: {
  binding: ChannelBindingViewM7;
  publicUrl: string | null;
  /** The label of the binding whose app credentials this one uses. */
  sharedWithLabel: string | null;
  onSaved: (b: ChannelBindingViewM7) => void;
}) {
  const api = useChannelsApi();
  const toast = useToast();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(binding));
  const [base, setBase] = useState(binding);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [askingNone, setAskingNone] = useState(false);
  // A list refresh hands a new object for the same binding: keep the user's edits. Only a
  // binding that really changed (another save, a connect) resets a form with no edits pending.
  if (base !== binding) {
    setBase(binding);
    const untouched = Object.keys(settingsPatch(base, draft)).length === 0;
    if (base.id !== binding.id || (binding.updatedAt !== base.updatedAt && untouched))
      setDraft(draftOf(binding));
  }
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const patch = settingsPatch(binding, draft);
  const dirty = Object.keys(patch).length > 0;
  const inapp = binding.kind === 'inapp';
  const ref = REF_TEXT[binding.kind];

  /** This save turns the email sender check off (the Hub wants it confirmed). */
  const turningOff =
    binding.kind === 'email' &&
    draft.config.senderCheck === 'none' &&
    binding.config.senderCheck !== 'none';

  const save = async () => {
    if (!dirty || busy) return;
    const parsed = updateChannelBindingSchema.safeParse(patch);
    if (!parsed.success) {
      setErrors(issueErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const next = await api.updateChannel(binding.id, {
        ...parsed.data,
        ...(turningOff && draft.confirmNone ? { confirmSenderCheckNone: true as const } : {}),
      });
      onSaved(next);
      toast.show(BINDING_TEXT.saved({ name: next.label }), { tone: 'success' });
    } catch (err) {
      const field = errorField(err);
      const message = errorMessage(err, BINDING_TEXT.saveFailed);
      if (isConfirmRequired(err)) setErrors({ 'config.senderCheck': CHANNEL_TEXT.confirmRequired });
      else if (field) setErrors({ [field]: message });
      else toast.show(BINDING_TEXT.saveFailedWith({ error: message }), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // An email binding's OAuth settings show only while it signs in with OAuth (M8).
  const oauthDraft = draft.config.auth === 'oauth';
  const keys = (CONFIG_KEYS[binding.kind] ?? []).filter(
    (k) => binding.kind !== 'email' || oauthDraft || !MAIL_OAUTH_KEYS.includes(k),
  );
  const choiceSets = configChoices()[binding.kind];
  const configFields = keys.map((k) => {
    const choices = choiceSets?.[k];
    const value = draft.config[k] ?? '';
    const label = CONFIG_TEXT[k]?.label ?? k;
    if (choices) {
      // A stored value the list does not know stays selectable.
      const options = choices.some((c) => c.value === value)
        ? choices
        : [...choices, { value, label: value }];
      const chosen = choices.find((c) => c.value === value)?.hint;
      return (
        <SelectField
          key={k}
          label={label}
          value={value}
          options={options.map((c) => ({ value: c.value, label: c.label }))}
          hint={
            k === 'mode' && binding.kind === 'telegram'
              ? [chosen, BINDING_TEXT.webhookNeedsHttps].filter(Boolean).join(' ')
              : (CHOICE_HINT[k] ?? chosen)
          }
          error={errors[`config.${k}`]}
          onChange={(v) => {
            // Trusting the From address asks first; the value changes only once confirmed.
            if (k === 'senderCheck' && binding.kind === 'email') {
              if (v === 'none' && binding.config.senderCheck !== 'none' && !draft.confirmNone) {
                setAskingNone(true);
                return;
              }
              setAskingNone(false);
              set({ config: { ...draft.config, [k]: v }, confirmNone: v === 'none' });
              return;
            }
            set({ config: { ...draft.config, [k]: v } });
          }}
        />
      );
    }
    return (
      <TextField
        key={k}
        label={label}
        hint={CONFIG_TEXT[k]?.hint || undefined}
        value={value}
        spellCheck={false}
        autoComplete="off"
        error={errors[`config.${k}`]}
        onChange={(e) => set({ config: { ...draft.config, [k]: e.target.value } })}
      />
    );
  });

  const S = BINDING_TEXT;
  return (
    <div className="ch-settings stack" id={`${id}-settings`}>
      <form
        className="stack"
        aria-label={S.form({ name: binding.label })}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label={S.name}
          value={draft.label}
          maxLength={200}
          error={errors.label}
          onChange={(e) => set({ label: e.target.value })}
        />
        {!inapp ? (
          <p className="ws-flush">
            {rich(S.refValue, {
              label: <span className="muted">{ref.label}</span>,
              value: (
                <code className="ws-code-inline" dir="auto">
                  {binding.externalRef}
                </code>
              ),
            })}
          </p>
        ) : null}
        {!inapp ? (
          <RadioGroup
            legend={S.audience}
            name={`${id}-audience`}
            value={draft.audience}
            onChange={(v) => set({ audience: v as ChannelAudience })}
            options={(['private', 'shared'] as const).map((v) => ({
              value: v,
              label: S[v].label,
              description: S[v].description,
            }))}
          />
        ) : (
          <p className="muted ws-flush">{S.inappPrivate}</p>
        )}
        {inapp || draft.audience === 'private' ? (
          <SwitchField
            label={S.mainThread}
            description={S.mainThreadHint}
            checked={draft.sharePrimaryThread}
            onChange={(v) => set({ sharePrimaryThread: v })}
          />
        ) : (
          <SwitchField
            label={S.unknown}
            description={S.unknownHint}
            checked={draft.allowUnknown}
            onChange={(v) => set({ allowUnknown: v })}
          />
        )}
        {!inapp ? (
          <fieldset className="ws-fieldset">
            <legend>{S.rateLimit}</legend>
            <p className="nv-field-hint ws-flush">{S.rateLimitHint}</p>
            <div className="row">
              <TextField
                label={S.perMinute}
                type="number"
                min={1}
                max={600}
                className="ws-number"
                value={draft.perMinute}
                error={errors['rateLimit.perMinute']}
                onChange={(e) => set({ perMinute: e.target.value })}
              />
              <TextField
                label={S.perHour}
                type="number"
                min={1}
                max={10000}
                className="ws-number"
                value={draft.perHour}
                error={errors['rateLimit.perHour']}
                onChange={(e) => set({ perHour: e.target.value })}
              />
            </div>
          </fieldset>
        ) : null}
        {binding.kind === 'telegram' && binding.config.botUsername ? (
          <p className="ws-flush">
            {rich(S.bot, {
              name: <code className="ws-code-inline">@{binding.config.botUsername}</code>,
            })}
          </p>
        ) : null}
        {binding.kind === 'email' ? (
          <fieldset className="ws-fieldset">
            <legend>{S.mailbox}</legend>
            <p className="nv-field-hint ws-flush">{S.mailboxHint}</p>
            <div className="ch-mail-grid">{configFields}</div>
            {askingNone ? (
              <SenderCheckOffConfirm
                onCancel={() => setAskingNone(false)}
                onConfirm={() => {
                  setAskingNone(false);
                  set({ config: { ...draft.config, senderCheck: 'none' }, confirmNone: true });
                }}
              />
            ) : null}
            {draft.config.senderCheck === 'none' ? <SenderCheckOffNotice /> : null}
          </fieldset>
        ) : (
          configFields
        )}
        {errors.config ? (
          <p role="alert" className="nv-field-error">
            {errors.config}
          </p>
        ) : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={!dirty || busy}>
            {busy ? S.saving : S.save}
          </Button>
          {dirty ? (
            <Button
              onClick={() => {
                setDraft(draftOf(binding));
                setErrors({});
                setAskingNone(false);
              }}
            >
              {S.discard}
            </Button>
          ) : null}
        </div>
      </form>
      {usesMailOAuth(binding) ? <MailOAuthPanel binding={binding} onSaved={onSaved} /> : null}
      {binding.credentials.length ? (
        <Credentials binding={binding} sharedWithLabel={sharedWithLabel} onSaved={onSaved} />
      ) : null}
      {APPROVAL_HINT[binding.kind] ? (
        <p className="muted ws-flush">
          <Icon name="shield" /> {APPROVAL_HINT[binding.kind]}
        </p>
      ) : null}
      {binding.inboundPath ? (
        <div className="stack">
          <CopyValue
            label={S.inbound}
            value={absoluteUrl(binding.inboundPath, publicUrl)}
            hint={INBOUND_HINT[binding.kind]}
          />
          {binding.kind === 'webhook' ? <SigningHelp /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Write-only credentials: set or not set, and a Replace control per name. */
function Credentials({
  binding,
  sharedWithLabel,
  onSaved,
}: {
  binding: ChannelBindingViewM7;
  sharedWithLabel: string | null;
  onSaved: (b: ChannelBindingViewM7) => void;
}) {
  const api = useChannelsApi();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ token: string; secret: string } | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const C = BINDING_TEXT.credentials;
  const nameOf = (name: string) => messageFor(CREDENTIAL_TEXT, name) ?? name;

  const replace = async (credentials: Record<string, string>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateChannel(binding.id, { credentials });
      onSaved(next);
      return true;
    } catch (err) {
      setError(errorMessage(err, C.replaceFailed));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveOne = async (name: string) => {
    if (value.length < 8) {
      setError(C.tooShort);
      return;
    }
    if (await replace({ [name]: value })) {
      setEditing(null);
      setValue('');
      toast.show(C.replaced({ name: nameOf(name) }), { tone: 'success' });
    }
  };

  const rotate = async () => {
    setConfirmRotate(false);
    const next = { token: randomSecret(24), secret: randomSecret(32) };
    if (await replace(next)) setFresh(next);
  };

  return (
    <fieldset className="ws-fieldset">
      <legend>{C.legend}</legend>
      <p className="nv-field-hint ws-flush">
        {sharedWithLabel ? C.shared({ kind: binding.kind, name: sharedWithLabel }) : C.kept}
      </p>
      <ul className="ws-list" aria-label={C.legend}>
        {binding.credentials.map((c) => {
          const label = nameOf(c.name);
          return (
            <li key={c.name} className="ws-list-row">
              <div className="ws-source-main">
                <strong>{label}</strong>
                <span className="ws-badge" data-set={c.set}>
                  {c.set ? (
                    <>
                      <Icon name="check" /> {C.set}
                    </>
                  ) : (
                    <>
                      <Icon name="alert" /> {C.notSet}
                    </>
                  )}
                </span>
              </div>
              {(GENERATED_CREDENTIALS[binding.kind] ?? []).includes(c.name) ? (
                <span className="muted">{C.madeByNova}</span>
              ) : binding.kind !== 'webhook' && editing !== c.name ? (
                <Button
                  variant="ghost"
                  aria-label={C.replaceLabel({ label: midSentence(label) })}
                  onClick={() => {
                    setEditing(c.name);
                    setValue('');
                    setError(null);
                  }}
                >
                  {c.set ? C.replace : C.set}
                </Button>
              ) : null}
              {editing === c.name ? (
                <form
                  className="row ch-replace"
                  aria-label={C.replaceLabel({ label: midSentence(label) })}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveOne(c.name);
                  }}
                >
                  <TextField
                    label={C.newLabel({ label: midSentence(label) })}
                    type="password"
                    autoComplete="new-password"
                    value={value}
                    autoFocus
                    onChange={(e) => setValue(e.target.value)}
                  />
                  <Button type="submit" variant="primary" disabled={busy}>
                    {C.save}
                  </Button>
                  <Button
                    onClick={() => {
                      setEditing(null);
                      setValue('');
                      setError(null);
                    }}
                  >
                    {C.cancel}
                  </Button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
      {binding.kind === 'webhook' ? (
        <div className="row">
          <Button disabled={busy} onClick={() => setConfirmRotate(true)}>
            <Icon name="refresh" /> {C.rotate}
          </Button>
        </div>
      ) : null}
      {fresh ? (
        <SecretsOnce
          items={[
            { label: CREDENTIAL_TEXT.token, value: fresh.token },
            { label: CREDENTIAL_TEXT.secret, value: fresh.secret },
          ]}
        />
      ) : null}
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      <Dialog
        open={confirmRotate}
        title={C.rotateTitle}
        description={C.rotateWhat}
        onClose={() => setConfirmRotate(false)}
        footer={
          <>
            <Button onClick={() => setConfirmRotate(false)}>{C.cancel}</Button>
            <Button variant="danger" onClick={() => void rotate()}>
              {C.rotateConfirm}
            </Button>
          </>
        }
      />
    </fieldset>
  );
}
