// Appshots (FR-075; docs/11 §6): a window, the whole screen or the agent browser's page saved as
// an image artifact for debugging, with its app, window title and time. They also appear in the
// Library with the other artifacts.
import { useEffect, useId, useState } from 'react';
import type { AppshotView, ScreenWindowView } from '@nova/shared';
import { Button, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useScreenApi } from './api.ts';
import { coord, sentence } from './format.ts';

type Source = AppshotView['source'];

export const APPSHOTS_TEXT = defineMessages('screen.appshots', {
  title: 'Appshots',
  intro: 'Save what an app shows as an image, to look at later or share in a chat.',
  sources: {
    window: 'A window',
    screen: 'The whole screen',
    browser: 'The agent browser page',
  },
  /** An appshot without an app's name. */
  unnamed: '{source, select, screen {Screen} other {Browser}}',
  /** An app (or "Screen") and its window title. */
  withTitle: '{what} – {title}',
  loadFailed: 'Could not load the appshots.',
  savedSaid: 'Appshot saved: {label}.',
  saved: 'Appshot saved. It is also in the Library.',
  notTaken: 'The appshot could not be taken.',
  capture: 'Capture',
  app: 'App',
  inFront: 'The one in front',
  take: 'Take appshot',
  retry: 'Retry',
  loading: 'Loading appshots',
  empty: 'No appshots of this computer yet.',
  size: '{width}×{height}',
  byYou: 'By you',
  byNova: 'By Nova',
  hide: 'Hide',
  view: 'View',
  openImage: 'Open image',
  image: 'Appshot: {label}',
});
const S = APPSHOTS_TEXT;

const SOURCES = ['window', 'screen', 'browser'] as const satisfies readonly Source[];

export function appshotLabel(s: AppshotView): string {
  const what = s.app ?? S.unnamed({ source: s.source });
  return s.windowTitle ? S.withTitle({ what, title: s.windowTitle }) : what;
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
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
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
      announce(S.savedSaid({ label: appshotLabel(shot) }));
      toast.show(S.saved, { tone: 'success' });
    } catch (err) {
      setProblem(sentence(errorMessage(err, S.notTaken)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section scr-appshots" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>{S.title}</h3>
      </div>
      <p className="muted ws-flush">{S.intro}</p>
      <form
        className="ws-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void capture();
        }}
      >
        <SelectField
          label={S.capture}
          value={source}
          onChange={(v) => setSource(v as Source)}
          options={SOURCES.map((s) => ({ value: s, label: S.sources[s] }))}
        />
        {source === 'window' ? (
          <>
            <TextField
              label={S.app}
              value={app}
              list={listId}
              maxLength={200}
              autoComplete="off"
              placeholder={S.inFront}
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
          <Icon name="image" /> {S.take}
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
          <Button onClick={() => setAttempt((n) => n + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={S.loading} /> : null}
      {items?.length === 0 ? <p className="muted">{S.empty}</p> : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={S.title}>
          {items.map((s) => {
            const label = appshotLabel(s);
            const src = api.appshotImageUrl(s.artifactId);
            return (
              <li key={s.id} className="ws-list-row" aria-label={label}>
                <div className="ws-source-main">
                  <strong dir="auto">{label}</strong>
                  <span className="muted ws-row-meta">
                    <span>{S.sources[s.source]}</span>
                    {s.width && s.height ? (
                      <span>{S.size({ width: coord(s.width), height: coord(s.height) })}</span>
                    ) : null}
                    <span>{s.capturedBy === 'user' ? S.byYou : S.byNova}</span>
                    <span>{formatWhen(s.capturedAt)}</span>
                  </span>
                </div>
                <div className="row ws-row-actions">
                  <Button
                    aria-expanded={shown === s.id}
                    onClick={() => setShown((v) => (v === s.id ? null : s.id))}
                  >
                    {shown === s.id ? S.hide : S.view}
                  </Button>
                  <a
                    className="nv-btn"
                    data-variant="ghost"
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Icon name="external" /> {S.openImage}
                  </a>
                </div>
                {shown === s.id ? (
                  <figure className="scr-appshot-figure">
                    <img src={src} alt={S.image({ label })} />
                    {s.url ? (
                      <figcaption className="muted" dir="ltr">
                        {s.url}
                      </figcaption>
                    ) : null}
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
