// Settings → Appearance (FR-010, FR-011, docs/14 §2): theme, accent, background and text colors,
// fonts, size and motion, and theme import and export. Every change applies at once and is saved
// to the Hub; managed values are shown disabled with the reason.
import { useEffect, useId, useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, ColorField, Icon, RadioGroup, TextField, resolveTheme, useToast } from '@nova/ui';
import type { ThemeChoice } from '@nova/ui';
import type { SettingKey } from '@nova/shared';
import { errorMessage } from '../api.ts';
import { contrastWarnings, customBase, customLook, resolveAppearance } from '../appearance.ts';
import { useMediaQuery } from '../hooks.ts';
import { useSettings, type SettingValue } from '../settings.tsx';
import { setLookByHand, useAppearanceSettings, type HandSetKey } from '../use-appearance.ts';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { PetSettings } from '../pets/PetSettings.tsx';
import { THEME_TEXT, ThemeShare, ratioText } from './ThemeShare.tsx';
import { LanguageSection } from '../i18n/LanguageSection.tsx';

export const APPEARANCE_TEXT = defineMessages('settings.appearance', {
  theme: {
    system: 'System',
    systemHint: 'Follows your device’s light or dark setting.',
    light: 'Light',
    dark: 'Dark',
    highContrastLight: 'High contrast light',
    highContrastDark: 'High contrast dark',
  },
  saveFailed: 'Could not save: {error}',
  title: 'Appearance',
  themeLabel: 'Theme',
  colors: 'Colors',
  colorsHint: 'Overrides apply on top of the theme. Reset returns to the theme’s color.',
  accent: 'Accent',
  background: 'Background',
  text: 'Text',
  lowContrast:
    '{kind, select, controls {{pair}: contrast is {ratio}:1, below the {minimum}:1 minimum for readable controls. Pick colors further apart.} other {{pair}: contrast is {ratio}:1, below the {minimum}:1 minimum for readable text. Pick colors further apart.}}',
  textSection: 'Text',
  uiFont: 'Interface font',
  uiFontHint:
    'A CSS font list, for example: Inter, system-ui, sans-serif. Empty uses the system font.',
  codeFont: 'Code font',
  codeFontHint: 'Used for code blocks. Empty uses the bundled monospace font.',
  /** A sentence that shows the interface font; any sentence with many letters will do. */
  sample: 'The quick brown fox jumps over the lazy dog.',
  motion: 'Motion',
  reduceMotion: 'Reduce motion',
  followDevice: 'Follow the device setting',
  reduce: 'Reduce motion',
  allow: 'Allow motion',
  fontRule: 'Use letters, digits, spaces, quotes, commas and hyphens only.',
  textSize: 'Text size: {size}',
});
const S = APPEARANCE_TEXT;

/** A line of code that shows the code font: code, the same in every language. */
const CODE_SAMPLE = 'const answer = 42;';

/** The base themes, with their words read in the active locale. */
const themeOptions = (): { value: ThemeChoice; label: string; description?: string }[] => [
  { value: 'system', label: S.theme.system, description: S.theme.systemHint },
  { value: 'light', label: S.theme.light },
  { value: 'dark', label: S.theme.dark },
  { value: 'high-contrast-light', label: S.theme.highContrastLight },
  { value: 'high-contrast-dark', label: S.theme.highContrastDark },
];

// Mirrors the font-stack rule in @nova/shared settings so a bad value never reaches the Hub.
const FONT_STACK = /^[\w\s,'"-]+$/;

export function AppearancePage() {
  const settings = useSettings();
  const toast = useToast();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)', true);
  const theme = settings.get('appearance.theme');
  const accent = settings.get('appearance.accent');
  const background = settings.get('appearance.background');
  const foreground = settings.get('appearance.foreground');
  const uiFont = settings.get('appearance.uiFont');
  const codeFont = settings.get('appearance.codeFont');
  const fontScale = settings.get('appearance.fontScale');
  const motion = settings.get('appearance.reducedMotion');

  const save = <K extends SettingKey>(key: K, value: SettingValue<K>) => {
    settings.set(key, value).catch((err: unknown) => {
      toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });
    });
  };
  // The base theme, accent and colors changed by hand also stop using a saved theme (FR-011).
  const saveByHand = <K extends HandSetKey>(key: K, value: SettingValue<K>) => {
    setLookByHand(settings, key, value).catch((err: unknown) => {
      toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });
    });
  };

  // A saved theme in use replaces the base theme: the color fields start from its colors.
  const appearance = useAppearanceSettings();
  const custom = appearance.custom ?? null;
  const baseTheme = custom
    ? customBase(custom, prefersDark)
    : resolveTheme(theme.value, prefersDark);
  const base = (custom ? customLook(custom, prefersDark) : baseTheme).tokens;
  const effective = resolveAppearance(appearance, prefersDark);
  const warnings = contrastWarnings(effective.theme);

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <section className="settings-section" aria-labelledby="appearance-theme">
        <h3 id="appearance-theme" className="nv-vh">
          {S.themeLabel}
        </h3>
        <RadioGroup
          legend={S.themeLabel}
          name="theme"
          value={theme.value}
          options={themeOptions()}
          locked={theme.locked}
          setting="appearance.theme"
          onChange={(v) => saveByHand('appearance.theme', v as ThemeChoice)}
        />
        <SavedThemeStatus name={custom?.name ?? null} />
      </section>

      <LanguageSection />

      <section className="settings-section" aria-labelledby="appearance-colors">
        <h3 id="appearance-colors">{S.colors}</h3>
        <p className="muted">{S.colorsHint}</p>
        <ColorField
          label={S.accent}
          value={accent.value}
          fallback={base['--u-accent'] ?? '#7d98ff'}
          locked={accent.locked}
          setting="appearance.accent"
          onChange={(v) => saveByHand('appearance.accent', v)}
          onReset={() => saveByHand('appearance.accent', null)}
        />
        <ColorField
          label={S.background}
          value={background.value}
          fallback={base['--u-bg'] ?? '#0e0f12'}
          locked={background.locked}
          setting="appearance.background"
          onChange={(v) => saveByHand('appearance.background', v)}
          onReset={() => saveByHand('appearance.background', null)}
        />
        <ColorField
          label={S.text}
          value={foreground.value}
          fallback={base['--u-text'] ?? '#e8eaf0'}
          locked={foreground.locked}
          setting="appearance.foreground"
          onChange={(v) => saveByHand('appearance.foreground', v)}
          onReset={() => saveByHand('appearance.foreground', null)}
        />
        {warnings.length ? (
          <div className="contrast-warning" role="status">
            <Icon name="alert" />
            <ul>
              {warnings.map((w) => (
                <li key={w.pair}>
                  {S.lowContrast({
                    kind: w.minimum === 3 ? 'controls' : 'text',
                    pair: w.pair,
                    ratio: ratioText(w.ratio),
                    minimum: w.minimum,
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="settings-section" aria-labelledby="appearance-type">
        <h3 id="appearance-type">{S.textSection}</h3>
        <FontField
          label={S.uiFont}
          hint={S.uiFontHint}
          value={uiFont.value}
          locked={uiFont.locked}
          setting="appearance.uiFont"
          onSave={(v) => save('appearance.uiFont', v)}
        />
        <FontField
          label={S.codeFont}
          hint={S.codeFontHint}
          value={codeFont.value}
          locked={codeFont.locked}
          setting="appearance.codeFont"
          onSave={(v) => save('appearance.codeFont', v)}
        />
        <ScaleField
          value={fontScale.value}
          locked={fontScale.locked}
          onSave={(v) => save('appearance.fontScale', v)}
        />
        <p className="font-preview" aria-hidden="true">
          {S.sample} <code>{CODE_SAMPLE}</code>
        </p>
      </section>

      <section className="settings-section" aria-labelledby="appearance-motion">
        <h3 id="appearance-motion" className="nv-vh">
          {S.motion}
        </h3>
        <RadioGroup
          legend={S.reduceMotion}
          name="motion"
          value={motion.value}
          locked={motion.locked}
          setting="appearance.reducedMotion"
          onChange={(v) => save('appearance.reducedMotion', v as 'system' | 'on' | 'off')}
          options={[
            { value: 'system', label: S.followDevice },
            { value: 'on', label: S.reduce },
            { value: 'off', label: S.allow },
          ]}
        />
      </section>

      <PetSettings />
      <ThemeShare effective={effective} baseId={baseTheme.id} prefersDark={prefersDark} />
    </div>
  );
}

/** Which saved theme is in use, and how to stop using it (FR-011). */
function SavedThemeStatus({ name }: { name: string | null }) {
  const settings = useSettings();
  const toast = useToast();
  const inUse = settings.get('appearance.customTheme');
  if (inUse.value === null) return null;
  if (name === null) return <p className="muted">{THEME_TEXT.missing}</p>;
  const stop = () => {
    // The button leaves with the saved theme: keep focus on the theme choice.
    document.querySelector<HTMLInputElement>('input[name="theme"]:checked')?.focus();
    settings.set('appearance.customTheme', null).then(
      () => toast.show(THEME_TEXT.stopped({ name }), { tone: 'success' }),
      (err: unknown) =>
        toast.show(THEME_TEXT.stopFailed({ name, error: errorMessage(err) }), { tone: 'error' }),
    );
  };
  return (
    <div className="stack" role="group" aria-label={THEME_TEXT.statusLabel}>
      <p>
        {THEME_TEXT.current({ name })} {inUse.locked ? null : THEME_TEXT.currentHint}
      </p>
      {inUse.locked ? <ManagedNote as="p" setting="appearance.customTheme" /> : null}
      {inUse.locked ? null : (
        <div className="row">
          <Button onClick={stop}>{THEME_TEXT.stop({ name })}</Button>
        </div>
      )}
    </div>
  );
}

function FontField({
  label,
  hint,
  value,
  locked,
  setting,
  onSave,
}: {
  label: string;
  hint: string;
  value: string | null;
  locked: boolean;
  setting: string;
  onSave: (v: string | null) => void;
}) {
  const lockId = `font-lock${useId()}`;
  const [draft, setDraft] = useState<{ base: string | null; text: string } | null>(null);
  const text = draft && draft.base === value ? draft.text : (value ?? '');
  const trimmed = text.trim();
  const error =
    trimmed && (!FONT_STACK.test(trimmed) || trimmed.length > 200) ? S.fontRule : undefined;
  const commit = () => {
    if (error) return;
    const next = trimmed || null;
    if (next !== value) onSave(next);
    setDraft(null);
  };
  return (
    <>
      <TextField
        label={label}
        hint={hint}
        value={text}
        disabled={locked}
        aria-describedby={locked ? lockId : undefined}
        error={error}
        spellCheck={false}
        onChange={(e) => setDraft({ base: value, text: e.target.value })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {locked ? <ManagedNote id={lockId} setting={setting} /> : null}
    </>
  );
}

function ScaleField({
  value,
  locked,
  onSave,
}: {
  value: number;
  locked: boolean;
  onSave: (v: number) => void;
}) {
  const [live, setLive] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const shown = live ?? value;
  return (
    <div className="nv-field">
      <label className="nv-field-label" htmlFor="font-scale">
        {S.textSize({ size: fmt.percent(shown) })}
      </label>
      <input
        id="font-scale"
        type="range"
        min={0.75}
        max={2}
        step={0.05}
        value={shown}
        disabled={locked}
        aria-valuetext={fmt.percent(shown)}
        aria-describedby={locked ? 'font-scale-lock' : undefined}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLive(v);
          document.documentElement.style.setProperty('--u-font-scale', String(v));
          // Save once the user pauses, not on every step of a drag.
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            onSave(v);
            setLive(null);
          }, 300);
        }}
      />
      {locked ? <ManagedNote id="font-scale-lock" setting="appearance.fontScale" /> : null}
    </div>
  );
}
