// The live contrast check, in the page (Amendment 2026-10-30-C Part 1 §5): what the screen shows
// right now, read from the design system's variables, against the checks the core publishes
// (GET /design-systems/schema → live_checks; src/core/design.ts LIVE_CHECKS). And which design
// Nova recommends for this device. Pure, so it is unit-tested against the core's own math.

// A CSS colour as [r, g, b, a]: #rgb(a), #rrggbb(aa), rgb() and rgba(), with commas or spaces.
export function parseColor(v) {
  const s = String(v ?? '').trim();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    const h = m[1].length <= 4 ? [...m[1]].map((c) => c + c).join('') : m[1];
    const n = [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
    return [n[0], n[1], n[2], n[3] / 255];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some((x) => Number.isNaN(x))) return null;
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return null;
}

const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
function luminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Every check against colours from `get(token)`: translucent backgrounds sit on bg/base, and
// translucent text on its background, as the core measures them.
export function liveCheck(get, checks) {
  const base = parseColor(get('bg/base'));
  const failures = [];
  const results = [];
  for (const c of checks) {
    const b0 = parseColor(get(c.bg));
    const f0 = parseColor(get(c.fg));
    if (!base || !b0 || !f0 || base[3] < 1) continue;
    const b = b0[3] < 1 ? over(b0, base) : b0;
    const ratio = Math.round(contrast(f0[3] < 1 ? over(f0, b) : f0, b) * 100) / 100;
    const r = { ...c, ratio, ok: ratio >= c.min };
    results.push(r);
    if (!r.ok) failures.push(r);
  }
  return { ok: failures.length === 0, failures, results };
}

// One recommendation for this device, with its reason. It fits the light or dark the device
// asks for (the person's choice, else the system's), and every text and control in it passes the
// live check. Nova's own starter for that look comes first; otherwise the one with the most
// room to spare.
export function recommend(list, { mode = 'auto', prefers = 'dark' } = {}) {
  const want = mode === 'light' || mode === 'dark' ? mode : prefers === 'light' ? 'light' : 'dark';
  const whose = mode === 'auto' ? 'this device’s system setting' : 'your light and dark choice';
  const look = (d) => d.looks?.[want] ?? d.looks?.default ?? null;
  const usable = list.filter((d) => d.valid && d.state !== 'disabled' && look(d));
  // Stage 1: Orb Teal leads regardless of the OS scheme. Alternatives need the same
  // scale and rendered-review bar before they can become peer recommendations.
  const lead = usable.find((d) => d.lead && d.at_bar && look(d).ok);
  if (lead) return { ...lead, reason: 'Nova’s lead design, with all its text and controls passing the contrast check.' };
  const best = (xs) => [...xs].sort((a, b) => look(b).margin - look(a).margin)[0] ?? null;
  const fits = usable.filter((d) => look(d).scheme === want && look(d).ok);
  const starter = fits.find((d) => d.starter);
  if (starter) return { ...starter, reason: `Made for Nova, ${want} like ${whose}, and all its text and controls pass the contrast check.` };
  const fit = best(fits);
  if (fit) return { ...fit, reason: `${want === 'light' ? 'Light' : 'Dark'} like ${whose}, and all its text and controls pass the contrast check.` };
  const readable = best(usable.filter((d) => look(d).ok));
  if (readable) return { ...readable, reason: 'All its text and controls pass the contrast check.' };
  const any = best(usable);
  return any ? { ...any, reason: 'The easiest to read of the designs you have.' } : null;
}
