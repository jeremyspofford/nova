// Add a channel (FR-088, docs/13 §4): pick a kind the Hub offers (unavailable kinds say why),
// then its conversation, agent, audience and credentials. Credentials are write-only: Slack and
// Teams take the app's secrets or reuse another binding's app; a webhook gets a token and secret
// made here and shown once after it is created. The last step shows the inbound address to paste
// into the other service. The body is checked with the Hub's own schema before it is sent.
import { useId, useState } from 'react';
import {
  createChannelBindingSchema,
  type AgentView,
  type ChannelAdapterView,
  type ChannelAudience,
  type ChannelBindingKind,
  type ChannelBindingView,
} from '@nova/shared';
import { Button, Dialog, Icon, RadioGroup, SelectField, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useChannelsApi } from './api.ts';
import {
  BINDING_STATUS,
  INBOUND_HINT,
  KIND_HINT,
  KIND_TEXT,
  REF_TEXT,
  absoluteUrl,
  errorField,
  issueErrors,
  randomSecret,
  sentence,
} from './format.ts';
import { Chip, CopyValue, SecretsOnce, SigningHelp } from './parts.tsx';

interface Form {
  kind: ChannelBindingKind | null;
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
};

const opt = (v: string) => (v.trim() ? v.trim() : undefined);

/** The request body for the form, plus the webhook credentials it carries (shown once). */
export function bindingBody(
  f: Form & { kind: ChannelBindingKind },
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
    case 'email':
      return shared;
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
  adapters: ChannelAdapterView[];
  /** null when the agents could not be listed. */
  agents: AgentView[] | null;
  bindings: ChannelBindingView[];
  publicUrl: string | null;
  onCreated: (b: ChannelBindingView) => void;
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
  adapters: ChannelAdapterView[];
  agents: AgentView[] | null;
  bindings: ChannelBindingView[];
  publicUrl: string | null;
  onCreated: (b: ChannelBindingView) => void;
}) {
  const api = useChannelsApi();
  const toast = useToast();
  const id = useId();
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    binding: ChannelBindingView;
    secrets: { token: string; secret: string } | null;
  } | null>(null);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const kind = form.kind;
  const apps = kind
    ? bindings.filter((b) => b.kind === kind && b.sharesCredentialsWith === null)
    : [];

  const submit = async () => {
    if (!kind || busy) return;
    const webhook = { token: randomSecret(24), secret: randomSecret(32) };
    const body = bindingBody({ ...form, kind }, webhook);
    const parsed = createChannelBindingSchema.safeParse(body);
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
      const message = errorMessage(err, 'Could not add the channel.');
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
  apps: ChannelBindingView[];
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
