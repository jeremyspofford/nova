// Block pages and bot challenges (FR-209, docs/11 §4.6): when a site refuses the agent's own
// browser, the controller may offer the local browser fallback. A challenge reuses the
// classifier's CAPTCHA detection (M6 handoff); a block page needs an HTTP status a block uses and
// words of a refusal, so an ordinary 403 (a page that needs a sign-in) is not one. What decides is
// page content and therefore untrusted: at worst a page makes Nova offer the fallback, which the
// user still has to accept, and only for that site.
import { CAPTCHA, CAPTCHA_FRAME, plainWords } from './classifier.ts';

/** Challenges on one site within this window make it "repeated". */
export const CHALLENGE_WINDOW_MS = 10 * 60_000;
/** How many challenges on one site count as repeated. */
export const CHALLENGE_REPEATS = 2;

const BLOCK_STATUS = new Set([401, 403, 405, 406, 429, 451, 503]);
const BLOCK_WORDS =
  /\b(access (is )?denied|access to this page has been denied|you have been blocked|you ve been blocked|request (was )?blocked|request (has been )?rejected|blocked by|attention required|unusual traffic|automated (queries|requests|access|traffic)|suspicious activity|bot (detected|protection|traffic)|are you a robot|not a robot|too many requests|rate limited|forbidden|pardon our interruption|please enable cookies)\b/;
const CHALLENGE_WORDS =
  /\b(just a moment|checking (if the site connection is secure|your browser)|verify(ing)? you are (a )?human|press (and|&) hold|complete the (security )?check|one more step|human verification|security check)\b/;

export interface BlockInput {
  status: number | null;
  title: string;
  /** Visible text; only the first few thousand characters are looked at. */
  text: string;
  /** Child frame URLs (a CAPTCHA widget). */
  frames: readonly string[];
}

export interface BlockFinding {
  kind: 'block' | 'challenge';
  /** Short, for the offer and the audit (never page text). */
  reason: string;
}

/** Whether a page is a block page or a bot challenge, and which; null for an ordinary page. */
export function detectBlock(input: BlockInput): BlockFinding | null {
  const words = plainWords(input.title, input.text.slice(0, 4_000));
  if (input.frames.some((f) => CAPTCHA_FRAME.test(f)))
    return { kind: 'challenge', reason: 'a CAPTCHA widget' };
  if (CHALLENGE_WORDS.test(words) || CAPTCHA.test(plainWords(input.title)))
    return { kind: 'challenge', reason: 'a bot check' };
  if (input.status !== null && BLOCK_STATUS.has(input.status) && BLOCK_WORDS.test(words))
    return { kind: 'block', reason: `a block page (HTTP ${input.status})` };
  if (input.status === 429) return { kind: 'block', reason: 'too many requests (HTTP 429)' };
  if (CAPTCHA.test(words)) return { kind: 'challenge', reason: 'a CAPTCHA' };
  return null;
}

/**
 * Challenges seen per site of one browser: a block page counts at once, a challenge once it
 * repeats within the window (the first one is the user's to solve, FR-189).
 */
export class ChallengeCounter {
  readonly #seen = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Note a finding on `site`; true when it calls for the fallback offer. */
  note(site: string, finding: BlockFinding): boolean {
    if (finding.kind === 'block') return true;
    const now = this.#now();
    const list = (this.#seen.get(site) ?? []).filter((t) => now - t < CHALLENGE_WINDOW_MS);
    list.push(now);
    this.#seen.set(site, list.slice(-10));
    if (this.#seen.size > 200) {
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined && oldest !== site) this.#seen.delete(oldest);
    }
    return list.length >= CHALLENGE_REPEATS;
  }

  /** Forget a site (the fallback was offered or the user solved it). */
  reset(site: string): void {
    this.#seen.delete(site);
  }
}
