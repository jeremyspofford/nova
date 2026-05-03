import { useState } from 'react'
import { Settings2, ChevronDown, ChevronRight } from 'lucide-react'
import { Section } from '../../components/ui'
import type { ConfigSectionProps } from './shared'
import { useConfigValue } from './shared'

// ── Slider field ──────────────────────────────────────────────────────────────

interface SliderFieldProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (v: number) => void
  saving: boolean
}

function SliderField({ label, value, min, max, step, unit, onChange, saving }: SliderFieldProps) {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)

  // Sync when external value changes (after save round-trip)
  if (!dirty && draft !== value) setDraft(value)

  const handleChange = (v: number) => {
    setDraft(v)
    setDirty(v !== value)
  }

  const handleCommit = () => {
    onChange(draft)
    setDirty(false)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-caption font-medium text-content-secondary">{label}</label>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={draft}
            disabled={saving}
            onChange={e => handleChange(Number(e.target.value))}
            onMouseUp={handleCommit}
            onTouchEnd={handleCommit}
            className="w-32 accent-teal-500 disabled:opacity-50"
          />
          <span className="text-caption text-content-secondary tabular-nums w-16 text-right">
            {draft}{unit ? ` ${unit}` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Number field ──────────────────────────────────────────────────────────────

interface NumberFieldProps {
  label: string
  description?: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  saving: boolean
}

function NumberField({ label, description, value, min, max, onChange, saving }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value))

  // Sync when external value changes
  const parsed = parseInt(draft, 10)
  if (!isNaN(parsed) && parsed === value && draft !== String(value)) {
    setDraft(String(value))
  }

  const commit = () => {
    const v = parseInt(draft, 10)
    if (!isNaN(v)) {
      const clamped = Math.min(max, Math.max(min, v))
      setDraft(String(clamped))
      onChange(clamped)
    } else {
      setDraft(String(value))
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-caption font-medium text-content-secondary">{label}</label>
        <input
          type="number"
          min={min}
          max={max}
          value={draft}
          disabled={saving}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit() }}
          className="w-20 rounded-md border border-border-subtle bg-surface-card px-2 py-1 text-caption text-content-primary text-right focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />
      </div>
      {description && <p className="text-micro text-content-tertiary">{description}</p>}
    </div>
  )
}

// ── Section ───────────────────────────────────────────────────────────────────

export function CaptureAdvancedSection({ entries, onSave, saving }: ConfigSectionProps) {
  const [expanded, setExpanded] = useState(false)

  const sessionMaxRaw = useConfigValue(entries, 'capture.session_max_minutes', '30')
  const sessionMinRaw = useConfigValue(entries, 'capture.session_min_seconds', '30')
  const bufferSizeRaw = useConfigValue(entries, 'capture.buffer_size', '10')
  const paused = useConfigValue(entries, 'capture.paused', 'false') === 'true'

  const sessionMax = Math.min(120, Math.max(5, parseInt(sessionMaxRaw, 10) || 30))
  const sessionMin = Math.min(300, Math.max(0, parseInt(sessionMinRaw, 10) || 30))
  const bufferSize = Math.min(100, Math.max(1, parseInt(bufferSizeRaw, 10) || 10))

  return (
    <Section
      icon={Settings2}
      title="Capture Advanced"
      description="Session aggregation and backpressure tuning. Defaults are sensible — only adjust if needed."
    >
      {/* Pause toggle — always visible, frequent action */}
      <div className="flex items-center justify-between py-2 border-b border-border-subtle mb-4">
        <div>
          <p className="text-compact font-medium text-content-primary">Capture paused</p>
          <p className="text-caption text-content-tertiary mt-0.5">
            {paused ? 'Capture is currently paused. No new events are being collected.' : 'Capture is active. New screen events are being collected.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onSave('capture.paused', paused ? 'false' : 'true')}
          disabled={saving}
          className={`relative w-10 h-5 rounded-full transition-colors shrink-0 disabled:opacity-50 ${
            paused ? 'bg-amber-400' : 'bg-teal-500'
          }`}
          aria-label={paused ? 'Resume capture' : 'Pause capture'}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            paused ? '' : 'translate-x-5'
          }`} />
        </button>
      </div>

      {/* Expand/collapse trigger */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1.5 text-caption text-content-tertiary hover:text-content-secondary transition-colors mb-2"
      >
        {expanded
          ? <ChevronDown size={14} />
          : <ChevronRight size={14} />
        }
        {expanded ? 'Hide advanced settings' : 'Show advanced settings'}
      </button>

      {/* Collapsible advanced fields */}
      {expanded && (
        <div className="space-y-4 border-t border-border-subtle pt-4">
          <SliderField
            label="Session max duration (min)"
            value={sessionMax}
            min={5}
            max={120}
            step={1}
            unit="min"
            onChange={v => onSave('capture.session_max_minutes', String(v))}
            saving={saving}
          />
          <SliderField
            label="Session min duration (sec)"
            value={sessionMin}
            min={0}
            max={300}
            step={5}
            unit="sec"
            onChange={v => onSave('capture.session_min_seconds', String(v))}
            saving={saving}
          />
          <NumberField
            label="Backpressure buffer size"
            description={`Events buffered before backpressure kicks in. Range: 1–100.`}
            value={bufferSize}
            min={1}
            max={100}
            onChange={v => onSave('capture.buffer_size', String(v))}
            saving={saving}
          />
        </div>
      )}
    </Section>
  )
}
