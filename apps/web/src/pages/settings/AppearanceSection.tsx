import { useState } from 'react'
import { Monitor, Moon, Palette, Sun, Type } from 'lucide-react'
import { Section } from '../../components/ui'
import { useTheme } from '../../stores/theme-store'
import { accentPalettes, resolvePalette, themePresets, type ThemePreset } from '../../lib/color-palettes'
import { putSetting } from '../../lib/api'
import { InlineSave, type SaveMessage } from './shared'

/** Accents that are not the signature colour of a community theme. */
const communityAccents = new Set(
  Object.values(themePresets)
    .filter(p => p.group === 'community')
    .map(p => p.accent),
)
const generalAccents = Object.keys(accentPalettes).filter(key => !communityAccents.has(key))

const MODES: { value: 'light' | 'system' | 'dark'; label: string; icon: React.ElementType }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
]

const FONT_SCALES = [
  { value: 0.85, label: 'S' },
  { value: 1, label: 'M' },
  { value: 1.15, label: 'L' },
  { value: 1.3, label: 'XL' },
]

const GROUPS: { key: ThemePreset['group']; label: string }[] = [
  { key: 'nova', label: 'Built in' },
  { key: 'community', label: 'Community' },
  { key: 'custom', label: 'Custom' },
]

const readable = (key: string) => key.replace(/-/g, ' ')

function SegmentedButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      className={
        'flex items-center gap-1.5 rounded-xs px-3 py-1.5 text-caption font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
        (active
          ? 'bg-surface-elevated text-accent'
          : 'text-content-tertiary hover:text-content-secondary')
      }
    >
      {children}
    </button>
  )
}

/**
 * The swatch is the chrome in miniature — ground with its atmosphere, the
 * nav strip, a card with a line of text, your bubble, a button — painted
 * from the SAME resolver the store uses, in the mode the theme would show.
 * Two rectangles of "neutral-900 and accent-600" is what the old card was,
 * and every theme's rectangles were the same shade of dark.
 */
function ThemeSwatch({ presetKey, customAccent, mode }: {
  presetKey: string
  customAccent: string
  mode: 'light' | 'dark'
}) {
  const { accent, neutral, secondary, card } = resolvePalette(presetKey, customAccent)
  const dark = mode === 'dark'
  const rgb = (t: string, a?: number) => (a === undefined ? `rgb(${t})` : `rgb(${t} / ${a})`)
  const ground = rgb(dark ? neutral[950] : neutral[50])
  // Custom is not a look, it is a choice of accent — so its swatch is the
  // choice: the accents on offer, the current one ringed. Drawn as chrome it
  // was pixel-identical to Nova and read as a duplicate.
  if (themePresets[presetKey]?.group === 'custom') {
    return (
      <span
        aria-hidden="true"
        className="flex h-14 w-full flex-wrap content-center items-center justify-center gap-[5px] overflow-hidden rounded-xs border border-dashed border-border px-2"
        style={{ background: ground }}
      >
        {generalAccents.map(name => (
          <span
            key={name}
            className="block h-[9px] w-[9px] rounded-full"
            style={{
              background: rgb((accentPalettes[name] ?? accentPalettes.teal)[500]),
              boxShadow: name === customAccent ? `0 0 0 2px ${ground}, 0 0 0 3px ${rgb(accent[dark ? 300 : 700])}` : undefined,
            }}
          />
        ))}
      </span>
    )
  }
  const hasSecondary = secondary !== accent
  const nav = dark ? rgb(accent[950], 0.45) : rgb(neutral[100])
  const cardBg = rgb(dark ? card.dark : card.light)
  const line = rgb(dark ? neutral[400] : neutral[500])
  const faint = rgb(dark ? neutral[700] : neutral[200])
  const glow1 = rgb(dark ? accent[950] : accent[200], dark ? 0.8 : 0.5)
  const glow2 = rgb(dark ? secondary[950] : secondary[200], dark ? 0.7 : 0.4)
  const ui = accent[dark ? 500 : 700]
  return (
    <span
      aria-hidden="true"
      className="relative flex h-14 w-full overflow-hidden rounded-xs border border-border-subtle"
      style={{
        background:
          `radial-gradient(ellipse at 20% 40%, ${glow1} 0%, transparent 55%),` +
          `radial-gradient(ellipse at 90% 100%, ${glow2} 0%, transparent 55%),` +
          ground,
      }}
    >
      <span className="h-full w-[14px] shrink-0 flex flex-col items-center gap-[3px] pt-[6px]" style={{ background: nav }}>
        <span className="block h-[5px] w-[5px] rounded-[1.5px]" style={{ background: rgb(accent[dark ? 400 : 600]) }} />
        <span className="block h-[5px] w-[5px] rounded-[1.5px]" style={{ background: faint }} />
        {/* the attention colour, where the badge would sit — Nova's amber */}
        <span className="block h-[5px] w-[5px] rounded-[1.5px]" style={{ background: hasSecondary ? rgb(secondary[dark ? 400 : 500]) : faint }} />
      </span>
      <span className="flex-1 flex flex-col gap-[5px] px-[7px] py-[6px]">
        <span className="self-end h-[8px] w-[34%] rounded-[3px]" style={{ background: rgb(accent[dark ? 700 : 600]) }} />
        <span className="flex flex-col gap-[3px] rounded-[3px] px-[5px] py-[4px]" style={{ background: cardBg, boxShadow: `inset 0 0 0 1px ${rgb(dark ? neutral[800] : neutral[200])}` }}>
          <span className="block h-[3px] w-[70%] rounded-full" style={{ background: line }} />
          <span className="block h-[3px] w-[45%] rounded-full" style={{ background: faint }} />
        </span>
        <span className="mt-auto flex items-center gap-[4px]">
          <span className="block h-[6px] flex-1 rounded-[2px]" style={{ background: rgb(dark ? neutral[800] : neutral[200]) }} />
          <span className="block h-[6px] w-[16px] rounded-[2px]" style={{ background: rgb(ui) }} />
        </span>
      </span>
    </span>
  )
}

function PresetCard({
  id,
  preset,
  active,
  isDefault,
  customAccent,
  mode,
  onClick,
}: {
  id: string
  preset: ThemePreset
  active: boolean
  isDefault: boolean
  customAccent: string
  mode: 'light' | 'dark'
  onClick: () => void
}) {
  const defaultTagId = `theme-${id}-default`
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={preset.label}
      aria-describedby={isDefault ? defaultTagId : undefined}
      onClick={onClick}
      title={preset.description}
      className={
        'group flex flex-col items-stretch gap-1.5 rounded-sm border p-2 text-left transition-all ' +
        (preset.group === 'custom' && !active ? 'border-dashed ' : '') +
        (active
          ? 'border-accent ring-2 ring-accent/30'
          : 'border-border hover:border-border-focus')
      }
    >
      <ThemeSwatch presetKey={id} customAccent={customAccent} mode={preset.preferredMode ?? mode} />
      <span className="flex items-center justify-between gap-1">
        <span className={'truncate text-micro font-medium ' + (active ? 'text-accent' : 'text-content-secondary')}>
          {preset.label}
        </span>
        {isDefault && (
          <span
            id={defaultTagId}
            className="shrink-0 text-micro font-semibold uppercase tracking-wider text-content-tertiary"
          >
            Default
            <span className="sr-only"> — what a browser that has not chosen a theme starts on</span>
          </span>
        )}
      </span>
    </button>
  )
}

function AccentPicker({
  active,
  onSelect,
}: {
  active: string
  onSelect: (name: string) => void
}) {
  return (
    <div className="mt-2" role="group" aria-label="Accent colour">
      <div className="mb-1.5 text-caption text-content-tertiary">Accent colour</div>
      <div className="flex flex-wrap gap-2">
        {generalAccents.map(name => (
          <button
            key={name}
            type="button"
            onClick={() => onSelect(name)}
            title={readable(name)}
            aria-label={`Accent ${readable(name)}`}
            aria-pressed={active === name}
            className={
              'size-8 rounded-full border-2 transition-transform hover:scale-110 ' +
              (active === name ? 'border-accent ring-2 ring-accent/30 scale-110' : 'border-border')
            }
            style={{ background: `rgb(${(accentPalettes[name] ?? accentPalettes.teal)[500]})` }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Theme choices are a browser preference and take effect immediately.
 * `appearance.default_preset` is the separate, server-held answer to "what
 * does a browser that has never chosen start on" — so it gets the
 * draft/dirty inline save rather than being written on every click.
 */
export function AppearanceSection({
  storedPreset,
  onStored,
}: {
  storedPreset: string
  onStored: (preset: string) => void
}) {
  const {
    modePreference, setModePreference,
    preset, setPreset,
    customAccent, setCustomAccent,
    fontScale, setFontScale,
    mode,
  } = useTheme()

  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<SaveMessage | null>(null)
  const active = themePresets[preset]
  const lockedMode = active?.preferredMode
  const differs = preset !== storedPreset
  // A custom accent lives in this browser only; saving 'custom' as the
  // instance default would hand every other browser teal-on-stone and call
  // it the same theme. Named themes only.
  const saveable = differs && preset !== 'custom'

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      await putSetting('appearance.default_preset', preset)
      onStored(preset)
      setMessage({ kind: 'ok', text: 'Saved as the default theme' })
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setMessage(null)
    if (!themePresets[storedPreset]) return
    setPreset(storedPreset)
  }

  const presets = Object.entries(themePresets)

  return (
    <Section
      icon={Palette}
      title="Appearance"
      description="How this browser renders Nova. Changes apply as you make them."
    >
      <div>
        <div className="mb-2 text-caption font-medium text-content-secondary">Theme</div>
        <p className="mb-3 text-caption text-content-tertiary">
          The palette for the whole app — ground, nav, cards, text and the glow behind them.
          A theme that is light or dark by nature brings its mode with it.
        </p>
        <div role="radiogroup" aria-label="Theme" className="space-y-4">
          {GROUPS.map(group => {
            const members = presets.filter(([, p]) => p.group === group.key)
            if (members.length === 0) return null
            return (
              <div key={group.key}>
                <div className="mb-1.5 text-micro font-semibold uppercase tracking-wider text-content-tertiary">
                  {group.label}
                </div>
                <div role="group" aria-label={`${group.label} themes`} className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2">
                  {members.map(([key, p]) => (
                    <PresetCard
                      key={key}
                      id={key}
                      preset={p}
                      active={preset === key}
                      isDefault={storedPreset === key}
                      customAccent={customAccent}
                      mode={mode}
                      onClick={() => setPreset(key)}
                    />
                  ))}
                </div>
                {group.key === 'custom' && preset === 'custom' && (
                  <AccentPicker active={customAccent} onSelect={setCustomAccent} />
                )}
              </div>
            )
          })}
        </div>
        {active && (
          <p className="mt-3 text-caption text-content-secondary" data-testid="theme-description">
            <span className="font-medium text-content-primary">{active.label}</span>
            {' — '}
            {active.description}
          </p>
        )}
      </div>

      <div role="group" aria-label="Mode">
        <div className="mb-2 text-caption font-medium text-content-secondary">Mode</div>
        <div className="inline-flex rounded-sm border border-border p-0.5">
          {MODES.map(({ value, label, icon: Icon }) => (
            <SegmentedButton
              key={value}
              active={modePreference === value}
              disabled={Boolean(lockedMode)}
              onClick={() => setModePreference(value)}
            >
              <Icon size={13} />
              {label}
            </SegmentedButton>
          ))}
        </div>
        {lockedMode && active && (
          <p className="mt-1.5 text-caption text-content-tertiary">
            {active.label} is a {lockedMode} theme, so it sets the mode. Pick another theme to choose one.
          </p>
        )}
      </div>

      <div role="group" aria-label="Text size">
        <div className="mb-2 text-caption font-medium text-content-secondary">Text size</div>
        <div className="inline-flex rounded-sm border border-border p-0.5">
          {FONT_SCALES.map(({ value, label }) => (
            <SegmentedButton
              key={value}
              active={fontScale === value}
              onClick={() => setFontScale(value)}
            >
              <Type size={value <= 1 ? 12 : 15} />
              {label}
            </SegmentedButton>
          ))}
        </div>
      </div>

      <div className="border-t border-border-subtle pt-4 space-y-2">
        <p className="text-caption text-content-secondary">
          Default for browsers that have not chosen a theme:{' '}
          <span className="font-mono text-content-primary">{themePresets[storedPreset]?.label ?? storedPreset}</span>
          {differs && (
            <>
              {' — this browser is showing '}
              <span className="font-mono text-content-primary">{active?.label ?? preset}</span>
            </>
          )}
        </p>
        {differs && preset === 'custom' && (
          <p className="text-caption text-content-tertiary">
            A custom accent is this browser's alone; pick a named theme to make it the default.
          </p>
        )}
        <InlineSave
          dirty={saveable}
          saving={saving}
          saveLabel="Save as default"
          onSave={save}
          onReset={reset}
          message={message}
        />
      </div>
    </Section>
  )
}
