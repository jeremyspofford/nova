// Shared M9 observer methodology; topology uses the same calculations and limits.
export function observe() {
  const v = { lcp: [] as number[][], shifts: [] as number[][], events: [] as number[][], firstInput: Infinity };
  (window as any).__v = v;
  const watch = (type: string, f: (e: any) => void, extra = {}) => { try { new PerformanceObserver((l) => l.getEntries().forEach(f)).observe({ type, buffered: true, ...extra }); } catch { /* not supported */ } };
  watch('largest-contentful-paint', (e) => v.lcp.push([e.startTime]));
  watch('layout-shift', (e) => { v.shifts.push([e.startTime, e.value, e.hadRecentInput ? 1 : 0]); if (!e.hadRecentInput) ((v as any).moved ??= []).push(`${Math.round(e.startTime)} ms ${e.value.toFixed(3)}: ${(e.sources ?? []).map((x: any) => x.node?.id || x.node?.className || x.node?.nodeName).join(', ')}`); });
  watch('event', (e) => { if (e.interactionId) { v.events.push([e.interactionId, e.duration, e.startTime]); (v as any).names ??= {}; (v as any).names[e.interactionId] = `${e.name} on ${e.target?.id || e.target?.className || e.target?.tagName || '?'}`; } }, { durationThreshold: 16 });
  watch('first-input', (e) => { v.firstInput = Math.min(v.firstInput, e.startTime); });
}

export function compute() {
  const v = (window as any).__v;
  const lcps = v.lcp.filter((x: number[]) => x[0]! < v.firstInput);
  const lcp = lcps.length ? lcps.at(-1)[0] : (v.lcp.at(-1)?.[0] ?? 0);
  let cls = 0;
  let win = 0;
  let first = 0;
  let last = 0;
  for (const [t, value, input] of v.shifts) {
    if (input) continue;
    if (win && t - last < 1000 && t - first < 5000) { win += value; last = t; } else { win = value; first = t; last = t; }
    cls = Math.max(cls, win);
  }
  const by = new Map<number, number>();
  for (const [id, d] of v.events) by.set(id, Math.max(by.get(id) ?? 0, d));
  const inp = Math.max(0, ...by.values());
  const worst = [...by].find(([, d]) => d === inp)?.[0];
  return { moved: (v.moved ?? []).join(' | '), lcp, cls, inp, interactions: by.size, worst: worst ? `${v.names?.[worst]} (${Math.round(inp)} ms)` : '' };
}

export const p75 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.75 * xs.length) - 1]!;
