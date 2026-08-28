import { useState, useRef, useEffect } from 'react'
import { HelpCircle, X } from 'lucide-react'

interface HelpEntry {
  term: string
  definition: string
}

interface PageHelpProps {
  entries: HelpEntry[]
}

/**
 * Contextual help toggle — renders a "?" icon button that expands a
 * glossary card below. Designed to sit in PageHeader's action area.
 */
export function PageHelp({ entries }: PageHelpProps) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (entries.length === 0) return null

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`p-1.5 rounded-sm transition-colors ${
          open
            ? 'text-accent bg-accent-dim'
            : 'text-content-tertiary hover:text-content-secondary hover:bg-surface-elevated'
        }`}
        title="Quick reference — what's on this page?"
        aria-label="Toggle help reference"
      >
        <HelpCircle size={16} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[28rem] max-w-[calc(100vw-2rem)] bg-surface-card border border-border-subtle rounded-md p-4 shadow-lg animate-fade-in glass-overlay dark:border-white/[0.10]">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-compact font-semibold text-content-primary flex items-center gap-1.5">
              <HelpCircle size={14} className="text-accent" />
              Quick Reference
            </h4>
            <button
              onClick={() => setOpen(false)}
              className="text-content-tertiary hover:text-content-secondary transition-colors p-0.5 rounded-sm hover:bg-surface-elevated"
            >
              <X size={14} />
            </button>
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
            {entries.map(({ term, definition }) => (
              <div key={term}>
                <dt className="text-caption font-medium text-content-secondary">{term}</dt>
                <dd className="text-caption text-content-tertiary mt-0.5">{definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}
