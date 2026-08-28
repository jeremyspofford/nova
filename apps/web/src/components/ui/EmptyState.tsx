import { Button } from './Button'

type EmptyStateProps = {
  icon: React.ElementType
  title: string
  description: string
  action?: { label: string; onClick: () => void }
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon className="w-12 h-12 text-content-tertiary mb-4" />
      <h3 className="text-h3 text-content-primary mb-2">{title}</h3>
      <p className="text-compact text-content-secondary max-w-sm mb-6">{description}</p>
      {action && (
        <Button variant="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
