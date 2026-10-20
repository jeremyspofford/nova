// Permission modes of a Code session (FR-063, docs/10 §3, docs/12 §2.1): their names, what each
// does, and why one cannot be picked now. Auto needs a reviewer model (`review.model`); Bypass
// needs a VM or container environment and `code.allowBypass`. The Hub enforces the same rules and
// managed policy can remove modes; the UI only explains them before a request fails.
import { defineMessages } from '@nova/i18n';
import { PERMISSION_MODES, type EnvironmentView, type PermissionMode } from '@nova/shared';

export { PERMISSION_MODES };

export const MODE_LABEL = defineMessages('code.modes', {
  manual: 'Manual',
  accept_edits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  bypass: 'Bypass',
}) satisfies Record<PermissionMode, string>;

/** Why a mode cannot be picked now, as a phrase after its name, and how a picker shows it. */
export const MODE_TEXT = defineMessages('code.modeUnavailable', {
  reviewer: 'needs a reviewer model in Settings → Code',
  isolatedAndAllow: 'needs a VM or container environment and Allow Bypass in Settings → Code',
  isolated: 'needs a VM or container environment',
  allow: 'needs Allow Bypass in Settings → Code',
  /** A disabled choice: "Auto (needs a reviewer model in Settings → Code)". */
  option: '{mode} ({reason})',
  /** Its tooltip: "Auto needs a reviewer model in Settings → Code." */
  title: '{mode} {reason}.',
});

export const MODE_DESCRIPTION = defineMessages('code.modeDescription', {
  manual: 'Asks before every action that is not read-only. Edits show the diff first.',
  accept_edits:
    'File edits in the project are made and shown as diffs. Commands still ask unless a rule allows them.',
  plan: 'Reads and explores only, then proposes a plan. No source edits.',
  auto: 'A reviewer model checks every consequential action and can only make it stricter.',
  bypass:
    'Does not ask where a tool default would. Your rules, managed policy and confirmation steps still apply.',
}) satisfies Record<PermissionMode, string>;

export interface ModeContext {
  /** The `review.model` setting. */
  reviewerModel: string | null;
  /** The `code.allowBypass` setting. */
  allowBypass: boolean;
  /** The environment the session runs in, when known. */
  environment: Pick<EnvironmentView, 'kind' | 'isolated'> | null;
}

/** Bypass runs only on a VM or container substrate (FR-195). */
/** The Hub says whether commands there run on a container or VM substrate (Bypass needs one). */
export function isIsolatedEnvironment(
  env: Pick<EnvironmentView, 'kind' | 'isolated'> | null,
): boolean {
  return env?.isolated === true || env?.kind === 'container' || env?.kind === 'vm';
}

/** Why `mode` cannot be picked now, as a short phrase, or null when it can. */
export function modeUnavailable(mode: PermissionMode, ctx: ModeContext): string | null {
  if (mode === 'auto' && !ctx.reviewerModel) return MODE_TEXT.reviewer;
  if (mode === 'bypass') {
    const isolated = isIsolatedEnvironment(ctx.environment);
    if (!isolated && !ctx.allowBypass) return MODE_TEXT.isolatedAndAllow;
    if (!isolated) return MODE_TEXT.isolated;
    if (!ctx.allowBypass) return MODE_TEXT.allow;
  }
  return null;
}

/** Options for a mode picker: disabled modes say why in their label, not only in a tooltip. */
export function modeOptions(
  ctx: ModeContext,
  modes: readonly PermissionMode[] = PERMISSION_MODES,
): { value: PermissionMode; label: string; disabled: boolean; title: string }[] {
  return modes.map((m) => {
    const why = modeUnavailable(m, ctx);
    return {
      value: m,
      label: why ? MODE_TEXT.option({ mode: MODE_LABEL[m], reason: why }) : MODE_LABEL[m],
      disabled: why !== null,
      title: why ? MODE_TEXT.title({ mode: MODE_LABEL[m], reason: why }) : MODE_DESCRIPTION[m],
    };
  });
}

/**
 * The mode a new session in `folder` starts in: the one last used there, else the default
 * (`code.folderModes`, `code.permissionMode`; Plan is never remembered). Falls back to Manual
 * when the remembered mode is not available now.
 */
export function initialMode(
  folder: string,
  defaults: { permissionMode: PermissionMode; folderModes: Record<string, PermissionMode> },
  ctx: ModeContext,
): PermissionMode {
  const wanted = defaults.folderModes[folder] ?? defaults.permissionMode;
  return modeUnavailable(wanted, ctx) ? 'manual' : wanted;
}
