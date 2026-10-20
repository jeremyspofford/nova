// New and edit dialogs for event triggers (FR-056, FR-201; docs/09 §7). A trigger is one source
// (a webhook made here, an MCP server's advertised event, or a watched Slack conversation) and
// what it starts: a Work run, or a wake of an agent. A webhook's token and signing secret are made
// in the browser, stored by the Hub and shown once. Bodies are checked with the Hub's schemas
// before they are sent; the Hub's field errors land on their fields.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import {
  createMcpSubscriptionSchema,
  createTriggerSchema,
  updateTriggerSchema,
  type AgentView,
  type ChannelBindingViewM7,
  type McpEventSourceView,
  type ProjectView,
  type TriggerAction,
  type TriggerView,
} from '@nova/shared';
import { Button, Dialog, Icon, RadioGroup, SelectField, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useChannelsApi } from './api.ts';
import { CREDENTIAL_TEXT, absoluteUrl, errorField, issueErrors, randomSecret } from './format.ts';
import { CopyValue, SecretsOnce, SigningHelp, TextAreaField } from './parts.tsx';

export type NewTriggerKind = 'webhook' | 'mcp_event' | 'connector_event';

/** The trigger dialogs' words (FR-016). Names, event names and the Hub's errors are data. */
export const TRIGGER_DIALOG_TEXT = defineMessages('channels.triggerDialogs', {
  newTitle: {
    webhook: 'New webhook trigger',
    mcp_event: 'New MCP event trigger',
    connector_event: 'New channel watch',
  },
  newDescription: {
    webhook:
      'A private address another service calls to start work. Calls must carry the token and a signature.',
    mcp_event:
      'Subscribe to an event a connected MCP server offers. Nova renews the subscription before it expires.',
    connector_event:
      'Start work when a message arrives in a Slack conversation. Only this watch reads it; joining a channel never does.',
  },
  notObject: 'Enter a JSON object, like {example}.',
  notJson: 'This is not valid JSON.',
  noSources: 'No connected MCP server offers events. Connect one in Settings → Tools & MCP.',
  noSlack: 'Add a Slack channel first: a watch reads a conversation through it.',
  chooseAgent: 'Choose the agent to wake.',
  subscribed: 'Subscribed.',
  savedPending: 'Saved. Nova subscribes once the server answers.',
  added: '{name} added.',
  addFailed: 'Could not add the trigger.',
  webhookAdded: 'Webhook trigger added',
  webhookAddedWhat: 'Give the address, token and secret to the service that will call it.',
  done: 'Done',
  address: 'Webhook address',
  addressHint: 'POST the event here; JSON or plain text.',
  cancel: 'Cancel',
  adding: 'Adding…',
  subscribe: 'Subscribe',
  add: 'Add trigger',
  server: 'MCP server',
  event: 'Event',
  filter: 'Filter (optional)',
  filterLabel: 'Filter as JSON',
  filterHint: 'Sent to the server with the subscription; it decides which events match.',
  slackChannel: 'Slack channel',
  slackChannelHint: "Messages arrive through this channel's Slack app.",
  conversation: 'Conversation to watch (optional)',
  conversationHint: "Another conversation of the same app; empty watches the channel's own.",
  contains: 'Only messages containing (optional)',
  duplicates: 'Duplicate events',
  eventId: 'Event id field (optional)',
  eventIdHint:
    'The field of the JSON body that names the event, like id or event.id. An event seen before starts nothing.',
  starts: 'What it starts',
  when: 'When it fires',
  run: { label: 'Start a Work run', description: 'A new run with these instructions.' },
  wake: {
    label: 'Wake an agent',
    description: 'A turn in the agent’s thread.',
    noAgents: 'No agents yet; create one in Agents first.',
  },
  agent: 'Agent',
  noAgents: 'No agents',
  project: 'Project (optional)',
  noProject: 'No project',
  instructions: 'Instructions',
  instructionsExample: 'Triage the new issue and label it.',
  instructionsHint:
    'What to do with each event. The event itself is passed along as untrusted data, never as your instruction.',
  name: 'Name (optional)',
  askFirst: 'Ask before acting',
  askFirstHint: 'The run or the agent asks you before each action.',
  editTitle: 'Edit {name}',
  editName: 'Name',
  saving: 'Saving…',
  save: 'Save',
  saved: '{name} saved.',
  saveFailed: 'Could not save the trigger.',
});

/** Examples shown in empty fields: JSON and field names, not translated. */
const EXAMPLE = { filter: '{"repo": "nova"}', eventId: 'id' } as const;

interface Form {
  title: string;
  instructions: string;
  action: TriggerAction;
  agentId: string;
  projectId: string;
  askFirst: boolean;
  dedupeKey: string;
  serverId: string;
  event: string;
  filter: string;
  bindingId: string;
  conversation: string;
  contains: string;
}

const opt = (v: string) => (v.trim() ? v.trim() : undefined);

/** The create body for the form (the webhook credentials are passed in, made by the caller). */
export function triggerBody(
  kind: NewTriggerKind,
  f: Form,
  credentials: { token: string; secret: string },
): { body: Record<string, unknown>; filterError: string | null } {
  const base = {
    ...(opt(f.title) ? { title: opt(f.title) } : {}),
    instructions: f.instructions,
    action: f.action,
    ...(f.action === 'wake' && f.agentId ? { agentId: f.agentId } : {}),
    ...(f.action === 'run' && f.projectId ? { projectId: f.projectId } : {}),
    ...(f.askFirst ? { autonomy: 'ask_first' } : {}),
  };
  switch (kind) {
    case 'webhook':
      return {
        body: {
          ...base,
          kind,
          credentials,
          ...(opt(f.dedupeKey) ? { dedupeKey: opt(f.dedupeKey) } : {}),
        },
        filterError: null,
      };
    case 'connector_event':
      return {
        body: {
          ...base,
          kind,
          bindingId: f.bindingId,
          ...(opt(f.conversation) ? { conversation: opt(f.conversation) } : {}),
          ...(opt(f.contains) ? { contains: opt(f.contains) } : {}),
        },
        filterError: null,
      };
    case 'mcp_event': {
      let filter: Record<string, unknown> | undefined;
      let filterError: string | null = null;
      if (f.filter.trim()) {
        try {
          const v = JSON.parse(f.filter) as unknown;
          if (v && typeof v === 'object' && !Array.isArray(v))
            filter = v as Record<string, unknown>;
          else filterError = TRIGGER_DIALOG_TEXT.notObject({ example: EXAMPLE.filter });
        } catch {
          filterError = TRIGGER_DIALOG_TEXT.notJson;
        }
      }
      return {
        body: {
          ...base,
          serverId: f.serverId,
          event: f.event,
          ...(filter ? { filter } : {}),
        },
        filterError,
      };
    }
  }
}

export function NewTriggerDialog({
  kind,
  onClose,
  agents,
  projects,
  sources,
  slackBindings,
  publicUrl,
  onCreated,
}: {
  kind: NewTriggerKind;
  onClose: () => void;
  agents: AgentView[] | null;
  projects: ProjectView[];
  sources: McpEventSourceView[] | null;
  slackBindings: ChannelBindingViewM7[];
  publicUrl: string | null;
  /** The new trigger (or, for an MCP event, a refetch is enough). */
  onCreated: (t: TriggerView | null) => void;
}) {
  const api = useChannelsApi();
  const toast = useToast();
  const S = TRIGGER_DIALOG_TEXT;
  const [form, setForm] = useState<Form>(() => ({
    title: '',
    instructions: '',
    action: 'run',
    agentId: agents?.[0]?.id ?? '',
    projectId: '',
    askFirst: false,
    dedupeKey: '',
    serverId: sources?.[0]?.serverId ?? '',
    event: sources?.[0]?.events[0]?.name ?? '',
    filter: '',
    bindingId: slackBindings[0]?.id ?? '',
    conversation: '',
    contains: '',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    trigger: TriggerView;
    secrets: { token: string; secret: string };
  } | null>(null);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const server = sources?.find((s) => s.serverId === form.serverId) ?? null;
  const event = server?.events.find((e) => e.name === form.event) ?? null;
  const blocked =
    kind === 'mcp_event'
      ? !sources?.length
        ? S.noSources
        : null
      : kind === 'connector_event' && !slackBindings.length
        ? S.noSlack
        : null;

  const submit = async () => {
    if (busy || blocked) return;
    const credentials = { token: randomSecret(24), secret: randomSecret(32) };
    const { body, filterError } = triggerBody(kind, form, credentials);
    const parsed =
      kind === 'mcp_event'
        ? createMcpSubscriptionSchema.safeParse(body)
        : createTriggerSchema.safeParse(body);
    const next = parsed.success ? {} : issueErrors(parsed.error.issues);
    if (filterError) next.filter = filterError;
    if (form.action === 'wake' && !form.agentId) next.agentId = S.chooseAgent;
    if (Object.keys(next).length || !parsed.success) {
      setErrors(next);
      return;
    }
    setErrors({});
    setFailure(null);
    setBusy(true);
    try {
      if (kind === 'mcp_event') {
        const sub = await api.createMcpSubscription(
          parsed.data as Parameters<typeof api.createMcpSubscription>[0],
        );
        onCreated(null);
        toast.show(sub.status === 'active' ? S.subscribed : S.savedPending, { tone: 'success' });
        onClose();
        return;
      }
      const t = await api.createTrigger(parsed.data as Parameters<typeof api.createTrigger>[0]);
      onCreated(t);
      if (kind === 'webhook') setCreated({ trigger: t, secrets: credentials });
      else {
        toast.show(S.added({ name: t.title }), { tone: 'success' });
        onClose();
      }
    } catch (err) {
      const field = errorField(err);
      const message = errorMessage(err, S.addFailed);
      if (field) setErrors({ [field]: message });
      else setFailure(message);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Dialog
        open
        className="ch-dialog"
        title={S.webhookAdded}
        description={S.webhookAddedWhat}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            {S.done}
          </Button>
        }
      >
        <div className="stack">
          {created.trigger.webhookPath ? (
            <CopyValue
              label={S.address}
              value={absoluteUrl(created.trigger.webhookPath, publicUrl)}
              hint={S.addressHint}
            />
          ) : null}
          <SecretsOnce
            items={[
              { label: CREDENTIAL_TEXT.token, value: created.secrets.token },
              { label: CREDENTIAL_TEXT.secret, value: created.secrets.secret },
            ]}
          />
          <SigningHelp eventId />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      className="ch-dialog"
      title={S.newTitle[kind]}
      description={S.newDescription[kind]}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button variant="primary" disabled={busy || !!blocked} onClick={() => void submit()}>
            {busy ? S.adding : kind === 'mcp_event' ? S.subscribe : S.add}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        aria-label={S.newTitle[kind]}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {blocked ? (
          <p role="status" className="ws-warning">
            <Icon name="alert" /> {blocked}
          </p>
        ) : null}
        {kind === 'mcp_event' && sources?.length ? (
          <>
            <SelectField
              label={S.server}
              value={form.serverId}
              error={errors.serverId}
              onChange={(v) => {
                const s = sources.find((x) => x.serverId === v);
                set({ serverId: v, event: s?.events[0]?.name ?? '' });
              }}
              options={sources.map((s) => ({ value: s.serverId, label: s.name }))}
            />
            <SelectField
              label={S.event}
              value={form.event}
              error={errors.event}
              hint={event?.description ?? undefined}
              onChange={(v) => set({ event: v })}
              options={(server?.events ?? []).map((e) => ({ value: e.name, label: e.name }))}
            />
            <details className="ws-advanced">
              <summary>{S.filter}</summary>
              <TextAreaField
                label={S.filterLabel}
                value={form.filter}
                spellCheck={false}
                placeholder={EXAMPLE.filter}
                hint={S.filterHint}
                error={errors.filter}
                onChange={(v) => set({ filter: v })}
              />
            </details>
          </>
        ) : null}
        {kind === 'connector_event' && slackBindings.length ? (
          <>
            <SelectField
              label={S.slackChannel}
              value={form.bindingId}
              error={errors.bindingId}
              onChange={(v) => set({ bindingId: v })}
              options={slackBindings.map((b) => ({ value: b.id, label: b.label }))}
              hint={S.slackChannelHint}
            />
            <TextField
              label={S.conversation}
              value={form.conversation}
              spellCheck={false}
              autoComplete="off"
              placeholder={slackBindings.find((b) => b.id === form.bindingId)?.externalRef}
              hint={S.conversationHint}
              error={errors.conversation}
              onChange={(e) => set({ conversation: e.target.value })}
            />
            <TextField
              label={S.contains}
              value={form.contains}
              error={errors.contains}
              onChange={(e) => set({ contains: e.target.value })}
            />
          </>
        ) : null}
        <WhatItStarts form={form} set={set} errors={errors} agents={agents} projects={projects} />
        {kind === 'webhook' ? (
          <details className="ws-advanced">
            <summary>{S.duplicates}</summary>
            <TextField
              label={S.eventId}
              value={form.dedupeKey}
              spellCheck={false}
              autoComplete="off"
              placeholder={EXAMPLE.eventId}
              hint={S.eventIdHint}
              error={errors.dedupeKey}
              onChange={(e) => set({ dedupeKey: e.target.value })}
            />
          </details>
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

/** Title, instructions, run or wake, the agent or project, and asking first. */
function WhatItStarts({
  form,
  set,
  errors,
  agents,
  projects,
}: {
  form: Form;
  set: (patch: Partial<Form>) => void;
  errors: Record<string, string>;
  agents: AgentView[] | null;
  projects: ProjectView[];
}) {
  const id = useId();
  const noAgents = !agents?.length;
  const S = TRIGGER_DIALOG_TEXT;
  return (
    <fieldset className="ws-fieldset">
      <legend>{S.starts}</legend>
      <RadioGroup
        legend={S.when}
        name={`${id}-action`}
        value={form.action}
        onChange={(v) => set({ action: v as TriggerAction })}
        options={[
          { value: 'run', label: S.run.label, description: S.run.description },
          {
            value: 'wake',
            label: S.wake.label,
            description: noAgents ? S.wake.noAgents : S.wake.description,
          },
        ]}
      />
      {form.action === 'wake' ? (
        <SelectField
          label={S.agent}
          value={form.agentId}
          error={errors.agentId}
          disabled={noAgents}
          onChange={(v) => set({ agentId: v })}
          options={
            noAgents
              ? [{ value: '', label: S.noAgents }]
              : (agents ?? []).map((a) => ({ value: a.id, label: a.name }))
          }
        />
      ) : (
        <SelectField
          label={S.project}
          value={form.projectId}
          error={errors.projectId}
          onChange={(v) => set({ projectId: v })}
          options={[
            { value: '', label: S.noProject },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      )}
      <TextAreaField
        label={S.instructions}
        value={form.instructions}
        maxLength={8000}
        placeholder={S.instructionsExample}
        hint={S.instructionsHint}
        error={errors.instructions}
        onChange={(v) => set({ instructions: v })}
      />
      <TextField
        label={S.name}
        value={form.title}
        maxLength={200}
        error={errors.title}
        onChange={(e) => set({ title: e.target.value })}
      />
      <SwitchField
        label={S.askFirst}
        description={S.askFirstHint}
        checked={form.askFirst}
        onChange={(v) => set({ askFirst: v })}
      />
    </fieldset>
  );
}

/** Edit a trigger's name, instructions, asking first, and its kind's filter. */
export function EditTriggerDialog({
  trigger,
  onClose,
  onSaved,
}: {
  trigger: TriggerView;
  onClose: () => void;
  onSaved: (t: TriggerView) => void;
}) {
  const api = useChannelsApi();
  const toast = useToast();
  const [title, setTitle] = useState(trigger.title);
  const [instructions, setInstructions] = useState(trigger.instructions);
  const [askFirst, setAskFirst] = useState(trigger.autonomy === 'ask_first');
  const [dedupeKey, setDedupeKey] = useState(trigger.dedupeKey ?? '');
  const contains0 = typeof trigger.config.contains === 'string' ? trigger.config.contains : '';
  const [contains, setContains] = useState(contains0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const S = TRIGGER_DIALOG_TEXT;

  const patch: Record<string, unknown> = {};
  if (title.trim() !== trigger.title) patch.title = title.trim();
  if (instructions.trim() !== trigger.instructions) patch.instructions = instructions.trim();
  if (askFirst !== (trigger.autonomy === 'ask_first'))
    patch.autonomy = askFirst ? 'ask_first' : 'standard';
  if (trigger.kind === 'webhook' && dedupeKey.trim() !== (trigger.dedupeKey ?? ''))
    patch.dedupeKey = dedupeKey.trim() || null;
  if (trigger.kind === 'connector_event' && contains.trim() !== contains0)
    patch.contains = contains.trim() || null;
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    if (!dirty || busy) return;
    const parsed = updateTriggerSchema.safeParse(patch);
    if (!parsed.success) {
      setErrors(issueErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const t = await api.updateTrigger(trigger.id, parsed.data);
      onSaved(t);
      toast.show(S.saved({ name: t.title }), { tone: 'success' });
      onClose();
    } catch (err) {
      const field = errorField(err);
      const message = errorMessage(err, S.saveFailed);
      setErrors({ [field ?? '_']: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      className="ch-dialog"
      title={S.editTitle({ name: trigger.title })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? S.saving : S.save}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        aria-label={S.editTitle({ name: trigger.title })}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label={S.editName}
          value={title}
          maxLength={200}
          error={errors.title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextAreaField
          label={S.instructions}
          value={instructions}
          maxLength={8000}
          error={errors.instructions}
          onChange={setInstructions}
        />
        <SwitchField
          label={S.askFirst}
          description={S.askFirstHint}
          checked={askFirst}
          onChange={setAskFirst}
        />
        {trigger.kind === 'webhook' ? (
          <TextField
            label={S.eventId}
            value={dedupeKey}
            spellCheck={false}
            autoComplete="off"
            placeholder={EXAMPLE.eventId}
            error={errors.dedupeKey}
            onChange={(e) => setDedupeKey(e.target.value)}
          />
        ) : null}
        {trigger.kind === 'connector_event' ? (
          <TextField
            label={S.contains}
            value={contains}
            error={errors.contains}
            onChange={(e) => setContains(e.target.value)}
          />
        ) : null}
        {errors._ ? (
          <p role="alert" className="nv-field-error">
            {errors._}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
