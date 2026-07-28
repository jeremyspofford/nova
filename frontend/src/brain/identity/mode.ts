/** The presence state machine, matching the orb's so the two views never
 *  disagree about what she is doing. Deliberately a copy of the orb's rules
 *  rather than a shared import: the orb is shipped and reviewed, and a face
 *  landing should not be able to change how it behaves.
 *
 *  The mode colour tints the ATMOSPHERE only. Nothing here is allowed near
 *  her skin — a violet-faced Nova reads wrong. */

import { speaker } from '../../voice/speech';

export type Mode = 'idle' | 'listening' | 'thinking' | 'working' | 'speaking';

export const MODE_COLOR: Record<Mode, string> = {
  idle: '#2dd4bf',
  listening: '#38bdf8',
  thinking: '#a78bfa',
  working: '#fbbf24',
  speaking: '#99f6e4',
};

export interface Activity { active: boolean; kind?: string; at: number }

export function resolveMode(listening: boolean, act: Activity): Mode {
  const now = performance.now();
  // a stream that died without a done event must not think forever
  const fresh = act.active && now - act.at < 90_000;
  if (speaker.speaking) return 'speaking';
  if (fresh && (act.kind === 'tool' || act.kind === 'dispatch') && now - act.at < 4000) return 'working';
  if (fresh) return 'thinking';
  if (listening) return 'listening';
  return 'idle';
}
