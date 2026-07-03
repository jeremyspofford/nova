import { Brain, AlertTriangle } from 'lucide-react'
import { Section, Toggle } from '../../components/ui'
import { useConfigValue, type ConfigSectionProps } from './shared'

/**
 * Brain enable toggle — gates Cortex's autonomous thinking loop AND the
 * dashboard's engram graph prefetch + 3D visualization keep-alive. Default
 * off because both have non-trivial resource costs (continuous LLM calls,
 * a 2000-node graph fetch on every page load) that make the dashboard feel
 * sluggish on lower-spec hardware.
 */
export function BrainSection({ entries, onSave, saving }: ConfigSectionProps) {
  const enabled = useConfigValue(entries, 'features.brain_enabled', 'false') === 'true'

  return (
    <Section
      id="brain"
      icon={Brain}
      title="Brain"
      description="Nova's autonomous thinking loop and 3D engram graph visualization."
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="text-body font-medium text-content-primary">Enable Brain</div>
            <p className="mt-1 text-compact text-content-tertiary">
              The single on/off switch for Nova's autonomous brain. When on, Cortex runs its
              thinking cycle in the background (scheduled goals fire, drives run) and the dashboard
              prefetches the engram graph so the <code>/brain</code> page renders immediately.
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
            The 3D graph prefetch loads up to 2,000 engram nodes on every dashboard load, and
            the Cortex loop makes a steady stream of local-LLM calls. On systems with limited
            RAM or no GPU, dashboard refreshes can feel sluggish — sometimes timing out — while
            the brain is running. Recommended for production hosts with headroom; leave off
            during local development.
          </div>
        </div>
      </div>
    </Section>
  )
}
