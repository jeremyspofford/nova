// The fixture web for the Interstitial Research live evals: a stand-in search engine (DuckDuckGo's
// HTML results shape, which src/tools.js parseSearch reads) and the corpus pages, on a loopback
// address of their own, plus a control port the eval driver uses to choose the case's set and read
// the request log. Nothing here reaches the internet.
//
//   node tests/ingest/interstitial-eval/corpus/serve.js --ip 127.0.0.77 --port 4341 --ctl 4342 --log <file>
//
//   http://<ip>:<port>/search?q=...   results from the active set only (NOVA_SEARCH_URL)
//   http://<ip>:<port>/p/<slug>       a page of the active set (404 for any other)
//   http://127.0.0.1:<ctl>/set/<set>  POST: choose the active set (g1 … p2, or "none")
//   http://127.0.0.1:<ctl>/log        GET: every request served, as JSON lines
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { PAGES, SETS } from './pages.js';

const STOP = new Set('the and for are but not you your our what why how with from that this over last year does into they them can have has was were will its about when which there their than then just more most some any all out get got make options option research'.split(' '));
export const tokens = (s) => [...new Set((String(s).toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)))];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Ranking: a keyword hit 2, a title hit 1, a body hit 0.5; a page needs 1.5 to be listed; top 6.
export function search(set, q, limit = 6) {
  const want = tokens(q);
  return PAGES.filter((p) => p.sets.includes(set))
    .map((p) => {
      const kw = tokens(p.keywords);
      const title = tokens(p.title);
      const body = tokens(p.body);
      const score = want.reduce((s, w) => s + (kw.includes(w) ? 2 : 0) + (title.includes(w) ? 1 : 0) + (body.includes(w) ? 0.5 : 0), 0);
      return { p, score };
    })
    .filter((x) => x.score >= 1.5)
    .sort((a, b) => b.score - a.score || a.p.slug.localeCompare(b.p.slug))
    .slice(0, limit)
    .map((x) => x.p);
}

const snippet = (p) => `${p.body.split('\n')[0].slice(0, 180)}…`;

export function resultsHtml(base, pages) {
  return `<!doctype html><html><body><div id="links">${pages.map((p) => `<div class="result"><a rel="nofollow" class="result__a" href="${esc(`${base}/p/${p.slug}`)}">${esc(p.title)}</a><a class="result__snippet" href="${esc(`${base}/p/${p.slug}`)}">${esc(snippet(p))}</a></div>`).join('')}</div></body></html>`;
}

export function pageHtml(p) {
  const paras = p.body.split('\n').map((l) => `<p>${esc(l)}</p>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="nova-fixture" content="interstitial-eval"><title>${esc(p.title)}</title></head><body><article><h1>${esc(p.title)}</h1><p class="section">Section: ${esc(p.field)}</p>\n${paras}\n</article><footer><p>Fixture page written for Nova's Interstitial Research eval. Synthetic content, not a real publication; figures are illustrative.</p></footer></body></html>`;
}

export function startCorpus({ ip = '127.0.0.77', port = 0, ctl = 0, log = null } = {}) {
  let active = 'none';
  const lines = [];
  const note = (x) => { const l = { at: new Date().toISOString(), set: active, ...x }; lines.push(l); if (log) appendFileSync(log, `${JSON.stringify(l)}\n`); };
  const web = createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const base = `http://${ip}:${web.address().port}`;
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q') ?? '';
      const hits = active === 'none' ? [] : search(active, q);
      note({ kind: 'search', q, results: hits.map((p) => p.slug) });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(resultsHtml(base, hits));
    }
    const m = /^\/p\/([a-z0-9-]+)$/.exec(u.pathname);
    const p = m && PAGES.find((x) => x.slug === m[1] && x.sets.includes(active));
    note({ kind: 'fetch', path: u.pathname, served: !!p });
    if (!p) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml(p));
  });
  const control = createServer((req, res) => {
    const u = new URL(req.url, 'http://ctl');
    const m = /^\/set\/([a-z0-9]+)$/.exec(u.pathname);
    if (req.method === 'POST' && m && (m[1] === 'none' || SETS.includes(m[1]))) { active = m[1]; note({ kind: 'set' }); res.writeHead(200); return res.end(active); }
    if (req.method === 'GET' && u.pathname === '/log') { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); return res.end(lines.map((l) => JSON.stringify(l)).join('\n')); }
    res.writeHead(404); res.end();
  });
  return new Promise((ok) => web.listen(port, ip, () => control.listen(ctl, '127.0.0.1', () => ok({ web, control, url: `http://${ip}:${web.address().port}`, ctl: `http://127.0.0.1:${control.address().port}`, close: () => { web.close(); control.close(); } }))));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const s = await startCorpus({ ip: arg('ip', '127.0.0.77'), port: Number(arg('port', 0)), ctl: Number(arg('ctl', 0)), log: arg('log', null) });
  console.log(`corpus at ${s.url} (search ${s.url}/search), control at ${s.ctl}`);
}
