// Development only (npm run dev): applies CSS changes in place and reloads
// the page for anything else, including a server restart.
const es = new EventSource('/__dev/events');
let connected = false;
es.addEventListener('open', () => { connected = true; });
es.addEventListener('change', (e) => {
  const { kind } = JSON.parse(e.data);
  if (kind !== 'css') return location.reload();
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const url = new URL(link.href);
    url.searchParams.set('t', Date.now());
    link.href = url.href;
  }
});
es.addEventListener('error', () => {
  if (!connected) return;
  es.close();
  const wait = () => fetch('/api/health').then((r) => (r.ok ? location.reload() : setTimeout(wait, 300))).catch(() => setTimeout(wait, 300));
  setTimeout(wait, 300);
});
