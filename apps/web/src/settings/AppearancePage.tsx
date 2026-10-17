// Settings → Appearance (FR-010, docs/14 §2): theme, accent, background and text colors, fonts,
// size and motion. Every change applies at once and is saved to the Hub; managed values are
// shown disabled with the reason.
import { useEffect, useRef, useState } from 'react';
import { ColorField, Icon, RadioGroup, TextField, resolveTheme, useToast } from '@nova/ui';
import type { ThemeChoice } from '@nova/ui';
import type { SettingKey } from '@nova/shared';
import { errorMessage } from '../api.ts';
import { contrastWarnings, resolveAppearance } from '../appearance.ts';
import { useMediaQuery } from '../hooks.ts';
import { useSettings, type SettingValue } from '../settings.tsx';
import { MANAGED } from './common.ts';

const THEMES: { value: ThemeChoice; label: string; description?: string }[] = [
  { value: 'system', label: 'System', description: 'Follows your device’s light or dark setting.' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'high-contrast-light', label: 'High contrast light' },
  { value: 'high-contrast-dark', label: 'High contrast dark' },
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
      toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });
    });
  };

  const base = resolveTheme(theme.value, prefersDark).tokens;
  const effective = resolveAppearance(
    {
      theme: theme.value,
      accent: accent.value,
      background: background.value,
      foreground: foreground.value,
      uiFont: uiFont.value,
      codeFont: codeFont.value,
      fontScale: fontScale.value,
      reducedMotion: motion.value,
    },
    prefersDark,
  );
  const warnings = contrastWarnings(effective.theme);

  return (
    <div className="settings-page">
      <h2>Appearance</h2>
      <section className="settings-section" aria-labelledby="appearance-theme">
        <h3 id="appearance-theme" className="nv-vh">
          Theme
        </h3>
        <RadioGroup
          legend="Theme"
          name="theme"
          value={theme.value}
          options={THEMES}
          locked={theme.locked}
          onChange={(v) => save('appearance.theme', v as ThemeChoice)}
        />
      </section>

      <section className="settings-section" aria-labelledby="appearance-colors">
        <h3 id="appearance-colors">Colors</h3>
        <p className="muted">
          Overrides apply on top of the theme. Reset returns to the theme’s color.
        </p>
        <ColorField
          label="Accent"
          value={accent.value}
          fallback={base['--u-accent'] ?? '#7d98ff'}
          locked={accent.locked}
          onChange={(v) => save('appearance.accent', v)}
          onReset={() => save('appearance.accent', null)}
        />
        <ColorField
          label="Background"
          value={background.value}
          fallback={base['--u-bg'] ?? '#0e0f12'}
          locked={background.locked}
          onChange={(v) => save('appearance.background', v)}
          onReset={() => save('appearance.background', null)}
        />
        <ColorField
          label="Text"
          value={foreground.value}
          fallback={base['--u-text'] ?? '#e8eaf0'}
          locked={foreground.locked}
          onChange={(v) => save('appearance.foreground', v)}
          onReset={() => save('appearance.foreground', null)}
        />
        {warnings.length ? (
          <div className="contrast-warning" role="status">
            <Icon name="alert" />
            <ul>
              {warnings.map((w) => (
                <li key={w.pair}>
                  {w.pair}: contrast is {w.ratio.toFixed(1)}:1, below the {w.minimum}:1 minimum for
                  readable {w.minimum === 3 ? 'controls' : 'text'}. Pick colors further apart.
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="settings-section" aria-labelledby="appearance-type">
        <h3 id="appearance-type">Text</h3>
        <FontField
          label="Interface font"
          hint="A CSS font list, for example: Inter, system-ui, sans-serif. Empty uses the system font."
          value={uiFont.value}
          locked={uiFont.locked}
          onSave={(v) => save('appearance.uiFont', v)}
        />
        <FontField
          label="Code font"
          hint="Used for code blocks. Empty uses the bundled monospace font."
          value={codeFont.value}
          locked={codeFont.locked}
          onSave={(v) => save('appearance.codeFont', v)}
        />
        <ScaleField
          value={fontScale.value}
          locked={fontScale.locked}
          onSave={(v) => save('appearance.fontScale', v)}
        />
        <p className="font-preview" aria-hidden="true">
          The quick brown fox jumps over the lazy dog. <code>const answer = 42;</code>
        </p>
      </section>

      <section className="settings-section" aria-labelledby="appearance-motion">
        <h3 id="appearance-motion" className="nv-vh">
          Motion
        </h3>
        <RadioGroup
          legend="Reduce motion"
          name="motion"
          value={motion.value}
          locked={motion.locked}
          onChange={(v) => save('appearance.reducedMotion', v as 'system' | 'on' | 'off')}
          options={[
            { value: 'system', label: 'Follow the device setting' },
            { value: 'on', label: 'Reduce motion' },
            { value: 'off', label: 'Allow motion' },
          ]}
        />
      </section>
    </div>
  );
}

function FontField({
  label,
  hint,
  value,
  locked,
  onSave,
}: {
  label: string;
  hint: string;
  value: string | null;
  locked: boolean;
  onSave: (v: string | null) => void;
}) {
  const [draft, setDraft] = useState<{ base: string | null; text: string } | null>(null);
  const text = draft && draft.base === value ? draft.text : (value ?? '');
  const trimmed = text.trim();
  const error =
    trimmed && (!FONT_STACK.test(trimmed) || trimmed.length > 200)
      ? 'Use letters, digits, spaces, quotes, commas and hyphens only.'
      : undefined;
  const commit = () => {
    if (error) return;
    const next = trimmed || null;
    if (next !== value) onSave(next);
    setDraft(null);
  };
  return (
    <TextField
      label={label}
      hint={locked ? `${MANAGED}. ${hint}` : hint}
      value={text}
      disabled={locked}
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
        Text size: {Math.round(shown * 100)}%
      </label>
      <input
        id="font-scale"
        type="range"
        min={0.75}
        max={2}
        step={0.05}
        value={shown}
        disabled={locked}
        aria-valuetext={`${Math.round(shown * 100)} percent`}
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
      {locked ? (
        <span id="font-scale-lock" className="nv-field-hint nv-field-lock">
          {MANAGED}
        </span>
      ) : null}
    </div>
  );
}
