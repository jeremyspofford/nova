// Onboarding, step 3 (docs/plans/M10-orchestration.md, Point 11; docs/plans/M10f.md §3): the backend
// options for this OS, in plain words. Nova recommends; it doesn't quiz (DESIGN-SYSTEM: fewer
// choices). Only what is built is offered: the supervisor runs every service today, and the K3s
// driver isn't built (M10j/M10k), so on Linux it is shown as not available yet, never as working,
// and on Windows, macOS and WSL2 it isn't offered at all, because it needs Linux.
//
// The words are cut to the evidence (Amendment 2026-10-31-B, closing rule). The ADR's draft named
// capture on every device and services on other devices; those come with M10h, so they aren't said.
// What is said is true now: everything Nova does runs under the supervisor, and nothing in Nova needs
// Kubernetes (the M10e suite runs with a tripwire on every Kubernetes tool, docs/evidence/m10e-gate.md).
import type { OsFamily } from './detect.ts';

export type Backend = 'supervisor' | 'k3s';
export interface BackendOption { id: Backend; label: string; available: boolean; recommended: boolean; note: string }
export interface BackendSummary { os: OsFamily; recommended: 'supervisor'; options: BackendOption[]; gets: string; misses: string; switching: string; words: string }

export const SUPERVISOR_WORDS = 'Ordinary programs, under Nova’s supervisor';
// Switching is said only where K3s could come (Linux), and promises nothing unbuilt (review 9).
export const SWITCH_LATER = 'You can see this in Settings › Services. Switching to K3s will be there once it is available, and it will ask for your explicit confirmation.';
export const SEE_SETTINGS = 'You can see this in Settings › Services.';
export const RUNS_TODAY = 'Everything Nova does today runs this way; nothing in Nova needs Kubernetes.';

export function backendFor(os: OsFamily): BackendSummary {
  const supervisor: BackendOption = { id: 'supervisor', label: SUPERVISOR_WORDS, available: true, recommended: true, note: 'Lighter, and needs nothing extra.' };
  if (os === 'linux') {
    const k3s: BackendOption = { id: 'k3s', label: 'K3s, a small Kubernetes', available: false, recommended: false, note: 'Not available yet in this version.' };
    const gets = `Recommended: ordinary programs, under Nova’s supervisor. It’s lighter and needs nothing extra. ${RUNS_TODAY}`;
    const misses = 'K3s, for container services, isn’t available in this version yet.';
    return { os, recommended: 'supervisor', options: [supervisor, k3s], gets, misses, switching: SWITCH_LATER, words: `${gets} ${misses} ${SWITCH_LATER}` };
  }
  const where = os === 'wsl2'
    ? 'This is Linux inside Windows (WSL2), which counts as Windows here: K3s inside WSL2 isn’t supported.'
    : `K3s isn’t offered on ${os === 'macos' ? 'a Mac' : 'Windows'}: it needs Linux.`;
  const gets = `On this computer, Nova runs its services as ordinary programs, under its supervisor. ${RUNS_TODAY}`;
  const misses = `${where} What this computer can’t do is host container services itself.`;
  return { os, recommended: 'supervisor', options: [supervisor], gets, misses, switching: SEE_SETTINGS, words: `${gets} ${misses} ${SEE_SETTINGS}` };
}
