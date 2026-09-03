import type { AutonomyClass } from '../../lib/api'

/**
 * Pure presentation logic for Settings -> Autonomy, kept apart from the
 * section component so the one property the master control rests on is a
 * function a test pins without rendering anything:
 *
 * The master value is DERIVED from the live per-class rows, never stored.
 * There is no "all classes" row in the action_classes table and no setting
 * remembering what the owner last picked at the top — the kernel reads one
 * disposition per class, so the only honest master reading is "what every
 * class agrees on", or "mixed" when they do not. Setting the master writes
 * the rows (PUT /api/v1/autonomy); the master then re-derives from what came
 * back.
 */
export type MasterDisposition = AutonomyClass['disposition'] | 'mixed'

/**
 * The shared disposition when every class agrees, 'mixed' when they do not,
 * null when there are no classes to agree (nothing to derive from — the
 * section shows its EmptyState, not a control over nothing).
 */
export function masterDisposition(classes: readonly AutonomyClass[]): MasterDisposition | null {
  if (classes.length === 0) return null
  const first = classes[0].disposition
  return classes.every(c => c.disposition === first) ? first : 'mixed'
}
