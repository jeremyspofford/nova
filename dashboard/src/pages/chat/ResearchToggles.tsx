import { Globe, BookOpen, Users } from 'lucide-react'
import { useChatStore } from '../../stores/chat-store'
import { Toggle } from '../../components/ui/Toggle'

export function ResearchToggles() {
  const {
    webSearchEnabled, setWebSearchEnabled,
    deepResearchEnabled, setDeepResearchEnabled,
    councilEnabled, setCouncilEnabled,
  } = useChatStore()

  return (
    <div className="space-y-2">
      <label className="block text-caption font-medium text-content-secondary">
        Research
      </label>
      <div className="space-y-2">
        <ToggleRow
          icon={<Globe size={14} />}
          label="Web Search"
          checked={webSearchEnabled}
          onChange={setWebSearchEnabled}
        />
        <ToggleRow
          icon={<BookOpen size={14} />}
          label="Deep Research"
          description={deepResearchEnabled ? 'Multi-step research with cross-referencing' : undefined}
          checked={deepResearchEnabled}
          onChange={setDeepResearchEnabled}
        />
        <ToggleRow
          icon={<Users size={14} />}
          label="Council"
          description={councilEnabled ? 'Several models answer in parallel; one synthesizes. Slower, stronger.' : undefined}
          checked={councilEnabled}
          onChange={setCouncilEnabled}
        />
      </div>
    </div>
  )
}

function ToggleRow({ icon, label, description, checked, onChange }: {
  icon: React.ReactNode
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-content-tertiary">
          {icon}
        </span>
        <span className="flex-1 text-caption text-content-primary">{label}</span>
        <Toggle checked={checked} onChange={onChange} size="sm" />
      </div>
      {description && (
        <p className="ml-6 mt-0.5 text-micro text-content-tertiary">{description}</p>
      )}
    </div>
  )
}
