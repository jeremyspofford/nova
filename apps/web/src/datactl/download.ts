// A browser download of a Hub address (the export's one-use ticket link): a temporary link the
// browser follows with the session cookie, so the file streams to disk without passing through
// the page.
export function startDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
