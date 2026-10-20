// First-run onboarding (FR-014, docs/04 §2.1 and §8): provider → default model → name → tool →
// sample task → land in the chat. Every step can be skipped, and progress is saved to the
// `onboarding.state` setting after each step so a reload resumes where the user left off. The
// tool step adds an MCP server with the same form as Settings → Tools & MCP.
import { useEffect, useRef, useState } from 'react';
import type { McpServerView, ProviderAccountView } from '@nova/shared';
import { Button, Icon, Kbd, RadioGroup, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { PROVIDER_NAMES } from '../providers/names.ts';
import { pendingFromText } from '../chat/attachments.ts';
import { formatBinding } from '../keys.ts';
import { ProviderSetup } from '../providers/ProviderSetup.tsx';
import { McpServerForm } from '../settings/McpServerForm.tsx';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels, useThreads } from '../stores.tsx';
import { fmt } from '@nova/i18n';
import { rich } from '../i18n/rich.tsx';
import { SAMPLE_DOCUMENT, SAMPLE_NAME } from './sample.ts';
import { ONBOARDING_TEXT as T } from './strings.ts';

type Step = 'provider' | 'model' | 'profile' | 'tool' | 'sample';

/** Settings → Data, at its import section. */
export const DATA_IMPORT_PATH = '/settings/data#import';

/** The steps in order; each one's title is T.steps[id]. */
const STEPS: { id: Step }[] = [
  { id: 'provider' },
  { id: 'model' },
  { id: 'profile' },
  { id: 'tool' },
  { id: 'sample' },
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
      toast.show(T.saveProgressFailed({ reason: errorMessage(err) }), { tone: 'error' });
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
      {index > 0 ? <Button onClick={back}>{T.back}</Button> : null}
      {step !== 'sample' ? (
        <Button variant="ghost" onClick={next}>
          {T.skipStep}
        </Button>
      ) : null}
    </div>
  );

  return (
    <div className="onboarding">
      <header className="onboarding-header">
        <p className="muted">{T.stepOf({ n: index + 1, total: STEPS.length })}</p>
        <ol className="onboarding-steps" aria-label={T.stepsLabel}>
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              aria-current={s.id === step ? 'step' : undefined}
              data-done={i < index || undefined}
            >
              {T.steps[s.id]}
            </li>
          ))}
        </ol>
        <button type="button" className="link onboarding-skip" onClick={skipAll}>
          {T.skipSetup}
        </button>
      </header>
      <h1 ref={heading} tabIndex={-1} className="onboarding-title">
        {T.steps[step]}
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
      <p className="muted">{T.provider.intro}</p>
      {existing?.length ? (
        <div className="panel-inset">
          <p>{T.provider.connected}</p>
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
              {T.continue}
            </Button>
            {!adding ? (
              <Button onClick={() => setAdding(true)}>{T.provider.addAnother}</Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {/* After "Delete all data" a Hub starts empty: an owner can restore an export instead. The
          setup state stays as it is; the imported settings decide it after the Hub restarts. */}
      <div className="row">
        <p className="muted" id="onboarding-restore-hint">
          {T.provider.restoreHint}
        </p>
        <Button
          aria-describedby="onboarding-restore-hint"
          onClick={() => navigate(DATA_IMPORT_PATH)}
        >
          {T.provider.restore}
        </Button>
      </div>
      {showForm && existing !== null ? (
        <ProviderSetup
          submitLabel={T.provider.connectAndTest}
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
        <p>{T.model.none}</p>
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
            toast.show(T.saveFailed({ reason: errorMessage(err) }), { tone: 'error' }),
          );
      }}
    >
      <RadioGroup
        legend={T.model.legend}
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
          {T.continue}
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
          (err: unknown) => setError(errorMessage(err, T.profile.saveFailed)),
        );
      }}
    >
      <TextField
        label={T.profile.displayName}
        hint={T.profile.hint}
        value={name}
        maxLength={100}
        autoComplete="name"
        onChange={(e) => setName(e.target.value)}
        error={error ?? undefined}
      />
      <div className="row">
        <Button type="submit" variant="primary">
          {T.continue}
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
      <p>{T.tool.intro}</p>
      {added.length ? (
        <p role="status">
          {T.tool.added({ n: added.length, names: fmt.list(added.map((s) => s.name)) })}
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
            <Icon name="plus" /> {added.length ? T.tool.addAnotherServer : T.tool.addServer}
          </Button>
          <Button variant="primary" onClick={onDone}>
            {T.continue}
          </Button>
        </div>
      )}
      <p className="muted">{T.tool.later}</p>
      <p className="muted">
        {rich(T.tool.importPrompt, {
          link: (
            <a
              href="/settings/import"
              onClick={(e) => {
                e.preventDefault();
                navigate('/settings/import');
              }}
            >
              {T.tool.importLink}
            </a>
          ),
        })}
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
  const [text, setText] = useState(() => T.sample.prompt);
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
        title: T.sample.threadTitle,
        model: model ?? undefined,
      });
      memory.pending.set(thread.id, { text, attachments: [attachment] });
      threads.upsertLocal(thread);
      await onFinish();
      navigate(chatPath(thread.id));
      toast.show(T.sample.done, { tone: 'success' });
    } catch (err) {
      setError(errorMessage(err, T.sample.startFailed));
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <aside className="primer" aria-labelledby="primer-title">
        <h2 id="primer-title" className="primer-title">
          <Icon name="stop" /> {T.sample.control}
        </h2>
        <ul>
          <li>
            {rich(T.sample.stopTip, {
              stop: <strong>{T.sample.stop}</strong>,
              key: <Kbd keys={formatBinding('escape', mac)} />,
            })}
          </li>
          <li>{T.sample.approvalTip}</li>
          <li>{rich(T.sample.paletteTip, { key: <Kbd keys={formatBinding('mod+k', mac)} /> })}</li>
        </ul>
      </aside>
      <p>{model ? T.sample.tryIt : T.sample.tryItNoModel}</p>
      <label className="nv-field-label" htmlFor="sample-message">
        {T.sample.message}
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
          <Icon name="file" /> <span translate="no">{SAMPLE_NAME}</span>{' '}
          <span className="muted">({fmt.bytes(attachment.size)})</span>
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
          {T.sample.run}
        </Button>
        <Button
          onClick={() => {
            void onFinish().then(() => navigate(chatPath(null)));
          }}
        >
          {T.sample.finishWithout}
        </Button>
      </div>
      {nav}
    </div>
  );
}
