// The Content-Security-Policy every HTML page Nova serves is sent with (src/server.js: the app
// shell, /pair, /styleguide; src/supervisor: the safe-mode page), and the other headers that go
// with it. Nothing outside Nova's own address is loaded, framed or posted to.
//
// Scripts: files from Nova's own address only. The few inline scripts a shipped page carries (the
// app page's status-bar picker and its "never blank" timer, ui/index.html) are allowed by their
// sha256, computed from the shipped file itself, so any other inline script, an injected
// `<script>` or an `onclick=` attribute, is refused. They stay inline rather than in files because
// the service worker's offline shell (ui/sw.js SHELL) would not hold a new file, and the timer
// must run even offline.
// Styles: stylesheet files from Nova's own address. The applied design system is a `<style id="ds">`
// that theme.js refills on every design change, so it can't be hashed: the shipped page's own
// `<style>` elements carry a nonce made fresh for each response, and no other `<style>` element
// is applied. `style=""` attributes (style-src-attr) are allowed: the app's templates set
// per-render values in them (skeleton boxes, fit bars, table alignment, the wait's clock, the
// topology's peer count, the ring's amplitude). They can't hold selectors, and anything they
// would load is still held to img-src and font-src.
import { createHash, randomBytes } from 'node:crypto';

// Allowed for `style=""` attributes. One place, so it can be dropped once the templates set those
// values through element.style instead (the CSP UI test, tests/ui/csp.test.ts, then shows any left).
export const STYLE_ATTRIBUTES = "'unsafe-inline'";

export const cspHash = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

// An inline script is a <script> element with no src: its exact text is what the browser hashes.
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
export function inlineScriptHashes(html: string): string[] {
  const out = new Set<string>();
  for (const [, attrs, body] of html.matchAll(SCRIPT)) if (!/\ssrc\s*=/i.test(` ${attrs}`)) out.add(cspHash(body!));
  return [...out];
}

// The shipped page's own <style> elements get this response's nonce; returns the page and the
// nonce (null when the page has no <style> element, so the policy names none).
export function nonceStyles(html: string): { html: string; nonce: string | null } {
  if (!/<style[\s>]/i.test(html)) return { html, nonce: null };
  const nonce = randomBytes(18).toString('base64');
  return { html: html.replace(/<style(?=[\s>])/gi, `<style nonce="${nonce}"`), nonce };
}

export function contentSecurityPolicy({ scripts = [], styleNonce = null }: { scripts?: string[]; styleNonce?: string | null } = {}): string {
  return [
    "default-src 'self'",
    ['script-src', "'self'", ...scripts].join(' '),
    ['style-src', "'self'", ...(styleNonce ? [`'nonce-${styleNonce}'`] : [])].join(' '),
    `style-src-attr ${STYLE_ATTRIBUTES}`,
    // data: the pairing page's mark (ui/pair.html) and a browser task's live frames (takeover.js).
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// Every HTML response: the policy for this page (its raw shipped text, before the server changes
// it, is what the script hashes come from), plus no MIME sniffing and no referrer to other sites.
// (same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` on the app's own
// POSTs, which the API refuses.)
export function htmlSecurityHeaders(shipped: string, styleNonce: string | null): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy({ scripts: inlineScriptHashes(shipped), styleNonce }),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  };
}
