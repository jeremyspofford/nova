// A channel's settings, opened from its row (FR-088, docs/13 §4): name, who can read it, the
// shared thread for private channels, unknown senders, rate limits and the kind's settings; its
// credentials, write-only (set or not set, replaced by name, never shown); and the inbound address
// to paste into the other service. Only the fields that changed are sent.
import { useId, useState } from 'react';
import {
  updateChannelBindingSchema,
  type ChannelAudience,
  type ChannelBindingView,
} from '@nova/shared';
import { Button, Dialog, Icon, RadioGroup, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useChannelsApi } from './api.ts';
import {
  CONFIG_KEYS,
  CONFIG_TEXT,
  CREDENTIAL_TEXT,
  INBOUND_HINT,
  REF_TEXT,
  absoluteUrl,
  errorField,
  issueErrors,
  randomSecret,
} from './format.ts';
import { CopyValue, SecretsOnce, SigningHelp } from './parts.tsx';

interface Draft {
  label: string;
  audience: ChannelAudience;
  sharePrimaryThread: boolean;
  allowUnknown: boolean;
  perMinute: string;
  perHour: string;
  config: Record<string, string>;
}

function draftOf(b: ChannelBindingView): Draft {
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
  };
}

/** The PATCH body: only what differs from the binding. */
export function settingsPatch(b: ChannelBindingView, d: Draft): Record<string, unknown> {
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
  binding: ChannelBindingView;
  publicUrl: string | null;
  /** The label of the binding whose app credentials this one uses. */
  sharedWithLabel: string | null;
  onSaved: (b: ChannelBindingView) => void;
}) {
  const api = useChannelsApi();
  const toast = useToast();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(binding));
  const [base, setBase] = useState(binding);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // A newer binding from outside (an event, a connect) resets the form to it.
  if (base !== binding) {
    setBase(binding);
    setDraft(draftOf(binding));
  }
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const patch = settingsPatch(binding, draft);
  const dirty = Object.keys(patch).length > 0;
  const inapp = binding.kind === 'inapp';
  const ref = REF_TEXT[binding.kind];

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
      const next = await api.updateChannel(binding.id, parsed.data);
      onSaved(next);
      toast.show(`${next.label} saved.`, { tone: 'success' });
    } catch (err) {
      const field = errorField(err);
      const message = errorMessage(err, 'Could not save the channel.');
      if (field) setErrors({ [field]: message });
      else toast.show(`Could not save: ${message}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ch-settings stack" id={`${id}-settings`}>
      <form
        className="stack"
        aria-label={`${binding.label} settings`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label="Name"
          value={draft.label}
          maxLength={200}
          error={errors.label}
          onChange={(e) => set({ label: e.target.value })}
        />
        {!inapp ? (
          <p className="ws-flush">
            <span className="muted">{ref.label}: </span>
            <code className="ws-code-inline">{binding.externalRef}</code>
          </p>
        ) : null}
        {!inapp ? (
          <RadioGroup
            legend="Who can read it"
            name={`${id}-audience`}
            value={draft.audience}
            onChange={(v) => set({ audience: v as ChannelAudience })}
            options={[
              { value: 'private', label: 'Private', description: 'Only you.' },
              {
                value: 'shared',
                label: 'Shared',
                description: 'Other people read it; private details are checked first.',
              },
            ]}
          />
        ) : (
          <p className="muted ws-flush">The in-app channel is always private.</p>
        )}
        {inapp || draft.audience === 'private' ? (
          <SwitchField
            label="Use the agent's main thread"
            description="Your private channels and the in-app channel share one thread."
            checked={draft.sharePrimaryThread}
            onChange={(v) => set({ sharePrimaryThread: v })}
          />
        ) : (
          <SwitchField
            label="Answer people Nova does not know"
            description="Off: only people listed under People get answers here."
            checked={draft.allowUnknown}
            onChange={(v) => set({ allowUnknown: v })}
          />
        )}
        {!inapp ? (
          <fieldset className="ws-fieldset">
            <legend>Rate limit</legend>
            <p className="nv-field-hint ws-flush">
              The most messages the agent answers here; more are dropped.
            </p>
            <div className="row">
              <TextField
                label="Per minute"
                type="number"
                min={1}
                max={600}
                className="ws-number"
                value={draft.perMinute}
                error={errors['rateLimit.perMinute']}
                onChange={(e) => set({ perMinute: e.target.value })}
              />
              <TextField
                label="Per hour"
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
        {(CONFIG_KEYS[binding.kind] ?? []).map((k) => (
          <TextField
            key={k}
            label={CONFIG_TEXT[k]?.label ?? k}
            hint={CONFIG_TEXT[k]?.hint}
            value={draft.config[k] ?? ''}
            spellCheck={false}
            autoComplete="off"
            error={errors[`config.${k}`]}
            onChange={(e) => set({ config: { ...draft.config, [k]: e.target.value } })}
          />
        ))}
        <div className="row">
          <Button type="submit" variant="primary" disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
          {dirty ? (
            <Button
              onClick={() => {
                setDraft(draftOf(binding));
                setErrors({});
              }}
            >
              Discard
            </Button>
          ) : null}
        </div>
      </form>
      {binding.credentials.length ? (
        <Credentials binding={binding} sharedWithLabel={sharedWithLabel} onSaved={onSaved} />
      ) : null}
      {binding.inboundPath ? (
        <div className="stack">
          <CopyValue
            label="Inbound address"
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
  binding: ChannelBindingView;
  sharedWithLabel: string | null;
  onSaved: (b: ChannelBindingView) => void;
}) {
  const api = useChannelsApi();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ token: string; secret: string } | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const replace = async (credentials: Record<string, string>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateChannel(binding.id, { credentials });
      onSaved(next);
      return true;
    } catch (err) {
      setError(errorMessage(err, 'Could not replace it.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveOne = async (name: string) => {
    if (value.length < 8) {
      setError('Enter at least 8 characters.');
      return;
    }
    if (await replace({ [name]: value })) {
      setEditing(null);
      setValue('');
      toast.show(`${CREDENTIAL_TEXT[name] ?? name} replaced.`, { tone: 'success' });
    }
  };

  const rotate = async () => {
    setConfirmRotate(false);
    const next = { token: randomSecret(24), secret: randomSecret(32) };
    if (await replace(next)) setFresh(next);
  };

  return (
    <fieldset className="ws-fieldset">
      <legend>Credentials</legend>
      <p className="nv-field-hint ws-flush">
        {sharedWithLabel
          ? `Uses the app of ${sharedWithLabel}. Replacing one changes it for every channel of that app.`
          : 'Kept in the Hub’s secret store; values are never shown.'}
      </p>
      <ul className="ws-list" aria-label="Credentials">
        {binding.credentials.map((c) => {
          const label = CREDENTIAL_TEXT[c.name] ?? c.name;
          return (
            <li key={c.name} className="ws-list-row">
              <div className="ws-source-main">
                <strong>{label}</strong>
                <span className="ws-badge" data-set={c.set}>
                  {c.set ? (
                    <>
                      <Icon name="check" /> Set
                    </>
                  ) : (
                    <>
                      <Icon name="alert" /> Not set
                    </>
                  )}
                </span>
              </div>
              {binding.kind !== 'webhook' && editing !== c.name ? (
                <Button
                  variant="ghost"
                  aria-label={`Replace ${label.toLowerCase()}`}
                  onClick={() => {
                    setEditing(c.name);
                    setValue('');
                    setError(null);
                  }}
                >
                  {c.set ? 'Replace' : 'Set'}
                </Button>
              ) : null}
              {editing === c.name ? (
                <form
                  className="row ch-replace"
                  aria-label={`Replace ${label.toLowerCase()}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveOne(c.name);
                  }}
                >
                  <TextField
                    label={`New ${label.toLowerCase()}`}
                    type="password"
                    autoComplete="new-password"
                    value={value}
                    autoFocus
                    onChange={(e) => setValue(e.target.value)}
                  />
                  <Button type="submit" variant="primary" disabled={busy}>
                    Save
                  </Button>
                  <Button
                    onClick={() => {
                      setEditing(null);
                      setValue('');
                      setError(null);
                    }}
                  >
                    Cancel
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
            <Icon name="refresh" /> New token and secret
          </Button>
        </div>
      ) : null}
      {fresh ? (
        <SecretsOnce
          items={[
            { label: 'Bearer token', value: fresh.token },
            { label: 'Signing secret', value: fresh.secret },
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
        title="Make a new token and secret?"
        description="The current ones stop working at once. Give the new ones to the service on the other side."
        onClose={() => setConfirmRotate(false)}
        footer={
          <>
            <Button onClick={() => setConfirmRotate(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => void rotate()}>
              Make new ones
            </Button>
          </>
        }
      />
    </fieldset>
  );
}
