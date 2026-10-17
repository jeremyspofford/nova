// Copy text for the user. When the clipboard is unavailable or blocked, the text in `fallback` is
// selected instead so it can be copied with the keyboard; the result says which happened.
export async function copyText(text: string, fallback?: HTMLElement | null): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const sel = window.getSelection();
    if (fallback && sel) {
      const range = document.createRange();
      range.selectNodeContents(fallback);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return false;
  }
}

/** Save `text` as a file through a temporary link (the browser's download prompt). */
export function downloadText(name: string, text: string, mime = 'application/json'): boolean {
  if (typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
