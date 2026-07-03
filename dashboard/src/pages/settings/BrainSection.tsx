import { Brain, AlertTriangle } from 'lucide-react'
import { Section, Toggle } from '../../components/ui'
import { useConfigValue, type ConfigSectionProps } from './shared'

/**
 * Brain enable toggle — gates Cortex's autonomous thinking loop. Default
 * off because the loop makes continuous LLM calls, a real cost on
 * lower-spec hardware.
 */
export function BrainSection({ entries, onSave, saving }: ConfigSectionProps) {
  const enabled = useConfigValue(entries, 'features.brain_enabled', 'false') === 'true'

  return (
    <Section
      id="brain"
      icon={Brain}
      title="Brain"
      description="Nova's autonomous thinking loop."
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="text-body font-medium text-content-primary">Enable Brain</div>
            <p className="mt-1 text-compact text-content-tertiary">
              The single on/off switch for Nova's autonomous brain. When on, Cortex runs its
              thinking cycle in the background (scheduled goals fire, drives run).
              When off, Cortex does nothing and makes no model calls.
            </p>
          </div>
          <Toggle
            checked={enabled}
            onChange={() => onSave('features.brain_enabled', JSON.stringify(!enabled))}
            disabled={saving}
          />
        </div>

        <div className="flex gap-3 p-3 rounded-sm bg-warning-subtle border border-warning-subtle">
          <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <div className="text-compact text-content-secondary leading-relaxed">
            <span className="font-medium text-content-primary">Performance impact.</span>{' '}
            The Cortex loop makes a steady stream of local-LLM calls. On systems with limited
            RAM or no GPU it can compete with interactive chat for inference capacity.
            Recommended for production hosts with headroom; leave off during local development.
          </div>
        </div>
      </div>
    </Section>
  )
}
