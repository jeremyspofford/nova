/**
 * Every word a setup QR code puts in front of someone (S47), in one place, so
 * the Settings panels, her chat card and the public pages cannot drift apart —
 * and every install step carries the page its wording was checked against.
 *
 * Checked against each vendor's page on 2026-09-26.
 */
import type { DevicePlatform } from './devicePlatform'

export type SetupKind = 'install_pwa' | 'get_app' | 'add_machine' | 'add_model_server'
export const SETUP_KINDS: readonly SetupKind[] = ['add_machine', 'add_model_server', 'install_pwa', 'get_app']

export function isSetupKind(value: unknown): value is SetupKind {
  return typeof value === 'string' && (SETUP_KINDS as readonly string[]).includes(value)
}

export function isMachineSetup(setup: SetupKind): boolean {
  return setup === 'add_machine' || setup === 'add_model_server'
}

export const SETUP_TITLES: Record<SetupKind, string> = {
  add_machine: 'A machine Nova controls',
  add_model_server: 'A model server',
  install_pwa: 'Nova on a phone',
  get_app: 'The Nova app',
}

export const SETUP_BLURBS: Record<SetupKind, string> = {
  add_machine: 'Pair a computer so Nova can act on it.',
  add_model_server: 'Pair a machine whose models Nova will use.',
  install_pwa: 'Put Nova on a phone’s home screen.',
  get_app: 'Send a phone to its app store.',
}

const PAGE: Record<SetupKind, string> = {
  install_pwa: '/install',
  get_app: '/app',
  add_machine: '/add',
  add_model_server: '/add',
}

export function formatCode(code: string): string {
  const clean = code.replace(/[\s-]/g, '').toUpperCase()
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

/** The link a setup's QR code encodes. A machine code rides the fragment, which a browser never sends. */
export function setupLink(setup: SetupKind, address: string, code?: string | null): string {
  const base = `${address.replace(/\/+$/, '')}${PAGE[setup]}`
  return isMachineSetup(setup) && code ? `${base}#${formatCode(code)}` : base
}

// The pairing alphabet (services/core/app/devices.py, PAIRING_CODE_ALPHABET): no 0, 1, I, L, O.
const CODE = /(?:^|[^A-Z0-9])([2-9A-HJKMNP-Z]{4})-?([2-9A-HJKMNP-Z]{4})(?![A-Z0-9])/

export function parseCodeFragment(hash: string): string | null {
  let text: string
  try {
    text = decodeURIComponent(hash.replace(/^#/, ''))
  } catch {
    return null
  }
  const found = text.toUpperCase().match(CODE)
  return found ? `${found[1]}-${found[2]}` : null
}

export const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download'
export const TAILSCALE_STEP =
  'First, the phone needs Tailscale, signed in to the same tailnet as Nova. Nova cannot check this from here: if the page opens on the phone, it is.'
export const MODEL_SERVER_NOTE =
  'Serving this machine’s models arrives with S44. Until then, this pairs it as a machine Nova controls.'
export const NOVAD_README = 'https://github.com/jeremyspofford/nova/blob/main/apps/novad/README.md'

export const AGENT_STEPS = {
  install: {
    text: 'Install Nova’s agent, novad, first: build it as its README says. A one-line installer replaces this step later.',
    source: NOVAD_README,
  },
  enroll: 'Then run this on the machine:',
  run: 'Then start it with novad run. The README shows how to keep it running as a user service.',
  unsupported: 'Nova’s agent runs on Linux today. Windows and macOS arrive with S42a.',
  phone: 'Open this on the computer you’re adding.',
  phoneSelf: 'Adding this phone itself needs the Nova app, which doesn’t exist yet.',
} as const

export interface Step {
  text: string
  /** Where the wording was checked — shown to nobody, pinned by a test. */
  source?: string
}

export interface PlatformSteps {
  label: string
  steps: Step[]
}

const APPLE_WEB_APP = 'https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios'
const CHROME_IOS = 'https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DiOS'
const CHROME_ANDROID = 'https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid'
const CHROME_DESKTOP = 'https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DDesktop'
const EDGE =
  'https://support.microsoft.com/topic/install-manage-or-uninstall-apps-in-microsoft-edge-0c156575-a94a-45e4-a54f-3a84846f6113'
const SAFARI_MAC = 'https://support.apple.com/en-us/104996'
const FIREFOX_WINDOWS = 'https://support.mozilla.org/kb/web-apps-firefox-windows'

const INSTALL: Record<string, PlatformSteps> = {
  ios_safari: {
    label: 'iPhone or iPad, Safari',
    steps: [
      { text: 'Tap Share (the square with an arrow).', source: APPLE_WEB_APP },
      { text: 'Tap Add to Home Screen.' },
      { text: 'Turn on Open as Web App if you see it, then tap Add.' },
    ],
  },
  ios_chrome: {
    label: 'iPhone or iPad, Chrome',
    steps: [
      { text: 'Tap Share, at the right of the address bar.', source: CHROME_IOS },
      { text: 'Tap Add to Home Screen.' },
      { text: 'Confirm the name, then tap Add.' },
    ],
  },
  ios_other: {
    label: 'iPhone or iPad, another browser',
    steps: [{ text: 'Tap the browser’s Share button, then Add to Home Screen. If it has none, open this page in Safari.' }],
  },
  android_chrome: {
    label: 'Android, Chrome',
    steps: [
      { text: 'Tap More (the three dots), at the right of the address bar.', source: CHROME_ANDROID },
      { text: 'Tap Install and create shortcut, then Install.' },
    ],
  },
  android_other: {
    label: 'Android, another browser',
    steps: [{ text: 'Open the browser’s menu and choose Install app, Add to Home screen, or Add page to.' }],
  },
  desktop_chrome: {
    label: 'A computer, Chrome',
    steps: [
      {
        text: 'Click the install icon at the right of the address bar. If there is none: the menu (three dots), Cast, save, and share, Install page as app.',
        source: CHROME_DESKTOP,
      },
    ],
  },
  desktop_edge: {
    label: 'A computer, Edge',
    steps: [{ text: 'Click Settings and more (…), then More tools, then Apps, then Install this site as an app.', source: EDGE }],
  },
  mac_safari: {
    label: 'A Mac, Safari',
    steps: [{ text: 'Choose File, then Add to Dock.', source: SAFARI_MAC }],
  },
  windows_firefox: {
    label: 'Windows, Firefox',
    steps: [{ text: 'Click Add tab to taskbar, in the address bar.', source: FIREFOX_WINDOWS }],
  },
  desktop_firefox: {
    label: 'A computer, Firefox',
    steps: [
      {
        text: 'Firefox cannot install a site on this system: bookmark this page, or open it in Chrome or Edge to install it.',
        source: FIREFOX_WINDOWS,
      },
    ],
  },
  desktop_other: {
    label: 'A computer, another browser',
    steps: [{ text: 'Bookmark this page, or open it in Chrome or Edge to install it.' }],
  },
}

function installKey({ os, browser }: DevicePlatform): string | null {
  if (os === 'ios') return browser === 'safari' ? 'ios_safari' : browser === 'chrome' ? 'ios_chrome' : 'ios_other'
  if (os === 'android') {
    if (browser === 'chrome') return 'android_chrome'
    return 'android_other'
  }
  if (os === 'unknown') return null
  if (browser === 'chrome') return 'desktop_chrome'
  if (browser === 'edge') return 'desktop_edge'
  if (browser === 'safari' && os === 'mac') return 'mac_safari'
  if (browser === 'firefox') return os === 'windows' ? 'windows_firefox' : 'desktop_firefox'
  return 'desktop_other'
}

export function installSteps(platform: DevicePlatform): PlatformSteps[] {
  const key = installKey(platform)
  return key ? [INSTALL[key]] : Object.values(INSTALL)
}
