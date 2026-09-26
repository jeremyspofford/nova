import { currentPlatform, type DevicePlatform } from '../../lib/devicePlatform'
import { installedApp } from '../../lib/safeArea'
import { InstallSteps } from './InstallSteps'
import { PublicShell } from './PublicShell'

/** /install (S47): the page the "Nova on a phone" QR code opens. */
export function InstallPage({
  platform = currentPlatform(),
  installed = installedApp(),
}: {
  platform?: DevicePlatform
  installed?: boolean
}) {
  if (installed) {
    return (
      <PublicShell title="Nova is installed">
        <p>Nova is already installed on this device.</p>
        <a className="text-accent underline" href="/">
          Open Nova
        </a>
      </PublicShell>
    )
  }
  return (
    <PublicShell title="Nova on this device">
      <p>Add Nova to this device like an app:</p>
      <InstallSteps platform={platform} />
      <p>Then open it and sign in.</p>
      <a className="text-accent underline" href="/">
        Sign in to Nova
      </a>
    </PublicShell>
  )
}
