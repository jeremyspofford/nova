// Add a channel (FR-088, FR-110, docs/13 §4): pick a kind the Hub offers (unavailable kinds say
// why), then its conversation, agent, audience and credentials. Credentials are write-only: Slack,
// Teams and Telegram take the app's (bot's) secrets or reuse another binding's; email takes the
// mailbox's servers and password (and optionally its Authentication-Results name) or reuses
// another binding's mailbox, and trusting the From address alone asks first; a webhook gets a
// token and secret made here and shown once after it is created. The last step shows the inbound address to
// paste into the other service. The body is checked with the Hub's own schema before it is sent.
import { useId, useState } from 'react';
import {
  createChannelBindingM7Schema,
  type AgentView,
  type ChannelAdapterViewM7,
  type ChannelAudience,
  type ChannelBindingViewM7,
  type ChannelKindM7,
} from '@nova/shared';
import { Button, Dialog, Icon, RadioGroup, SelectField, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useChannelsApi } from './api.ts';
import {
  APPROVAL_HINT,
  BINDING_STATUS,
  CHOICE_HINT,
  CONFIG_TEXT,
  CONFIRM_REQUIRED_TEXT,
  CONFIG_CHOICES,
  INBOUND_HINT,
  KIND_HINT,
  KIND_TEXT,
  REF_TEXT,
  absoluteUrl,
  errorField,
  isConfirmRequired,
  issueErrors,
  plainMailAllowed,
  randomSecret,
  sentence,
} from './format.ts';
import {
  Chip,
  CopyValue,
  SecretsOnce,
  SenderCheckOffConfirm,
  SenderCheckOffNotice,
  SigningHelp,
} from './parts.tsx';

const CONFIRM_REQUIRED_SHARED =
  'That mailbox trusts the From address. Confirm it above, or choose another mailbox.';

interface Form {
  kind: ChannelKindM7 | null;
  agentId: string;
  label: string;
  externalRef: string;
  audience: ChannelAudience;
  sharePrimaryThread: boolean;
  allowUnknown: boolean;
  /** Slack and Teams: '' for the app's own credentials, else the binding whose app to reuse. */
  shareWith: string;
  botToken: string;
  signingSecret: string;
  botUserId: string;
  teamId: string;
  appPassword: string;
  appId: string;
  callbackUrl: string;
  /** Telegram: '' (polling) or `webhook`; email: '' (IDLE) or `polling`. */
  mode: string;
  /** Email: the mailbox (Telegram uses `botToken`). */
  address: string;
  username: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: string;
  folder: string;
  /** '' (the Hub's default, DMARC) or `none`, set only after the user confirmed it. */
  senderCheck: string;
  /** The receiving server's Authentication-Results name (authserv-id). */
  authservId: string;
  /** The user confirmed trusting the From address (`senderCheck: none`, own or shared). */
  confirmNone: boolean;
  password: string;
}

const EMPTY: Form = {
  kind: null,
  agentId: '',
  label: '',
  externalRef: '',
  audience: 'shared',
  sharePrimaryThread: false,
  allowUnknown: false,
  shareWith: '',
  botToken: '',
  signingSecret: '',
  botUserId: '',
  teamId: '',
  appPassword: '',
  appId: '',
  callbackUrl: '',
  mode: '',
  address: '',
  username: '',
  imapHost: '',
  imapPort: '',
  imapSecurity: '',
  smtpHost: '',
  smtpPort: '',
  smtpSecurity: '',
  folder: '',
  senderCheck: '',
  authservId: '',
  confirmNone: false,
  password: '',
};

/** The mailbox settings of the form, without empty ones (the Hub's defaults apply). */
function mailboxConfig(f: Form): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    'address',
    'username',
    'imapHost',
    'imapPort',
    'imapSecurity',
    'smtpHost',
    'smtpPort',
    'smtpSecurity',
    'folder',
    'mode',
    'senderCheck',
    'authservId',
  ] as const) {
    const v = f[k].trim();
    if (v) out[k] = k === 'authservId' ? v.toLowerCase() : v;
  }
  return out;
}

const opt = (v: string) => (v.trim() ? v.trim() : undefined);

/** The request body for the form, plus the webhook credentials it carries (shown once). */
export function bindingBody(
  f: Form & { kind: ChannelKindM7 },
  webhook: { token: string; secret: string },
): Record<string, unknown> {
  const common = {
    kind: f.kind,
    ...(f.agentId ? { agentId: f.agentId } : {}),
    ...(opt(f.label) ? { label: opt(f.label) } : {}),
  };
  if (f.kind === 'inapp')
    return { ...common, ...(f.sharePrimaryThread ? { sharePrimaryThread: true } : {}) };
  const shared = {
    ...common,
    externalRef: f.externalRef.trim(),
    audience: f.audience,
    ...(f.audience === 'private' && f.sharePrimaryThread ? { sharePrimaryThread: true } : {}),
    ...(f.audience === 'shared' && f.allowUnknown ? { allowUnknown: true } : {}),
  };
  switch (f.kind) {
    case 'slack': {
      const config = {
        ...(opt(f.botUserId) ? { botUserId: opt(f.botUserId) } : {}),
        ...(opt(f.teamId) ? { teamId: opt(f.teamId) } : {}),
      };
      return {
        ...shared,
        ...(f.shareWith
          ? { shareCredentialsWith: f.shareWith }
          : { credentials: { botToken: f.botToken, signingSecret: f.signingSecret } }),
        ...(Object.keys(config).length ? { config } : {}),
      };
    }
    case 'teams':
      return {
        ...shared,
        ...(f.shareWith
          ? { shareCredentialsWith: f.shareWith }
          : {
              credentials: { appPassword: f.appPassword },
              config: { appId: f.appId.trim() },
            }),
      };
    case 'webhook':
      return {
        ...shared,
        credentials: webhook,
        ...(opt(f.callbackUrl) ? { config: { callbackUrl: opt(f.callbackUrl) } } : {}),
      };
    case 'telegram':
      return {
        ...shared,
        ...(f.shareWith
          ? { shareCredentialsWith: f.shareWith }
          : {
              credentials: { botToken: f.botToken.trim() },
              ...(f.mode ? { config: { mode: f.mode } } : {}),
            }),
      };
    case 'email':
      return {
        ...shared,
        externalRef: f.externalRef.trim().toLowerCase(),
        ...(f.shareWith
          ? { shareCredentialsWith: f.shareWith }
          : { credentials: { password: f.password }, config: mailboxConfig(f) }),
        // Sent only once the user confirmed trusting the From address.
        ...(f.confirmNone ? { confirmSenderCheckNone: true } : {}),
      };
  }
}

/** Field errors keyed the way the form shows them. */
function formErrors(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.startsWith('credentials.') || k.startsWith('config.') ? k.split('.')[1]! : k;
    out[key] ??= v;
  }
  return out;
}

export function AddChannelDialog({
  open,
  onClose,
  adapters,
  agents,
  bindings,
  publicUrl,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  adapters: ChannelAdapterViewM7[];
  /** null when the agents could not be listed. */
  agents: AgentView[] | null;
  bindings: ChannelBindingViewM7[];
  publicUrl: string | null;
  onCreated: (b: ChannelBindingViewM7) => void;
}) {
  if (!open) return null;
  return (
    <AddChannel
      onClose={onClose}
      adapters={adapters}
      agents={agents}
      bindings={bindings}
      publicUrl={publicUrl}
      onCreated={onCreated}
    />
  );
}

function AddChannel({
  onClose,
  adapters,
  agents,
  bindings,
  publicUrl,
  onCreated,
}: {
  onClose: () => void;
  adapters: ChannelAdapterViewM7[];
  agents: AgentView[] | null;
  bindings: ChannelBindingViewM7[];
  publicUrl: string | null;
  onCreated: (b: ChannelBindingViewM7) => void;
}) {
  const api = useChannelsApi();
  const toast = useToast();
  const id = useId();
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    binding: ChannelBindingViewM7;
    secrets: { token: string; secret: string } | null;
  } | null>(null);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const kind = form.kind;
  const apps = kind
    ? bindings.filter((b) => b.kind === kind && b.sharesCredentialsWith === null)
    : [];

  /** The mailbox shared with has its sender check off: adding to it needs the same confirmation. */
  const sharedNone =
    kind === 'email' &&
    form.shareWith !== '' &&
    bindings.find((b) => b.id === form.shareWith)?.config.senderCheck === 'none';

  const submit = async () => {
    if (!kind || busy) return;
    if (sharedNone && !form.confirmNone) {
      setErrors({ confirmSenderCheckNone: CONFIRM_REQUIRED_SHARED });
      return;
    }
    const webhook = { token: randomSecret(24), secret: randomSecret(32) };
    const body = bindingBody({ ...form, kind }, webhook);
    const parsed = createChannelBindingM7Schema.safeParse(body);
    if (!parsed.success) {
      setErrors(formErrors(issueErrors(parsed.error.issues)));
      return;
    }
    setErrors({});
    setFailure(null);
    setBusy(true);
    try {
      const b = await api.createChannel(parsed.data);
      onCreated(b);
      if (kind === 'inapp') {
        toast.show(`${b.label} added.`, { tone: 'success' });
        onClose();
        return;
      }
      setCreated({ binding: b, secrets: kind === 'webhook' ? webhook : null });
    } catch (err) {
      const field = errorField(err);
      const message = isConfirmRequired(err)
        ? CONFIRM_REQUIRED_TEXT
        : errorMessage(err, 'Could not add the channel.');
      if (field) setErrors(formErrors({ [field]: message }));
      else setFailure(message);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const b = created.binding;
    return (
      <Dialog
        open
        className="ch-dialog"
        title={`Finish setting up ${b.label}`}
        description="The channel is added. Connect the other side so messages can reach Nova."
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="stack">
          <p className="ws-flush">
            Status: <Chip spec={BINDING_STATUS[b.status]} />
          </p>
          {b.inboundPath ? (
            <CopyValue
              label="Inbound address"
              value={absoluteUrl(b.inboundPath, publicUrl)}
              hint={INBOUND_HINT[b.kind]}
            />
          ) : null}
          {APPROVAL_HINT[b.kind] ? (
            <p className="muted ws-flush">
              <Icon name="shield" /> {APPROVAL_HINT[b.kind]}
            </p>
          ) : null}
          {b.kind === 'telegram' || b.kind === 'email' ? (
            <p className="muted ws-flush">
              Connecting checks the {b.kind === 'telegram' ? 'bot token' : 'mailbox'} and says what
              went wrong, if anything. Add the people the agent should answer under People.
            </p>
          ) : null}
          {created.secrets ? (
            <>
              <SecretsOnce
                items={[
                  { label: 'Bearer token', value: created.secrets.token },
                  { label: 'Signing secret', value: created.secrets.secret },
                ]}
              />
              <SigningHelp />
            </>
          ) : null}
          {publicUrl ? null : (
            <p className="muted ws-flush">
              The address uses this page&apos;s address. If Slack, Teams or your service reach the
              Hub at another address, set the public address on the Channels page.
            </p>
          )}
        </div>
      </Dialog>
    );
  }

  const agentOptions = [
    { value: '', label: 'No agent (Nova)' },
    ...(agents ?? []).map((a) => ({ value: a.id, label: a.name })),
  ];
  const ref = kind ? REF_TEXT[kind] : null;

  return (
    <Dialog
      open
      className="ch-dialog"
      title="Add a channel"
      description="Message an agent from another app. Each channel keeps its own thread; the agent's memory is shared across them."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!kind || busy} onClick={() => void submit()}>
            {busy ? 'Adding…' : 'Add channel'}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        aria-label="New channel"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="nv-radios ch-kinds">
          <legend className="nv-field-label">Kind</legend>
          {adapters.map((a) => (
            <label key={a.kind} className="nv-radio" data-disabled={!a.available || undefined}>
              <input
                type="radio"
                name={`${id}-kind`}
                value={a.kind}
                checked={kind === a.kind}
                disabled={!a.available}
                aria-labelledby={`${id}-kind-${a.kind}-label`}
                aria-describedby={`${id}-kind-${a.kind}`}
                onChange={() => {
                  setErrors({});
                  set({
                    kind: a.kind,
                    audience: a.kind === 'inapp' ? 'private' : form.audience,
                    shareWith: '',
                    mode: '',
                  });
                }}
              />
              <span className="nv-radio-text">
                <span id={`${id}-kind-${a.kind}-label`}>{KIND_TEXT[a.kind]}</span>
                <span id={`${id}-kind-${a.kind}`} className="nv-field-hint">
                  {a.available
                    ? KIND_HINT[a.kind]
                    : a.detail
                      ? sentence(a.detail)
                      : 'Not available on this Hub.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {kind ? (
          <>
            <SelectField
              label="Agent"
              value={form.agentId}
              options={agentOptions}
              hint={
                agents === null
                  ? 'Agents could not be listed; the channel can be added without one.'
                  : 'Who answers in this channel.'
              }
              error={errors.agentId}
              onChange={(v) => set({ agentId: v })}
            />
            <TextField
              label="Name (optional)"
              value={form.label}
              maxLength={200}
              placeholder={kind === 'inapp' ? 'In-app' : `${KIND_TEXT[kind]} conversation`}
              error={errors.label}
              onChange={(e) => set({ label: e.target.value })}
            />
            {kind !== 'inapp' && ref ? (
              <TextField
                label={ref.label}
                value={form.externalRef}
                spellCheck={false}
                autoComplete="off"
                hint={ref.hint || undefined}
                error={errors.externalRef}
                onChange={(e) => set({ externalRef: e.target.value })}
              />
            ) : null}
            {kind !== 'inapp' ? (
              <RadioGroup
                legend="Who can read it"
                name={`${id}-audience`}
                value={form.audience}
                onChange={(v) => set({ audience: v as ChannelAudience })}
                options={[
                  {
                    value: 'private',
                    label: 'Private',
                    description: 'Only you, like your own direct message with the bot.',
                  },
                  {
                    value: 'shared',
                    label: 'Shared',
                    description:
                      'Other people read it. Replies that use your private details are checked first.',
                  },
                ]}
              />
            ) : null}
            {kind === 'inapp' || form.audience === 'private' ? (
              <SwitchField
                label="Use the agent's main thread"
                description="Your private channels and the in-app channel share one thread instead of each keeping its own."
                checked={form.sharePrimaryThread}
                onChange={(v) => set({ sharePrimaryThread: v })}
              />
            ) : (
              <SwitchField
                label="Answer people Nova does not know"
                description="Off: only people listed under People get answers here."
                checked={form.allowUnknown}
                onChange={(v) => set({ allowUnknown: v })}
              />
            )}
            {kind === 'slack' || kind === 'teams' ? (
              <CredentialsFields kind={kind} form={form} apps={apps} errors={errors} set={set} />
            ) : null}
            {kind === 'telegram' ? (
              <TelegramFields
                form={form}
                apps={apps}
                errors={errors}
                set={set}
                publicUrl={publicUrl}
              />
            ) : null}
            {kind === 'email' ? (
              <MailboxFields
                form={form}
                apps={apps}
                errors={errors}
                set={set}
                sharedNone={sharedNone}
              />
            ) : null}
            {APPROVAL_HINT[kind] ? (
              <p className="muted ws-flush">
                <Icon name="shield" /> {APPROVAL_HINT[kind]}
              </p>
            ) : null}
            {kind === 'webhook' ? (
              <>
                <TextField
                  label="Reply URL (optional)"
                  type="url"
                  value={form.callbackUrl}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="https://"
                  hint="Where replies are posted, signed with the secret. Without it, the agent cannot answer here."
                  error={errors.callbackUrl}
                  onChange={(e) => set({ callbackUrl: e.target.value })}
                />
                <p className="muted ws-flush">
                  <Icon name="shield" /> A token and a signing secret are made for this channel when
                  you add it and shown once.
                </p>
              </>
            ) : null}
          </>
        ) : null}
        {failure ? (
          <p role="alert" className="nv-field-error">
            {failure}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

function CredentialsFields({
  kind,
  form,
  apps,
  errors,
  set,
}: {
  kind: 'slack' | 'teams';
  form: Form;
  apps: ChannelBindingViewM7[];
  errors: Record<string, string>;
  set: (patch: Partial<Form>) => void;
}) {
  const own = form.shareWith === '';
  return (
    <fieldset className="ws-fieldset">
      <legend>{kind === 'slack' ? 'Slack app' : 'Azure bot'}</legend>
      {apps.length ? (
        <SelectField
          label="Credentials"
          value={form.shareWith}
          onChange={(v) => set({ shareWith: v })}
          error={errors.shareCredentialsWith}
          options={[
            { value: '', label: 'Enter this app’s credentials' },
            ...apps.map((b) => ({ value: b.id, label: `Same app as ${b.label}` })),
          ]}
        />
      ) : null}
      {own ? (
        <p className="nv-field-hint ws-flush">
          Kept in the Hub&apos;s secret store and never shown again.
        </p>
      ) : (
        <p className="nv-field-hint ws-flush">
          This channel uses that app&apos;s stored credentials.
        </p>
      )}
      {own && kind === 'slack' ? (
        <>
          <TextField
            label="Bot token"
            type="password"
            autoComplete="new-password"
            placeholder="xoxb-…"
            value={form.botToken}
            error={errors.botToken ?? errors.credentials}
            onChange={(e) => set({ botToken: e.target.value })}
          />
          <TextField
            label="Signing secret"
            type="password"
            autoComplete="new-password"
            value={form.signingSecret}
            error={errors.signingSecret}
            onChange={(e) => set({ signingSecret: e.target.value })}
          />
          <TextField
            label="Bot user ID (optional)"
            value={form.botUserId}
            spellCheck={false}
            autoComplete="off"
            hint="Lets Nova tell when the bot is mentioned."
            error={errors.botUserId}
            onChange={(e) => set({ botUserId: e.target.value })}
          />
          <TextField
            label="Workspace ID (optional)"
            value={form.teamId}
            spellCheck={false}
            autoComplete="off"
            error={errors.teamId}
            onChange={(e) => set({ teamId: e.target.value })}
          />
        </>
      ) : null}
      {own && kind === 'teams' ? (
        <>
          <TextField
            label="App ID"
            value={form.appId}
            spellCheck={false}
            autoComplete="off"
            hint="The Microsoft app ID of your Azure bot."
            error={errors.appId ?? errors.config}
            onChange={(e) => set({ appId: e.target.value })}
          />
          <TextField
            label="App password"
            type="password"
            autoComplete="new-password"
            value={form.appPassword}
            error={errors.appPassword ?? errors.credentials}
            onChange={(e) => set({ appPassword: e.target.value })}
          />
        </>
      ) : null}
    </fieldset>
  );
}

/** Telegram: the bot's token (or another binding's bot) and how messages arrive. */
function TelegramFields({
  form,
  apps,
  errors,
  set,
  publicUrl,
}: {
  form: Form;
  apps: ChannelBindingViewM7[];
  errors: Record<string, string>;
  set: (patch: Partial<Form>) => void;
  publicUrl: string | null;
}) {
  const id = useId();
  const own = form.shareWith === '';
  const httpsAddress = publicUrl?.startsWith('https://') ?? false;
  const modes = CONFIG_CHOICES.telegram?.mode ?? [];
  return (
    <fieldset className="ws-fieldset">
      <legend>Telegram bot</legend>
      {apps.length ? (
        <SelectField
          label="Bot"
          value={form.shareWith}
          onChange={(v) => set({ shareWith: v })}
          error={errors.shareCredentialsWith}
          options={[
            { value: '', label: 'Enter this bot’s token' },
            ...apps.map((b) => ({ value: b.id, label: `Same bot as ${b.label}` })),
          ]}
        />
      ) : null}
      {own ? (
        <>
          <TextField
            label="Bot token"
            type="password"
            autoComplete="new-password"
            placeholder="123456789:AA…"
            value={form.botToken}
            hint="From @BotFather. Kept in the Hub’s secret store and never shown again."
            error={errors.botToken ?? errors.credentials}
            onChange={(e) => set({ botToken: e.target.value })}
          />
          <fieldset className="nv-radios">
            <legend className="nv-field-label">How messages arrive</legend>
            {modes.map((m) => {
              const disabled = m.value === 'webhook' && !httpsAddress;
              return (
                <label key={m.value} className="nv-radio" data-disabled={disabled || undefined}>
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    value={m.value}
                    checked={form.mode === m.value}
                    disabled={disabled}
                    aria-describedby={disabled ? `${id}-mode-why` : undefined}
                    onChange={() => set({ mode: m.value })}
                  />
                  <span className="nv-radio-text">
                    <span>{m.label}</span>
                    <span className="nv-field-hint">{m.hint}</span>
                    {disabled ? (
                      <span id={`${id}-mode-why`} className="nv-field-hint">
                        Needs an https public address, set on the Channels page.
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        </>
      ) : (
        <p className="nv-field-hint ws-flush">
          This channel uses that bot’s stored token and settings.
        </p>
      )}
    </fieldset>
  );
}

/** Email: the mailbox the agent reads and answers from (or another binding's mailbox). */
function MailboxFields({
  form,
  apps,
  errors,
  set,
  sharedNone,
}: {
  form: Form;
  apps: ChannelBindingViewM7[];
  errors: Record<string, string>;
  set: (patch: Partial<Form>) => void;
  /** The mailbox shared with has its sender check off. */
  sharedNone: boolean;
}) {
  const own = form.shareWith === '';
  const [asking, setAsking] = useState(false);
  const confirmError = errors.confirmSenderCheckNone ? (
    <p role="alert" className="nv-field-error">
      {errors.confirmSenderCheckNone}
    </p>
  ) : null;
  const choices = CONFIG_CHOICES.email ?? {};
  const plain = (host: string, sec: string) =>
    sec === 'none' && host.trim() !== '' && !plainMailAllowed(host)
      ? 'Without TLS only works for a server on this machine. Choose TLS or STARTTLS.'
      : undefined;
  const select = (key: 'imapSecurity' | 'smtpSecurity' | 'mode' | 'senderCheck', label: string) => (
    <SelectField
      label={label}
      value={form[key]}
      onChange={(v) => {
        if (key !== 'senderCheck') set({ [key]: v });
        // Trusting the From address asks first; the value changes only once confirmed.
        else if (v === 'none') setAsking(true);
        else {
          setAsking(false);
          set({ senderCheck: '', confirmNone: false });
        }
      }}
      options={(choices[key] ?? []).map((c) => ({ value: c.value, label: c.label }))}
      hint={key === 'senderCheck' ? CHOICE_HINT.senderCheck : undefined}
      error={errors[key]}
    />
  );
  return (
    <fieldset className="ws-fieldset">
      <legend>Mailbox</legend>
      {apps.length ? (
        <SelectField
          label="Mailbox"
          value={form.shareWith}
          onChange={(v) => {
            setAsking(false);
            set({ shareWith: v, senderCheck: '', confirmNone: false });
          }}
          error={errors.shareCredentialsWith}
          options={[
            { value: '', label: 'Enter a mailbox' },
            ...apps.map((b) => ({ value: b.id, label: `Same mailbox as ${b.label}` })),
          ]}
        />
      ) : null}
      {own ? (
        <div className="stack">
          <p className="nv-field-hint ws-flush">
            The agent reads new mail from this person in the mailbox and answers from it. Mail
            already there is never read.
          </p>
          <TextField
            label="Mailbox address"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={form.address}
            placeholder="agent@example.com"
            error={errors.address}
            onChange={(e) => set({ address: e.target.value })}
          />
          <TextField
            label="Login name (optional)"
            autoComplete="off"
            spellCheck={false}
            value={form.username}
            hint="Leave empty to sign in with the mailbox address."
            error={errors.username}
            onChange={(e) => set({ username: e.target.value })}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            hint="An app password if your provider has them. Kept in the Hub’s secret store and never shown again."
            error={errors.password ?? errors.credentials}
            onChange={(e) => set({ password: e.target.value })}
          />
          <div className="ch-mail-grid">
            <TextField
              label="IMAP server"
              spellCheck={false}
              autoComplete="off"
              value={form.imapHost}
              placeholder="imap.example.com"
              error={errors.imapHost}
              onChange={(e) => set({ imapHost: e.target.value })}
            />
            <TextField
              label="IMAP port (optional)"
              inputMode="numeric"
              value={form.imapPort}
              placeholder="993"
              error={errors.imapPort}
              onChange={(e) => set({ imapPort: e.target.value })}
            />
            {select('imapSecurity', 'IMAP security')}
            <TextField
              label="SMTP server"
              spellCheck={false}
              autoComplete="off"
              value={form.smtpHost}
              placeholder="smtp.example.com"
              error={errors.smtpHost}
              onChange={(e) => set({ smtpHost: e.target.value })}
            />
            <TextField
              label="SMTP port (optional)"
              inputMode="numeric"
              value={form.smtpPort}
              placeholder="465"
              error={errors.smtpPort}
              onChange={(e) => set({ smtpPort: e.target.value })}
            />
            {select('smtpSecurity', 'SMTP security')}
          </div>
          {(plain(form.imapHost, form.imapSecurity) ?? plain(form.smtpHost, form.smtpSecurity)) ? (
            <p role="alert" className="nv-field-error">
              {plain(form.imapHost, form.imapSecurity) ?? plain(form.smtpHost, form.smtpSecurity)}
            </p>
          ) : null}
          <details className="ws-advanced">
            <summary>More mailbox settings</summary>
            <div className="stack">
              <TextField
                label="Folder (optional)"
                spellCheck={false}
                value={form.folder}
                placeholder="INBOX"
                error={errors.folder}
                onChange={(e) => set({ folder: e.target.value })}
              />
              {select('mode', 'Checking for mail')}
              {select('senderCheck', 'Who counts as a known sender')}
              {asking ? (
                <SenderCheckOffConfirm
                  onCancel={() => setAsking(false)}
                  onConfirm={() => {
                    setAsking(false);
                    set({ senderCheck: 'none', confirmNone: true });
                  }}
                />
              ) : null}
              {form.senderCheck === 'none' ? <SenderCheckOffNotice /> : null}
              <TextField
                label="Authentication-Results name (optional)"
                spellCheck={false}
                autoComplete="off"
                value={form.authservId}
                placeholder="mx.google.com"
                hint={CONFIG_TEXT.authservId?.hint}
                error={errors.authservId}
                onChange={(e) => set({ authservId: e.target.value })}
              />
            </div>
          </details>
          {confirmError}
          {errors.config ? (
            <p role="alert" className="nv-field-error">
              {errors.config}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <p className="nv-field-hint ws-flush">
            This channel uses that mailbox’s stored password and settings.
          </p>
          {sharedNone && !form.confirmNone ? (
            <SenderCheckOffConfirm
              onCancel={() => set({ shareWith: '', confirmNone: false })}
              onConfirm={() => set({ confirmNone: true })}
            />
          ) : null}
          {sharedNone && form.confirmNone ? <SenderCheckOffNotice /> : null}
          {confirmError}
        </div>
      )}
    </fieldset>
  );
}
