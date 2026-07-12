import { useState, useEffect } from 'react'
import { Save, RotateCcw, Gauge } from 'lucide-react'
import { Section, Slider, Button, Input, Label } from '../../components/ui'
import type { ConfigSectionProps } from './shared'

// The per-slice budget sliders (system/tools/memory/history/working) were
// removed in the 2026-07-10 config audit: no allocator ever consumed them,
// so the UI was configuring nothing. Only re-add a slice control when a
// backend consumer for its key actually exists.

const STAGE_TIMEOUT_DEFAULT = 900

export function ContextBudgetSection({
  entries,
  onSave,
  saving,
}: ConfigSectionProps) {
  const getVal = (key: string, fallback: number) => {
    const e = entries.find(en => en.key === key)
    if (e && e.value !== null && e.value !== '') return Number(e.value)
    return fallback
  }

  const [compaction, setCompaction] = useState(() => getVal('context.compaction_threshold', 0.80))
  const [stageTimeout, setStageTimeout] = useState(() => getVal('pipeline.stage_timeout_seconds', STAGE_TIMEOUT_DEFAULT))
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setCompaction(getVal('context.compaction_threshold', 0.80))
    setStageTimeout(getVal('pipeline.stage_timeout_seconds', STAGE_TIMEOUT_DEFAULT))
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries])

  const handleSave = () => {
    onSave('context.compaction_threshold', JSON.stringify(compaction))
    onSave('pipeline.stage_timeout_seconds', JSON.stringify(stageTimeout))
    setDirty(false)
  }

  const handleReset = () => {
    setCompaction(getVal('context.compaction_threshold', 0.80))
    setStageTimeout(getVal('pipeline.stage_timeout_seconds', STAGE_TIMEOUT_DEFAULT))
    setDirty(false)
  }

  return (
    <Section
      icon={Gauge}
      title="Execution & Context"
      description="Pipeline execution limits and context management."
    >
      <div className="space-y-3">
        <Slider
          label="Compaction Threshold"
          min={50}
          max={100}
          step={5}
          value={Math.round(compaction * 100)}
          onChange={val => { setCompaction(val / 100); setDirty(true) }}
        />
        <p className="text-caption text-content-tertiary">
          Trigger context compaction when pipeline state exceeds this fraction of the context window.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Stage timeout (seconds)</Label>
        <Input
          type="number"
          min={0}
          step={60}
          value={stageTimeout}
          onChange={e => { setStageTimeout(Number(e.target.value)); setDirty(true) }}
          className="w-32 font-mono"
        />
        <p className="text-caption text-content-tertiary">
          Wall-clock budget per pipeline stage — a stage running longer is cancelled and the
          task fails with a clear timeout error. Keep it generous if you run slow local models.
          0 disables (the stale-heartbeat reaper remains as backstop).
        </p>
      </div>

      {dirty && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={handleReset} icon={<RotateCcw size={10} />}>
            Reset
          </Button>
          <Button size="sm" onClick={handleSave} loading={saving} icon={<Save size={10} />}>
            Save
          </Button>
        </div>
      )}
    </Section>
  )
}
