// Appshots (FR-075; docs/11 §6): a window, the whole screen or the agent browser's page saved as
// an image artifact for debugging, with its app, window title and time. They also appear in the
// Library with the other artifacts.
import { useEffect, useId, useState } from 'react';
import type { AppshotView, ScreenWindowView } from '@nova/shared';
import { Button, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useScreenApi } from './api.ts';
import { sentence } from './format.ts';

type Source = AppshotView['source'];

const SOURCE_TEXT: Record<Source, string> = {
  window: 'A window',
  screen: 'The whole screen',
  browser: 'The agent browser page',
};

export function appshotLabel(s: AppshotView): string {
  const what = s.app ?? (s.source === 'screen' ? 'Screen' : 'Browser');
  return s.windowTitle ? `${what} – ${s.windowTitle}` : what;
}

export function Appshots({
  computerId,
  windows,
}: {
  computerId: string;
  /** Apps on screen from the last look, offered as the window to capture. */
  windows: ScreenWindowView[] | null;
}) {
  const api = useScreenApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const listId = useId();
  const [items, setItems] = useState<AppshotView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<Source>('window');
  const [app, setApp] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.listAppshots({ computerId, limit: 50 }).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the appshots.')),
    );
    return () => {
      alive = false;
    };
  }, [api, computerId, attempt]);

  const capture = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const shot = await api.captureAppshot(computerId, {
        source,
        ...(source === 'window' && app.trim() ? { app: app.trim() } : {}),
      });
      setItems((list) => [shot, ...(list ?? []).filter((s) => s.id !== shot.id)]);
      setShown(shot.id);
      announce(`Appshot saved: ${appshotLabel(shot)}.`);
      toast.show('Appshot saved. It is also in the Library.', { tone: 'success' });
    } catch (err) {
      setProblem(sentence(errorMessage(err, 'The appshot could not be taken.')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section scr-appshots" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>Appshots</h3>
      </div>
      <p className="muted ws-flush">
        Save what an app shows as an image, to look at later or share in a chat.
      </p>
      <form
        className="ws-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void capture();
        }}
      >
        <SelectField
          label="Capture"
          value={source}
          onChange={(v) => setSource(v as Source)}
          options={(Object.keys(SOURCE_TEXT) as Source[]).map((s) => ({
            value: s,
            label: SOURCE_TEXT[s],
          }))}
        />
        {source === 'window' ? (
          <>
            <TextField
              label="App"
              value={app}
              list={listId}
              maxLength={200}
              autoComplete="off"
              placeholder="The one in front"
              onChange={(e) => setApp(e.target.value)}
            />
            <datalist id={listId}>
              {(windows ?? []).map((w) => (
                <option key={w.id} value={w.app} />
              ))}
            </datalist>
          </>
        ) : null}
        <Button type="submit" disabled={busy}>
          <Icon name="image" /> Take appshot
        </Button>
      </form>
      {problem ? (
        <p className="ws-warning" role="alert">
          <Icon name="alert" /> {problem}
        </p>
      ) : null}
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label="Loading appshots" /> : null}
      {items?.length === 0 ? <p className="muted">No appshots of this computer yet.</p> : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Appshots">
          {items.map((s) => {
            const label = appshotLabel(s);
            const src = api.appshotImageUrl(s.artifactId);
            return (
              <li key={s.id} className="ws-list-row" aria-label={label}>
                <div className="ws-source-main">
                  <strong>{label}</strong>
                  <span className="muted ws-row-meta">
                    <span>{SOURCE_TEXT[s.source]}</span>
                    {s.width && s.height ? (
                      <span>
                        {s.width}×{s.height}
                      </span>
                    ) : null}
                    <span>{s.capturedBy === 'user' ? 'By you' : 'By Nova'}</span>
                    <span>{formatWhen(s.capturedAt)}</span>
                  </span>
                </div>
                <div className="row ws-row-actions">
                  <Button
                    aria-expanded={shown === s.id}
                    onClick={() => setShown((v) => (v === s.id ? null : s.id))}
                  >
                    {shown === s.id ? 'Hide' : 'View'}
                  </Button>
                  <a
                    className="nv-btn"
                    data-variant="ghost"
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Icon name="external" /> Open image
                  </a>
                </div>
                {shown === s.id ? (
                  <figure className="scr-appshot-figure">
                    <img src={src} alt={`Appshot: ${label}`} />
                    {s.url ? <figcaption className="muted">{s.url}</figcaption> : null}
                  </figure>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
