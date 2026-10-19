// What running extensions offer to Appearance and Keyboard (FR-117, docs/14 §4.1; FR-010, FR-004):
// themes and suggested shortcuts, listed next to the user's own. Nothing is applied until the user
// chooses it: a theme is saved to (and used from) "Your themes", and a suggested shortcut is bound
// only by "Use this shortcut", which writes `keyboard.bindings` like any rebinding.
import { useSyncExternalStore } from 'react';
import type { Theme } from '@nova/ui';
import { Button, Kbd, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { bindingText, formatBinding, normalizeBinding } from '../keys.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { MANAGED } from '../settings/common.ts';
import { checkTheme } from '../settings/theme-file.ts';
import { extensionCommandKey, parseExtensionCommand } from './format.ts';
import { extensionName, useExtensionContributions } from './store.ts';
import './extensions.css';

export const OFFER_TEXT = {
  themes: 'From your extensions',
  themesHint: 'Themes your running extensions offer. Nothing changes until you save or use one.',
  saveTheme: 'Save to your themes',
  saveAndUse: 'Save and use',
  saved: 'In your themes',
  from: (name: string) => `From ${name}`,
  badTheme: (name: string, why: string) => `${name} offers a theme Nova cannot use: ${why}`,
  keys: 'Suggested by extensions',
  keysHint:
    'Shortcuts your running extensions suggest for their commands. A shortcut is bound only when you choose it.',
  use: 'Use this shortcut',
  bindFor: (keys: string, title: string) => `Use ${keys} for ${title}`,
  inUse: 'In use',
  conflict: (names: string) => `Also used by ${names}.`,
  conflictToast: (keys: string, names: string) =>
    `${keys} is also used by ${names}. Change one of them to resolve the conflict.`,
  bound: (keys: string, title: string) => `${keys} now runs ${title}.`,
  badKey: 'Nova cannot read this shortcut.',
  saveFailed: (why: string) => `Could not save the shortcut: ${why}`,
} as const;

function Swatches({ theme }: { theme: Theme }) {
  const keys = ['--u-bg', '--u-surface', '--u-text', '--u-accent'] as const;
  return (
    <span className="ws-swatches" aria-hidden="true">
      {keys.map((k) =>
        theme.tokens[k] ? (
          <span key={k} className="ws-swatch" style={{ background: theme.tokens[k] }} />
        ) : null,
      )}
    </span>
  );
}

/** Extension themes in Settings → Appearance → Themes, beside "Your themes". */
export function ExtensionThemeOffers({
  saved,
  disabled,
  onKeep,
}: {
  /** The user's saved themes (an offer already saved shows "In your themes"). */
  saved: readonly Theme[];
  /** The saved themes are managed: nothing can be added. */
  disabled: boolean;
  onKeep: (theme: Theme, use: boolean) => void;
}) {
  const state = useExtensionContributions();
  const offers = state.contributions.themes.map((t) => ({
    extensionId: t.extensionId,
    check: checkTheme(t.theme),
  }));
  if (offers.length === 0) return null;
  return (
    <div className="stack ext-offers" role="group" aria-labelledby="appearance-ext-themes">
      <h4 id="appearance-ext-themes">{OFFER_TEXT.themes}</h4>
      <p className="muted">{OFFER_TEXT.themesHint}</p>
      {disabled ? <p className="nv-field-hint nv-field-lock">{MANAGED}</p> : null}
      <ul className="ws-list" aria-label={OFFER_TEXT.themes}>
        {offers.map((o, i) => {
          const from = extensionName(state, o.extensionId);
          if (!o.check.ok)
            return (
              <li key={`${o.extensionId}:${i}`} className="ws-list-row">
                <span className="muted">
                  {OFFER_TEXT.badTheme(from, o.check.errors[0] ?? 'invalid')}
                </span>
              </li>
            );
          const theme = o.check.theme;
          const isSaved = saved.some((s) => s.id === theme.id);
          return (
            <li
              key={`${o.extensionId}:${theme.id}`}
              className="ws-list-row"
              aria-label={theme.name}
            >
              <div className="ws-source-main">
                <span className="ws-row-meta">
                  <Swatches theme={theme} />
                  <strong>{theme.name}</strong>
                  <span className="muted">{theme.variant}</span>
                </span>
                <span className="muted">{OFFER_TEXT.from(from)}</span>
              </div>
              {isSaved ? (
                <span className="muted">{OFFER_TEXT.saved}</span>
              ) : (
                <div className="row ws-row-actions">
                  <Button
                    disabled={disabled}
                    aria-label={`${OFFER_TEXT.saveAndUse}: ${theme.name}`}
                    onClick={() => onKeep(theme, true)}
                  >
                    {OFFER_TEXT.saveAndUse}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`${OFFER_TEXT.saveTheme}: ${theme.name}`}
                    onClick={() => onKeep(theme, false)}
                  >
                    {OFFER_TEXT.saveTheme}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Extension shortcuts in Settings → Keyboard: bound only when the user picks one. */
export function ExtensionKeyOffers() {
  const { registry } = useServices();
  const settings = useSettings();
  const toast = useToast();
  const state = useExtensionContributions();
  // Re-render when commands or bindings change.
  useSyncExternalStore(
    (fn) => registry.subscribe(fn),
    () => registry.version(),
  );
  const bindings = settings.get('keyboard.bindings');
  const mac = registry.platform.mac;
  const offers = state.contributions.keybindings.flatMap((k) => {
    const cmd = parseExtensionCommand(k.command);
    if (!cmd) return [];
    const id = extensionCommandKey(cmd.extensionId, cmd.commandId);
    const command = registry.get(id);
    if (!command) return [];
    return [
      {
        key: `${k.extensionId}:${k.command}:${k.key}`,
        id,
        title: command.title,
        from: extensionName(state, k.extensionId),
        binding: normalizeBinding(k.key, mac),
      },
    ];
  });
  if (offers.length === 0) return null;

  const use = (id: string, title: string, binding: string) => {
    const clash = registry.conflictsWith(id, binding);
    const keys = bindingText(binding, mac);
    settings.set('keyboard.bindings', { ...bindings.value, [id]: binding }).then(
      () =>
        toast.show(
          clash.length
            ? OFFER_TEXT.conflictToast(keys, clash.map((c) => c.title).join(', '))
            : OFFER_TEXT.bound(keys, title),
          { tone: clash.length ? 'error' : 'success' },
        ),
      (err: unknown) => toast.show(OFFER_TEXT.saveFailed(errorMessage(err)), { tone: 'error' }),
    );
  };

  return (
    <section className="settings-section ext-offers" aria-labelledby="keyboard-ext">
      <h3 id="keyboard-ext">{OFFER_TEXT.keys}</h3>
      <p className="muted">{OFFER_TEXT.keysHint}</p>
      {bindings.locked ? <p className="nv-field-hint nv-field-lock">{MANAGED}</p> : null}
      <ul className="ws-list" aria-label={OFFER_TEXT.keys}>
        {offers.map((o) => {
          const b = o.binding;
          const inUse = b !== null && registry.bindingsFor(o.id).includes(b);
          const clash = b ? registry.conflictsWith(o.id, b) : [];
          return (
            <li key={o.key} className="ws-list-row" aria-label={`${o.from}: ${o.title}`}>
              <div className="ws-source-main">
                <span className="ws-row-meta">
                  <strong>{o.title}</strong>
                  <span className="muted">{OFFER_TEXT.from(o.from)}</span>
                </span>
                {b ? <Kbd keys={formatBinding(b, mac)} /> : <span>{OFFER_TEXT.badKey}</span>}
                {b && !inUse && clash.length ? (
                  <span className="muted">
                    {OFFER_TEXT.conflict(clash.map((c) => c.title).join(', '))}
                  </span>
                ) : null}
              </div>
              {b === null ? null : inUse ? (
                <span className="muted">{OFFER_TEXT.inUse}</span>
              ) : (
                <Button
                  disabled={bindings.locked}
                  aria-label={OFFER_TEXT.bindFor(bindingText(b, mac), o.title)}
                  onClick={() => use(o.id, o.title, b)}
                >
                  {OFFER_TEXT.use}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
