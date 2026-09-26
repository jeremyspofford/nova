import { useEffect } from 'react'
import { currentPlatform, type DevicePlatform } from '../../lib/devicePlatform'
import { NATIVE_APP_LINKS } from '../../lib/nativeApp'
import { InstallSteps } from './InstallSteps'
import { PublicShell } from './PublicShell'

const replaceLocation = (url: string) => window.location.replace(url)

/**
 * /app (S47): the page the "Nova app" QR code opens. A phone whose store has a
 * Nova app is sent there; today neither store has one, so the page says so and
 * offers the web app instead — never a redirect to a listing that does not exist.
 */
export function AppPage({
  platform = currentPlatform(),
  links = NATIVE_APP_LINKS,
  go = replaceLocation,
}: {
  platform?: DevicePlatform
  links?: { ios: string | null; android: string | null }
  go?: (url: string) => void
}) {
  const link = platform.os === 'ios' ? links.ios : platform.os === 'android' ? links.android : null
  useEffect(() => {
    if (link) go(link)
  }, [link, go])
  if (link) {
    return (
      <PublicShell title="The Nova app">
        <p>Opening the app store…</p>
        <a className="text-accent underline" href={link}>
          Open the store
        </a>
      </PublicShell>
    )
  }
  if (platform.phone) {
    return (
      <PublicShell title="The Nova app">
        <p>There’s no Nova app for {platform.os === 'ios' ? 'iPhone' : 'Android'} yet.</p>
        <p>Nova works as a web app on this phone instead:</p>
        <InstallSteps platform={platform} />
        <a className="text-accent underline" href="/">
          Sign in to Nova
        </a>
      </PublicShell>
    )
  }
  return (
    <PublicShell title="The Nova app">
      <p>The Nova app is for phones.</p>
      <a className="text-accent underline" href="/install">
        Install Nova on this computer instead
      </a>
    </PublicShell>
  )
}
