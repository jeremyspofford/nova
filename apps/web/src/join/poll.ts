// The joining device polls its request until the owner decides (docs/22 §4.1, ADR-094): at most
// one poll every 2 s, each signed over a time (Unix seconds) strictly later than the last one the
// Hub accepted, within 60 s of the Hub's clock. The Hub's clock comes from its Date header, so a
// device whose own clock is off still polls in time. A lost connection backs off and keeps
// trying; a refusal that cannot get better (a bad signature) stops.
import type { AddDeviceStatusView } from '@nova/shared';
import { ApiError } from '../api.ts';

/** The fewest milliseconds between two polls. */
export const POLL_GAP_MS = 2_000;
/** The longest wait after repeated failures. */
export const POLL_MAX_BACKOFF_MS = 15_000;
/** Own clock differences smaller than this are left alone. */
const SKEW_TOLERANCE_MS = 10_000;

export interface PollAnswer {
  body: AddDeviceStatusView;
  hubTime: number | null;
}

export interface PollDeps {
  /** Send one poll signed over `time` (Unix seconds). */
  poll: (time: number) => Promise<PollAnswer>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The last accepted time, after a reload. */
  lastTime?: number;
  minGapMs?: number;
  /** After every poll: whether the Hub answered, and the time that was used. */
  onProgress?: (p: { offline: boolean; time: number }) => void;
}

export type PollOutcome =
  | { status: 'approved' | 'denied' | 'expired'; view: AddDeviceStatusView }
  | { status: 'failed'; error: unknown }
  | { status: 'stopped' };

/** A refusal that carries the Hub's clock, so a stale time can be corrected. */
export class TimedApiError extends ApiError {
  readonly hubTime: number | null;
  constructor(err: ApiError, hubTime: number | null) {
    super(err.status, err.body);
    this.hubTime = hubTime;
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

function reasonOf(err: ApiError): string | null {
  const r = err.body.details?.reason;
  return typeof r === 'string' ? r : null;
}

export async function pollStatus(deps: PollDeps, signal: AbortSignal): Promise<PollOutcome> {
  const now = deps.now ?? (() => Date.now());
  const wait = deps.wait ?? sleep;
  const gap = deps.minGapMs ?? POLL_GAP_MS;
  let last = deps.lastTime ?? 0;
  let offset = 0;
  let nextAt = now();
  let failures = 0;
  let staleRetries = 0;
  const adopt = (hubTime: number | null, always: boolean) => {
    if (hubTime === null) return;
    const diff = hubTime - now();
    if (always || Math.abs(diff) > SKEW_TOLERANCE_MS) offset = diff;
  };
  while (!signal.aborted) {
    const delay = nextAt - now();
    if (delay > 0) await wait(delay, signal);
    if (signal.aborted) break;
    let time = Math.floor((now() + offset) / 1000);
    if (time <= last) time = last + 1;
    last = time;
    nextAt = now() + gap;
    try {
      const answer = await deps.poll(time);
      failures = 0;
      staleRetries = 0;
      adopt(answer.hubTime, false);
      deps.onProgress?.({ offline: false, time });
      const view = answer.body;
      if (view.status !== 'pending') return { status: view.status, view };
    } catch (err) {
      if (signal.aborted) break;
      if (err instanceof ApiError && err.status < 500) {
        const reason = reasonOf(err);
        // A poll the Hub saw as old: the next one uses a later time.
        if (err.status === 401 && reason === 'replayed') continue;
        if (err.status === 401 && reason === 'stale_time' && staleRetries < 3) {
          staleRetries++;
          adopt(err instanceof TimedApiError ? err.hubTime : null, true);
          continue;
        }
        if (err.status === 429) {
          const after = err.body.details?.retryAfterMs;
          nextAt = now() + Math.max(typeof after === 'number' ? after : 0, 10_000);
          deps.onProgress?.({ offline: false, time });
          continue;
        }
        return { status: 'failed', error: err };
      }
      // No answer, or a Hub error: try again later.
      failures++;
      nextAt = now() + Math.min(gap * 2 ** failures, POLL_MAX_BACKOFF_MS);
      deps.onProgress?.({ offline: true, time });
    }
  }
  return { status: 'stopped' };
}
