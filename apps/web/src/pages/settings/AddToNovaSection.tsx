import { useState } from 'react'
import { AppWindow, Laptop, QrCode as QrIcon, Server, Smartphone } from 'lucide-react'
import { Badge, Section } from '../../components/ui'
import { hasNativeApp, NATIVE_APP_LINKS } from '../../lib/nativeApp'
import { GET_APP_UNAVAILABLE, SETUP_BLURBS, SETUP_KINDS, SETUP_TITLES, type SetupKind } from '../../lib/setupSteps'
import { SetupModal, type SetupModalApi } from './SetupModal'

const ICONS: Record<SetupKind, React.ElementType> = {
  add_machine: Laptop,
  add_model_server: Server,
  install_pwa: Smartphone,
  get_app: AppWindow,
}

/** Settings → Devices, first (S47): a QR code for each of the four setups. */
export function AddToNovaSection({
  api,
  links = NATIVE_APP_LINKS,
}: {
  api?: SetupModalApi
  links?: { ios: string | null; android: string | null }
}) {
  const [open, setOpen] = useState<SetupKind | null>(null)
  // The app tile is "Coming soon" exactly while neither store lists one —
  // read from the links, never a flag someone has to remember to flip.
  const appComing = !hasNativeApp(links)
  return (
    <Section
      icon={QrIcon}
      title="Add to Nova"
      description="A QR code for each setup: scan it with a phone, or open its link on the machine you are adding."
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {SETUP_KINDS.map(kind => {
          const Icon = ICONS[kind]
          const coming = kind === 'get_app' && appComing
          return (
            <button
              key={kind}
              type="button"
              data-testid={`setup-tile-${kind}`}
              onClick={() => setOpen(kind)}
              className="flex items-start gap-3 rounded-md border border-border bg-surface-card p-3 text-left transition-colors hover:border-border-focus"
            >
              <Icon size={18} className="mt-0.5 shrink-0 text-accent" />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 text-compact font-medium text-content-primary">
                  {SETUP_TITLES[kind]}
                  {coming && (
                    <Badge size="sm" color="info">
                      Coming soon
                    </Badge>
                  )}
                </span>
                <span className="block text-caption text-content-secondary">
                  {coming ? GET_APP_UNAVAILABLE : SETUP_BLURBS[kind]}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <SetupModal setup={open} onClose={() => setOpen(null)} api={api} />
    </Section>
  )
}
