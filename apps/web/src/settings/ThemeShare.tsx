// Theme import and export (FR-011, docs/14 §2.2) in Settings → Appearance: export the current
// look as a theme file or a nova://theme?data= link, import one from a file or a pasted link
// (checked against the theme schema and for contrast), keep it in `appearance.customThemes`, and
// use a kept theme: `appearance.customTheme` applies it token for token over its base, after a
// warning when its body text fails the contrast minimum. Removing the theme in use falls back to
// its base. Opening a theme link lands here with the import filled in.
import { useEffect, useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { Theme } from '@nova/ui';
import { Button, Dialog, Icon, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { ExtensionThemeOffers } from '../extensions/Offers.tsx';
import {
  bodyTextContrast,
  customLook,
  type ContrastWarning,
  type ResolvedAppearance,
} from '../appearance.ts';
import { navigate, useLocation } from '../router.ts';
import { useSettings } from '../settings.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { copyText, downloadText } from './copy.ts';
import {
  exportTheme,
  readTheme,
  storedThemes,
  themeBase,
  themeContrast,
  themeJson,
  themeLink,
  type ThemeCheck,
} from './theme-file.ts';

/** Theme import and export, and using saved themes (FR-011). */
export const THEME_TEXT = defineMessages('settings.themes', {
  apply: 'Use',
  labelForUse: 'Use {name}',
  inUse: 'In use',
  using: 'Using {name}.',
  usingExcept: 'Using {name}, except settings your organization manages.',
  couldNotUse: 'Could not use {name}: {error}',
  managedUse: 'Your organization manages which saved theme is used.',
  statusLabel: 'Saved theme in use',
  current: 'Using {name}, one of your saved themes, with every color it sets.',
  currentHint: 'Choosing a theme, accent, background or text color here stops using it.',
  missing: 'The saved theme you chose is no longer in your themes, so its base theme is used.',
  stop: 'Stop using {name}',
  stopped: 'Stopped using {name}.',
  stopFailed: 'Could not stop using {name}: {error}',
  removedInUse: '{name} removed. Its base theme is used now.',
  lowContrastTitle: 'Use {name}?',
  lowContrast:
    'Text in {name} has a contrast of {ratio}:1 against its background, below the {minimum}:1 minimum for readable text. It may be hard to read.',
  lowContrastHint: 'You can stop using it in Settings → Appearance at any time.',
  confirmUse: 'Use anyway',
  cancel: 'Cancel',
  defaultName: 'My theme',
  tooMany: 'You can keep up to {max} themes. Remove one first.',
  saved: '{name} saved to your themes.',
  saveFailed: 'Could not save the theme: {error}',
  removeFailed: 'Could not remove it: {error}',
  removed: '{name} removed.',
  fileTooLarge: 'That file is too large to be a theme.',
  title: 'Themes',
  export: 'Export the current look',
  name: 'Theme name',
  downloaded: 'Theme file downloaded.',
  cannotSave: 'This browser cannot save files here; copy the link instead.',
  download: 'Download theme file',
  linkCopied: 'Theme link copied.',
  copyFailedSelected: 'Could not copy. The link is selected; copy it with your keyboard.',
  copyLink: 'Copy theme link',
  link: 'Theme link',
  import: 'Import a theme',
  importText: 'Theme link or theme JSON',
  check: 'Check theme',
  fromFile: 'Import from a file',
  file: 'Theme file',
  cannotImport: 'This theme cannot be imported:',
  toImport: 'Theme to import',
  variant:
    '{variant, select, light {light} dark {dark} system {follows the system} other {{variant}}}',
  ignored: 'Ignored (not used by Nova): {names}',
  contrast: '{pair}: contrast is {ratio}:1, below the {minimum}:1 minimum.',
  contrastOk: 'Contrast meets the minimums.',
  saveAndUse: 'Save and use',
  save: 'Save theme',
  yours: 'Your themes',
  none: 'No imported themes yet.',
  copyLinkFor: 'Copy link for {name}',
  copyLinkShort: 'Copy link',
  copyFailed: 'Could not copy the link.',
  removeName: 'Remove {name}',
  remove: 'Remove',
});
const S = THEME_TEXT;

/** A contrast ratio as the warnings show it: one decimal, in the active locale. */
export const ratioText = (ratio: number) =>
  fmt.number(ratio, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const MAX_THEMES = 50;
const THEME_FILE_MAX = 64 * 1024;

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

export function ThemeShare({
  effective,
  baseId,
  prefersDark,
}: {
  effective: ResolvedAppearance;
  /** The built-in theme the current look starts from. */
  baseId: string;
  prefersDark: boolean;
}) {
  const settings = useSettings();
  const toast = useToast();
  const custom = settings.get('appearance.customThemes');
  const inUse = settings.get('appearance.customTheme');
  const saved = storedThemes(custom.value);
  const usedTheme = saved.find((t) => t.id === inUse.value) ?? null;
  // A theme whose body text fails the contrast minimum waits here for "Use anyway".
  const [pending, setPending] = useState<{ theme: Theme; warning: ContrastWarning } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [name, setName] = useState(() => S.defaultName);
  const [text, setText] = useState('');
  const [check, setCheck] = useState<ThemeCheck | null>(null);
  const linkRef = useRef<HTMLElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const importBox = useRef<HTMLTextAreaElement>(null);

  // A theme link opened from outside arrives as /settings/appearance?theme=<data>: fill in the
  // import once, then drop the query so a reload does not repeat it.
  const loc = useLocation();
  const q = loc.indexOf('?');
  const incoming = q < 0 ? null : new URLSearchParams(loc.slice(q + 1)).get('theme');
  const [seen, setSeen] = useState<string | null>(null);
  if (incoming && incoming !== seen) {
    const link = `nova://theme?data=${incoming}`;
    setSeen(incoming);
    setText(link);
    setCheck(readTheme(link));
  }
  if (!incoming && seen) setSeen(null);
  useEffect(() => {
    if (incoming) navigate('/settings/appearance', { replace: true });
  }, [incoming]);

  const current = exportTheme(effective.theme, effective.fonts, name, baseId);
  const link = themeLink(current);

  const say = (ok: boolean, done: string, failed: string) =>
    toast.show(ok ? done : failed, { tone: ok ? 'success' : 'error' });

  const keep = async (theme: Theme, use: boolean) => {
    const rest = custom.value.filter((t) => t.id !== theme.id);
    if (rest.length >= MAX_THEMES) {
      toast.show(S.tooMany({ max: MAX_THEMES }), { tone: 'error' });
      return;
    }
    try {
      await settings.set('appearance.customThemes', [...rest, { ...theme }]);
      // An import's preview already showed its contrast; an extension's offer did not.
      const warned = check?.ok === true && check.theme.id === theme.id;
      setText('');
      setCheck(null);
      if (use) await apply(theme, warned);
      else toast.show(S.saved({ name: theme.name }), { tone: 'success' });
    } catch (err) {
      toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });
    }
  };

  /** Use a saved theme; one whose body text fails the minimum asks first unless already shown. */
  const apply = async (theme: Theme, warned = false) => {
    if (inUse.locked) {
      toast.show(S.managedUse, { tone: 'error' });
      return;
    }
    const warning = warned ? null : bodyTextContrast(customLook(theme, prefersDark));
    if (warning) {
      setPending({ theme, warning });
      return;
    }
    await startUsing(theme);
  };

  // `appearance.customTheme` applies the theme token for token over its base. The base theme
  // goes under it (so removing it falls back there), and the overrides that would hide its
  // colors and fonts are cleared; keys managed policy holds are left as they are.
  const startUsing = async (theme: Theme) => {
    const writes = [
      ['appearance.theme', themeBase(theme)],
      ['appearance.accent', null],
      ['appearance.background', null],
      ['appearance.foreground', null],
      ...(theme.fonts?.['--u-font-ui'] ? ([['appearance.uiFont', null]] as const) : []),
      ...(theme.fonts?.['--u-font-code'] ? ([['appearance.codeFont', null]] as const) : []),
    ] as const;
    let skipped = false;
    try {
      for (const [key, value] of writes) {
        const now = settings.get(key);
        if (now.value === value) continue;
        if (now.locked) {
          skipped = true;
          continue;
        }
        await settings.set(key, value);
      }
      await settings.set('appearance.customTheme', theme.id);
      toast.show(skipped ? S.usingExcept({ name: theme.name }) : S.using({ name: theme.name }), {
        tone: 'success',
      });
    } catch (err) {
      toast.show(S.couldNotUse({ name: theme.name, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  // Removing the theme in use falls back to its base theme (FR-011).
  const remove = async (theme: Theme) => {
    const wasInUse = inUse.value === theme.id;
    try {
      await settings.set(
        'appearance.customThemes',
        custom.value.filter((t) => t.id !== theme.id),
      );
    } catch (err) {
      toast.show(S.removeFailed({ error: errorMessage(err) }), { tone: 'error' });
      return;
    }
    if (!wasInUse) {
      toast.show(S.removed({ name: theme.name }), { tone: 'success' });
      return;
    }
    const base = themeBase(theme);
    const theme0 = settings.get('appearance.theme');
    try {
      if (!inUse.locked) await settings.set('appearance.customTheme', null);
      if (!theme0.locked && theme0.value !== base) await settings.set('appearance.theme', base);
    } catch {
      // The theme is gone from the list, so the look already falls back to the base setting.
    }
    toast.show(S.removedInUse({ name: theme.name }), { tone: 'success' });
  };

  const readFile = async (f: File) => {
    if (f.size > THEME_FILE_MAX) {
      setCheck({ ok: false, errors: [S.fileTooLarge] });
      return;
    }
    const content = await f.text();
    setText(content);
    setCheck(readTheme(content));
  };

  const warnings = check?.ok ? themeContrast(check.theme, prefersDark) : [];

  return (
    <section className="settings-section" aria-labelledby="appearance-share">
      <h3 id="appearance-share">{S.title}</h3>

      <div className="stack" role="group" aria-labelledby="appearance-export">
        <h4 id="appearance-export">{S.export}</h4>
        <TextField
          label={S.name}
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="row">
          <Button
            onClick={() =>
              say(
                downloadText(`${current.id}.json`, themeJson(current)),
                S.downloaded,
                S.cannotSave,
              )
            }
          >
            <Icon name="download" /> {S.download}
          </Button>
          <Button
            onClick={() =>
              void copyText(link, linkRef.current).then((ok) =>
                say(ok, S.linkCopied, S.copyFailedSelected),
              )
            }
          >
            <Icon name="copy" /> {S.copyLink}
          </Button>
        </div>
        <pre role="group" className="ws-command ws-link" aria-label={S.link}>
          <code ref={linkRef}>{link}</code>
        </pre>
      </div>

      <div className="stack" role="group" aria-labelledby="appearance-import">
        <h4 id="appearance-import">{S.import}</h4>
        <div className="nv-field">
          <label className="nv-field-label" htmlFor="theme-import-text">
            {S.importText}
          </label>
          <textarea
            id="theme-import-text"
            ref={importBox}
            className="nv-input ws-textarea"
            rows={3}
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCheck(null);
            }}
          />
        </div>
        <div className="row">
          <Button onClick={() => setCheck(readTheme(text))} disabled={!text.trim()}>
            {S.check}
          </Button>
          <Button variant="ghost" onClick={() => file.current?.click()}>
            {S.fromFile}
          </Button>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label={S.file}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void readFile(f);
            }}
          />
        </div>
        {check && !check.ok ? (
          <div role="alert" className="ws-error">
            <p>{S.cannotImport}</p>
            <ul className="ws-plain-list">
              {check.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {check?.ok ? (
          <div className="panel-inset stack" role="group" aria-label={S.toImport}>
            <p className="ws-row-meta">
              <Swatches theme={check.theme} />
              <strong>{check.theme.name}</strong>
              <code className="ws-code-inline" dir="ltr">
                {check.theme.id}
              </code>
              <span className="muted">{S.variant({ variant: check.theme.variant })}</span>
            </p>
            {check.ignored.length ? (
              <p className="muted">
                {S.ignored({ names: fmt.list(check.ignored, { type: 'unit' }) })}
              </p>
            ) : null}
            {warnings.length ? (
              <div className="contrast-warning" role="status">
                <Icon name="alert" />
                <ul>
                  {warnings.map((w) => (
                    <li key={w.pair}>
                      {S.contrast({ pair: w.pair, ratio: ratioText(w.ratio), minimum: w.minimum })}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="muted">{S.contrastOk}</p>
            )}
            <div className="row">
              <Button
                variant="primary"
                disabled={custom.locked}
                onClick={() => void keep(check.theme, true)}
              >
                {S.saveAndUse}
              </Button>
              <Button disabled={custom.locked} onClick={() => void keep(check.theme, false)}>
                {S.save}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="stack" role="group" aria-labelledby="appearance-saved">
        <h4 id="appearance-saved">{S.yours}</h4>
        {saved.length === 0 ? <p className="muted">{S.none}</p> : null}
        {saved.length && inUse.locked ? (
          <ManagedNote as="p" id="themes-lock" setting="appearance.customTheme" />
        ) : null}
        {saved.length ? (
          <ul
            className="ws-list"
            aria-label={S.yours}
            aria-describedby={inUse.locked ? 'themes-lock' : undefined}
            ref={listRef}
          >
            {saved.map((t) => (
              <li key={t.id} className="ws-list-row" aria-label={t.name} data-theme-id={t.id}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <Swatches theme={t} />
                    <strong>{t.name}</strong>
                    <span className="muted">{S.variant({ variant: t.variant })}</span>
                    {usedTheme?.id === t.id ? <span>{S.inUse}</span> : null}
                  </span>
                </div>
                <div className="row ws-row-actions">
                  <Button
                    onClick={() => void apply(t)}
                    disabled={inUse.locked}
                    aria-label={S.labelForUse({ name: t.name })}
                  >
                    {S.apply}
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={S.copyLinkFor({ name: t.name })}
                    onClick={() =>
                      void copyText(themeLink(t)).then((ok) => say(ok, S.linkCopied, S.copyFailed))
                    }
                  >
                    {S.copyLinkShort}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={custom.locked}
                    aria-label={S.removeName({ name: t.name })}
                    onClick={() => void remove(t)}
                  >
                    {S.remove}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {/* M8: themes running extensions offer; nothing is used until chosen (FR-117). */}
        <ExtensionThemeOffers
          saved={saved}
          disabled={custom.locked}
          onKeep={(theme, use) => void keep(theme, use)}
        />
      </div>
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending ? S.lowContrastTitle({ name: pending.theme.name }) : ''}
        description={
          pending
            ? S.lowContrast({
                name: pending.theme.name,
                ratio: ratioText(pending.warning.ratio),
                minimum: pending.warning.minimum,
              })
            : undefined
        }
        // An extension's offer leaves the list once saved: focus that theme's row instead.
        fallbackFocus={() =>
          listRef.current?.querySelector<HTMLElement>(
            `[data-theme-id="${pending?.theme.id ?? ''}"] button:not([disabled])`,
          ) ?? null
        }
        footer={
          <>
            <Button onClick={() => setPending(null)}>{S.cancel}</Button>
            <Button
              variant="primary"
              onClick={() => {
                const p = pending;
                setPending(null);
                if (p) void startUsing(p.theme);
              }}
            >
              {S.confirmUse}
            </Button>
          </>
        }
      >
        <p className="muted">{S.lowContrastHint}</p>
      </Dialog>
    </section>
  );
}
