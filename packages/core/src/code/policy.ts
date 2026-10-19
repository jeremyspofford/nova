// Permission modes of a Code session as thread policy (FR-063, docs/10 §3, docs/12 §2.1,
// ADR-059). A mode is a preset over the two axes the engine evaluates: an approval policy and a
// permission profile. The session folder (or its worktree) is the only root: writable in every
// mode but Plan; protected paths inside it stay read-only or denied (FR-190, enforced by the
// engine). Auto needs a reviewer model; Bypass needs `code.allowBypass` and a VM or container
// substrate; managed policy can turn any mode but Manual off (FR-106). When a condition no longer
// holds, the session runs with Manual's axes: the policy fails closed, never open.
import { basename } from 'node:path';
import { isolatedSubstrate } from '@nova/policy';
import { NovaError, type PermissionMode } from '@nova/shared';
import { managedDenied } from '../managed/restrictions.ts';
import type { ThreadPolicy } from '../runtime/types.ts';
import type { SandboxClient } from '../tools/types.ts';

export interface PermissionModeAxes {
  approvalPolicy: NonNullable<ThreadPolicy['approvalPolicy']>;
  profileId: 'workspace' | 'read-only' | 'full';
  autoAcceptEdits: boolean;
}

/** docs/12 §2.1: the preset table. */
export const MODE_AXES: Record<PermissionMode, PermissionModeAxes> = {
  manual: { approvalPolicy: 'ask_always', profileId: 'workspace', autoAcceptEdits: false },
  accept_edits: { approvalPolicy: 'defaults', profileId: 'workspace', autoAcceptEdits: true },
  plan: { approvalPolicy: 'ask_always', profileId: 'read-only', autoAcceptEdits: false },
  auto: { approvalPolicy: 'review', profileId: 'workspace', autoAcceptEdits: false },
  bypass: { approvalPolicy: 'never_ask', profileId: 'full', autoAcceptEdits: false },
};

export interface PermissionModeConditions {
  /** `review.model` is set (Auto). */
  reviewerModel: string | null;
  /** `code.allowBypass` (Bypass). */
  allowBypass: boolean;
  /** The tools' sandbox substrate (Bypass needs a VM or container). */
  substrate: SandboxClient['substrate'];
  /** Why managed policy turns the mode off, or null (FR-106; `ManagedRestrictions`). */
  managed?: (mode: PermissionMode) => string | null;
}

/** Why a mode cannot be used now, or null when it can. */
export function modeUnavailable(mode: PermissionMode, c: PermissionModeConditions): string | null {
  const managed = c.managed?.(mode);
  if (managed) return managed;
  if (mode === 'auto' && !c.reviewerModel)
    return 'Auto mode needs a reviewer model: set one in Settings (review.model) first';
  if (mode === 'bypass') {
    if (!c.allowBypass) return 'Bypass mode is turned off in Settings (code.allowBypass)';
    if (!isolatedSubstrate(c.substrate))
      return 'Bypass mode needs a VM or container sandbox on this Hub';
  }
  return null;
}

/**
 * Throws `validation` when the mode cannot be selected now, and `policy_denied` `{reason: managed}`
 * when managed policy turns it off (FR-106).
 */
export function assertModeAvailable(mode: PermissionMode, c: PermissionModeConditions): void {
  const managed = c.managed?.(mode);
  if (managed) throw managedDenied(managed, { mode });
  const why = modeUnavailable(mode, c);
  if (why)
    throw new NovaError('validation', why, {
      details: { reason: 'mode_unavailable', mode },
    });
}

/** The thread policy of a session in `mode`, working in `folder`. */
export function modePolicy(
  mode: PermissionMode,
  folder: string,
  c: PermissionModeConditions,
): ThreadPolicy {
  // A mode whose condition lapsed runs with Manual's axes (fail closed).
  const effective: PermissionMode = modeUnavailable(mode, c) ? 'manual' : mode;
  const axes = MODE_AXES[effective];
  return {
    approvalPolicy: axes.approvalPolicy,
    profileId: axes.profileId,
    roots: [
      {
        path: folder,
        access: effective === 'plan' ? 'read' : 'write',
        label: basename(folder) || folder,
      },
    ],
    permissionMode: effective,
    autoAcceptEdits: axes.autoAcceptEdits,
  };
}

/** A one-line description of a mode for the Environment block. */
export function describePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'manual':
      return 'Manual: every action that is not read-only asks the user first';
    case 'accept_edits':
      return 'Accept edits: file edits inside the folder are applied and shown as diffs; commands ask';
    case 'plan':
      return 'Plan: read and explore only, then propose a plan; no edits';
    case 'auto':
      return 'Auto: allowed actions run; consequential ones are checked by the reviewer';
    case 'bypass':
      return 'Bypass: actions run without asking inside the sandbox, except protected tiers';
  }
}
