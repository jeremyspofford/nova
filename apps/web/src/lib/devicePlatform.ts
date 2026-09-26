/**
 * Which device opened a setup page (S47), from its user agent — the one place
 * this is decided. Detection is a heuristic, so it never guesses: an agent it
 * does not recognise is 'unknown', and a page shows every platform's steps.
 *
 * Order matters. iPadOS in desktop mode reports a Mac and only a touch screen
 * tells them apart. Edge and Samsung Internet both carry "Chrome/", and every
 * Chromium carries "Safari/", so the specific names are read first.
 */
export type DeviceOS = 'ios' | 'android' | 'mac' | 'windows' | 'linux' | 'chromeos' | 'unknown'
export type DeviceBrowser = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'other'

export interface DevicePlatform {
  os: DeviceOS
  browser: DeviceBrowser
  phone: boolean
}

function osOf(ua: string, maxTouchPoints: number): DeviceOS {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/CrOS/.test(ua)) return 'chromeos'
  if (/Windows NT/.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac'
  if (/Linux|X11/.test(ua)) return 'linux'
  return 'unknown'
}

function browserOf(ua: string, os: DeviceOS): DeviceBrowser {
  if (/SamsungBrowser\//.test(ua)) return 'samsung'
  if (/EdgiOS\/|EdgA\/|Edg\//.test(ua)) return 'edge'
  if (/FxiOS\/|Firefox\//.test(ua)) return 'firefox'
  if (/CriOS\/|Chrome\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua) && (os === 'ios' || os === 'mac')) return 'safari'
  return 'other'
}

export function devicePlatform(ua: string, maxTouchPoints = 0): DevicePlatform {
  const os = osOf(ua, maxTouchPoints)
  return { os, browser: browserOf(ua, os), phone: os === 'ios' || os === 'android' }
}

export function currentPlatform(): DevicePlatform {
  if (typeof navigator === 'undefined') return { os: 'unknown', browser: 'other', phone: false }
  return devicePlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0)
}
