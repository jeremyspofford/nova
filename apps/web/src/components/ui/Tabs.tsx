import clsx from 'clsx'

type TabItem = {
  id: string
  label: string
  icon?: React.ElementType
  badge?: number
}

type TabsProps = {
  tabs: TabItem[]
  activeTab: string
  onChange: (id: string) => void
  className?: string
}

export function Tabs({ tabs, activeTab, onChange, className }: TabsProps) {
  return (
    <div
      className={clsx(
        'flex overflow-x-auto no-scrollbar border-b border-border-subtle',
        className,
      )}
    >
      {tabs.map((tab) => {
        const Icon = tab.icon
        const active = tab.id === activeTab
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={clsx(
              'px-3 py-2 text-compact font-medium whitespace-nowrap transition-colors duration-fast',
              'border-b-2 -mb-px',
              active
                ? 'text-accent border-accent dark:shadow-[0_2px_8px_rgb(var(--accent-500)/0.2)]'
                : 'text-content-tertiary hover:text-content-secondary border-transparent',
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {Icon && <Icon className="w-3.5 h-3.5" />}
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-micro font-semibold bg-accent-500/20 text-accent-400">
                  {tab.badge}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
