// The history prompt: one search, one answer. Allowing asks the browser for the history
// permission in this click; the extension removes it again after the search.
import type { ChromeApi } from './chrome.ts';

const api = (globalThis as unknown as { chrome: ChromeApi }).chrome;
const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';
document.getElementById('query')!.textContent = params.get('q') ?? '';

async function answer(allow: boolean): Promise<void> {
  const granted = allow && (await api.permissions.request({ permissions: ['history'] }));
  await api.runtime.sendMessage({ type: 'history.answer', id, allow: granted });
  window.close();
}

document.getElementById('allow')!.onclick = () => void answer(true);
document.getElementById('deny')!.onclick = () => void answer(false);
