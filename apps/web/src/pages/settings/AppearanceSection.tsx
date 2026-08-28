import { useState } from 'react'
import { Monitor, Moon, Palette, Sun, Type } from 'lucide-react'
import { Section } from '../../components/ui'
import { useTheme } from '../../stores/theme-store'
import { accentPalettes, neutralPalettes, themePresets } from '../../lib/color-palettes'
import { putSetting } from '../../lib/api'
import { InlineSave, type SaveMessage } from './shared'

// Preview colours are read from the palettes themselves rather than a
// parallel table — adding a preset must not require remembering to update a
// swatch map that would otherwise go quietly wrong.
const previewAccent = (key: string) =>
  `rgb(${(accentPalettes[key] ?? accentPalettes.teal)[600]})`
const previewNeutral = (key: string) =>
  `rgb(${(neutralPalettes[key] ?? neutralPalettes.stone)[900]})`

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

function SegmentedButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-center gap-1.5 rounded-xs px-3 py-1.5 text-caption font-medium transition-colors ' +
        (active
          ? 'bg-surface-elevated text-accent'
          : 'text-content-tertiary hover:text-content-secondary')
      }
    >
      {children}
    </button>
  )
}

function PresetCard({
  id,
  label,
  active,
  onClick,
}: {
  id: string
  label: string
  active: boolean
  onClick: () => void
}) {
  const preset = themePresets[id]
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'group flex flex-col items-center gap-1.5 rounded-sm border p-2 text-micro font-medium transition-all ' +
        (active
          ? 'border-accent ring-2 ring-accent/30 text-accent'
          : 'border-border text-content-secondary hover:border-border-focus')
      }
    >
      <span className="relative flex h-6 w-full overflow-hidden rounded-xs border border-border-subtle">
        <span className="flex-1" style={{ background: previewNeutral(preset.neutral) }} />
        <span className="w-2" style={{ background: previewAccent(preset.accent) }} />
      </span>
      <span className="truncate max-w-full">{label}</span>
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
    <div className="mt-2">
      <label className="mb-1.5 block text-caption text-content-tertiary">Accent colour</label>
      <div className="flex flex-wrap gap-2">
        {generalAccents.map(name => (
          <button
            key={name}
            type="button"
            onClick={() => onSelect(name)}
            title={name}
            aria-label={`Accent ${name}`}
            className={
              'size-8 rounded-full border-2 transition-transform hover:scale-110 ' +
              (active === name ? 'border-accent ring-2 ring-accent/30 scale-110' : 'border-border')
            }
            style={{ background: previewAccent(name) }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Theme choices are a browser preference and take effect immediately.
 * `appearance.default_preset` is the separate, server-held answer to "what
 * does a browser that has never been here start on" — so it gets the
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
    lightPreset, setLightPreset,
    darkPreset, setDarkPreset,
    customLightAccent, setCustomLightAccent,
    customDarkAccent, setCustomDarkAccent,
    fontScale, setFontScale,
    mode, activePreset,
  } = useTheme()

  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<SaveMessage | null>(null)
  const dirty = activePreset !== storedPreset

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      await putSetting('appearance.default_preset', activePreset)
      onStored(activePreset)
      setMessage({ kind: 'ok', text: 'Saved as the default preset' })
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setMessage(null)
    if (!themePresets[storedPreset]) return
    // `dirty` compares against activePreset, which follows the RESOLVED mode.
    // Branching on the preference instead meant that under 'system' with a
    // light OS this wrote the dark preset: the visible preset never moved,
    // dirty never cleared, and the button silently did nothing.
    if (mode === 'light') setLightPreset(storedPreset)
    else setDarkPreset(storedPreset)
  }

  const presets = Object.entries(themePresets)

  return (
    <Section
      icon={Palette}
      title="Appearance"
      description="How this browser renders Nova. Changes apply as you make them."
    >
      <div>
        <label className="mb-2 block text-caption font-medium text-content-secondary">Mode</label>
        <div className="inline-flex rounded-sm border border-border p-0.5">
          {MODES.map(({ value, label, icon: Icon }) => (
            <SegmentedButton
              key={value}
              active={modePreference === value}
              onClick={() => setModePreference(value)}
            >
              <Icon size={13} />
              {label}
            </SegmentedButton>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-caption font-medium text-content-secondary">
          Text size
        </label>
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

      <div>
        <label className="mb-2 block text-caption font-medium text-content-secondary">
          Light theme
        </label>
        <div role="group" aria-label="Light theme presets" className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {presets.map(([key, preset]) => (
            <PresetCard
              key={key}
              id={key}
              label={preset.label}
              active={lightPreset === key}
              onClick={() => setLightPreset(key)}
            />
          ))}
        </div>
        {lightPreset === 'custom' && (
          <AccentPicker active={customLightAccent} onSelect={setCustomLightAccent} />
        )}
      </div>

      <div>
        <label className="mb-2 block text-caption font-medium text-content-secondary">
          Dark theme
        </label>
        <div role="group" aria-label="Dark theme presets" className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {presets.map(([key, preset]) => (
            <PresetCard
              key={key}
              id={key}
              label={preset.label}
              active={darkPreset === key}
              onClick={() => setDarkPreset(key)}
            />
          ))}
        </div>
        {darkPreset === 'custom' && (
          <AccentPicker active={customDarkAccent} onSelect={setCustomDarkAccent} />
        )}
      </div>

      <div className="border-t border-border-subtle pt-4 space-y-2">
        <p className="text-caption text-content-secondary">
          Instance default preset:{' '}
          <span className="font-mono text-content-primary">{storedPreset}</span>
          {dirty && (
            <>
              {' — this browser is showing '}
              <span className="font-mono text-content-primary">{activePreset}</span>
            </>
          )}
        </p>
        <InlineSave
          dirty={dirty}
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
