// Settings → Keyboard, "Global shortcuts" (FR-008, FR-214, docs/04 §5, docs/14 §3): the keys that
// work while Nova is in the background, Open quick chat and Attach the frontmost window. Only the
// desktop app can register them; a browser tab says so and lists the defaults. In the app each
// shortcut shows its key and whether the OS let Nova have it (another app may hold it), and can be
// changed by pressing the new keys, removed, or reset to its default, through `setShortcut`.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, Kbd, Spinner } from '@nova/ui';
import { useAnnounce } from '../services.tsx';
import {
  DEFAULT_GLOBAL_SHORTCUTS,
  GLOBAL_SHORTCUT_ACTIONS,
  GLOBAL_SHORTCUT_TEXT,
  acceleratorKeys,
  acceleratorLabel,
  acceleratorProblem,
  eventToAccelerator,
  shellErrorMessage,
  shortcutProblemText,
  useShell,
  type ShellBridge,
  type ShellShortcutAction,
  type ShellShortcutView,
} from './bridge.ts';
import './shellbridge.css';

/** Settings → Keyboard, Global shortcuts. `{title}` is a shortcut's title, `{key}` a key as printed. */
export const GLOBAL_SHORTCUTS_TEXT = defineMessages('shellbridge.globalShortcuts', {
  heading: 'Global shortcuts',
  chip: {
    off: 'Off',
    works: 'Works',
    taken: 'Taken by another app',
    usedTwice: 'Used twice',
    notValid: 'Not valid',
  },
  browserIntro:
    'These keys work while Nova is in the background, so only the Nova desktop app can offer ' +
    'them. A browser tab cannot. In the app you can change them here.',
  browserList: 'Global shortcuts in the desktop app',
  appIntro:
    'These keys work while Nova is in the background. If another app already uses a key, Nova ' +
    'cannot have it: choose another one.',
  listFailed: 'The desktop app did not list its shortcuts.',
  refused: 'The desktop app refused that key.',
  retry: 'Retry',
  loading: 'Loading global shortcuts',
  problems: 'Global shortcut problems',
  /** A shortcut with a problem: "Attach the frontmost window (Ctrl+Alt+A): Both global shortcuts use this key." */
  problemLine: '{title} ({key}): {problem}',
  list: 'Global shortcuts',
  none: 'No shortcut',
  clash:
    'In the app this key wins over Nova’s own “Go to the next item that needs input”, which also uses {key}.',
  capture: 'Press the new shortcut for {title}, or Escape to cancel',
  capturing: 'Press keys… (Esc cancels)',
  change: 'Change',
  changeFor: 'Change the shortcut for {title}',
  remove: 'Remove',
  removeFor: 'Remove the shortcut for {title}',
  reset: 'Reset',
  resetFor: 'Reset the shortcut for {title} to {key}',
  announce: {
    off: '{title}: no shortcut.',
    problem: '{title}: {problem}',
    notRegistered: '{title}: not registered.',
    set: '{title}: {key}.',
  },
});

/** The status chip of one global shortcut: icon and text, never color alone. */
function ShortcutChip({ view }: { view: ShellShortcutView }) {
  const S = GLOBAL_SHORTCUTS_TEXT.chip;
  const spec: { text: string; icon: 'check' | 'alert' | 'slash'; tone?: string } = !view.accelerator
    ? { text: S.off, icon: 'slash' }
    : view.registered
      ? { text: S.works, icon: 'check', tone: 'ready' }
      : view.problem === 'conflict'
        ? { text: S.taken, icon: 'alert', tone: 'blocked' }
        : view.problem === 'duplicate'
          ? { text: S.usedTwice, icon: 'alert', tone: 'blocked' }
          : { text: S.notValid, icon: 'alert', tone: 'blocked' };
  return (
    <span className="nv-chip" data-status={spec.tone}>
      <Icon name={spec.icon} />
      <span>{spec.text}</span>
    </span>
  );
}

export function GlobalShortcutsSection() {
  const shell = useShell();
  const headingId = useId();
  return (
    <section className="settings-section shb-shortcuts" aria-labelledby={headingId}>
      <h3 id={headingId}>{GLOBAL_SHORTCUTS_TEXT.heading}</h3>
      {shell ? <ShellShortcuts shell={shell} /> : <BrowserTabShortcuts />}
    </section>
  );
}

/** In a browser tab: nothing can be registered; say where they work and what they are. */
function BrowserTabShortcuts() {
  const mac = /mac|iphone|ipad/i.test(typeof navigator === 'undefined' ? '' : navigator.platform);
  const platform = mac ? 'darwin' : 'other';
  const S = GLOBAL_SHORTCUTS_TEXT;
  return (
    <>
      <p className="muted">{S.browserIntro}</p>
      <ul className="ws-list" aria-label={S.browserList}>
        {GLOBAL_SHORTCUT_ACTIONS.map((a) => (
          <li key={a} className="ws-list-row shb-row">
            <div className="ws-source-main">
              <strong>{GLOBAL_SHORTCUT_TEXT[a].title}</strong>
              <span className="muted ws-row-meta">{GLOBAL_SHORTCUT_TEXT[a].hint}</span>
            </div>
            <Kbd keys={acceleratorKeys(DEFAULT_GLOBAL_SHORTCUTS[a], platform)} />
          </li>
        ))}
      </ul>
    </>
  );
}

function ShellShortcuts({ shell }: { shell: ShellBridge }) {
  const announce = useAnnounce();
  const [views, setViews] = useState<ShellShortcutView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [capturing, setCapturing] = useState<ShellShortcutAction | null>(null);
  const [busy, setBusy] = useState<ShellShortcutAction | null>(null);
  const [rowError, setRowError] = useState<{ action: ShellShortcutAction; text: string } | null>(
    null,
  );
  const mac = shell.platform === 'darwin';
  const S = GLOBAL_SHORTCUTS_TEXT;

  useEffect(() => {
    let alive = true;
    shell.shortcuts().then(
      (list) => {
        if (!alive) return;
        setViews(list);
        setLoadError(null);
      },
      (err: unknown) =>
        alive && setLoadError(shellErrorMessage(err, GLOBAL_SHORTCUTS_TEXT.listFailed)),
    );
    return () => {
      alive = false;
    };
  }, [shell, attempt]);

  const set = async (action: ShellShortcutAction, accelerator: string | null) => {
    setRowError(null);
    if (accelerator) {
      const problem = acceleratorProblem(accelerator);
      if (problem) {
        setRowError({ action, text: problem });
        return;
      }
    }
    setBusy(action);
    try {
      const next = await shell.setShortcut(action, accelerator);
      setViews(next);
      const mine = next.find((v) => v.action === action);
      const title = GLOBAL_SHORTCUT_TEXT[action].title;
      if (!accelerator) announce(S.announce.off({ title }));
      else if (mine && !mine.registered && mine.problem) {
        const problem = shortcutProblemText(mine);
        announce(
          problem ? S.announce.problem({ title, problem }) : S.announce.notRegistered({ title }),
        );
      } else announce(S.announce.set({ title, key: mine?.label ?? accelerator }));
    } catch (err) {
      setRowError({ action, text: shellErrorMessage(err, S.refused) });
    } finally {
      setBusy(null);
    }
  };

  if (loadError)
    return (
      <div role="alert" className="ws-error">
        <p>{loadError}</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>{S.retry}</Button>
      </div>
    );
  if (!views) return <Spinner label={S.loading} />;

  const byAction = new Map(views.map((v) => [v.action, v]));
  const problems = views.filter((v) => v.accelerator && !v.registered && v.problem);
  return (
    <>
      <p className="muted">{S.appIntro}</p>
      {problems.length ? (
        <div className="contrast-warning" role="status" aria-label={S.problems}>
          <Icon name="alert" />
          <ul>
            {problems.map((v) => (
              <li key={v.action}>
                {S.problemLine({
                  title: GLOBAL_SHORTCUT_TEXT[v.action].title,
                  key: v.label ?? v.accelerator ?? '',
                  problem: shortcutProblemText(v) ?? '',
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="ws-list" aria-label={S.list}>
        {GLOBAL_SHORTCUT_ACTIONS.map((action) => {
          const v = byAction.get(action) ?? {
            action,
            accelerator: null,
            label: null,
            registered: false,
            problem: null,
          };
          const text = GLOBAL_SHORTCUT_TEXT[action];
          const fallback = DEFAULT_GLOBAL_SHORTCUTS[action];
          const isDefault = v.accelerator === fallback;
          const error = rowError?.action === action ? rowError.text : null;
          const clashesInApp =
            action === 'attachWindow' && !mac && v.registered && v.accelerator === fallback;
          return (
            <li
              key={action}
              className="ws-list-row shb-row"
              aria-label={text.title}
              data-problem={v.problem ?? undefined}
            >
              <div className="ws-source-main">
                <strong>{text.title}</strong>
                <span className="muted ws-row-meta">{text.hint}</span>
                <span className="shb-key">
                  {v.accelerator ? (
                    <Kbd keys={acceleratorKeys(v.accelerator, shell.platform)} />
                  ) : (
                    <span className="muted">{S.none}</span>
                  )}
                  <ShortcutChip view={v} />
                </span>
                {clashesInApp ? (
                  <span className="muted shb-note">
                    {S.clash({ key: acceleratorLabel(fallback, shell.platform) })}
                  </span>
                ) : null}
                {error ? (
                  <span role="alert" className="nv-field-error">
                    {error}
                  </span>
                ) : null}
              </div>
              <div className="row ws-row-actions">
                {capturing === action ? (
                  <button
                    type="button"
                    className="nv-btn kb-capture"
                    data-variant="primary"
                    autoFocus
                    aria-label={S.capture({ title: text.title })}
                    onBlur={() => setCapturing(null)}
                    onKeyDown={(e) => {
                      // Plain Tab leaves capture, so the keyboard is never trapped here.
                      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                        setCapturing(null);
                        return;
                      }
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                        setCapturing(null);
                        return;
                      }
                      const acc = eventToAccelerator(e, mac);
                      if (!acc) return;
                      setCapturing(null);
                      void set(action, acc);
                    }}
                  >
                    {S.capturing}
                  </button>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    aria-label={S.changeFor({ title: text.title })}
                    onClick={() => {
                      setRowError(null);
                      setCapturing(action);
                    }}
                  >
                    {busy === action ? <Spinner /> : null} {S.change}
                  </Button>
                )}
                {v.accelerator ? (
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    aria-label={S.removeFor({ title: text.title })}
                    onClick={() => void set(action, null)}
                  >
                    {S.remove}
                  </Button>
                ) : null}
                {!isDefault ? (
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    aria-label={S.resetFor({
                      title: text.title,
                      key: acceleratorLabel(fallback, shell.platform),
                    })}
                    onClick={() => void set(action, fallback)}
                  >
                    {S.reset}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
