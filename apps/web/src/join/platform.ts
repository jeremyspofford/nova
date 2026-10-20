// What the joining device is, read from its user agent, only to name it and to say how to
// install the app on it (docs/22 §4.4). Nothing here decides access: the Hub never trusts it.
// The name ("Safari on iPhone") is a suggestion in the active locale; browser and device names are
// product names. `platform` is a protocol value the Hub keeps as it is.
import { defineMessages } from '@nova/i18n';

const NAME_TEXT = defineMessages('join.deviceName', {
  browserOn: '{browser} on {device}',
  otherBrowserOn: 'Browser on {device}',
  webBrowser: 'Web browser',
});

export type JoinOs = 'ios' | 'android' | 'macos' | 'windows' | 'chromeos' | 'linux' | 'other';
export type JoinBrowser = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'other';

export interface JoinPlatform {
  os: JoinOs;
  browser: JoinBrowser;
  /** A readable default name, e.g. "Safari on iPhone". */
  name: string;
  /** The `platform` sent with the request, e.g. "iOS". */
  platform: string;
}

const OS_LABEL: Record<JoinOs, string> = {
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  chromeos: 'ChromeOS',
  linux: 'Linux',
  other: 'Unknown',
};

/** Browser product names (not translated); any other browser is named by NAME_TEXT. */
const BROWSER_LABEL: Record<Exclude<JoinBrowser, 'other'>, string> = {
  safari: 'Safari',
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  samsung: 'Samsung Internet',
};

function osOf(ua: string): { os: JoinOs; device: string } {
  if (/iPad/.test(ua)) return { os: 'ios', device: 'iPad' };
  if (/iPhone|iPod/.test(ua)) return { os: 'ios', device: 'iPhone' };
  if (/Android/.test(ua)) return { os: 'android', device: 'Android' };
  if (/CrOS/.test(ua)) return { os: 'chromeos', device: 'ChromeOS' };
  if (/Windows/.test(ua)) return { os: 'windows', device: 'Windows' };
  // iPadOS reports a Mac; it is told apart by touch in `detectPlatform`.
  if (/Macintosh|Mac OS X/.test(ua)) return { os: 'macos', device: 'Mac' };
  if (/Linux|X11/.test(ua)) return { os: 'linux', device: 'Linux' };
  return { os: 'other', device: '' };
}

function browserOf(ua: string): JoinBrowser {
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

/** The platform as far as the user agent tells it. `touch` tells an iPad that reports a Mac. */
export function detectPlatform(ua: string, touch = 0): JoinPlatform {
  let { os, device } = osOf(ua);
  if (os === 'macos' && touch > 1) {
    os = 'ios';
    device = 'iPad';
  }
  const browser = browserOf(ua);
  const b = browser === 'other' ? null : BROWSER_LABEL[browser];
  const name = device
    ? b
      ? NAME_TEXT.browserOn({ browser: b, device })
      : NAME_TEXT.otherBrowserOn({ device })
    : (b ?? NAME_TEXT.webBrowser);
  return { os, browser, name: name.slice(0, 100), platform: OS_LABEL[os] };
}

/** How to install the app here: the iOS steps, the browser's own prompt, or none. */
export type InstallWay = 'ios-share' | 'prompt' | 'menu' | 'none';

/**
 * iOS installs from Share → Add to Home Screen; Chromium browsers offer a prompt
 * (`beforeinstallprompt`) when the app qualifies, else an item in their menu; Firefox on a
 * computer cannot install it.
 */
export function installWay(p: JoinPlatform, promptReady: boolean): InstallWay {
  if (p.os === 'ios') return 'ios-share';
  if (promptReady) return 'prompt';
  if (p.browser === 'chrome' || p.browser === 'edge' || p.browser === 'samsung') return 'menu';
  if (p.os === 'android') return 'menu';
  return 'none';
}
