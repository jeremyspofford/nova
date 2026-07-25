/** Wake-score history — the passive evidence trail (ROADMAP #11b).
 *
 * The wake detector scores every 80 ms chunk. Most of those scores are noise
 * floor and worthless; what matters is the PEAK of each attempt, and above all
 * the peaks that came CLOSE and didn't fire. A near-miss is the fingerprint of
 * "I had to say it three times" — the operator's exact symptom, and the only
 * way to see a child's experience without asking the child to do anything.
 *
 * One event per attempt, not per chunk: a peak opens when the score crosses
 * FLOOR, tracks its max, and closes after the score has stayed below FLOOR for
 * QUIET_MS. Persisted (bounded, time-windowed) so the picture builds over days
 * of ordinary use rather than one sitting.
 *
 * Scores only — no audio. Retaining the audio is phase 5a and is opt-in.
 */

export interface WakeEvent {
  at: number;              // epoch ms
  score: number;           // peak score of the attempt
  kind: 'fire' | 'near';   // did it cross the threshold?
  threshold: number;       // what the bar was at the time
}

const KEY = 'nova.wakeLog';
const MAX_EVENTS = 500;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;   // two weeks

let events: WakeEvent[] = load();
const subs = new Set<() => void>();

function load(): WakeEvent[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e: unknown): e is WakeEvent =>
      !!e && typeof e === 'object'
      && typeof (e as WakeEvent).at === 'number'
      && typeof (e as WakeEvent).score === 'number');
  } catch {
    return [];   // corrupt or unavailable storage is not worth an error path
  }
}

function persist(): void {
  try { localStorage.setItem(KEY, JSON.stringify(events)); }
  catch { /* quota or private mode — the in-memory log still works */ }
}

export function recordWakeEvent(e: WakeEvent): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  events = [...events.filter(x => x.at >= cutoff), e].slice(-MAX_EVENTS);
  persist();
  subs.forEach(fn => fn());
}

export function wakeEvents(): readonly WakeEvent[] {
  return events;
}

export function clearWakeLog(): void {
  events = [];
  persist();
  subs.forEach(fn => fn());
}

export function subscribeWakeLog(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** Rolling summary for the Settings readout. `sinceMs` defaults to 24 h.
 *  `nearMisses` is the number that should trend DOWN as the wake word
 *  improves — it counts attempts that got close and were ignored. */
export function wakeSummary(sinceMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - sinceMs;
  const recent = events.filter(e => e.at >= cutoff);
  const fires = recent.filter(e => e.kind === 'fire');
  const near = recent.filter(e => e.kind === 'near');
  const best = near.reduce((m, e) => Math.max(m, e.score), 0);
  return {
    fires: fires.length,
    nearMisses: near.length,
    bestNearMiss: best,
    total: recent.length,
  };
}
