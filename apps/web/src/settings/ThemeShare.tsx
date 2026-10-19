// Theme import and export (FR-011, docs/14 §2.2) in Settings → Appearance: export the current
// look as a theme file or a nova://theme?data= link, import one from a file or a pasted link
// (checked against the theme schema and for contrast), keep it in `appearance.customThemes`, and
// use a kept theme. Opening a theme link lands here with the import filled in.
import { useEffect, useRef, useState } from 'react';
import type { Theme } from '@nova/ui';
import { Button, Icon, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { ExtensionThemeOffers } from '../extensions/Offers.tsx';
import type { ResolvedAppearance } from '../appearance.ts';
import { navigate, useLocation } from '../router.ts';
import { useSettings } from '../settings.tsx';
import { copyText, downloadText } from './copy.ts';
import {
  exportTheme,
  readTheme,
  storedThemes,
  themeContrast,
  themeJson,
  themeLink,
  themeSettings,
  type ThemeCheck,
} from './theme-file.ts';

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
  const saved = storedThemes(custom.value);
  const [name, setName] = useState('My theme');
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
      toast.show(`You can keep up to ${MAX_THEMES} themes. Remove one first.`, { tone: 'error' });
      return;
    }
    try {
      await settings.set('appearance.customThemes', [...rest, { ...theme }]);
      setText('');
      setCheck(null);
      if (use) await apply(theme);
      else toast.show(`${theme.name} saved to your themes.`, { tone: 'success' });
    } catch (err) {
      toast.show(`Could not save the theme: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const apply = async (theme: Theme) => {
    const s = themeSettings(theme, prefersDark);
    const writes = [
      ['appearance.theme', s.base],
      ['appearance.accent', s.accent],
      ['appearance.background', s.background],
      ['appearance.foreground', s.foreground],
      ['appearance.uiFont', s.uiFont],
      ['appearance.codeFont', s.codeFont],
    ] as const;
    const skipped: string[] = [];
    try {
      for (const [key, value] of writes) {
        if (settings.get(key).locked) {
          skipped.push(key);
          continue;
        }
        await settings.set(key, value);
      }
      toast.show(
        skipped.length
          ? `Using ${theme.name}, except settings your organization manages.`
          : `Using ${theme.name}.`,
        { tone: 'success' },
      );
    } catch (err) {
      toast.show(`Could not use ${theme.name}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const remove = (theme: Theme) => {
    settings
      .set(
        'appearance.customThemes',
        custom.value.filter((t) => t.id !== theme.id),
      )
      .then(
        () => toast.show(`${theme.name} removed.`, { tone: 'success' }),
        (err: unknown) =>
          toast.show(`Could not remove it: ${errorMessage(err)}`, { tone: 'error' }),
      );
  };

  const readFile = async (f: File) => {
    if (f.size > THEME_FILE_MAX) {
      setCheck({ ok: false, errors: ['That file is too large to be a theme.'] });
      return;
    }
    const content = await f.text();
    setText(content);
    setCheck(readTheme(content));
  };

  const warnings = check?.ok ? themeContrast(check.theme, prefersDark) : [];

  return (
    <section className="settings-section" aria-labelledby="appearance-share">
      <h3 id="appearance-share">Themes</h3>

      <div className="stack" role="group" aria-labelledby="appearance-export">
        <h4 id="appearance-export">Export the current look</h4>
        <TextField
          label="Theme name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="row">
          <Button
            onClick={() =>
              say(
                downloadText(`${current.id}.json`, themeJson(current)),
                'Theme file downloaded.',
                'This browser cannot save files here; copy the link instead.',
              )
            }
          >
            <Icon name="download" /> Download theme file
          </Button>
          <Button
            onClick={() =>
              void copyText(link, linkRef.current).then((ok) =>
                say(
                  ok,
                  'Theme link copied.',
                  'Could not copy. The link is selected; copy it with your keyboard.',
                ),
              )
            }
          >
            <Icon name="copy" /> Copy theme link
          </Button>
        </div>
        <pre className="ws-command ws-link" aria-label="Theme link">
          <code ref={linkRef}>{link}</code>
        </pre>
      </div>

      <div className="stack" role="group" aria-labelledby="appearance-import">
        <h4 id="appearance-import">Import a theme</h4>
        <div className="nv-field">
          <label className="nv-field-label" htmlFor="theme-import-text">
            Theme link or theme JSON
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
            Check theme
          </Button>
          <Button variant="ghost" onClick={() => file.current?.click()}>
            Import from a file
          </Button>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label="Theme file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void readFile(f);
            }}
          />
        </div>
        {check && !check.ok ? (
          <div role="alert" className="ws-error">
            <p>This theme cannot be imported:</p>
            <ul className="ws-plain-list">
              {check.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {check?.ok ? (
          <div className="panel-inset stack" role="group" aria-label="Theme to import">
            <p className="ws-row-meta">
              <Swatches theme={check.theme} />
              <strong>{check.theme.name}</strong>
              <code className="ws-code-inline">{check.theme.id}</code>
              <span className="muted">{check.theme.variant}</span>
            </p>
            {check.ignored.length ? (
              <p className="muted">Ignored (not used by Nova): {check.ignored.join(', ')}</p>
            ) : null}
            {warnings.length ? (
              <div className="contrast-warning" role="status">
                <Icon name="alert" />
                <ul>
                  {warnings.map((w) => (
                    <li key={w.pair}>
                      {w.pair}: contrast is {w.ratio.toFixed(1)}:1, below the {w.minimum}:1 minimum.
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="muted">Contrast meets the minimums.</p>
            )}
            <div className="row">
              <Button
                variant="primary"
                disabled={custom.locked}
                onClick={() => void keep(check.theme, true)}
              >
                Save and use
              </Button>
              <Button disabled={custom.locked} onClick={() => void keep(check.theme, false)}>
                Save theme
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="stack" role="group" aria-labelledby="appearance-saved">
        <h4 id="appearance-saved">Your themes</h4>
        {saved.length === 0 ? <p className="muted">No imported themes yet.</p> : null}
        {saved.length ? (
          <ul className="ws-list" aria-label="Your themes">
            {saved.map((t) => (
              <li key={t.id} className="ws-list-row" aria-label={t.name}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <Swatches theme={t} />
                    <strong>{t.name}</strong>
                    <span className="muted">{t.variant}</span>
                  </span>
                </div>
                <div className="row ws-row-actions">
                  <Button onClick={() => void apply(t)} aria-label={`Use ${t.name}`}>
                    Use
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Copy link for ${t.name}`}
                    onClick={() =>
                      void copyText(themeLink(t)).then((ok) =>
                        say(ok, 'Theme link copied.', 'Could not copy the link.'),
                      )
                    }
                  >
                    Copy link
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={custom.locked}
                    aria-label={`Remove ${t.name}`}
                    onClick={() => remove(t)}
                  >
                    Remove
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
    </section>
  );
}
