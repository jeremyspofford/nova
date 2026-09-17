import { useEffect, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { Section } from '../../components/ui'
import { coversScreen, installedApp } from '../../lib/safeArea'

/**
 * What this browser actually reports about the screen it is on.
 *
 * Built 2026-09-15 after three rounds of guessing at a phone layout defect
 * nobody could see from the code. The harness that renders this app at
 * iPhone dimensions is Chromium/WebKit in a normal page — it cannot
 * reproduce iOS STANDALONE mode, which is where every one of these bugs
 * has lived. So the numbers have to come from the device.
 *
 * Deliberately plain and always on: a debug flag would be off on the one
 * device that needs it. It reads nothing and writes nothing.
 */

type Reading = {
  envTop: number
  envBottom: number
  publishedTop: string
  publishedBottom: string
  innerHeight: number
  innerWidth: number
  screenHeight: number
  screenWidth: number
  visualViewport: number | null
  standalone: boolean
  covers: boolean
  /** What the app shell ACTUALLY occupies, measured off the element. */
  shellHeight: number | null
}

/** Resolve a CSS length live — env() is not readable from JS any other way. */
function resolveCss(css: string): number {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none'
  probe.style.height = css
  document.body.appendChild(probe)
  const h = probe.getBoundingClientRect().height
  probe.remove()
  return h
}

function read(): Reading {
  const root = getComputedStyle(document.documentElement)
  return {
    envTop: resolveCss('env(safe-area-inset-top, 0px)'),
    envBottom: resolveCss('env(safe-area-inset-bottom, 0px)'),
    publishedTop: root.getPropertyValue('--nova-safe-top').trim() || '(unset)',
    publishedBottom: root.getPropertyValue('--nova-safe-bottom').trim() || '(unset)',
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    screenHeight: window.screen?.height ?? 0,
    screenWidth: window.screen?.width ?? 0,
    visualViewport: window.visualViewport ? Math.round(window.visualViewport.height) : null,
    standalone: installedApp(),
    covers: coversScreen(),
    // THE ONE THAT SETTLES IT (2026-09-16). Everything above is a number
    // the browser REPORTS; this is the height the shell is actually drawn
    // at. On the owner's installed app innerHeight read 793 against an
    // 852px screen — and 852 − 59 is exactly 793, so innerHeight was
    // reporting the SAFE height rather than the viewport's. A shortfall
    // computed from it therefore described a gap that may not exist.
    //
    // The shell is `position: fixed; inset: 0`, so it is the layout
    // viewport by construction. Measuring it asks the question directly
    // instead of inferring it from a figure that has already lied twice.
    shellHeight: shellRect(),
  }
}

function shellRect(): number | null {
  const shell = document.querySelector('[data-testid="app-shell"]')
  return shell ? Math.round(shell.getBoundingClientRect().height) : null
}

export function DisplayDiagnostics() {
  const [r, setR] = useState<Reading | null>(null)

  useEffect(() => {
    const update = () => setR(read())
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  if (!r) return null

  // innerHeight BELOW screen height while installed and full-bleed is the
  // signature of the bug class: the web view is shorter than the screen but
  // still drawn from the top, so whatever is pinned to bottom:0 sits above
  // the visible bottom edge.
  const shortfall = r.screenHeight > 0 ? r.screenHeight - r.innerHeight : 0

  const rows: [string, string][] = [
    ['env(safe-area-inset-top)', `${r.envTop}px`],
    ['env(safe-area-inset-bottom)', `${r.envBottom}px`],
    ['--nova-safe-top (published)', r.publishedTop],
    ['--nova-safe-bottom (published)', r.publishedBottom],
    ['window.innerHeight', `${r.innerHeight}px`],
    ['window.screen.height', `${r.screenHeight}px`],
    ['visualViewport.height', r.visualViewport === null ? '(none)' : `${r.visualViewport}px`],
    ['viewport width × screen width', `${r.innerWidth} × ${r.screenWidth}`],
    ['installed app (standalone)', r.standalone ? 'yes' : 'no'],
    ['viewport covers screen', r.covers ? 'yes' : 'no'],
    ['screen − innerHeight', `${shortfall}px`],
    [
      'app shell height (measured)',
      r.shellHeight === null ? '(not on this page)' : `${r.shellHeight}px`,
    ],
  ]

  return (
    <Section
      icon={Smartphone}
      title="Display diagnostics"
      description="What this device reports about its own screen. Useful when a layout looks wrong on a phone and right everywhere else — read it on the device that looks wrong."
    >
      <dl data-testid="display-diagnostics" className="text-compact">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-1.5 last:border-0"
          >
            <dt className="text-content-secondary">{label}</dt>
            <dd className="font-mono text-content-primary">{value}</dd>
          </div>
        ))}
      </dl>
      {/* THE VERDICT, from the measured shell rather than from innerHeight.
          The warning that stood here read the shortfall and announced a gap
          — but innerHeight on an installed iOS app reports the SAFE height
          (852 − 59 = 793 on this device), so it was describing a figure,
          not the app. The shell is `fixed inset-0`, so its own height is
          the layout viewport; if that reaches the screen there is no gap,
          whatever innerHeight says. */}
      {r.shellHeight !== null && r.screenHeight > 0 && (
        <p
          className={`mt-3 text-caption ${
            r.screenHeight - r.shellHeight > 4 ? 'text-warning' : 'text-content-tertiary'
          }`}
          data-testid="display-verdict"
        >
          {r.screenHeight - r.shellHeight > 4
            ? `The app is drawn ${r.screenHeight - r.shellHeight}px shorter than the screen, so ` +
              'there is a real strip at one end that no CSS here can reach.'
            : 'The app is drawn the full height of the screen. innerHeight being ' +
              'lower than the screen is iOS reporting the SAFE height, not a gap — ' +
              'the shell is pinned to the viewport edges, so it does not read that number.'}
        </p>
      )}
    </Section>
  )
}
