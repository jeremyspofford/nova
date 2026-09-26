import { describe, it, expect } from 'vitest'
import { devicePlatform } from './devicePlatform'

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1',
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
  linuxChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
}

describe('devicePlatform', () => {
  it.each([
    ['iphoneSafari', 0, 'ios', 'safari', true],
    ['iphoneChrome', 0, 'ios', 'chrome', true],
    ['ipadDesktopMode', 5, 'ios', 'safari', true],
    ['ipadDesktopMode', 0, 'mac', 'safari', false],
    ['androidChrome', 5, 'android', 'chrome', true],
    ['samsung', 5, 'android', 'samsung', true],
    ['androidFirefox', 5, 'android', 'firefox', true],
    ['windowsChrome', 0, 'windows', 'chrome', false],
    ['windowsEdge', 0, 'windows', 'edge', false],
    ['windowsFirefox', 0, 'windows', 'firefox', false],
    ['linuxChrome', 0, 'linux', 'chrome', false],
    ['chromebook', 0, 'chromeos', 'chrome', false],
  ] as const)('%s (touch %i) is %s / %s', (key, touch, os, browser, phone) => {
    expect(devicePlatform(UA[key], touch)).toEqual({ os, browser, phone })
  })

  it('never guesses: an agent it does not know is unknown', () => {
    expect(devicePlatform('curl/8.5.0')).toEqual({ os: 'unknown', browser: 'other', phone: false })
  })
})
