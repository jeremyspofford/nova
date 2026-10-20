// Add a channel (FR-088, FR-110, docs/13 §4): pick a kind the Hub offers (unavailable kinds say
// why), then its conversation, agent, audience and credentials. Credentials are write-only: Slack,
// Teams and Telegram take the app's (bot's) secrets or reuse another binding's; email takes the
// mailbox's servers and password (and optionally its Authentication-Results name) or reuses
// another binding's mailbox, and trusting the From address alone asks first (M8: or OAuth, with
// the provider's endpoints, the client ID and an optional client secret, then Authorize once the
// channel exists, and the redirect URI to register); a webhook gets a
// token and secret made here and shown once after it is created. The last step shows the inbound address to
// paste into the other service. The body is checked with the Hub's own schema before it is sent.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
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
import { rich } from '../i18n/rich.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { useChannelsApi } from './api.ts';
import {
  APPROVAL_HINT,
  BINDING_STATUS,
  CHANNEL_TEXT,
  CHOICE_HINT,
  CONFIG_TEXT,
  CREDENTIAL_TEXT,
  INBOUND_HINT,
  KIND_HINT,
  KIND_TEXT,
  REF_TEXT,
  absoluteUrl,
  configChoices,
  errorField,
  isConfirmRequired,
  issueErrors,
  plainMailAllowed,
  MAIL_OAUTH_TEXT,
  mailOAuthRedirectUri,
  randomSecret,
  sentence,
} from './format.ts';
import { MailOAuthPanel } from './MailOAuth.tsx';
import {
  Chip,
  CopyValue,
  SecretsOnce,
  SenderCheckOffConfirm,
  SenderCheckOffNotice,
  SigningHelp,
} from './parts.tsx';

/** The Add channel dialog's words (FR-016). Names, addresses and the Hub's errors are data. */
export const ADD_CHANNEL_TEXT = defineMessages('channels.add', {
  title: 'Add a channel',
  description:
    "Message an agent from another app. Each channel keeps its own thread; the agent's memory is shared across them.",
  form: 'New channel',
  cancel: 'Cancel',
  adding: 'Adding…',
  add: 'Add channel',
  added: '{name} added.',
  addFailed: 'Could not add the channel.',
  confirmShared:
    'That mailbox trusts the From address. Confirm it above, or choose another mailbox.',
  kind: 'Kind',
  unavailable: 'Not available on this Hub.',
  agent: 'Agent',
  noAgent: 'No agent (Nova)',
  agentsUnlisted: 'Agents could not be listed; the channel can be added without one.',
  agentHint: 'Who answers in this channel.',
  name: 'Name (optional)',
  conversationOf: '{kind} conversation',
  audience: 'Who can read it',
  private: {
    label: 'Private',
    description: 'Only you, like your own direct message with the bot.',
  },
  shared: {
    label: 'Shared',
    description: 'Other people read it. Replies that use your private details are checked first.',
  },
  mainThread: "Use the agent's main thread",
  mainThreadHint:
    'Your private channels and the in-app channel share one thread instead of each keeping its own.',
  unknown: 'Answer people Nova does not know',
  unknownHint: 'Off: only people listed under People get answers here.',
  replyUrl: 'Reply URL (optional)',
  replyUrlHint:
    'Where replies are posted, signed with the secret. Without it, the agent cannot answer here.',
  webhookOnce:
    'A token and a signing secret are made for this channel when you add it and shown once.',
  finish: {
    title: 'Finish setting up {name}',
    description: 'The channel is added. Connect the other side so messages can reach Nova.',
    done: 'Done',
    status: 'Status: {status}',
    inbound: 'Inbound address',
    connectChecks:
      '{kind, select, telegram {Connecting checks the bot token and says what went wrong, if anything. Add the people the agent should answer under People.} other {Connecting checks the mailbox and says what went wrong, if anything. Add the people the agent should answer under People.}}',
    pageAddress:
      "The address uses this page's address. If Slack, Teams or your service reach the Hub at another address, set the public address on the Channels page.",
  },
  app: {
    slack: 'Slack app',
    teams: 'Azure bot',
    credentials: 'Credentials',
    own: 'Enter this app’s credentials',
    same: 'Same app as {name}',
    kept: "Kept in the Hub's secret store and never shown again.",
    uses: "This channel uses that app's stored credentials.",
    botToken: 'Bot token',
    signingSecret: 'Signing secret',
    botUserId: 'Bot user ID (optional)',
    teamId: 'Workspace ID (optional)',
    appId: 'App ID',
    appPassword: 'App password',
  },
  telegram: {
    legend: 'Telegram bot',
    bot: 'Bot',
    own: 'Enter this bot’s token',
    same: 'Same bot as {name}',
    token: 'Bot token',
    tokenHint: 'From @BotFather. Kept in the Hub’s secret store and never shown again.',
    mode: 'How messages arrive',
    needsHttps: 'Needs an https public address, set on the Channels page.',
    uses: 'This channel uses that bot’s stored token and settings.',
  },
  mail: {
    legend: 'Mailbox',
    mailbox: 'Mailbox',
    own: 'Enter a mailbox',
    same: 'Same mailbox as {name}',
    intro:
      'The agent reads new mail from this person in the mailbox and answers from it. Mail already there is never read.',
    address: 'Mailbox address',
    username: 'Login name (optional)',
    password: 'Password',
    passwordHint:
      'An app password if your provider has them. Kept in the Hub’s secret store and never shown again.',
    imapHost: 'IMAP server',
    imapPort: 'IMAP port (optional)',
    imapSecurity: 'IMAP security',
    smtpHost: 'SMTP server',
    smtpPort: 'SMTP port (optional)',
    smtpSecurity: 'SMTP security',
    plain: 'Without TLS only works for a server on this machine. Choose TLS or STARTTLS.',
    more: 'More mailbox settings',
    folder: 'Folder (optional)',
    mode: 'Checking for mail',
    senderCheck: 'Who counts as a known sender',
    authservId: 'Authentication-Results name (optional)',
    uses: 'This channel uses that mailbox’s stored password and settings.',
  },
});

/** Examples shown in empty fields: protocol values and addresses, not translated. */
const EXAMPLE = {
  url: 'https://',
  slackToken: 'xoxb-…',
  telegramToken: '123456789:AA…',
  mailbox: 'agent@example.com',
  imapHost: 'imap.example.com',
  imapPort: '993',
  smtpHost: 'smtp.example.com',
  smtpPort: '465',
  folder: 'INBOX',
  authservId: 'mx.google.com',
} as const;

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
  /** Email (M8): '' (password, the Hub's default) or `oauth`. */
  auth: string;
  oauthAuthUrl: string;
  oauthTokenUrl: string;
  oauthRevokeUrl: string;
  oauthClientId: string;
  oauthScopes: string;
  oauthClientSecret: string;
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
  auth: '',
  oauthAuthUrl: '',
  oauthTokenUrl: '',
  oauthRevokeUrl: '',
  oauthClientId: '',
  oauthScopes: '',
  oauthClientSecret: '',
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
  if (f.auth === 'oauth') {
    out.auth = 'oauth';
    for (const k of [
      'oauthAuthUrl',
      'oauthTokenUrl',
      'oauthRevokeUrl',
      'oauthClientId',
      'oauthScopes',
    ] as const) {
      const v = f[k].trim();
      if (v) out[k] = v;
    }
  }
  return out;
}

/** OAuth sign-in needs the provider's two endpoints and the client ID (the Hub checks too). */
export function mailOAuthErrors(f: Form): Record<string, string> {
  if (f.kind !== 'email' || f.shareWith || f.auth !== 'oauth') return {};
  const out: Record<string, string> = {};
  if (!f.oauthAuthUrl.trim()) out.oauthAuthUrl = MAIL_OAUTH_TEXT.needAuthUrl;
  if (!f.oauthTokenUrl.trim()) out.oauthTokenUrl = MAIL_OAUTH_TEXT.needTokenUrl;
  if (!f.oauthClientId.trim()) out.oauthClientId = MAIL_OAUTH_TEXT.needClientId;
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
          : f.auth === 'oauth'
            ? {
                config: mailboxConfig(f),
                ...(f.oauthClientSecret ? { oauthClientSecret: f.oauthClientSecret } : {}),
              }
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
  mailHint,
}: {
  open: boolean;
  onClose: () => void;
  adapters: ChannelAdapterViewM7[];
  /** null when the agents could not be listed. */
  agents: AgentView[] | null;
  bindings: ChannelBindingViewM7[];
  publicUrl: string | null;
  onCreated: (b: ChannelBindingViewM7) => void;
  /** A note under the mail servers (a member's servers must be public addresses). */
  mailHint?: string;
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
      mailHint={mailHint}
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
  mailHint,
}: {
  onClose: () => void;
  adapters: ChannelAdapterViewM7[];
  agents: AgentView[] | null;
  bindings: ChannelBindingViewM7[];
  publicUrl: string | null;
  onCreated: (b: ChannelBindingViewM7) => void;
  mailHint: string | undefined;
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
      setErrors({ confirmSenderCheckNone: ADD_CHANNEL_TEXT.confirmShared });
      return;
    }
    const missing = mailOAuthErrors(form);
    if (Object.keys(missing).length) {
      setErrors(missing);
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
        toast.show(ADD_CHANNEL_TEXT.added({ name: b.label }), { tone: 'success' });
        onClose();
        return;
      }
      setCreated({ binding: b, secrets: kind === 'webhook' ? webhook : null });
    } catch (err) {
      const field = errorField(err);
      const message = isConfirmRequired(err)
        ? CHANNEL_TEXT.confirmRequired
        : errorMessage(err, ADD_CHANNEL_TEXT.addFailed);
      if (field) setErrors(formErrors({ [field]: message }));
      else setFailure(message);
    } finally {
      setBusy(false);
    }
  };

  const S = ADD_CHANNEL_TEXT;
  if (created) {
    const b = created.binding;
    const F = S.finish;
    return (
      <Dialog
        open
        className="ch-dialog"
        title={F.title({ name: b.label })}
        description={F.description}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            {F.done}
          </Button>
        }
      >
        <div className="stack">
          <p className="ws-flush">
            {rich(F.status, { status: <Chip spec={BINDING_STATUS[b.status]} /> })}
          </p>
          {b.inboundPath ? (
            <CopyValue
              label={F.inbound}
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
            <p className="muted ws-flush">{F.connectChecks({ kind: b.kind })}</p>
          ) : null}
          {b.kind === 'email' && b.oauth ? (
            <MailOAuthPanel
              binding={b}
              onSaved={(next) => {
                setCreated((c) => (c ? { ...c, binding: next } : c));
                onCreated(next);
              }}
            />
          ) : null}
          {created.secrets ? (
            <>
              <SecretsOnce
                items={[
                  { label: CREDENTIAL_TEXT.token, value: created.secrets.token },
                  { label: CREDENTIAL_TEXT.secret, value: created.secrets.secret },
                ]}
              />
              <SigningHelp />
            </>
          ) : null}
          {publicUrl ? null : <p className="muted ws-flush">{F.pageAddress}</p>}
        </div>
      </Dialog>
    );
  }

  const agentOptions = [
    { value: '', label: S.noAgent },
    ...(agents ?? []).map((a) => ({ value: a.id, label: a.name })),
  ];
  const ref = kind ? REF_TEXT[kind] : null;

  return (
    <Dialog
      open
      className="ch-dialog"
      title={S.title}
      description={S.description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button variant="primary" disabled={!kind || busy} onClick={() => void submit()}>
            {busy ? S.adding : S.add}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        aria-label={S.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="nv-radios ch-kinds">
          <legend className="nv-field-label">{S.kind}</legend>
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
                  {a.available ? KIND_HINT[a.kind] : a.detail ? sentence(a.detail) : S.unavailable}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {kind ? (
          <>
            <SelectField
              label={S.agent}
              value={form.agentId}
              options={agentOptions}
              hint={agents === null ? S.agentsUnlisted : S.agentHint}
              error={errors.agentId}
              onChange={(v) => set({ agentId: v })}
            />
            <TextField
              label={S.name}
              value={form.label}
              maxLength={200}
              placeholder={
                kind === 'inapp' ? KIND_TEXT.inapp : S.conversationOf({ kind: KIND_TEXT[kind] })
              }
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
                legend={S.audience}
                name={`${id}-audience`}
                value={form.audience}
                onChange={(v) => set({ audience: v as ChannelAudience })}
                options={(['private', 'shared'] as const).map((v) => ({
                  value: v,
                  label: S[v].label,
                  description: S[v].description,
                }))}
              />
            ) : null}
            {kind === 'inapp' || form.audience === 'private' ? (
              <SwitchField
                label={S.mainThread}
                description={S.mainThreadHint}
                checked={form.sharePrimaryThread}
                onChange={(v) => set({ sharePrimaryThread: v })}
              />
            ) : (
              <SwitchField
                label={S.unknown}
                description={S.unknownHint}
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
                hint={mailHint}
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
                  label={S.replyUrl}
                  type="url"
                  value={form.callbackUrl}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={EXAMPLE.url}
                  hint={S.replyUrlHint}
                  error={errors.callbackUrl}
                  onChange={(e) => set({ callbackUrl: e.target.value })}
                />
                <p className="muted ws-flush">
                  <Icon name="shield" /> {S.webhookOnce}
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
  const A = ADD_CHANNEL_TEXT.app;
  return (
    <fieldset className="ws-fieldset">
      <legend>{A[kind]}</legend>
      {apps.length ? (
        <SelectField
          label={A.credentials}
          value={form.shareWith}
          onChange={(v) => set({ shareWith: v })}
          error={errors.shareCredentialsWith}
          options={[
            { value: '', label: A.own },
            ...apps.map((b) => ({ value: b.id, label: A.same({ name: b.label }) })),
          ]}
        />
      ) : null}
      {own ? (
        <p className="nv-field-hint ws-flush">{A.kept}</p>
      ) : (
        <p className="nv-field-hint ws-flush">{A.uses}</p>
      )}
      {own && kind === 'slack' ? (
        <>
          <TextField
            label={A.botToken}
            type="password"
            autoComplete="new-password"
            placeholder={EXAMPLE.slackToken}
            value={form.botToken}
            error={errors.botToken ?? errors.credentials}
            onChange={(e) => set({ botToken: e.target.value })}
          />
          <TextField
            label={A.signingSecret}
            type="password"
            autoComplete="new-password"
            value={form.signingSecret}
            error={errors.signingSecret}
            onChange={(e) => set({ signingSecret: e.target.value })}
          />
          <TextField
            label={A.botUserId}
            value={form.botUserId}
            spellCheck={false}
            autoComplete="off"
            hint={CONFIG_TEXT.botUserId?.hint}
            error={errors.botUserId}
            onChange={(e) => set({ botUserId: e.target.value })}
          />
          <TextField
            label={A.teamId}
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
            label={A.appId}
            value={form.appId}
            spellCheck={false}
            autoComplete="off"
            hint={CONFIG_TEXT.appId?.hint}
            error={errors.appId ?? errors.config}
            onChange={(e) => set({ appId: e.target.value })}
          />
          <TextField
            label={A.appPassword}
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
  const modes = configChoices().telegram?.mode ?? [];
  const T = ADD_CHANNEL_TEXT.telegram;
  return (
    <fieldset className="ws-fieldset">
      <legend>{T.legend}</legend>
      {apps.length ? (
        <SelectField
          label={T.bot}
          value={form.shareWith}
          onChange={(v) => set({ shareWith: v })}
          error={errors.shareCredentialsWith}
          options={[
            { value: '', label: T.own },
            ...apps.map((b) => ({ value: b.id, label: T.same({ name: b.label }) })),
          ]}
        />
      ) : null}
      {own ? (
        <>
          <TextField
            label={T.token}
            type="password"
            autoComplete="new-password"
            placeholder={EXAMPLE.telegramToken}
            value={form.botToken}
            hint={T.tokenHint}
            error={errors.botToken ?? errors.credentials}
            onChange={(e) => set({ botToken: e.target.value })}
          />
          <fieldset className="nv-radios">
            <legend className="nv-field-label">{T.mode}</legend>
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
                        {T.needsHttps}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        </>
      ) : (
        <p className="nv-field-hint ws-flush">{T.uses}</p>
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
  hint,
}: {
  form: Form;
  apps: ChannelBindingViewM7[];
  errors: Record<string, string>;
  set: (patch: Partial<Form>) => void;
  /** The mailbox shared with has its sender check off. */
  sharedNone: boolean;
  hint: string | undefined;
}) {
  const id = useId();
  const own = form.shareWith === '';
  const oauth = form.auth === 'oauth';
  const [asking, setAsking] = useState(false);
  const confirmError = errors.confirmSenderCheckNone ? (
    <p role="alert" className="nv-field-error">
      {errors.confirmSenderCheckNone}
    </p>
  ) : null;
  const choices = configChoices().email ?? {};
  const M = ADD_CHANNEL_TEXT.mail;
  const plain = (host: string, sec: string) =>
    sec === 'none' && host.trim() !== '' && !plainMailAllowed(host) ? M.plain : undefined;
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
      <legend>{M.legend}</legend>
      {apps.length ? (
        <SelectField
          label={M.mailbox}
          value={form.shareWith}
          onChange={(v) => {
            setAsking(false);
            set({ shareWith: v, senderCheck: '', confirmNone: false });
          }}
          error={errors.shareCredentialsWith}
          options={[
            { value: '', label: M.own },
            ...apps.map((b) => ({ value: b.id, label: M.same({ name: b.label }) })),
          ]}
        />
      ) : null}
      {own ? (
        <div className="stack">
          <p className="nv-field-hint ws-flush">{M.intro}</p>
          <TextField
            label={M.address}
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={form.address}
            placeholder={EXAMPLE.mailbox}
            error={errors.address}
            onChange={(e) => set({ address: e.target.value })}
          />
          <TextField
            label={M.username}
            autoComplete="off"
            spellCheck={false}
            value={form.username}
            hint={CONFIG_TEXT.username?.hint}
            error={errors.username}
            onChange={(e) => set({ username: e.target.value })}
          />
          <RadioGroup
            legend={MAIL_OAUTH_TEXT.authLegend}
            name={`${id}-auth`}
            value={form.auth}
            onChange={(v) => set({ auth: v === 'oauth' ? 'oauth' : '' })}
            options={[
              {
                value: '',
                label: MAIL_OAUTH_TEXT.password,
                description: MAIL_OAUTH_TEXT.passwordHint,
              },
              {
                value: 'oauth',
                label: MAIL_OAUTH_TEXT.oauth,
                description: MAIL_OAUTH_TEXT.oauthHint,
              },
            ]}
          />
          {oauth ? (
            <MailOAuthFields form={form} errors={errors} set={set} />
          ) : (
            <TextField
              label={M.password}
              type="password"
              autoComplete="new-password"
              value={form.password}
              hint={M.passwordHint}
              error={errors.password ?? errors.credentials}
              onChange={(e) => set({ password: e.target.value })}
            />
          )}
          <div className="ch-mail-grid">
            <TextField
              label={M.imapHost}
              spellCheck={false}
              autoComplete="off"
              value={form.imapHost}
              placeholder={EXAMPLE.imapHost}
              error={errors.imapHost}
              onChange={(e) => set({ imapHost: e.target.value })}
            />
            <TextField
              label={M.imapPort}
              inputMode="numeric"
              value={form.imapPort}
              placeholder={EXAMPLE.imapPort}
              error={errors.imapPort}
              onChange={(e) => set({ imapPort: e.target.value })}
            />
            {select('imapSecurity', M.imapSecurity)}
            <TextField
              label={M.smtpHost}
              spellCheck={false}
              autoComplete="off"
              value={form.smtpHost}
              placeholder={EXAMPLE.smtpHost}
              error={errors.smtpHost}
              onChange={(e) => set({ smtpHost: e.target.value })}
            />
            <TextField
              label={M.smtpPort}
              inputMode="numeric"
              value={form.smtpPort}
              placeholder={EXAMPLE.smtpPort}
              error={errors.smtpPort}
              onChange={(e) => set({ smtpPort: e.target.value })}
            />
            {select('smtpSecurity', M.smtpSecurity)}
          </div>
          {hint ? <p className="nv-field-hint ws-flush">{hint}</p> : null}
          {(plain(form.imapHost, form.imapSecurity) ?? plain(form.smtpHost, form.smtpSecurity)) ? (
            <p role="alert" className="nv-field-error">
              {plain(form.imapHost, form.imapSecurity) ?? plain(form.smtpHost, form.smtpSecurity)}
            </p>
          ) : null}
          <details className="ws-advanced">
            <summary>{M.more}</summary>
            <div className="stack">
              <TextField
                label={M.folder}
                spellCheck={false}
                value={form.folder}
                placeholder={EXAMPLE.folder}
                error={errors.folder}
                onChange={(e) => set({ folder: e.target.value })}
              />
              {select('mode', M.mode)}
              {select('senderCheck', M.senderCheck)}
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
                label={M.authservId}
                spellCheck={false}
                autoComplete="off"
                value={form.authservId}
                placeholder={EXAMPLE.authservId}
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
          <p className="nv-field-hint ws-flush">{M.uses}</p>
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

/** Email OAuth (M8): the provider's endpoints, the app's client ID and secret, and the redirect. */
function MailOAuthFields({
  form,
  errors,
  set,
}: {
  form: Form;
  errors: Record<string, string>;
  set: (patch: Partial<Form>) => void;
}) {
  const field = (
    key: 'oauthAuthUrl' | 'oauthTokenUrl' | 'oauthRevokeUrl' | 'oauthClientId' | 'oauthScopes',
    extra: { type?: string; placeholder?: string } = {},
  ) => (
    <TextField
      label={CONFIG_TEXT[key]?.label ?? key}
      hint={CONFIG_TEXT[key]?.hint || undefined}
      value={form[key]}
      spellCheck={false}
      autoComplete="off"
      error={errors[key]}
      onChange={(e) => set({ [key]: e.target.value })}
      {...extra}
    />
  );
  return (
    <div className="stack">
      {field('oauthAuthUrl', { type: 'url', placeholder: EXAMPLE.url })}
      {field('oauthTokenUrl', { type: 'url', placeholder: EXAMPLE.url })}
      {field('oauthClientId')}
      {field('oauthScopes')}
      <TextField
        label={MAIL_OAUTH_TEXT.clientSecret}
        type="password"
        autoComplete="new-password"
        value={form.oauthClientSecret}
        hint={MAIL_OAUTH_TEXT.clientSecretHint}
        error={errors.oauthClientSecret}
        onChange={(e) => set({ oauthClientSecret: e.target.value })}
      />
      {field('oauthRevokeUrl', { type: 'url', placeholder: EXAMPLE.url })}
      <CopyValue
        label={MAIL_OAUTH_TEXT.redirectLabel}
        value={mailOAuthRedirectUri()}
        hint={MAIL_OAUTH_TEXT.redirectHint}
      />
      <p className="nv-field-hint ws-flush">{MAIL_OAUTH_TEXT.authorizeAfter}</p>
    </div>
  );
}
