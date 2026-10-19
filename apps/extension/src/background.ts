// The service worker: the bridge logic on the browser's own extension API (bridge.ts).
import { Bridge } from './bridge.ts';
import type { ChromeApi } from './chrome.ts';

const api = (globalThis as unknown as { chrome: ChromeApi }).chrome;
const brands = (
  navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } }
).userAgentData?.brands;
const browser =
  brands
    ?.find((b) => !/not.?a.?brand/i.test(b.brand))
    ?.brand.concat(' ', brands[0]?.version ?? '') ?? 'Chromium';

void new Bridge({ chrome: api, browser }).start();
