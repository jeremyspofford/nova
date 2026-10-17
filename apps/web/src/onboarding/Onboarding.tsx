// First-run onboarding (FR-014, docs/04 §2.1 and §8): provider → default model → name → tool →
// sample task → land in the chat. Every step can be skipped, and progress is saved to the
// `onboarding.state` setting after each step so a reload resumes where the user left off. The
// tool step adds an MCP server with the same form as Settings → Tools & MCP.
import { useEffect, useRef, useState } from 'react';
import type { McpServerView, ProviderAccountView } from '@nova/shared';
import { Button, Icon, Kbd, RadioGroup, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { PROVIDER_NAMES } from '../providers/names.ts';
import { formatBytes, pendingFromText } from '../chat/attachments.ts';
import { formatBinding } from '../keys.ts';
import { ProviderSetup } from '../providers/ProviderSetup.tsx';
import { McpServerForm } from '../settings/McpServerForm.tsx';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels, useThreads } from '../stores.tsx';
import { SAMPLE_DOCUMENT, SAMPLE_NAME, SAMPLE_PROMPT } from './sample.ts';

type Step = 'provider' | 'model' | 'profile' | 'tool' | 'sample';

const STEPS: { id: Step; title: string }[] = [
  { id: 'provider', title: 'Connect a model provider' },
  { id: 'model', title: 'Pick a default model' },
  { id: 'profile', title: 'Choose your name' },
  { id: 'tool', title: 'Connect a tool' },
  { id: 'sample', title: 'Run a first task' },
];

export function Onboarding({
  displayName,
  onDisplayName,
}: {
  displayName: string | null;
  onDisplayName: (name: string | null) => void;
}) {
  const settings = useSettings();
  const toast = useToast();
  const state = settings.get('onboarding.state');
  const [step, setStep] = useState<Step>(
    state.value.step === 'done' ? 'provider' : state.value.step,
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const index = STEPS.findIndex((s) => s.id === step);

  useEffect(() => {
    // Move focus to the new step's heading so screen readers announce it (not on first load).
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const save = (value: typeof state.value) =>
    settings.set('onboarding.state', value).catch((err: unknown) => {
      toast.show(`Could not save your progress: ${errorMessage(err)}`, { tone: 'error' });
    });

  const go = (next: Step) => {
    setStep(next);
    void save({ ...state.value, step: next });
  };
  const next = () => {
    const n = STEPS[index + 1];
    if (n) go(n.id);
  };
  const back = () => {
    const p = STEPS[index - 1];
    if (p) go(p.id);
  };
  const finish = async () => {
    await save({ step: 'done', completed: true, skipped: false });
  };
  const skipAll = () => {
    void save({ ...state.value, skipped: true });
    navigate(chatPath(null));
  };

  const nav = (
    <div className="onboarding-nav">
      {index > 0 ? <Button onClick={back}>Back</Button> : null}
      {step !== 'sample' ? (
        <Button variant="ghost" onClick={next}>
          Skip this step
        </Button>
      ) : null}
    </div>
  );

  return (
    <div className="onboarding">
      <header className="onboarding-header">
        <p className="muted">
          Step {index + 1} of {STEPS.length}
        </p>
        <ol className="onboarding-steps" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              aria-current={s.id === step ? 'step' : undefined}
              data-done={i < index || undefined}
            >
              {s.title}
            </li>
          ))}
        </ol>
        <button type="button" className="link onboarding-skip" onClick={skipAll}>
          Skip setup
        </button>
      </header>
      <h1 ref={heading} tabIndex={-1} className="onboarding-title">
        {STEPS[index]?.title}
      </h1>
      {step === 'provider' ? <ProviderStep onDone={next} nav={nav} /> : null}
      {step === 'model' ? <ModelStep onDone={next} nav={nav} /> : null}
      {step === 'profile' ? (
        <ProfileStep
          displayName={displayName}
          onDisplayName={onDisplayName}
          onDone={next}
          nav={nav}
        />
      ) : null}
      {step === 'tool' ? <ToolStep onDone={next} nav={nav} /> : null}
      {step === 'sample' ? <SampleStep onFinish={finish} nav={nav} /> : null}
    </div>
  );
}

function ProviderStep({ onDone, nav }: { onDone: () => void; nav: React.ReactNode }) {
  const { api } = useServices();
  const models = useModels();
  const [existing, setExisting] = useState<ProviderAccountView[] | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let alive = true;
    api.listProviders().then(
      ({ items }) => alive && setExisting(items),
      () => alive && setExisting([]),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const showForm = adding || existing?.length === 0;
  return (
    <div className="stack">
      <p className="muted">
        Nova sends your messages to the model provider you choose. Pick Mock to try it offline.
      </p>
      {existing?.length ? (
        <div className="panel-inset">
          <p>Already connected:</p>
          <ul>
            {existing.map((p) => (
              <li key={p.id}>
                {p.label}{' '}
                <span className="muted">({PROVIDER_NAMES[p.provider] ?? p.provider})</span>
              </li>
            ))}
          </ul>
          <div className="row">
            <Button variant="primary" onClick={onDone}>
              Continue
            </Button>
            {!adding ? <Button onClick={() => setAdding(true)}>Add another</Button> : null}
          </div>
        </div>
      ) : null}
      {showForm && existing !== null ? (
        <ProviderSetup
          submitLabel="Connect and test"
          onConnected={() => {
            void models.refresh();
            onDone();
          }}
        />
      ) : null}
      {nav}
    </div>
  );
}

function ModelStep({ onDone, nav }: { onDone: () => void; nav: React.ReactNode }) {
  const settings = useSettings();
  const toast = useToast();
  const { models, loading } = useModels();
  const current = settings.get('chat.defaultModel').value;
  const [choice, setChoice] = useState<string | null>(null);
  const selected = choice ?? current ?? models[0]?.ref ?? '';

  if (!loading && models.length === 0) {
    return (
      <div className="stack">
        <p>No models are available yet. Go back and connect a provider, or skip for now.</p>
        {nav}
      </div>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!selected) return;
        settings
          .set('chat.defaultModel', selected)
          .then(onDone, (err: unknown) =>
            toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
          );
      }}
    >
      <RadioGroup
        legend="Default model for new chats"
        name="default-model"
        value={selected}
        onChange={setChoice}
        options={models.map((m) => ({
          value: m.ref,
          label: m.label,
          description: PROVIDER_NAMES[m.provider] ?? m.provider,
        }))}
      />
      <div className="row">
        <Button type="submit" variant="primary" disabled={!selected}>
          Continue
        </Button>
      </div>
      {nav}
    </form>
  );
}

function ProfileStep({
  displayName,
  onDisplayName,
  onDone,
  nav,
}: {
  displayName: string | null;
  onDisplayName: (n: string | null) => void;
  onDone: () => void;
  nav: React.ReactNode;
}) {
  const { api } = useServices();
  const [name, setName] = useState(displayName ?? '');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || trimmed === displayName) {
          onDone();
          return;
        }
        api.updateAccount({ displayName: trimmed }).then(
          (res) => {
            onDisplayName(res.displayName);
            onDone();
          },
          (err: unknown) => setError(errorMessage(err, 'Could not save your name.')),
        );
      }}
    >
      <TextField
        label="Display name"
        hint="Shown in Nova on your devices. Add a username and avatar later in Settings, Profile & usage."
        value={name}
        maxLength={100}
        autoComplete="name"
        onChange={(e) => setName(e.target.value)}
        error={error ?? undefined}
      />
      <div className="row">
        <Button type="submit" variant="primary">
          Continue
        </Button>
      </div>
      {nav}
    </form>
  );
}

function ToolStep({ onDone, nav }: { onDone: () => void; nav: React.ReactNode }) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<McpServerView[]>([]);
  return (
    <div className="stack">
      <p>
        Tools let Nova work with your files, issue trackers, calendars and other services through
        MCP servers. Add one now, or skip this step.
      </p>
      {added.length ? (
        <p role="status">
          Added {added.map((s) => s.name).join(', ')}. It connects in the background.
        </p>
      ) : null}
      {adding ? (
        <div className="panel-inset">
          <McpServerForm
            onCancel={() => setAdding(false)}
            onSaved={(s) => {
              setAdding(false);
              setAdded((list) => [...list, s]);
            }}
          />
        </div>
      ) : (
        <div className="row">
          <Button onClick={() => setAdding(true)}>
            <Icon name="plus" /> {added.length ? 'Add another server' : 'Add an MCP server'}
          </Button>
          <Button variant="primary" onClick={onDone}>
            Continue
          </Button>
        </div>
      )}
      <p className="muted">You can connect tools later in Settings, Tools &amp; MCP.</p>
      <p className="muted">
        Coming from another assistant?{' '}
        <a
          href="/settings/import"
          onClick={(e) => {
            e.preventDefault();
            navigate('/settings/import');
          }}
        >
          Import its skills, servers, memories and chats
        </a>
        .
      </p>
      {nav}
    </div>
  );
}

function SampleStep({ onFinish, nav }: { onFinish: () => Promise<void>; nav: React.ReactNode }) {
  const { api, registry, memory } = useServices();
  const threads = useThreads();
  const toast = useToast();
  const { models } = useModels();
  const settings = useSettings();
  const defaultModel = settings.get('chat.defaultModel').value;
  const [text, setText] = useState(SAMPLE_PROMPT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachment] = useState(() =>
    pendingFromText(SAMPLE_NAME, 'text/markdown', SAMPLE_DOCUMENT),
  );
  const model = defaultModel ?? models[0]?.ref ?? null;
  const mac = registry.platform.mac;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const thread = await api.createThread({
        mode: 'chat',
        title: 'Sample: summarize a document',
        model: model ?? undefined,
      });
      memory.pending.set(thread.id, { text, attachments: [attachment] });
      threads.upsertLocal(thread);
      await onFinish();
      navigate(chatPath(thread.id));
      toast.show('Setup complete. Your sample task is running.', { tone: 'success' });
    } catch (err) {
      setError(errorMessage(err, 'Could not start the sample task.'));
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <aside className="primer" aria-labelledby="primer-title">
        <h2 id="primer-title" className="primer-title">
          <Icon name="stop" /> You stay in control
        </h2>
        <ul>
          <li>
            Press <strong>Stop</strong> or <Kbd keys={formatBinding('escape', mac)} /> to stop a
            reply at any time. What was written so far is kept and marked “Stopped”.
          </li>
          <li>
            Before Nova takes a consequential action, it shows an approval card that says what it
            will do and why. You can allow it once, for the session or always, deny it and let the
            work continue, deny it and stop, or do the step yourself. Every decision is in the audit
            log under Settings, Diagnostics.
          </li>
          <li>
            Open the command palette with <Kbd keys={formatBinding('mod+k', mac)} /> to find any
            action.
          </li>
        </ul>
      </aside>
      <p>
        Try a harmless first task: Nova summarizes a short sample document. This runs on the model
        you picked{model ? '' : ' (connect a provider first)'}.
      </p>
      <label className="nv-field-label" htmlFor="sample-message">
        Message
      </label>
      <textarea
        id="sample-message"
        className="nv-input sample-message"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <details className="sample-attachment">
        <summary>
          <Icon name="file" /> {SAMPLE_NAME}{' '}
          <span className="muted">({formatBytes(attachment.size)})</span>
        </summary>
        <pre>{SAMPLE_DOCUMENT}</pre>
      </details>
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row">
        <Button
          variant="primary"
          onClick={() => void run()}
          disabled={busy || !model || !text.trim()}
        >
          Run this
        </Button>
        <Button
          onClick={() => {
            void onFinish().then(() => navigate(chatPath(null)));
          }}
        >
          Finish without the sample
        </Button>
      </div>
      {nav}
    </div>
  );
}
